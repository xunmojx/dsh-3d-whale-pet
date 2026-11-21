// 虎鲸桌宠 - Electron 主进程
// 职责：
//   1. 创建透明无框置顶窗口；处理"拖动身体移动窗口"
//   2. 作为 harness gateway 的第二客户端：订阅事件流、派活、驱动情绪状态机
const { app, BrowserWindow, ipcMain, Menu, screen, nativeImage, shell, clipboard, dialog, desktopCapturer } = require('electron')
const path = require('node:path')
const { Gateway, fetchBalance, resolveGatewayUrl } = require('./gateway.js')

const WINDOW_WIDTH = 420
const WINDOW_HEIGHT = 400

// 体型档位：窗口和模型一起缩放，所以不会有「模型变大被窗口切掉」的问题
const SIZES = [
  { id: 'small', label: '🐣 小', scale: 0.7 },
  { id: 'medium', label: '🐋 中（默认）', scale: 1.0 },
  { id: 'large', label: '🐳 大', scale: 1.35 },
  { id: 'huge', label: '🦣 特大', scale: 1.7 },
]
let sizeScale = 1
const winW = () => Math.round(WINDOW_WIDTH * sizeScale)
const winH = () => Math.round(WINDOW_HEIGHT * sizeScale)

// ==================== 小游戏：大鱼吃小鱼 ====================
// 桌面点击是收不到的（窗口只有几百像素，其余全穿透），所以开局时铺一层全屏透明窗口
// 专门接点击、顺便把鱼画在上面；虎鲸窗口在最顶层，负责追和吃。
const GAME = {
  on: false,
  win: null,
  fish: [],          // { id, x, y, vx, vy, size }
  nextId: 1,
  bounds: null,
  lastSyncAt: 0,
  speed: 430,        // 追鱼的速度，比跟随快一截
  fishSpeed: 340,    // 鱼的最高逃逸速度：要快，但不能快过虎鲸（430）
  alertDist: 420,    // 鱼的警戒范围：进了这个圈就开始逃
  eatDist: 64,
  maxFish: 12,
}

function gameSend(channel, payload) {
  if (!GAME.win || GAME.win.isDestroyed()) return
  try { GAME.win.webContents.send(channel, payload) } catch { /* 窗口刚销毁 */ }
}

function startGame() {
  if (GAME.on) return
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  GAME.bounds = disp.workArea
  GAME.on = true
  GAME.fish = []
  GAME.nextId = 1
  GAME.lastSyncAt = 0

  const wa = GAME.bounds
  GAME.win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  GAME.win.loadFile(path.join(__dirname, 'renderer', 'game.html'))
  GAME.win.on('closed', () => { GAME.win = null })

  // 提示条单独开一个居中小窗口，置顶在虎鲸之上。
  // 放在游戏层里会被虎鲸挡住（虎鲸是始终置顶的）。
  try {
    const tipW = 480
    const tipH = 96
    const tw = new BrowserWindow({
      x: Math.round(wa.x + wa.width / 2 - tipW / 2),
      y: Math.round(wa.y + wa.height / 2 - tipH / 2),
      width: tipW,
      height: tipH,
      transparent: true,
      frame: false,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    tw.setIgnoreMouseEvents(true, { forward: true })
    tw.setAlwaysOnTop(true, 'screen-saver')
    tw.moveTop()          // 同级置顶里也排到虎鲸前面去
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
      + 'html,body{margin:0;height:100%;background:transparent;overflow:hidden}'
      + 'body{display:flex;align-items:center;justify-content:center}'
      + 'div{padding:12px 26px;border-radius:999px;background:rgba(20,26,44,.86);'
      + 'color:#e6ecff;font-size:17px;font-weight:500;letter-spacing:.5px;'
      + 'font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;white-space:nowrap}'
      + '</style></head><body><div>🎮 左键点任意位置投鱼 · 右键退出游戏</div></body></html>'
    tw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    tw.once('ready-to-show', () => { try { tw.show(); tw.moveTop() } catch { /* 已销毁 */ } })
    GAME.tipWin = tw
    setTimeout(() => {
      if (GAME.tipWin === tw) { GAME.tipWin = null }
      try { if (!tw.isDestroyed()) tw.destroy() } catch { /* 已销毁 */ }
    }, 6000)
  } catch { /* 提示窗失败不影响游戏本身 */ }
  // 虎鲸必须在游戏层之上，否则会被这层全屏窗口整个盖住（透明也挡）。
  // 平时虎鲸是普通层级，这里临时提到最顶，退出游戏时还原。
  try {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    }
  } catch { /* 忽略 */ }
  sendToWin('pet:game-mode', true)
}

function stopGame() {
  if (!GAME.on) return
  GAME.on = false
  GAME.fish = []
  const w = GAME.win
  GAME.win = null
  try { if (w && !w.isDestroyed()) w.destroy() } catch { /* 已关 */ }
  if (GAME.tipWin) {
    const tw = GAME.tipWin
    GAME.tipWin = null
    try { if (!tw.isDestroyed()) tw.destroy() } catch { /* 已关 */ }
  }
  // 不退层级：桌宠始终是顶层窗口
  sendToWin('pet:game-mode', false)
}

/** 游戏循环：更新鱼群、追最近的那条、吃到就删掉。 */
function updateGame(now, dt, cx, cy) {
  const dtSec = Math.min(dt, 80) / 1000
  const wa = GAME.bounds
  if (!wa) return

  for (const f of GAME.fish) {
    const dx = f.x - cx
    const dy = f.y - cy
    const d = Math.hypot(dx, dy) || 1
    if (d < GAME.alertDist) {
      // 离虎鲸越近，逃得越急
      const push = (1 - d / GAME.alertDist) * 2400
      f.vx += (dx / d) * push * dtSec
      f.vy += (dy / d) * push * dtSec
    }
    // 平时（没被惊动）也要自己游：维持一个缓慢的巡游速度，方向隔一两秒换一次。
    // 否则阻尼会把速度吃掉，鱼就停在那儿等着被吃。
    if (d >= GAME.alertDist) {
      if (!f.cruiseAt || now - f.cruiseAt > 1500 + Math.random() * 2000) {
        f.cruiseAt = now
        const a = Math.random() * Math.PI * 2
        const cruise = 38 + Math.random() * 30
        f.cruiseVx = Math.cos(a) * cruise
        f.cruiseVy = Math.sin(a) * cruise
      }
      f.vx += ((f.cruiseVx || 0) - f.vx) * 0.05
      f.vy += ((f.cruiseVy || 0) - f.vy) * 0.05
    }
    const damp = Math.pow(0.06, dtSec)
    f.vx *= damp
    f.vy *= damp
    const sp = Math.hypot(f.vx, f.vy)
    const maxSp = GAME.fishSpeed
    if (sp > maxSp) { f.vx = f.vx / sp * maxSp; f.vy = f.vy / sp * maxSp }
    f.x += f.vx * dtSec
    f.y += f.vy * dtSec
    // 撞到屏幕边就弹回来
    if (f.x < wa.x + 24) { f.x = wa.x + 24; f.vx = Math.abs(f.vx) }
    if (f.x > wa.x + wa.width - 24) { f.x = wa.x + wa.width - 24; f.vx = -Math.abs(f.vx) }
    if (f.y < wa.y + 24) { f.y = wa.y + 24; f.vy = Math.abs(f.vy) }
    if (f.y > wa.y + wa.height - 24) { f.y = wa.y + wa.height - 24; f.vy = -Math.abs(f.vy) }
  }

  // 找最近的一条
  let target = null
  let best = Infinity
  for (const f of GAME.fish) {
    const d = Math.hypot(f.x - cx, f.y - cy)
    if (d < best) { best = d; target = f }
  }

  if (target) {
    if (best < GAME.eatDist) {
      GAME.fish = GAME.fish.filter((x) => x !== target)
      // 鲸鱼那边播放和喂食一样的反应；全屏层那边冒个水花
      // 桌宠只知道自己在窗口里的坐标：这里换算成窗口相对位置再发，
      // 鱼被吃掉时贴图才会从嘴边开始，而不是永远从左边冒出来。
      let relX, relY
      try {
        const b = win.getBounds()
        relX = target.x - b.x
        relY = target.y - b.y
      } catch { /* 窗口刚销毁 */ }
      sendToWin('pet:fish-eaten', { x: relX, y: relY })
      gameSend('pet:fish-eaten', { x: target.x - wa.x, y: target.y - wa.y })
    } else if (!dragStartBounds) {
      const ux = (target.x - cx) / best
      const uy = (target.y - cy) / best
      // 头始终朝着鱼：复用「跟随鼠标」那条朝向通道，
      // cx/cy 传目标相对窗口中心的位置，渲染层就会把头转过去。
      if (now - (GAME.lastFaceAt || 0) > 30) {
        GAME.lastFaceAt = now
        sendToWin('pet:swim', {
          moved: cursorMoved,
          vx: ux * GAME.speed,
          vy: uy * GAME.speed,
          cx: target.x - cx,
          cy: target.y - cy,
        })
      }
      const step = Math.min(best - GAME.eatDist * 0.5, GAME.speed * dtSec)
      const nx = Math.round(cx + ux * step - winW() / 2)
      const ny = Math.round(cy + uy * step - winH() / 2)
      if (nx !== Math.round(cx - winW() / 2) || ny !== Math.round(cy - winH() / 2)) {
        try { win.setBounds({ x: nx, y: ny, width: winW(), height: winH() }) } catch { /* 窗口销毁中 */ }
      }
    }
  }

  if (!target && now - (GAME.lastFaceAt || 0) > 200) {
    GAME.lastFaceAt = now
    try {
      const c = screen.getCursorScreenPoint()
      sendToWin('pet:swim', { vx: 0, vy: 0, cx: c.x - cx, cy: c.y - cy })
    } catch { /* 拿不到光标就算了 */ }
  }

  // 每 33ms 把鱼群位置推给全屏层
  if (now - GAME.lastSyncAt > 33) {
    GAME.lastSyncAt = now
    gameSend('pet:fish-sync', GAME.fish.map((f) => ({
      id: f.id, x: f.x - wa.x, y: f.y - wa.y, vx: f.vx, size: f.size,
    })))
  }
}

// 任务栏图标：渲染层用 canvas 把 🐋 画成 PNG 传过来（和侧边栏那个图标一致）
ipcMain.on('pet:icon', (_e, dataUrl) => {
  try {
    if (!win || win.isDestroyed() || typeof dataUrl !== 'string') return
    const img = nativeImage.createFromDataURL(dataUrl)
    if (!img.isEmpty()) win.setIcon(img)
  } catch { /* 图标失败不影响运行 */ }
})

ipcMain.on('pet:hold-still', (_e, ms) => {
  const d = Number(ms)
  holdStillUntil = Date.now() + (Number.isFinite(d) ? Math.max(200, Math.min(8000, d)) : 2500)
})

ipcMain.on('pet:drop-fish', (_e, x, y) => {
  if (!GAME.on) return
  if (GAME.fish.length >= GAME.maxFish) GAME.fish.shift()
  GAME.fish.push({
    id: GAME.nextId++,
    x: Number(x) || 0,
    y: Number(y) || 0,
    vx: (Math.random() - 0.5) * 150,
    vy: (Math.random() - 0.5) * 150,
    size: 16 + Math.random() * 8,
  })
})

ipcMain.on('pet:exit-game', () => stopGame())

// ---- 配置持久化：体型 / 跟随开关 / 漫游开关 ----
// 存在 Electron 的 userData 目录下，重开桌宠（甚至重装插件）都还记得。
const fs = require('node:fs')
let CONFIG_PATH = null
let savedCfg = {}
function clampSize(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.max(0.4, Math.min(2.5, n))
}
function loadConfig() {
  try {
    CONFIG_PATH = path.join(app.getPath('userData'), 'whale-pet-config.json')
    savedCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
  } catch {
    savedCfg = {}   // 没有配置或者文件坏了都当第一次启动
  }
  if (savedCfg.size !== undefined) sizeScale = clampSize(savedCfg.size)
  if (typeof savedCfg.follow === 'boolean') FOLLOW.enabled = savedCfg.follow
  if (typeof savedCfg.roam === 'boolean') ROAM.enabled = savedCfg.roam
  if (typeof savedCfg.skin === 'string' && savedCfg.skin) currentSkin = savedCfg.skin
  if (typeof savedCfg.dance === 'number') currentDance = savedCfg.dance
  if (typeof savedCfg.name === 'string') petName = savedCfg.name
  if (savedCfg.pose && typeof savedCfg.pose === 'object') {
    petPose = {
      yaw: Number(savedCfg.pose.yaw) || 0,
      pitch: Number(savedCfg.pose.pitch) || 0,
      roll: Number(savedCfg.pose.roll) || 0,
    }
  }
  if (Array.isArray(savedCfg.lineOff)) lineOff = savedCfg.lineOff.map(String)
  if (savedCfg.customLines && typeof savedCfg.customLines === 'object') {
    const next = { click: [], idle: [], pet: [], game: [] }
    for (const cat of Object.keys(next)) {
      const arr = savedCfg.customLines[cat]
      if (Array.isArray(arr)) next[cat] = normalizeCustom(arr)
    }
    customLines = next
  }
}
function saveConfig() {
  if (wiping) return          // 正在清数据：退出时也别写回
  if (!CONFIG_PATH) return
  try {
    savedCfg.size = sizeScale
    savedCfg.follow = FOLLOW.enabled
    savedCfg.roam = ROAM.enabled
    savedCfg.skin = currentSkin
    savedCfg.dance = currentDance
    savedCfg.name = petName
    savedCfg.lineOff = lineOff
    savedCfg.customLines = customLines
    savedCfg.pose = petPose
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(savedCfg, null, 2))
  } catch {
    // 写不进去（权限之类）就算了，不该影响桌宠运行
  }
}
// DSH 桌面版的监听端口**每次启动都是随机的**，没有固定端口可写。
// 地址由 gateway.js 的 resolveGatewayUrl() 按优先级解析：
//   1. WHALE_PET_URL       —— 插件 spawn 桌宠时把真实地址直接传进来（最可靠）
//   2. 插件写的发现文件     —— $DSH_HOME/cache/whale-pet-dsh-url.json（手动 npm start）
//   3. 默认端口探测        —— 旧版/固定端口场景的最后兜底
// 每次重连都会重新解析，所以 DSH 重启换端口后桌宠能自己跟回来。

let win = null
let dragStartBounds = null

// 退出中标记：窗口开始关闭后，网关/WebSocket 的回调可能仍在触发，
// 此时绝不能再往渲染进程发消息（否则 main process 抛 "Object has been destroyed" 并弹框）。
let quitting = false

/**
 * 安全地往主窗口发消息。
 * 窗口对象销毁后依然非 null，所以只判断 `if (win)` 不够——必须查 isDestroyed()。
 * @returns {boolean} 是否真的发出去了
 */
function sendToWin(channel, payload) {
  if (quitting) return false
  if (!win || win.isDestroyed()) return false
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return false
  try {
    wc.send(channel, payload)
    return true
  } catch {
    // 窗口正在销毁的竞态窗口期：静默忽略，不打扰用户
    return false
  }
}

function createWindow() {
  let startPos = { x: undefined, y: undefined }
  try {
    // 起始位置：屏幕右下角（贴任务栏上方一点，留 24 的边距）。
    // 注意：Electron 的 display.workArea 已经是 DIP，和 win.getBounds() 同一套坐标，
    // 千万不要再除以 scaleFactor —— 除一次窗口就会缩到屏幕中左上去（踩过）。
    const disp = screen.getPrimaryDisplay()
    const waX = disp.workArea.x
    const waY = disp.workArea.y
    const waW = disp.workArea.width
    const waH = disp.workArea.height
    const margin = 60
    startPos = {
      x: Math.round(waX + waW - winW() - margin),   // 贴右
      y: Math.round(waY + waH - winH() - margin),   // 贴下
    }
  } catch { /* 拿不到屏幕就交给 Electron 决定 */ }
  win = new BrowserWindow({
    x: startPos.x,
    y: startPos.y,
    width: winW(),
    height: winH(),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    // 先不显示：构造时给的 x/y 会被系统忽略，窗口会先出现在屏幕中间，
    // 等页面加载完再挪到右下角——那一跳就是你看到的「闪现」。
    // 改成加载完、位置钉好之后再 show，第一帧就在正确的位置。
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口被别的窗口盖住 / 失焦时，Chromium 会把动画帧率压到 10fps 甚至 1fps，
      // 点头就变成两三帧闪一下，看着像抽搐。桌宠必须一直 60fps。
      backgroundThrottling: false,
    },
  })

  // 透明无边框窗口在 Windows 上，构造时给的 x/y 有时会被忽略（实测跑到了屏幕中间），
  // 所以等 ready-to-show 之后再钉一次位置。
  if (typeof startPos.x === 'number' && typeof startPos.y === 'number') {
    const pin = () => {
      try {
        // setBounds 里带 x 在这台机器上会被吞掉（y 正常），改用 setPosition 单独设坐标
        win.setSize(winW(), winH())
        win.setPosition(startPos.x, startPos.y)
        const b1 = win.getBounds()
        if (Math.abs(b1.x - startPos.x) > 2) {
          win.setPosition(startPos.x + (startPos.x - b1.x), startPos.y)
        }
      } catch (e) { console.log('[pos] ' + tag + ' 失败 ' + (e && e.message)) }
    }
    // 透明窗口在 ready-to-show 阶段设坐标会被系统忽略；等页面真正加载完再设，
    // 并在显示之后再补一次。
    // 页面的 <title> 不要自动同步到窗口标题，否则用户取的名字会被覆盖回默认
  win.on('page-title-updated', (e) => { try { e.preventDefault() } catch { /* 忽略 */ } })

  win.webContents.on('did-finish-load', () => {
      pin()
      try { win.show() } catch { /* 忽略 */ }
    })
  }
  // 桌宠必须始终压在最上层：被别的窗口盖住时，连右键菜单都点不到
  // （点击会落到下面那个窗口上）。'screen-saver' 是 Windows 上最高的一档。
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenu(null)
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'))
  // 初始就穿透：只有光标落到鲸鱼身上时才收回（见 updateClickThrough）
  try {
    win.setIgnoreMouseEvents(true, { forward: true })
  } catch { /* 老版本 electron 没有 forward 选项，退化成普通穿透 */ }
  clickThrough = true
}

// ==================== 跟随鼠标 ====================
// 让虎鲸在桌面上跟着光标游，游到跟前就停下来看着你。
//
// 三条硬规则，都是被「躲鼠标 / 倒着游 / 抓不住」逼出来的：
//
// 1) 目标是**光标本身**，不是「光标旁边某个固定点」。目标是固定点的话，
//    光标一逼近，鲸鱼就得往反方向让位 —— 于是它一边看着你一边倒退，像躲。
//    现在它只做一件事：朝光标游过去，游到跟前就停。
// 2) 有死区。光标离它不到 deadzone 就不动。你伸手过去、围着它转，它只转
//    头看你，不会溜；想拖它、点它、挠它，都抓得到。
// 3) 慢。maxStep/ease 压到「游」而不是「瞬移」的速度（约 270px/s 封顶），
//    靠近目标时指数减速，看起来是自己滑过去的。
//
// 顺带解决了「窗口压住鼠标」的老问题：窗口开着点击穿透（见 updateClickThrough），
// 只有光标正好落在鲸鱼身上时才恢复可交互，其余透明区域全部让给下面的窗口。
const FOLLOW = {
  enabled: false,     // 首次安装默认不跟随；开关状态会存本地，改过就一直记得
  deadzone: 170,      // 光标离窗口中心小于这个距离就不动（px）
  // 下面两个都是「物理量」，不是「每帧多少」：Windows 的计时器粒度是 15.6ms，
  // 实际循环频率会随机器在 30~64Hz 之间浮动，只有按真实 dt 算位移才不会
  // 一会儿快一会儿慢（之前按 30fps 写死每帧 9px，一跳 9 像素，看着就卡）。
  speed: 215,         // 追光标的最大速度（px/s）—— 比漫游的 85 快一倍多，但不至于窜
  easePerFrame: 0.045, // 每 16.7ms 向目标靠近的比例（指数缓动，与帧率无关）
  tick: 8,            // 名义 125Hz；Windows 会把它拉到 15.6ms 一档（实际约 64Hz）
  resumeDelay: 6000,  // 手动拖完之后多久恢复跟随（ms）
  hitRx: 150,         // 鲸鱼身体的命中椭圆半径（窗口内 CSS px）
  hitRy: 125,         // 只有光标落在这个椭圆里，窗口才吃鼠标；其余穿透
}

let followTimer = null
let followPausedUntil = 0
let followIdle = false
// 跟随用的浮点累积位置（见下面 follow.fx 处的注释）
// 皮肤 / 跳舞强度（持久化用，loadConfig 里会读回来）
let currentSkin = 'classic'
let currentDance = 0.7
/** 用户给它取的名字；空串表示用默认标题 */
let petName = ''
// 初始姿势（度）：左右偏转 / 上下俯仰 / 侧倾。用户在「调整角度」里调，存本地配置
let petPose = { yaw: 64, pitch: -16, roll: -22 }   // 用户调好并确认的初始姿态

let followFx = null
let followFy = null
/** 启动后先原地停一会儿（ms 时间戳），别一开机就窜出去 */
let startHoldUntil = 0
/** 正在执行「删除本地数据」：期间不能再把配置写回去 */
let wiping = false
/** 上一次 tick 的时间戳（0 = 还没跑过），用来算真实 dt。 */
let lastTickAt = 0
/** 上一次推给渲染进程的光标方位（null = 还没推过），用来省掉没必要的 IPC。 */
let lastFace = null
/** 开场姿态：光标从启动位置移动超过 25px 才认为「用户动了」，之后才切到跟随角度。 */
let startCursorPos = null
let cursorMoved = false
/** 窗口当前是否在「点击穿透」状态（穿出去 = 不吃鼠标）。 */
let clickThrough = true

/**
 * 按光标位置决定窗口吃不吃鼠标。
 *
 * 这块 420×400 的置顶窗口一直压在桌面最上层，如果整块都吃鼠标，光标走到哪
 * 就被挡住哪 —— 更糟的是跟随时它会一直压着你正在点的地方。所以默认穿透，
 * 只有光标正好落在鲸鱼身体那个椭圆里时才收回穿透，让你能点它、拖它、右键它。
 *
 * 判定放在主进程（每帧都有现成的光标和窗口坐标），不做在渲染进程：
 * 渲染进程在穿透状态下只能收到转发来的 mousemove，一旦漏一帧就会卡在
 * 「可交互」状态挡住下层窗口，这种 bug 最难查。
 * @param {{cx: number, cy: number}} rel - 光标相对窗口中心的偏移（CSS px）
 * @returns {void}
 */
function updateClickThrough(rel) {
  // 拖动过程中不切状态：万一拖到一半窗口开始穿透，mouseup 就收不到了，
  // 拖拽会卡在「一直按着」的状态里。拖完自然会再判一次。
  if (dragStartBounds) return
  // 游戏模式：鲸鱼整个让位给全屏那一层接点击，否则点到鲸鱼身上会变成"互动"而不是投鱼
  if (GAME.on) {
    if (!clickThrough) {
      clickThrough = true
      try { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true }) } catch { /* 忽略 */ }
    }
    return
  }
  // 菜单现在是独立的窗口，鲸鱼这边不需要为了菜单专门放开命中区。
  // 命中区 = 身体椭圆，加上（面板打开时）左侧那一条。
  // 之前面板打开时把整窗都放开了，结果周围透明区域也能右键弹菜单 ——
  // 放开一条竖带就够按钮用了，别的一律穿透。
  // 命中区优先用渲染层的光线检测结果：它知道模型真正的轮廓（尾鳍、胸鳍这些细条
  // 都算），比固定椭圆贴合得多。椭圆只在还没收到结果时兜底。
  const inBody = hitFromRenderer === null
    ? (rel.cx / FOLLOW.hitRx) ** 2 + (rel.cy / FOLLOW.hitRy) ** 2 <= 1
    : hitFromRenderer
  // 面板打开时整个窗口都接鼠标：这样「点鲸鱼以外的空白处」才收得到点击，
  // 用来收起面板（窗口本身只有 420×400，挡住的地方很有限）
  const inPanel = panelOpen
  const inside = inBody || inPanel
  const ignore = !inside
  if (ignore === clickThrough) return
  clickThrough = ignore
  try {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true })
  } catch {
    // 设置失败（窗口正在销毁之类）不该影响跟随本身
  }
}

/** 停掉跟随轮询。 */
function stopFollowLoop() {
  if (followTimer) {
    clearInterval(followTimer)
    followTimer = null
  }
  followIdle = false
  if (global.__MVLOG === undefined) global.__MVLOG = 0
  lastTickAt = 0
}

/** 开跟随轮询（始终跑：就算关了跟随，头也要朝着光标，见 tickFollow）。 */
function startFollowLoop() {
  stopFollowLoop()
  followTimer = setInterval(tickFollow, FOLLOW.tick)
}

// ==================== 自主漫游 ====================
// 鼠标不动了、或者「跟随鼠标」被关掉时，它不再傻站着，而是自己在这块屏幕上
// 慢慢游：随机挑一个点游过去，到了歇一会儿，再挑下一个。
const ROAM = {
  // 跟随关掉之后要不要自己游。注意：跟随时「手停了 10 秒」也会自动游，
  // 那是跟随逻辑的一部分，不受这个开关影响。
  enabled: false,      // 首次安装默认关：刚放出来的鲸鱼先待在原地，别一上来就乱跑
  afterIdleMs: 10000,  // 鼠标静止多久，开始自己游
  speed: 85,           // px/s —— 大约是跟随时速的 40%，是"游"不是"冲"
  arrive: 80,          // 离目标多近算到（留足余量，否则会卡在门口进不去）
  pauseMin: 2200,      // 到了歇多久（ms）
  pauseMax: 5200,
  margin: 40,          // 在「窗口半宽 + 这个值」的基础再留边，保证目标点够得着
}
let lastCursorX = -1
let lastCursorY = -1
let lastCursorMoveAt = 0
const roam = { tx: null, ty: null, pauseUntil: 0 }

/** 渲染层是不是正在翻滚（转圈）。翻滚时窗口要停住，别一边转一边游。 */
let rendererSpinning = false
/** 渲染层是不是在睡觉。睡着时整只停住，不游也不追。 */
let rendererSleeping = false
/** 左侧动作面板（喂食/爱心/睡眠）是否打开。打开时放开左侧一条命中区。 */
let panelOpen = false
/** 渲染层射线检测的结果：光标在不在模型身上。null = 还没收到过，用椭圆兜底。 */
let hitFromRenderer = null
let lastCursorSent = { x: null, y: null, at: 0 }
let lastTopmostAt = 0
/** 右键按下后的一小段时间窗口站住不动（不然它自己游走了，mouseup 就落空，菜单打不开） */
let holdStillUntil = 0
/** 右键菜单是否正开着。开着的时候窗口必须一直可交互，否则菜单变浮层、点外面关不掉。 */
let menuOpen = false

/** 改体型：窗口和模型按同一比例缩放，围绕当前中心点。 */
function setSize(scale) {
  sizeScale = clampSize(scale)
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    const w = winW(), h = winH()
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h })
    roam.tx = null
    roam.pauseUntil = 0
  }
  // 注意：这里只放大窗口，不再缩放模型。
  // 相机视角固定，窗口高度翻倍，模型在屏幕上占的像素自然也翻倍 —— 再乘一次就成 1.8 倍了。
  sendToWin('pet:set-size', 1)
  saveConfig()
}

/** 停靠时的朝向：水平、朝最后一次游动的那一侧，而不是朝鼠标。 */
function parkFaceRel() {
  const side = (roam.lastUx || 1) >= 0 ? 1 : -1
  return { cx: side * 320, cy: 0 }
}

function pickRoamTarget(wa, b) {
  // 目标点必须让「整个窗口」都能到位，所以边距至少是窗口的一半 + 余量。
  const halfW = (b && b.width ? b.width : WINDOW_WIDTH) / 2
  const halfH = (b && b.height ? b.height : WINDOW_HEIGHT) / 2
  const mx = Math.min(Math.max(0, wa.width / 2 - 10), halfW + ROAM.margin)
  const my = Math.min(Math.max(0, wa.height / 2 - 10), halfH + ROAM.margin)
  roam.tx = wa.x + mx + Math.random() * Math.max(20, wa.width - 2 * mx)
  roam.ty = wa.y + my + Math.random() * Math.max(20, wa.height - 2 * my)
  roam.fx = null      // 换目标时重新对齐浮点位置，别带着旧残差
  roam.fy = null
}

/** 光标方位变了没（超过 2px 才算变）：原地不动时不为了同一朝向刷 IPC。 */
function faceChanged(rel) {
  if (lastFace === null) return true
  return Math.abs(rel.cx - lastFace.cx) > 2 || Math.abs(rel.cy - lastFace.cy) > 2
}

// 渲染层开始/结束翻滚时通知；翻滚期间窗口停住。
ipcMain.on('pet:spinning', (_e, v) => { rendererSpinning = !!v })
ipcMain.on('pet:sleeping', (_e, v) => { rendererSleeping = !!v })
ipcMain.on('pet:panel', (_e, v) => {
  panelOpen = !!v
  if (panelOpen) {
    // 立刻放开鼠标命中：等主循环下一拍（~15ms）再放开，头一两下点击会落到桌面上
    try { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false, { forward: true }) } catch { /* 忽略 */ }
    clickThrough = false
    // 面板开着的时候它必须站住：漫游/跟随会把窗口挪走，
    // 鼠标明明在按钮上，结果点到的是桌面 → 面板被当成「点外面」关掉
    followPausedUntil = Number.MAX_SAFE_INTEGER
    openCatcher()
  } else {
    followPausedUntil = 0
    closeCatcher()
  }
})

/**
 * 全屏点击捕手。
 * 桌宠窗口只有 420×400，用户点到窗口外面（别的程序上）时桌宠收不到事件，
 * 所以面板打开期间铺一层透明全屏窗口：层级比桌宠低，鲸鱼和按钮照样能点，
 * 其余地方的点击落到这层上，用来收起面板。
 */
let catcherWin = null
// 启动时就把这层建好（隐藏），面板打开只是「显示它」——
// 现场创建要 200~400ms，那段时间按钮点不动，就是用户说的「得等一会」。
function buildCatcher() {
  if (catcherWin && !catcherWin.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  catcherWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, show: false, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  catcherWin.loadFile(path.join(__dirname, 'renderer', 'catcher.html'))
  try { catcherWin.setAlwaysOnTop(true, 'pop-up-menu') } catch { /* 忽略 */ }
  catcherWin.on('closed', () => { catcherWin = null })
}

function openCatcher() {
  if (!win || win.isDestroyed()) return
  buildCatcher()
  if (!catcherWin || catcherWin.isDestroyed()) return
  try { catcherWin.showInactive() } catch { /* 忽略 */ }
}
function closeCatcher() {
  if (!catcherWin || catcherWin.isDestroyed()) { catcherWin = null; return }
  try { catcherWin.hide() } catch { /* 忽略 */ }
}
ipcMain.on('catcher-hit', () => {
  closeCatcher()
  panelOpen = false
  sendToWin('pet:panel-close', null)
})
ipcMain.on('pet:hit', (_e, v) => { hitFromRenderer = !!v })
// 渲染层收到任何一次点击 => 主动收起菜单（点模型上或者窗口内都算"外面"）


// ---- 诊断（只在 WHALE_PET_DEBUG=1 时输出）----
// 追问过「游起来为什么卡」：需要知道跟踪循环真实跑了几帧、每次 setBounds 花了多久。
const DEBUG_FOLLOW = process.env.WHALE_PET_DEBUG === '1'
let dbgTicks = 0
let dbgMoves = 0
let dbgCost = 0
let dbgSince = Date.now()
function debugTick(costMs) {
  if (!DEBUG_FOLLOW) return
  if (costMs === undefined) { dbgTicks++ } else { dbgMoves++; dbgCost += costMs }
  const now = Date.now()
  if (now - dbgSince < 1000) return
  const fps = dbgTicks * 1000 / (now - dbgSince)
  const avg = dbgMoves > 0 ? (dbgCost / dbgMoves).toFixed(2) : '0'
  console.log(`[follow] 循环 ${fps.toFixed(0)}/s，移动 ${dbgMoves} 次，setBounds 平均 ${avg}ms`)
  dbgTicks = 0; dbgMoves = 0; dbgCost = 0; dbgSince = now
}

/** 一次跟随推进：算目标点，缓动过去，顺手把速度方向和光标方位推给渲染进程。 */
function tickFollow() {
  if (quitting) return
  if (!win || win.isDestroyed() || win.isMinimized()) return

  let cursor
  try { cursor = screen.getCursorScreenPoint() } catch { return }
  debugTick()

  // 真实的帧间隔：Windows 的 setInterval(8) 实际会给到 ~15.6ms 一档，
  // 所以位移和缓动都按 dt 算，不能写死「每帧多少像素」。
  const now = Date.now()
  const dt = lastTickAt > 0 ? Math.min(now - lastTickAt, 120) : 16
  lastTickAt = now
  const b = win.getBounds()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  // 光标相对窗口中心的位置：既是「头朝哪儿」的依据，也是点击穿透的命中判定
  const rel = { cx: cursor.x - cx, cy: cursor.y - cy }
  if (!cursorMoved) {
    if (!startCursorPos) startCursorPos = { x: cursor.x, y: cursor.y }
    else if (Math.hypot(cursor.x - startCursorPos.x, cursor.y - startCursorPos.y) > 25) cursorMoved = true
  }

  // 把「光标在窗口里的坐标」丢给渲染层做光线检测（穿透时渲染层收不到鼠标事件，
  // 只能由主进程喂坐标）。约 60Hz，位置没动就跳过。
  if (now - lastCursorSent.at > 16 &&
      (lastCursorSent.x === null || Math.abs(rel.cx - lastCursorSent.x) > 0.5 ||
       Math.abs(rel.cy - lastCursorSent.y) > 0.5 ||
       now - lastCursorSent.at > 150)) {
    lastCursorSent = { x: rel.cx, y: rel.cy, at: now }
    // sx/sy 是屏幕绝对坐标：渲染层判「摸摸」要用它。
    // 只用窗口内相对坐标的话，它自己一游动，相对坐标就跟着变，晃动检测全被搅乱。
    sendToWin('pet:cursor', {
      x: rel.cx + winW() / 2,
      y: rel.cy + winH() / 2,
      sx: cursor.x,
      sy: cursor.y,
    })
  }

  updateClickThrough(rel)

  // 刚启动：先在屏幕中间站一秒再动（和 FACE.lockUntil 的 1 秒对齐，
  // 这样「停住 + 头朝左」是一起结束的，不会出现停着却已经转头）
  if (now < startHoldUntil) return

  // 右键按下后 / 菜单开着的时候：窗口站住。
  // 否则它在漫游里游着，你右键按下的那一下落在身上、松手时它已经挪开，
  // 浏览器就当成「拖动过」，菜单永远弹不出来。
  if (menuOpen || now < holdStillUntil) return

  // 游戏模式：窗口的移动完全由「追鱼」接管
  if (GAME.on) { updateGame(now, dt, cx, cy); return }

  // 有些程序（全屏播放器、安装器）会把自己提到 topmost 之上，被顶下去一次之后
  // 桌宠就再也收不到点击了。定期重新声明一次。
  if (!GAME.on && now - lastTopmostAt > 3000) {
    lastTopmostAt = now
    try { if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  }

  // 睡着：原地不动，也不追光标（和翻滚那条"停住"是同一类状态）
  if (rendererSleeping) return

  // 光标动没动：动过就记一笔，用来判断"手停了多久"
  if (Math.abs(cursor.x - lastCursorX) > 2 || Math.abs(cursor.y - lastCursorY) > 2) {
    lastCursorX = cursor.x
    lastCursorY = cursor.y
    lastCursorMoveAt = now
  }
  // 漫游总开关：关掉它，无论跟随开没开都不会自己游。
  // 开着时：跟随中，手停 10 秒才游；跟随关掉后，立刻自己游。
  const roaming = ROAM.enabled && (FOLLOW.enabled
    ? (now - lastCursorMoveAt > ROAM.afterIdleMs)
    : true)

  // —— 漫游：手没在动（或跟被关了）时自己游 ——
  if (DEBUG_FOLLOW && now - (roam.dbg || 0) > 2000) {
    roam.dbg = now
    console.log(`[roam] roaming=${roaming} paused=${Math.round(followPausedUntil - Date.now())} target=${roam.tx === null ? 'null' : Math.round(roam.tx) + ',' + Math.round(roam.ty)} win=${cx},${cy}`)
  }
  if (roaming && !(Date.now() < followPausedUntil)) {
    let wa = null
    try { wa = screen.getDisplayNearestPoint(cursor).workArea } catch { /* 用窗口所在处兜底 */ }
    if (wa) {
      // 翻滚优先于移动：正在转圈就停着，别一边转一边游。
      if (rendererSpinning) {
        const parkedSpin = parkFaceRel()
        if (faceChanged(parkedSpin)) {
          lastFace = parkedSpin
          sendToWin('pet:swim', { vx: 0, vy: 0, cx: parkedSpin.cx, cy: parkedSpin.cy, roam: 1 })
        }
        return
      }
      if (roam.tx === null) {
        pickRoamTarget(wa, b)
      } else if (Math.hypot(roam.tx - cx, roam.ty - cy) < ROAM.arrive) {
        // 到了：歇一会儿，顺手挑下一个点，脑袋摆回水平（朝刚才游的那一侧）
        roam.pauseUntil = now + ROAM.pauseMin + Math.random() * (ROAM.pauseMax - ROAM.pauseMin)
        pickRoamTarget(wa, b)
        const parked = parkFaceRel()
        lastFace = parked
        sendToWin('pet:swim', { vx: 0, vy: 0, cx: parked.cx, cy: parked.cy, roam: 1 })
        return
      }
      if (now < roam.pauseUntil) {
        // 歇脚中：不动，脑袋保持水平（朝刚才游的那一侧）
        const parked = parkFaceRel()
        if (faceChanged(parked)) {
          lastFace = parked
          sendToWin('pet:swim', { vx: 0, vy: 0, cx: parked.cx, cy: parked.cy, roam: 1 })
        }
        return
      }
      const rdx = roam.tx - cx
      const rdy = roam.ty - cy
      const rdist = Math.hypot(rdx, rdy) || 1
      const ux = rdx / rdist
      const uy = rdy / rdist
      // 记住最后一次游动的水平方向：停下来时要按这个把脑袋摆回水平
      if (Math.abs(ux) > 0.15) roam.lastUx = ux
      // 接近目标时自动减速，像鱼靠岸
      const step = Math.min(rdist * 0.03, Math.max(0.6, ROAM.speed * dt / 1000))
      // 用浮点累积位置，不能每帧都从"取整后的窗口位置"重新加一步：
      // 这块屏是 150% 缩放，1 倍 DIP 的位移经 DIP↔物理像素取整后可能原地不动，
      // 每帧的小数部分被扔掉 —— 81px/s 的慢游就会永久卡住（实测 1.27px 的步子
      // 走了几十秒还在原地）。累积浮点值，只在跨过整像素时才真正 setBounds。
      if (roam.fx == null || Math.abs(roam.fx - b.x) > 6 || Math.abs(roam.fy - b.y) > 6) {
        roam.fx = b.x
        roam.fy = b.y
      }
      roam.fx += ux * step
      roam.fy += uy * step
      const nx = Math.round(roam.fx)
      const ny = Math.round(roam.fy)
      // 兜底：明明该动却挪不动（目标够不着、或被系统钳制），2.5 秒后换个目标
      if (nx === b.x && ny === b.y) {
        if (!roam.stuckAt) roam.stuckAt = now
        else if (now - roam.stuckAt > 1200) {
          // 挪不动了（多半是最后几像素的取整卡住）：当成"到了"处理 ——
          // 停下来、脑袋摆正、歇一会儿、换下一个目标，而不是原地干耗。
          roam.stuckAt = 0
          roam.pauseUntil = now + ROAM.pauseMin + Math.random() * (ROAM.pauseMax - ROAM.pauseMin)
          pickRoamTarget(wa, b, cursor)
          const parked = parkFaceRel()
          lastFace = parked
          sendToWin('pet:swim', { vx: 0, vy: 0, cx: parked.cx, cy: parked.cy, roam: 1 })
          return
        }
      } else {
        roam.stuckAt = 0
      }
      if (nx !== b.x || ny !== b.y) {
        try {
          win.setBounds({ x: nx, y: ny, width: winW(), height: winH() })
          if (DEBUG_FOLLOW && now - (roam.dbg2 || 0) > 1000) {
            roam.dbg2 = now
            console.log(`[roam-move] step=${step.toFixed(2)} b=${b.x.toFixed(1)},${b.y.toFixed(1)} -> ${nx},${ny} dist=${rdist.toFixed(0)}`)
          }
        } catch (e) { console.log('[roam] setBounds failed', e && e.message); return }
      }
      // 漫游时头朝游动方向（把"朝向依据"换个虚拟点，渲染层逻辑不用改）
      const faceRel = { cx: ux * 320, cy: uy * 320 }
      lastFace = faceRel
      sendToWin('pet:swim', { vx: ux * 0.5, vy: uy * 0.5, cx: faceRel.cx, cy: faceRel.cy, roam: 1 })
      return
    }
  }

  // 不跟随（或正被手拖着）时窗口不动。
  // 注意：如果「跟随」和「漫游」都没开，就不要让头一直追着光标转 ——
  // 那种状态下它应该保持固定的初始朝向（正在调姿态时尤其明显）。
  if (!FOLLOW.enabled || Date.now() < followPausedUntil) {
    if (faceChanged(rel)) {
      lastFace = rel
      sendToWin('pet:swim', { vx: 0, vy: 0, cx: rel.cx, cy: rel.cy, moved: cursorMoved })
    }
    return
  }

  // 目标就是光标本身：朝它游过去，游到跟前停。光标逼近时它不会让位后退，
  // 所以看起来是「游过来贴着你」，而不是「被你赶着跑」。
  let tx = cursor.x
  let ty = cursor.y

  // 夹进光标所在显示器的可用区域，别游到屏幕外或多屏之间的缝里
  try {
    const wa = screen.getDisplayNearestPoint(cursor).workArea
    tx = Math.min(Math.max(tx, wa.x + b.width / 2), wa.x + wa.width - b.width / 2)
    ty = Math.min(Math.max(ty, wa.y + b.height / 2), wa.y + wa.height - b.height / 2)
  } catch { /* 取不到显示器信息就用未夹紧的目标 */ }

  const offX = tx - cx
  const offY = ty - cy

  // 死区：已经在跟前了就别再动弹。这一条是「能跟它互动」的前提 ——
  // 光标凑过来它只转头、不挪窝，你才抓得住它。
  if (Math.hypot(offX, offY) < FOLLOW.deadzone) {
    followIdle = true
    if (faceChanged(rel)) {
      lastFace = rel
      sendToWin('pet:swim', { vx: 0, vy: 0, cx: rel.cx, cy: rel.cy })
    }
    return
  }
  followIdle = false

  // 指数缓动按 dt 折算：帧率变了，靠近的手感也不会变
  const ease = 1 - Math.pow(1 - FOLLOW.easePerFrame, dt / 16.7)
  // 靠近时减速：死区边缘往外 150px 是减速段，速度从 100% 线性降到 20%。
  // 之前是全速冲到死区边线然后「啪」地停住，看着很生硬。
  const slowT = Math.min(1, Math.max(0, (Math.hypot(offX, offY) - FOLLOW.deadzone) / 150))
  const speedFactor = 0.2 + 0.8 * slowT
  const maxStep = Math.max(0.6, FOLLOW.speed * speedFactor * dt / 1000)
  let stepX = offX * ease
  let stepY = offY * ease
  const stepLen = Math.hypot(stepX, stepY)
  if (stepLen > maxStep) {
    stepX = stepX / stepLen * maxStep
    stepY = stepY / stepLen * maxStep
  }

  // 位置用浮点累积，不能每帧以「被吸附过的整数 b.x」为基准：
  // 这台屏是 150% DPI，setBounds 会把位置吸到物理像素网格上，
  // 同样 ±3px 的步长，向右实际走 2px、向左走 4px —— 左右速度差了将近一倍。
  // 累积浮点值，丢掉的小数留在里面，平均速度就对称了。
  if (followFx == null || Math.abs(followFx - b.x) > 40 || Math.abs(followFy - b.y) > 40) {
    followFx = b.x
    followFy = b.y
  }
  followFx += stepX
  followFy += stepY
  const nx = Math.round(followFx)
  const ny = Math.round(followFy)
  if (nx === b.x && ny === b.y) return
  // 必须用 setBounds 并显式钉死宽高，不能只 setPosition：这块屏带 DPI 缩放，
  // setPosition/getBounds 里的 DIP↔物理像素取整不互逆，会像下面「拖动」注释里
  // 那样把窗口「棘轮式」越撑越大（实测 420→500→524→552…）。窗口一涨，支撑函数
  // 算出的目标点就跟着外扩，最后整只虎鲸会往屏幕外跑飞。
  const moveT0 = Date.now()
  try {
    win.setBounds({ x: nx, y: ny, width: winW(), height: winH() })
  } catch { return }
  debugTick(Date.now() - moveT0)
  // 归一化速度（-1~1）交给渲染进程：横向速度 -> 侧倾，纵向 -> 轻微点头
  lastFace = rel
  sendToWin('pet:swim', {
    vx: stepX / maxStep,
    vy: stepY / maxStep,
    cx: rel.cx,
    cy: rel.cy,
  })
}

/** 开关跟随。关掉只是「不再游过来」，头照样会朝着光标转。 */
function setFollow(enabled) {
  FOLLOW.enabled = Boolean(enabled)
  if (FOLLOW.enabled) followPausedUntil = 0
  saveConfig()
  startFollowLoop()
  setTimeout(() => { try { buildCatcher() } catch { /* 忽略 */ } }, 1500)
}

// ---- 拖动：锁定窗口尺寸 + 相对总位移（修复 Windows 显示缩放下反复拖动窗口变大的 bug）----
// 根因：getPosition()+setPosition() 每次做 DIP↔物理像素取整，二者非互逆，误差累积会让窗口"棘轮式"变大；
//       窗口变大后相机距离不变，虎鲸跟着变大（放大），误差持续累积最终卡死/闪退。
// 修法：拖动开始缓存 getBounds()，之后一律用 "起点 + 总位移" 的 setBounds() 并锁死宽高。
ipcMain.on('drag-start', () => {
  if (!win || win.isDestroyed()) return
  dragStartBounds = win.getBounds()
  // 手已经抓住它了：这期间绝对不许跟随插一脚，否则会跟用户的手抢窗口
  followPausedUntil = Number.MAX_SAFE_INTEGER
})

ipcMain.on('drag-move', (_event, dx, dy) => {
  if (!win || typeof dx !== 'number' || typeof dy !== 'number') return
  if (!dragStartBounds) dragStartBounds = win.getBounds()
  win.setBounds({
    x: Math.round(dragStartBounds.x + dx),
    y: Math.round(dragStartBounds.y + dy),
    width: dragStartBounds.width,
    height: dragStartBounds.height,
  })
})

ipcMain.on('drag-end', (_event, moved) => {
  dragStartBounds = null
  // 松手后缓一下再恢复跟随：留点时间让你看清自己把它放哪了。
  // 但「单击」也会走 drag-start/drag-end 这一对 —— 没挪动过就别暂停，
  // 否则点一下它会有 6 秒不跟手。
  followPausedUntil = moved ? Date.now() + FOLLOW.resumeDelay : 0
})

// ==================== 右键菜单：换皮肤 / 播放器 / 最小化 / 退出 ====================
const SKINS = [
  { id: 'classic', label: '🔵 深寻蓝' },
  { id: 'night',   label: '🌙 虎鲸黑' },
  { id: 'pink',    label: '🌸 草莓粉' },
  { id: 'green',   label: '🌿 薄荷绿' },
  { id: 'gold',    label: '🌟 土豪金' },
]
const DANCE_LEVELS = [
  { id: 0,   label: '🚫 关闭' },
  { id: 0.4, label: '🐢 低' },
  { id: 0.7, label: '🐬 中' },
  { id: 1.0, label: '🚀 高' },
]

// ==================== 右键菜单（自绘窗口） ====================
// 原生 Menu.popup 在 Windows 上位置不可控（正坐标会被夹到屏幕最右边），
// 样式也跟桌宠不搭，所以改成自己画一个透明小窗口。
let menuWin = null
let menuCenterY = 0

// ==================== 安装来源 ====================
/**
 * 这个插件当初是从哪儿装上的。
 * 读 profile 的 package.json 里 dependencies["3d-whale-pet"] 那一条：
 *   github:xunmojx/dsh-3d-whale-pet      → 从 GitHub（或插件市场）装的
 *   https://gitee.com/.../xxx.tgz    → 从 Gitee 的 tarball 装的
 * @returns {string} 空串表示读不到
 */
function installSpec() {
  try {
    // __dirname = <profile>/node_modules/dsh-3d-whale-pet/pet
    const profileDir = path.resolve(__dirname, '..', '..', '..')
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const deps = (pkg && pkg.dependencies) || {}
    return String(deps['dsh-3d-whale-pet'] || deps['3d-whale-pet'] || '')
  } catch {
    return ''
  }
}

/**
 * 把 DSH 的窗口切到前台。
 *
 * 为什么不直接开浏览器：DSH 的 web 服务要令牌，而令牌只存在桌面端进程里，
 * 用浏览器打开裸地址只会得到「dsh web authentication required」。
 * 所以点「去更新」时，把已经登录着的 DSH 窗口叫到前面来更靠谱。
 * @returns {Promise<boolean>} 是否找到并激活了窗口
 */
function bringDshToFront() {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
if ($p) {
  # 先用 AppActivate（脚本里更可靠），失败再退回 Win32 的 SetForegroundWindow
  $ok = $false
  try { $ok = (New-Object -ComObject WScript.Shell).AppActivate($p.Id) } catch { }
  if (-not $ok) {
    [W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
    $ok = [W]::SetForegroundWindow($p.MainWindowHandle)
  }
  if ($ok) { 'FOUND' } else { 'FAILED' }
} else { 'NOTFOUND' }
`
  return new Promise((resolve) => {
    try {
      require('node:child_process').execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => resolve(!err && String(stdout).trim().split(/\s+/).includes('FOUND')),
      )
    } catch { resolve(false) }
  })
}

/** DSH 自己的界面地址（用于把用户送回插件页）。 */
function dshOrigin() {
  const raw = process.env.WHALE_PET_URL || ''
  try {
    const u = new URL(raw)
    return u.origin
  } catch {
    return ''
  }
}


/**
 * 「调整初始角度」窗口：单独开一个小窗，贴在桌宠旁边（不遮挡它本体）。
 * 滑杆改动 → 实时推给桌宠 + 存配置。
 */
let poseWin = null
function openPosePanel() {
  if (poseWin && !poseWin.isDestroyed()) {
    try { poseWin.show(); poseWin.focus() } catch { /* 忽略 */ }
    return
  }
  let x, y
  const w = 250, h = 190
  try {
    const b = win.getBounds()
    const disp = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) })
    x = b.x - w - 12
    if (x < disp.workArea.x + 8) x = b.x + b.width + 12
    y = Math.max(disp.workArea.y + 8, Math.min(b.y, disp.workArea.y + disp.workArea.height - h - 8))
  } catch { x = 40; y = 40 }
  poseWin = new BrowserWindow({
    width: w, height: h, x, y, title: '调整初始角度',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#141a2c', alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  poseWin.loadFile(path.join(__dirname, 'renderer', 'pose.html'))
  try { poseWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  poseWin.once('ready-to-show', () => {
    try { poseWin.showInactive() } catch { /* 忽略 */ }
    try { poseWin.webContents.send('pet:pose', petPose) } catch { /* 忽略 */ }
  })
  poseWin.on('closed', () => { poseWin = null })
}

ipcMain.on('pet:pose-set', (_e, pose) => {
  if (!pose || typeof pose !== 'object') return
  petPose = {
    yaw: Math.max(-180, Math.min(180, Number(pose.yaw) || 0)),
    pitch: Math.max(-60, Math.min(60, Number(pose.pitch) || 0)),
    roll: Math.max(-180, Math.min(180, Number(pose.roll) || 0)),
  }
  sendToWin('pet:pose', petPose)
  saveConfig()
})
ipcMain.on('pet:pose-close', () => {
  if (poseWin && !poseWin.isDestroyed()) poseWin.close()
})

// ==================== 台词（内置 + 自定义） ====================
// 内置台词写在代码里，不能被删；用户只能勾选「用不用」。
// 自定义台词存本地配置，改版不会覆盖。
const DEFAULT_LINES = {
  click: ['你好呀，我是小虎鲸！', '有事要我帮忙吗？', '摸鱼中，别打扰我~', '盯——你在看什么呀？'],
  idle: [
    '今天也辛苦啦，我在这儿呢',
    '你专心的时候，我就在旁边慢慢游',
    '刚才那个转身帅吧？',
    '有点想吃小鱼干……',
    '坐久啦，起来伸个懒腰嘛',
    '我不吵你，就看看你',
    '被你发现我在偷看你了',
    '我刚才打了个哈欠，你也打一个？',
    '累了就歇会儿，我帮你看着屏幕',
    '水底很安静的，适合想事情',
    '今天也做得很好哦，我说了算',
    '要不要摸摸我？我头很软的',
    '别急，慢慢来，我陪着你',
    '我数了一下，你已经认真很久了',
  ],
  pet: ['嘿嘿，舒服~', '再摸摸嘛', '我头很软的，对吧', '被你摸到啦', '呼噜呼噜……', '这个力度刚刚好'],
  game: ['好吃！', '再来一条', '嗯……鲜', '这条不错', '还要！', '别闹，我在捕猎', '鱼呢？', '等我抓到再说'],
}
// idle 的内置台词由渲染层自己提供（数量多且带名字替换），
// 这里留空表示「以内置为准」，编辑器只负责开关与追加。

let lineOff = []            // 被关掉的内置台词，形如 'click:2'
let customLines = { click: [], idle: [], pet: [], game: [] }

// 自定义台词存成 { text, on }：用户可以留着一批，只把想用的打开
function normalizeCustom(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map((it) => {
    if (typeof it === 'string') return { text: it, on: true }          // 老格式兼容
    if (it && typeof it === 'object') return { text: String(it.text || '').slice(0, 60), on: it.on !== false }
    return null
  }).filter((x) => x && x.text).slice(0, 200)
}

function linesForPet() {
  const out = {}
  for (const cat of Object.keys(DEFAULT_LINES)) {
    const builtin = DEFAULT_LINES[cat].filter((_, i) => !lineOff.includes(cat + ':' + i))
    const custom = normalizeCustom(customLines[cat]).filter((it) => it.on).map((it) => it.text)
    out[cat] = { builtin, custom }
  }
  return out
}

function pushLines() {
  sendToWin('pet:lines', linesForPet())
}

ipcMain.on('pet:save-pose', (_e, pose) => {
  if (!pose || typeof pose !== 'object') return
  petPose = {
    yaw: Math.max(-180, Math.min(180, Number(pose.yaw) || 0)),
    pitch: Math.max(-60, Math.min(60, Number(pose.pitch) || 0)),
    roll: Math.max(-60, Math.min(60, Number(pose.roll) || 0)),
  }
  saveConfig()
})
ipcMain.on('pet:pose-want', () => sendToWin('pet:pose', petPose))

ipcMain.on('pet:lines-want', () => pushLines())

ipcMain.on('pet:lines-close', () => {
  if (linesWin && !linesWin.isDestroyed()) linesWin.close()
})

ipcMain.handle('pet:lines-get', () => ({ defaults: DEFAULT_LINES, lineOff, custom: customLines }))
ipcMain.handle('pet:lines-save', (_e, payload) => {
  try {
    const p = payload || {}
    if (Array.isArray(p.lineOff)) lineOff = p.lineOff.map(String).slice(0, 500)
    if (p.custom && typeof p.custom === 'object') {
      const next = { click: [], idle: [], pet: [], game: [] }
      for (const cat of Object.keys(next)) next[cat] = normalizeCustom(p.custom[cat])
      customLines = next
    }
    saveConfig()
    pushLines()
    sendToWin('pet:pose', petPose)
    // 编辑器也要看到最新数据
    if (linesWin && !linesWin.isDestroyed()) {
      try { linesWin.webContents.send('pet:lines-state', { defaults: DEFAULT_LINES, lineOff, custom: customLines }) } catch { /* 忽略 */ }
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
})

let linesWin = null
function openLinesPanel() {
  if (linesWin && !linesWin.isDestroyed()) {
    try { linesWin.show(); linesWin.moveTop(); linesWin.focus() } catch { /* 忽略 */ }
    return
  }
  linesWin = new BrowserWindow({
    width: 460, height: 560,
    title: '台词管理',
    resizable: true,
    backgroundColor: '#141a2c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  linesWin.loadFile(path.join(__dirname, 'renderer', 'lines.html'))
  try { linesWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  linesWin.once('ready-to-show', () => {
    try { linesWin.show(); linesWin.moveTop(); linesWin.focus() } catch { /* 忽略 */ }
  })
  linesWin.on('closed', () => { linesWin = null })
}

// ==================== 取名 ====================
let renameWin = null

/** 把名字应用到窗口标题（任务栏上能看到）。 */
function applyPetName() {
  if (!win || win.isDestroyed()) return
  try { win.setTitle(petName ? petName : '虎鲸桌宠') } catch { /* 忽略 */ }
  // 页面也要知道名字，闲聊台词会以它为主语
  sendToWin('pet:set-name', petName)
}

function openRenamePanel() {
  if (renameWin && !renameWin.isDestroyed()) { renameWin.focus(); return }
  renameWin = new BrowserWindow({
    width: 300,
    height: 230,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#141a2c',
    title: '取个名字',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  renameWin.loadFile(path.join(__dirname, 'renderer', 'rename.html'))
  try { renameWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  renameWin.webContents.on('did-finish-load', () => {
    try { renameWin.webContents.send('pet:current-name', petName) } catch { /* 忽略 */ }
  })
  renameWin.once('ready-to-show', () => {
    try { renameWin.show(); renameWin.focus(); renameWin.moveTop() } catch { /* 忽略 */ }
  })
  renameWin.on('closed', () => { renameWin = null })
}

ipcMain.on('pet:set-name', (_e, v) => {
  petName = String(v || '').trim().slice(0, 12)
  applyPetName()
  saveConfig()
  if (petName) sendToWin('pet:say', { text: `好，以后叫我${petName}。`, ms: 5000 })
})

ipcMain.on('pet:close-rename', () => {
  if (renameWin && !renameWin.isDestroyed()) {
    try { renameWin.close() } catch { /* 忽略 */ }
  }
})

// ==================== 检查更新 ====================
// 仓库里放一份 version.json，桌宠启动时悄悄拉一下；比本地新就在菜单顶部提示。
// 拉不到就算了——网络问题不该打扰用户。
const UPDATE_URL = 'https://gitee.com/in-search-of-ink/dsh-3d-whale-pet/raw/master/version.json'
const UPDATE_PAGE = 'https://gitee.com/in-search-of-ink/dsh-3d-whale-pet'
const UPDATE_TGZ = 'https://gitee.com/in-search-of-ink/dsh-3d-whale-pet/raw/master/dsh-3d-whale-pet.tgz'
let updateInfo = null          // { version, page, url } 或 null
let lastCheckAt = 0            // 上次检查的时间（节流用）

/** 插件自身的版本号（读插件根目录的 package.json，不是 pet 的）。 */
function pluginVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return String(pkg.version || '')
  } catch (err) {
    // 优先级：环境变量 > 读插件根的 package.json
    if (process.env.WHALE_PLUGIN_VERSION) return process.env.WHALE_PLUGIN_VERSION
    console.log('[update] 读不到插件版本：' + (err && err.message ? err.message : String(err)))
    return process.env.WHALE_PLUGIN_VERSION || ''
  }
}

/** a 是否比 b 新（只比较 x.y.z）。 */
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

/**
 * 检查有没有新版。
 * @param {boolean} force 忽略节流立刻查（启动时和定时器用）
 */
async function checkUpdate(force = false) {
  if (quitting) return
  const now = Date.now()
  // 一分钟内查过就跳过：右键打开菜单也会触发它，不能每次都发请求
  if (!force && now - lastCheckAt < 60000) return
  lastCheckAt = now
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch(`${UPDATE_URL}?t=${Date.now()}`, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'whale-pet-update-check' },
    })
    clearTimeout(timer)
    if (!res.ok) return
    const info = await res.json()
    const local = pluginVersion()
    console.log('[update] 线上版本 ' + (info && info.version) + '，本地 ' + local)
    if (info && info.version && local && isNewer(info.version, local)) {
      updateInfo = {
        version: String(info.version),
        page: info.page || UPDATE_PAGE,
        url: info.url || '',          // 少了这个，点更新时取不到链接会直接 break
      }
      console.log('[update] 发现新版本', updateInfo.version, '（本地', local, '）')
      // 菜单正开着就推一份新状态过去，提示立刻出现
      if (menuWin && !menuWin.isDestroyed()) {
        try { menuWin.webContents.send('pet:menu-state', menuStateNow()) } catch { /* 忽略 */ }
      }
    }
  } catch (err) {
    // 网络不通 / 超时 / JSON 坏了：不打扰用户，但留一条日志方便排查
    console.log('[update] 检查失败：' + (err && err.message ? err.message : String(err)))
  }
}

function menuStateNow() {
  return {
    follow: FOLLOW.enabled,
    roam: ROAM.enabled,
    game: GAME.on,
    size: sizeScale,
    skin: currentSkin,
    dance: currentDance,
    name: petName,
    update: updateInfo,
  }
}

function closeMenuWindow() {
  if (!menuWin) return
  const w = menuWin
  menuWin = null
  menuOpen = false
  clickThrough = null
  try { if (!w.isDestroyed()) w.destroy() } catch { /* 已关 */ }
}

function openMenuWindow() {
  if (!win || win.isDestroyed()) return
  if (menuWin) { closeMenuWindow(); return }   // 再点一次 = 收起
  checkUpdate()          // 不 await：菜单先弹出来，查到新版再刷新
  const b = win.getBounds()
  // 菜单是内联展开的（子项缩进显示，不横向弹出），所以窗口可以很窄，
  // 这样才放得进虎鲸右边 —— 之前 430 宽总被判超界、只能翻到左边。
  // 窗口宽度直接决定「会不会压到鲸鱼」：模型在窗口里只占中间 180 左右，
  // 但窗口右边缘到屏幕边的余量很小，所以菜单越窄越容易落在模型右边。
  // 182 的面板 + 一点留白 = 200。
  const MW = 200
  const MH = 420          // 初始高度按「没展开子菜单」估，展开后由 pet:menu-resize 调
  // 注意单位：win.getBounds() 是 DIP，而 display.workArea 是**物理像素**。
  // 这台屏 scaleFactor=1.5，混着用会让「右边放不下就翻到左边」的判断失灵，
  // 菜单直接怼到屏幕外面去（之前原生菜单老是跑到最右边也是这个原因）。
  let wa
  try {
    // 同上：workArea 已经是 DIP，直接用
    const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
    wa = {
      x: disp.workArea.x,
      y: disp.workArea.y,
      width: disp.workArea.width,
      height: disp.workArea.height,
    }
  } catch {
    wa = { x: 0, y: 0, width: 1920, height: 1080 }
  }
  // 一律放右边。右边空间不够时不翻到左边（用户明确说左边不顺手），
  // 而是贴着屏幕右边缘 —— 宁可压住尾巴一点点。
  let mx = b.x + b.width + 10
  const maxX = wa.x + wa.width - MW - 8
  if (mx > maxX) mx = maxX
  mx = Math.max(wa.x + 8, mx)
  // 垂直居中到鲸鱼中心；记住这个中心，后面高度变化时围绕它伸缩
  const centerY = b.y + b.height / 2
  menuCenterY = centerY
  let my = Math.round(centerY - MH / 2)
  my = Math.max(wa.y, Math.min(my, wa.y + wa.height - MH))

  menuWin = new BrowserWindow({
    x: Math.round(mx), y: Math.round(my), width: MW, height: MH,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  menuOpen = true
  try { menuWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
  menuWin.webContents.on('did-finish-load', () => {
    try { menuWin.webContents.send('pet:menu-state', menuStateNow()) } catch { /* 忽略 */ }
  })
  menuWin.once('ready-to-show', () => {
    try {
      menuWin.show()
      // 创建时给的 x/y 在这个透明窗口上没生效（实测跑到屏幕右边去了），
      // 显示出来之后再钉一次位置。
      menuWin.setBounds({ x: Math.round(mx), y: Math.round(my), width: MW, height: MH })
      menuWin.focus()
      menuWin.moveTop()
    } catch { /* 忽略 */ }
  })
  menuWin.on('blur', () => closeMenuWindow())
  menuWin.on('closed', () => { menuWin = null; menuOpen = false; clickThrough = null })
}

ipcMain.on('pet:clear-local-data', async () => {
  const result = { ok: false }
  wiping = true
  try {
    // 1) 配置文件（几 KB，能直接删）
    const cfgPaths = new Set([CONFIG_PATH, path.join(app.getPath('userData'), 'whale-pet-config.json')].filter(Boolean))
    for (const p of cfgPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch (e) { console.error('[wipe] 删不掉 ' + p + ' : ' + (e && e.message)) }
    }

    // 2) 桌宠本体（180MB）：这 180MB 正被当前进程用着，自己删不动。
    //    交给一个独立的 node 进程，等 2 秒（本进程退出后）再删。
    //    注意：不能用 cmd + timeout/ping 延时——detached 里没有控制台，
    //    timeout 会直接失败，后面的命令就不执行了（实测 rmdir 根本没跑）。
    const rt = path.join(process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'),
                         'whale-pet-app', 'runtime')
    if (fs.existsSync(rt)) {
      try {
        const home = process.env.USERPROFILE || require('node:os').homedir()
        const nodeExe = path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
                                  'dependencies', 'node', 'bin', 'node.exe')
        const code = 'setTimeout(()=>{try{require("fs").rmSync(' + JSON.stringify(rt) + ',{recursive:true,force:true})}catch(e){}},2000)'
        const { spawn } = require('node:child_process')
        let child = null
        if (fs.existsSync(nodeExe)) {
          child = spawn(nodeExe, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true })
        } else {
          // 找不到 DSH 的 node 就退回系统 rmdir（可能因占用删不干净）
          child = spawn('cmd', ['/c', 'rmdir', '/s', '/q', rt], { detached: true, stdio: 'ignore', windowsHide: true })
        }
        child.unref()
      } catch (e) {
        console.error('[wipe] 启动删除进程失败: ' + (e && e.message))
      }
    }
    result.ok = true
  } catch (err) {
    console.error('[wipe] 失败: ' + (err && err.stack ? err.stack : String(err)))
    result.error = err && err.message ? err.message : String(err)
    wiping = false
  }
  sendToWin('pet:clear-local-data-result', result)
  if (result.ok) {
    setTimeout(() => { try { app.quit() } catch { /* 忽略 */ } }, 800)
  }
})

ipcMain.on('pet:menu-request', () => openMenuWindow())
ipcMain.on('pet:menu-resize', (_e, h) => {
  if (!menuWin || menuWin.isDestroyed()) return
  const n = Math.max(120, Math.min(900, Number(h) || 0))
  if (!n) return
  try {
    const bb = menuWin.getBounds()
    // 围绕鲸鱼中心伸缩，别让菜单越长越往下跑
    const y = Math.round(menuCenterY - n / 2)
    menuWin.setBounds({ x: bb.x, y, width: bb.width, height: n })
  } catch { /* 忽略 */ }
})
ipcMain.on('pet:menu-close', () => closeMenuWindow())


// 这些操作做完之后菜单继续保持打开，方便连着改好几项
const KEEP_MENU_OPEN = new Set(['follow', 'roam', 'size', 'skin', 'dance'])

ipcMain.on('pet:menu-action', (_e, a) => {
  if (!a || !a.id) return
  const keepOpen = KEEP_MENU_OPEN.has(a.id) && !(a.id === 'skin' && a.value === 'custom')
  if (!keepOpen) closeMenuWindow()
  switch (a.id) {
    case 'follow': setFollow(!FOLLOW.enabled); break
    case 'roam':
      ROAM.enabled = !ROAM.enabled
      roam.tx = null
      roam.pauseUntil = 0
      saveConfig()
      break
    case 'game':
      if (GAME.on) stopGame(); else startGame()
      break
    case 'size':
      setSize(Number(a.value))
      break
    case 'skin':
      if (a.value === 'custom') openColorPanel()
      else { currentSkin = String(a.value); sendToWin('pet:set-skin', currentSkin); saveConfig() }
      break
    case 'dance':
      currentDance = Number(a.value)
      sendToWin('pet:set-dance-freq', currentDance)
    pushLines()
      saveConfig()
      break
    case 'rename': openRenamePanel(); break
    case 'player': openPlayer(); break
    case 'balance': queryBalance(); break
    case 'help': openHelpPanel(); break
    case 'lines': openLinesPanel(); break
    case 'pose': openPosePanel(); break
    case 'update': {
      // 先把 DSH 窗口叫到前面（插件页就在里面）。直接开浏览器不行：
      // DSH 的 web 要令牌，令牌只存在桌面端进程里，浏览器打开只会 401。
      // 顺手把「直连 tgz」写进剪贴板：国内 npm 镜像常常滞后，
      // 用户在插件面板里搜包名可能装到旧版，直连链接一定能拿到新版
      try { clipboard.writeText(UPDATE_TGZ) } catch { /* 剪贴板不可用就算 */ }
      bringDshToFront().then((ok) => {
        if (ok) {
          sendToWin('pet:say', { text: '已复制直连链接，去「插件」页粘贴安装', ms: 5000 })
          return
        }
        // 切窗口失败：退而打开链接，并明确说一句，别让用户以为点了没反应
        try { shell.openExternal(UPDATE_PAGE) } catch { /* 打不开就算了 */ }
        sendToWin('pet:say', { text: '更新页面打不开，已复制链接', ms: 5000 })
        try { clipboard.writeText(UPDATE_PAGE) } catch { /* 剪贴板不可用 */ }
      })
      break
    }
    case 'minimize': try { if (win && !win.isDestroyed()) win.minimize() } catch { /* 忽略 */ } break
    case 'quit': app.quit(); break
  }
  // 菜单还开着：把最新状态推过去，勾选标记和副标题立刻更新
  if (keepOpen && menuWin && !menuWin.isDestroyed()) {
    try { menuWin.webContents.send('pet:menu-state', menuStateNow()) } catch { /* 忽略 */ }
  }
})

// ==================== 余额查询 ====================
// 走 DeepSeek 官方 /user/balance；key 自动从 ~/.dsh/.credentials.yaml 读取。
// 结果推给渲染进程，由虎鲸气泡播报。
let balanceBusy = false

async function queryBalance() {
  if (!win) return
  if (balanceBusy) return
  balanceBusy = true
  sendToWin('pet:balance', { kind: 'loading' })
  try {
    const b = await fetchBalance()
    const symbol = b.currency === 'USD' ? '$' : '¥'
    const total = b.total.toFixed(2)
    let text = `💰 余额 ${symbol}${total}`
    if (b.granted > 0) text += `（赠金 ${symbol}${b.granted.toFixed(2)}）`
    if (!b.available) text = `⚠️ 余额不足，API 已不可用：${symbol}${total}`
    else if (b.total < 1) text += '　⚡ 快没钱啦，记得充值'
    sendToWin('pet:balance', { kind: 'ok', text, data: b })
  } catch (err) {
    sendToWin('pet:balance', { kind: 'error', text: `余额查询失败：${err.message}` })
  } finally {
    balanceBusy = false
  }
}

ipcMain.on('pet:query-balance', () => { queryBalance() })

// ==================== 播放器窗口 ====================
let playerWin = null

function openPlayer() {
  if (playerWin && !playerWin.isDestroyed()) {
    if (!playerWin.isVisible()) playerWin.show()
    playerWin.focus()
    return
  }
  playerWin = new BrowserWindow({
    width: 320,
    height: 420,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#141a2c',
    title: '音乐播放器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 播放的是本机音频文件（file://），关掉同源限制才能让 <audio> 直接读路径
      webSecurity: false,
      // 关键：窗口最小化后 Chromium 会把定时器压到 1 次/秒。
      // 频谱是 50ms 发一次的，被压扁之后主窗口收到数据极少，
      // 表现出来就是「播放器开着时每拍都点，一最小化就变成两拍一点」。
      backgroundThrottling: false,
    },
  })
  playerWin.loadFile(path.join(__dirname, 'renderer', 'player.html'))
  // 桌宠是 screen-saver 层级，播放器用普通层级会被它压在下面——
  // 第一次点看着"没反应"，第二次因为走了上面的 focus() 才冒出来。
  try { playerWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  playerWin.once('ready-to-show', () => {
    try { playerWin.show(); playerWin.moveTop(); playerWin.focus() } catch { /* 忽略 */ }
  })
  playerWin.on('closed', () => { playerWin = null })
}

ipcMain.on('pet:open-player', () => openPlayer())

// 播放器选歌：走主进程的对话框，能拿到真实路径（renderer 里的 input[type=file] 拿不到）。
// 记住的也是路径，重启后能直接恢复列表。
// 抓系统声音（loopback）：主进程只负责把桌面源的 id 给渲染层，
// 真正的媒体流由渲染层用 getUserMedia 拿。这样别的软件放歌时也能跟着跳。
ipcMain.handle('pet:desktop-audio-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    if (!sources.length) return null
    return sources[0].id
  } catch { return null }
})

ipcMain.handle('pet:pick-audio', async () => {
  if (!win || win.isDestroyed()) return []
  try {
    const r = await dialog.showOpenDialog(playerWin && !playerWin.isDestroyed() ? playerWin : win, {
      title: '选择音频',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'] }],
    })
    return r.canceled ? [] : (r.filePaths || [])
  } catch { return [] }
})
ipcMain.on('pet:minimize-player', () => { if (playerWin && !playerWin.isDestroyed()) playerWin.hide() })
ipcMain.on('pet:close-panel', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender)
  if (w && w !== win) w.close()
})

// 播放器频谱/曲名 → 转发给主窗口（驱动虎鲸随节奏跳舞）
ipcMain.on('pet:audio-freq', (_event, data) => {
  sendToWin('pet:audio-freq', data)
})
ipcMain.on('pet:beat', (_event, gapMs) => {
  sendToWin('pet:beat', gapMs)
})
ipcMain.on('pet:music-comment', (_event, name) => {
  sendToWin('pet:music-comment', name)
})

// ==================== 自定义配色窗口 ====================
let colorWin = null
function openColorPanel() {
  if (colorWin && !colorWin.isDestroyed()) { colorWin.focus(); return; }
  colorWin = new BrowserWindow({
    width: 280,
    height: 260,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#141a2c',
    title: '自定义配色',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  colorWin.loadFile(path.join(__dirname, 'renderer', 'color.html'))
  try { colorWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  colorWin.once('ready-to-show', () => {
    try { colorWin.show(); colorWin.moveTop(); colorWin.focus() } catch { /* 忽略 */ }
  })
  colorWin.on('closed', () => { colorWin = null })
}
ipcMain.on('pet:set-custom-skin', (_event, data) => {
  if (data && data.dark !== undefined) sendToWin('pet:set-custom-skin', data)
})

// ==================== 帮助窗口 ====================
let helpWin = null
function openHelpPanel() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.focus(); return; }
  helpWin = new BrowserWindow({
    width: 360,
    height: 500,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#141a2c',
    title: '帮助',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  helpWin.loadFile(path.join(__dirname, 'renderer', 'help.html'))
  // 桌宠自己是 screen-saver 层级，帮助窗口要是普通层级就会被它压在下面，
  // 看起来就是「点了没反应」——其实窗口开了，只是被挡着。
  try { helpWin.setAlwaysOnTop(true, 'screen-saver') } catch { /* 忽略 */ }
  helpWin.once('ready-to-show', () => {
    try { helpWin.show(); helpWin.moveTop(); helpWin.focus() } catch { /* 忽略 */ }
  })
  helpWin.on('closed', () => { helpWin = null })
}

// ==================== gateway 客户端 ====================
// 协议细节全部封装在 gateway.js（鉴权 Cookie / RPC 路径 / WS mux），此处只关心业务。

let sessionId = null
let connected = false
let lastEventAt = 0
let mood = 'idle'
let idleTimer = null
const moodListeners = []
/** 最近一次解析 DSH 地址时试过的候选，连不上时点名用。 */
let lastTriedUrls = []

let gateway = null

// ---- 深度求索（思考）状态 ----
// DSH 的回合里，正文出来之前这段时间就是模型在想：从 turn/start 到第一段 text-delta。
// 桌宠头上会冒省略号；结果出来时闪一下灯泡。
let thinking = false
let thinkingTimer = null
let thinkPollTimer = null, thinkBaseline = 0, thinkSession = null

// DSH 对外的 $events 流只有「会话开始跑 / 跑完」两种通知，没有逐条消息。
// 想让灯泡正好落在「开始输出结果」那一刻，就只能自己盯：轮询 session.list，
// 一旦这轮会话的 updatedAt 往前走了，说明已经有新的产出，思考阶段结束。

async function startThinkWatch() {
  try {
    const { items } = await call('session.list', {})
    const live = (items || []).filter((it) => it && !it.blank)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    if (!live.length) return
    thinkSession = live[0].sessionId
    thinkBaseline = live[0].updatedAt || 0
  } catch { return }
  clearInterval(thinkPollTimer)
  thinkPollTimer = setInterval(async () => {
    try {
      const { items } = await call('session.list', {})
      const it = (items || []).find((x) => x && x.sessionId === thinkSession)
      if (!it) return
      // 只用「这一轮真正结束了」的信号。之前拿 token 总数当依据，
      // 但其中大头是 cacheRead，请求一发出就先涨，等于刚开始想就判成结束。
      if ((it.updatedAt || 0) > thinkBaseline || it.running === false) setThinking(false)
    } catch { /* 网络抖动，下一轮再看 */ }
  }, 300)
}

// 如果桌宠是在「思考途中」才启动的，它就错过了那次 status=true。
// 连上后看一眼最近有没有活动：刚刚还在动，就当作正在思考，接着盯。
async function resumeThinkingIfActive() {
  try {
    const { items } = await call('session.list', {})
    const live = (items || []).filter((it) => it && !it.blank)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    if (!live.length) return
    const it = live[0]
    // session.list 的条目里带 running：这才是「这个会话正在跑」的权威标志，
    // 比拿 updatedAt 猜时间窗靠谱（深度思考期间根本没有新消息落库）
    if (it.running === true) setThinking(true)
  } catch { /* 还没连好，下次再说 */ }
}

function setThinking(on) {
  if (thinking === on) return
  thinking = on
  sendToWin('pet:thinking', on)
  clearTimeout(thinkingTimer)
  if (on) {
    // 兜底：万一收不到结束事件，最多转 5 分钟就收
    thinkingTimer = setTimeout(() => setThinking(false), 5 * 60 * 1000)
    startThinkWatch()
  } else {
    clearInterval(thinkPollTimer)
    thinkPollTimer = null
  }
}

function pushMood(next) {
  if (mood === next) return
  mood = next
  lastEventAt = Date.now()
  sendToWin('pet:mood', next)
  for (const cb of moodListeners) cb(next)
}

// idle 回退：状态活跃后 40 秒无新事件 → 回归 idle
function resetIdleTimer() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (mood !== 'idle') pushMood('idle') }, 40_000)
}

function call(method, payload) {
  if (!gateway) throw new Error('gateway 尚未初始化')
  return gateway.call(method, payload)
}

// 选「当前」会话：harness 没有"当前窗口"的 host 端信号，就用"最近有人发消息的会话"近似，
// 也就是用户正在聊的那个窗口。每次派活都重新选，跟随用户切换窗口。
async function pickCurrentSession() {
  try {
    const { items } = await call('session.list', {})
    const live = items && items.filter((it) => !it.blank)
    if (live && live.length > 0) {
      live.sort((a, b) => b.updatedAt - a.updatedAt)
      return live[0].sessionId
    }
    // 没有任何非空白会话：新建一个（对应"刚打开一个全新窗口"的情况）
    const { sessionId } = await call('session.create', { cwd: process.env.USERPROFILE || process.env.HOME || '.' })
    return sessionId
  } catch (err) {
    console.error('pickCurrentSession 失败:', err.message)
    return null
  }
}

function sendMood(next) {
  pushMood(next)
  resetIdleTimer()
}

// 状态机：事件流帧 → 情绪 + 派活会话的流式回复转发（P3）
// 新版 $events 流推送的是事件对象本身（可能与旧版 session/event 包装不同），
// 这里做兼容解析：既接受 {type:'session/event', payload:{...}}，也接受裸事件。
function handleFrame(raw) {
  if (!raw || typeof raw !== 'object') return
  // 控制帧
  if (raw.type === 'ready') return

  // DSH 新版推的是 { type:'emit', event:'api-session/xxx', args:[...] }
  // 之前按 payload.events 解析，永远取不到东西，所以思考提示一直没反应。
  if (raw.type === 'emit' && typeof raw.event === 'string') {
    const args = Array.isArray(raw.args) ? raw.args : []
    if (raw.event === 'api-session/status') {
      // args = [sessionId, running]
      setThinking(!!args[1])
    } else if (raw.event === 'api-session/activity') {
      // 有人在用这个会话：算在跑
      setThinking(true)
    }
    return
  }
  let frame = raw
  // 兼容旧版包装：{ type:'server-request', method, payload }
  if (raw.type === 'server-request') {
    frame = { method: raw.method, payload: raw.payload }
  } else if (raw.sessionId !== undefined || raw.event !== undefined) {
    frame = { method: 'session/event', payload: raw }
  } else if (raw.method === undefined) {
    return
  }
  switch (frame.method) {
    case 'session/event':
    case 'session/event-batch': {
      const payload = frame.payload || {}
      const events = payload.events || (payload.event ? [payload.event] : [])
      const evSessionId = payload.sessionId
      for (const event of events) {
        if (!event || !event.type) continue
        const watching = !!sessionId && evSessionId === sessionId
        handleSessionEvent(event, watching)
      }
      break
    }
    case 'approval/requested':
    case 'question/requested':
      sendMood('needs-input')
      break
    case 'stream/error':
      sendMood('blocked')
      break
  }
}

function handleSessionEvent(event, watching) {
  let _ch = null
  try { _ch = event && event.data && event.data.chunk } catch { /* 忽略 */ }
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data && event.data.chunk
      if (chunk) {
        // 正文开始 = 想完了；reasoning 片段 = 还在想
        if (chunk.type === 'text-delta') setThinking(false)
        else if (String(chunk.type || '').indexOf('reasoning') >= 0) setThinking(true)
      }
      if (watching && chunk && chunk.type === 'text-delta' && chunk.text) {
        sendToWin('pet:stream', {
          kind: 'chunk',
          text: chunk.text,
          turn: event.data && event.data.turn,
          step: event.data && event.data.step,
        })
      }
      sendMood('working')
      break
    }
    case 'assistant/message': {
      setThinking(false)
      if (watching) {
        const text = ((event.data && event.data.content) || [])
          .filter((b) => b && b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n')
        if (text) sendToWin('pet:stream', { kind: 'message', text })
      }
      sendMood('ready')
      break
    }
    case 'turn/end': {
      setThinking(false)
      if (watching) sendToWin('pet:stream', { kind: 'done' })
      sendMood('ready')
      break
    }
    case 'turn/start':
    case 'step/start':
      setThinking(true)
      sendMood('working')
      break
    case 'tool/call':
      // 调工具说明这一轮在想的事告一段落，先收掉省略号，等下一段再说
      setThinking(false)
      sendMood('working')
      break
    default:
      break
  }
}

function connectGateway() {
  if (quitting) return
  gateway = new Gateway(
    // 每次连接前重新解析一次：DSH 重启换端口后不需要用户干预
    () => {
      lastTriedUrls = []
      return resolveGatewayUrl((url) => { lastTriedUrls.push(url) })
    },
    {
      onStatus: (isConnected, url, info) => {
        if (isConnected) resumeThinkingIfActive()
        connected = isConnected
        if (!isConnected) setThinking(false)
        // 窗口可能已销毁（用户在退出时网关恰好断开），sendToWin 会安全跳过
        sendToWin('pet:connection', {
          connected: isConnected,
          url,
          reason: info && info.reason,
          tried: info && info.tried,
          hint: info && info.hint,
        })
        if (isConnected && !sessionId && !quitting) {
          pickCurrentSession().then((sid) => { sessionId = sid }).catch(() => {})
        }
      },
      onEvent: (value) => {
        if (quitting) return
        handleFrame(value)
      },
      onLog: (message, extra) => {
        sendToWin('pet:log', { where: 'gateway', message, extra })
      },
    },
  )
  gateway.connect()
}

// ---- 派活：renderer 请求 prompt，流式 chunk 转发，结束汇总 ----
ipcMain.on('pet:prompt', async (event, text) => {
  if (!connected) {
    // DSH 桌面版端口随机，用户根本不知道自己该填什么；这里把事实直接讲清楚。
    const tried = (gateway && gateway.baseUrl) ? [gateway.baseUrl] : lastTriedUrls
    const where = tried && tried.length > 0 ? `（试过 ${tried.join(' / ')}）` : ''
    event.reply('pet:reply', {
      error: `未连接到 harness${where}。请从 DSH 侧边栏「启动」桌宠（插件会把真实地址传进来），`
        + '或手动设置 WHALE_PET_URL 指向 DSH 当前地址（侧边栏面板里会显示）',
    })
    return
  }
  try {
    // 每次派活都重新选「当前窗口」的会话，跟随用户在 harness 里切换窗口
    sessionId = await pickCurrentSession()
    if (!sessionId) throw new Error('找不到可用的会话')
    await call('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  } catch (err) {
    event.reply('pet:reply', { error: `派活失败: ${err.message}` })
  }
})

// 流式回复由 handleFrame 观察 mux 流、按会话过滤后转发 pet:stream；renderer 消费。

app.whenReady().then(() => {
  startHoldUntil = Date.now() + 1000   // 启动先站一秒（和朝向锁同步）
  setTimeout(() => checkUpdate(true), 6000)             // 启动后查一次
  setInterval(() => checkUpdate(true), 10 * 60 * 1000)  // 一直开着也每十分钟看一眼
  loadConfig()
  createWindow()
  applyPetName()
  win.webContents.on('did-finish-load', () => {
    applyPetName()   // 页面加载完会用自己的 <title> 覆盖窗口标题，这里再压一次
    connectGateway()
    // 把上次的皮肤和跳舞强度推给渲染层
    sendToWin('pet:set-skin', currentSkin)
    sendToWin('pet:set-dance-freq', currentDance)
  })
  startFollowLoop()
})

// ---- 退出清理 ----
// 关键顺序：先立 quitting 标记 → 再关网关 → 最后退出。
// 否则 WebSocket 的 close 回调会在窗口销毁之后才跑，触发
// "Object has been destroyed"（main process 未捕获异常弹框）。
function shutdown() {
  if (quitting) return
  quitting = true
  stopFollowLoop()
  try { if (gateway) gateway.close() } catch { /* 已关闭 */ }
}

// 用户关掉主窗口（例如右键→退出、或系统关闭）时走这里
app.on('before-quit', shutdown)

// 主窗口关闭：标记退出中，避免后续任何 send
app.on('window-all-closed', () => {
  shutdown()
  app.quit()
})

// 兜底：任何漏网的异常都不该弹「JavaScript error occurred」框打扰用户
process.on('uncaughtException', (err) => {
  // 窗口销毁竞态导致的发送失败属于预期内噪声，静默忽略
  if (err && /Object has been destroyed/i.test(String(err.message))) return
  console.error('[whale-pet] uncaughtException:', err)
})
