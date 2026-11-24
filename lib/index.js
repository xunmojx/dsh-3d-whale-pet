// 虎鲸桌宠 · DSH 插件 Host 半边
// 职责：管理 whale-pet Electron 桌宠进程（启动 / 停止 / 状态），并转发 DeepSeek 余额查询。
//
// 通道：在 DSH 自己的 web 服务器上注册一条私有 HTTP 路由 /whale-pet/rpc，
//       客户端半边用 fetch 调用。这条路由复用 DSH 的信任围栏 + 浏览器鉴权，
//       所以只有本机已登录的页面能访问。
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件自身目录。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** 路由前缀。带 3d- 前缀，避免与其他宠物插件抢同一个路径。 */
const ROUTE = '/dsh-3d-whale-pet/rpc'

/** DSH 数据目录（与桌宠侧 dshHome() 同一套推导规则）。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * 桌宠进程的 electron stderr 落盘位置。
 * 桌宠是 GUI 进程，没有控制台；它若在启动阶段崩掉，唯一的线索就是这里。
 */
const ELECTRON_LOG = join(tmpdir(), 'whale-pet-electron.log')

/** stderr 落盘上限：避免桌宠跑一整天把日志写成几百 MB。 */
const ELECTRON_LOG_LIMIT = 256 * 1024

/**
 * DSH 地址发现文件（相对 DSH_HOME 的路径）。
 *
 * 桌面版 DSH 每次启动的监听端口都是随机的（由 OS 分配），桌宠没法猜。
 * 所以 Host 半边把「当前 DSH 的 origin」写到这里，手动启动的桌宠
 * （npm start，没经过本插件 spawn）就能读到同一个地址。
 * 放 DSH_HOME 下是因为 Host 与桌宠都从 DSH_HOME 推导路径，基准天然一致。
 */
const DISCOVERY_RELATIVE = join('cache', 'whale-pet-dsh-url.json')

/** 旧版本写的位置，仍然同步写一份，兼容更早的桌宠副本。 */
const LEGACY_DISCOVERY_FILE = join(tmpdir(), 'whale-pet-dsh-url.json')

/** webServer 服务引用：由 apply() 的 inject 回调填入，用来取当前监听地址。 */
let webServerService

/** 桌宠进程状态。starting 是「正在启动」的 Promise，用来串行化并发的 start 请求。 */
const state = { child: null, startedAt: 0, lastError: undefined, installing: false, starting: undefined }

/** 已写进日志文件的字节数（每次启动重置），避免每个 chunk 都 statSync 一次。 */
let logBytes = 0

/** 上一次写进发现文件的地址，相同就不重复写（面板每 3s 轮询一次 status）。 */
let lastPublishedUrl

/** 是否在运行。 */
function isRunning() {
  return state.child !== null && state.child.exitCode === null && !state.child.killed
}

/**
 * 当前 DSH web 服务器的 origin（形如 http://127.0.0.1:52062）。
 *
 * 桌面版端口随机，所以绝不能写死；webServer 服务暴露了 getOrigin()/port/host，
 * 但 getOrigin() 在 listen 完成前会抛错，这里降级成「用 port + 配置里的 host/协议」。
 * @returns {string|undefined}
 */
function currentDshOrigin() {
  const webServer = webServerService
  if (!webServer) return undefined
  try {
    if (typeof webServer.getOrigin === 'function') return webServer.getOrigin()
  } catch {
    // 还没 listen：继续尝试 port 字段
  }
  const port = webServer.port
  if (!port) return undefined
  const protocol = typeof webServer.protocol === 'string' ? webServer.protocol : 'http:'
  // host 可能是 IPv6 字面量，URL 里必须带方括号
  const rawHost = typeof webServer.host === 'string' && webServer.host !== '' ? webServer.host : '127.0.0.1'
  const host = rawHost.includes(':') ? `[${rawHost}]` : rawHost
  return `${protocol}//${host}:${port}`
}

/**
 * 把当前 DSH 地址写进发现文件（尽力而为，失败只影响「手动启动桌宠」场景）。
 *
 * 相同地址不重复写：面板每 3s 轮询一次 status，每次都落盘纯属浪费。
 * 地址一变（DSH 重启换了随机端口）立刻重写，桌宠重连时就能读到新地址。
 * @returns {string|undefined} 当前地址；取不到监听地址时 undefined
 */
function publishDiscovery() {
  const url = currentDshOrigin()
  if (!url) return undefined
  if (url === lastPublishedUrl) return url
  const payload = JSON.stringify(
    { url, updatedAt: new Date().toISOString(), pid: process.pid },
    null,
    2,
  ) + '\n'
  const targets = [join(DSH_HOME, DISCOVERY_RELATIVE), LEGACY_DISCOVERY_FILE]
  let written = false
  for (const file of targets) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, payload, 'utf8')
      written = true
    } catch {
      // 某个位置不可写不影响另一个；两个都失败时仍可靠 spawn 时传的 WHALE_PET_URL
    }
  }
  // 只有真写成功才记住，否则下次还得再试
  if (written) lastPublishedUrl = url
  return url
}

/**
 * 追加 electron 的 stderr 到日志文件，超过 {@link ELECTRON_LOG_LIMIT} 后停止追加
 * （保留启动阶段那一段最有诊断价值的内容，不至于无限增长）。
 * @param {string} text - 本次读到的 stderr 片段
 * @param {number} [bytes] - 该片段的字节数；省略时按 UTF-8 现算
 * @returns {void}
 */
function appendElectronLog(text, bytes) {
  if (logBytes >= ELECTRON_LOG_LIMIT) return
  try {
    appendFileSync(ELECTRON_LOG, text, 'utf8')
  } catch {
    // 日志写不了不该影响桌宠进程本身
    return
  }
  logBytes += bytes ?? Buffer.byteLength(text)
}

/**
 * 候选桌宠目录，按优先级排列：
 *   1. WHALE_PET_DIR 环境变量（用户显式指定）
 *   2. 随插件分发的 pet/
 *   3. 仓库根目录（开发时插件就在仓库里，源码那份依赖通常已装好）
 * 只收录真正存在 main.js 的目录。
 * @returns {string[]} 去重后的候选绝对路径
 */
function petDirCandidates() {
  const list = []
  if (process.env.WHALE_PET_DIR) list.push(process.env.WHALE_PET_DIR)
  list.push(join(PLUGIN_DIR, '..', 'pet'))
  list.push(join(PLUGIN_DIR, '..', '..'))
  const seen = new Set()
  return list.filter((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return existsSync(join(p, 'main.js'))
  })
}

/**
 * 定位 electron 可执行文件。
 * 桌宠要跑起来必须能找到 electron，所以解析目录时以「哪里装好了依赖」为准，
 * 而不是单纯看 main.js 在不在。
 */
function resolveElectron(petDir) {
  if (!petDir) return undefined
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const candidates = [
    // 首选：运行时目录（插件目录里不再放 node_modules，卸载才能干净）
    join(runtimeDir(), 'node_modules', 'electron', 'dist', exe),
    join(runtimeDir(), 'node_modules', 'electron', exe),
    // 兼容旧布局
    join(petDir, 'node_modules', 'electron', 'dist', exe),
    join(petDir, 'node_modules', 'electron', exe),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

/**
 * 选出真正可用的桌宠目录：优先能跑起来的（依赖齐全）。
 * 全都没依赖时退回第一个候选，好把「请先 npm install」的原话报给用户。
 * @returns {{ dir: string|undefined, electron: string|undefined, candidates: string[] }}
 */
function resolvePet() {
  const candidates = petDirCandidates()
  for (const dir of candidates) {
    const electron = resolveElectron(dir)
    if (electron) return { dir, electron, candidates }
  }
  return { dir: candidates[0], electron: undefined, candidates }
}

/**
 * 识别「启动后秒退」的常见原因，把可操作的排查建议拼进错误信息。
 *
 * 已知的一条真实案例（issue #2）：桌宠放在非系统盘 / 虚拟卷（例如 `P:\`）上时，
 * Electron 在启动阶段就崩（0xC0000005 / 0x80000003），连 `electron.exe --version`
 * 都跑不起来，stderr 一个字都没有。插件侧只能识别并提示，改不了 Chromium 沙箱。
 * @param {{ code?: number|null, signal?: string|null }|undefined} exit - 子进程退出信息
 * @param {string} petDir - 桌宠目录（提示里点名）
 * @returns {string}
 */
function quickExitHint(exit, petDir) {
  const code = typeof exit?.code === 'number' ? exit.code >>> 0 : undefined
  // 0xC0000005（访问冲突）、0x80000003（断点）：Electron/Chromium 在启动阶段直接崩
  const crashed = code !== undefined && (code === 0xc0000005 || code === 0x80000003)
  const drive = /^[A-Za-z]:/u.exec(petDir)?.[0].toUpperCase()
  const systemDrive = String(process.env.SystemDrive || 'C:').toUpperCase()
  const otherDrive = drive !== undefined && drive !== systemDrive
  if (crashed) {
    const where = otherDrive
      ? `你的桌宠目录在 ${drive}（非系统盘）：放在网络盘、虚拟盘或某些挂载卷上时，`
      : '最常见的原因是桌宠目录不在本地磁盘——放在网络盘、虚拟盘或某些挂载卷（例如 P:\\）上时，'
    return '退出码看起来是 Electron 启动阶段直接崩溃（0xC0000005 / 0x80000003）。'
      + `${where}任何 Electron 二进制都会一启动就崩，与本插件无关。`
      + '请把桌宠目录移到本地磁盘（例如 C:\\Users\\<你>\\AppData\\Local\\whale-pet）后重试。'
  }
  return `桌宠启动后立即退出。请确认 ${petDir} 下依赖完整（在该目录执行 npm install），`
    + '并检查安全软件是否拦截了 electron.exe。'
    + (otherDrive ? `另外注意：桌宠目录在 ${drive}（非系统盘），若它在网络盘或虚拟盘上，Electron 会一启动就崩。` : '')
}

/** 启动桌宠。 */
async function startPet() {
  if (isRunning()) return { ok: true, already: true }
  // 串行化：连点两下「启动」会同时进来两次，两次 spawn 就双开了（还互相抢 state.child）。
  if (state.starting !== undefined) return state.starting
  state.starting = doStartPet()
  try {
    return await state.starting
  } finally {
    state.starting = undefined
  }
}

/**
 * startPet 的实际主体（已由 startPet 串行化）。
 * @returns {Promise<object>} 与 RPC 的 start 返回同形
 */
async function doStartPet() {
  // 运行时依赖已经有了（在 %APPDATA%\whale-pet-app\runtime），
  // 但插件目录里可能还没有 junction —— 自动接上，省得用户再点一次「安装依赖」。
  for (const dir of petDirCandidates()) {
    if (dir && existsSync(join(dir, 'main.js')) && !existsSync(join(dir, 'node_modules'))) {
      linkNodeModules(dir)
    }
  }
  const { dir: petDir, electron, candidates } = resolvePet()
  if (!petDir) {
    state.lastError = '找不到桌宠目录，请设置环境变量 WHALE_PET_DIR 指向 whale-pet 项目目录'
    return { ok: false, error: state.lastError }
  }
  if (!electron) {
    // 把所有候选都告诉用户，方便他挑一个装依赖 / 或设 WHALE_PET_DIR
    const tried = candidates.length > 0 ? candidates.join(' 、 ') : petDir
    state.lastError =
      `桌宠依赖未安装（缺 electron）。可在界面点「安装依赖」自动处理，` +
      `或手动在下面任一目录执行 npm install：${tried}`
    return { ok: false, error: state.lastError, needsInstall: true, petDir }
  }
  try {
    // 关键：剥掉会干扰 electron 的两个继承变量。
    //  - ELECTRON_RUN_AS_NODE：DSH 用 Electron 的 Node 模式跑 profile 宿主，这个变量
    //    一定在；electron.exe 见到它会退化成纯 Node，main.js 拿不到 ipcMain 而秒退。
    //  - NODE_OPTIONS：会被 Electron 主进程吃（--require/--inspect 会直接搞坏启动）。
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    // 把当前 DSH 的真实监听地址交给桌宠：桌面版端口每次启动都变，
    // 桌宠自己猜不到，由 Host 直接传是最可靠的方式。
    const origin = publishDiscovery()
    if (origin) env.WHALE_PET_URL = origin
    env.WHALE_PET_RUNTIME = runtimeDir()   // 依赖（ws）在运行时目录里，桌宠据此解析
    // stderr 落盘：桌宠没有控制台，启动阶段崩掉的线索全在这里。
    let stderrTail = ''
    logBytes = 0
    try { writeFileSync(ELECTRON_LOG, '', 'utf8') } catch { /* 临时目录不可写 */ }
    const child = spawn(electron, [petDir], {
      cwd: petDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env,
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderrTail = (stderrTail + text).slice(-4000)
      appendElectronLog(text, Buffer.byteLength(text))
    })
    let exitInfo
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      // 只在「还是当前这个 child」时清空：快速启停时旧 child 的 exit
      // 会在新 child 已经就位之后才到，无脑置空会让新进程失去追踪（孤儿）。
      if (state.child === child) state.child = null
    })
    child.on('error', (err) => {
      state.lastError = err?.message ?? String(err)
      if (state.child === child) state.child = null
    })
    state.child = child
    state.startedAt = Date.now()
    state.lastError = undefined
    // 等一小会儿确认进程没秒退，把真实原因带回给界面。
    await new Promise((r) => setTimeout(r, 1200))
    if (!isRunning()) {
      // 'exit' 可能先于最后的 stderr 数据到达：稍等 'close' 把尾巴收完再拼错误信息。
      if (exitInfo === undefined) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 600)
          child.once('close', () => { clearTimeout(timer); resolve() })
        })
      }
      const details = [
        state.lastError,
        stderrTail.trim().slice(-800),
        quickExitHint(exitInfo, petDir),
        `electron 完整输出：${ELECTRON_LOG}`,
      ].filter(Boolean)
      return { ok: false, error: details.join('\n') }
    }
    return { ok: true }
  } catch (err) {
    state.lastError = err?.message ?? String(err)
    return { ok: false, error: state.lastError }
  }
}

/**
 * 停止桌宠。
 *
 * 若正好有一次「启动」在飞（startPet 还在等首 1.2s 确认），先等它落定再杀：
 * 否则刚拉起来的 child 会被 startPet 的「秒退」判定误报成启动失败。
 * @returns {Promise<{ ok: boolean, already?: boolean }>}
 */
async function stopPet() {
  if (state.starting !== undefined) {
    try { await state.starting } catch { /* 启动失败也要继续收尾 */ }
  }
  if (!isRunning()) { state.child = null; return { ok: true, already: true } }
  const child = state.child
  try { child.kill() } catch { /* 已退出 */ }
  // 关键：kill() 只发信号，electron 还要一两秒才真的退出。
  // 以前立刻返回，卸载流程紧跟着删文件，exe 还占着 → 第一次必失败、得点第二次。
  // 现在等它真的没了（最多 5 秒）再返回。
  const deadline = Date.now() + 5000
  while (isRunning() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  state.child = null
  return { ok: true }
}

/**
 * electron 的二进制在 GitHub 上。国内网络经常打不开，所以默认走 npmmirror 镜像；
 * 想换回官方源，设环境变量 ELECTRON_MIRROR 即可。
 */
const ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/'

/** DSH 运行时自带的 node / pnpm（本机不一定装了 npm）。 */
function runtimeTools() {
  const deps = join(
    process.env.DSH_HOME || join(homedir(), '.dsh'),
    'dsh-runtimes', 'dsh-primary-runtime', 'dependencies',
  )
  const win = process.platform === 'win32'
  return {
    node: join(deps, 'node', 'bin', win ? 'node.exe' : 'node'),
    pnpm: join(deps, 'pnpm', 'bin', 'pnpm.mjs'),
  }
}

/**
 * 桌宠运行时（electron 那 172MB）不在插件目录里，而是放在这里。
 *
 * 原因：electron 的 default_app.asar 在桌宠跑过之后会被句柄占住，
 * pnpm 删不掉它 → 卸载插件时界面一直转圈。把依赖挪出插件目录、
 * pet/node_modules 改成指向它的 junction，卸载时只需要删一个链接。
 * 顺带的好处：重装插件不用再下 172MB。
 */
function configBase() {
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'whale-pet-app')
}

/** 用户自定义的运行时目录（存在 location.json 里，纯文本，可随时改回默认）。 */
function customRuntimeDir() {
  if (process.env.WHALE_PET_RUNTIME) return process.env.WHALE_PET_RUNTIME
  try {
    const cfg = JSON.parse(readFileSync(join(configBase(), 'location.json'), 'utf8'))
    if (cfg && typeof cfg.runtimeDir === 'string' && cfg.runtimeDir.trim()) return cfg.runtimeDir.trim()
  } catch { /* 没配过 */ }
  return ''
}

function runtimeDir() {
  const custom = customRuntimeDir()
  if (custom) return custom
  return join(configBase(), 'runtime')
}

/** 记下自定义目录；传空字符串表示恢复默认。 */
function saveRuntimeDir(dir) {
  const p = join(configBase(), 'location.json')
  mkdirSync(configBase(), { recursive: true })
  writeFileSync(p, JSON.stringify({ runtimeDir: dir || '' }, null, 2))
}

/**
 * 把已有的运行时搬到新目录（同盘 rename，跨盘复制后删除），再把 junction 重新指过去。
 * 传空字符串 = 恢复默认位置。正在运行时拒绝执行（文件被占住）。
 */
/**
 * 搬完目录后修复 pnpm 留下的绝对路径链接。
 * pnpm 的 node_modules 顶层条目全是指向 `<root>/node_modules/.pnpm/...` 的 junction，
 * .bin 里的启动脚本也写着绝对路径；目录一改名这些就全断了（表面搬成功、实际找不到 electron）。
 * 这里把旧根路径统一替换成新根路径，不需要重新下载任何东西。
 */
function repairLinksAfterMove(oldRoot, newRoot) {
  const normOld = oldRoot.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const normNew = newRoot.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const nm = join(newRoot, 'node_modules')
  if (!existsSync(nm)) return
  // 1) 顶层 junction 重指向
  for (const name of readdirSyncSafe(nm)) {
    const p = join(nm, name)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (!st.isSymbolicLink()) continue
    let target = ''
    try { target = readlinkSync(p) } catch { continue }
    const t = target.replace(/[\\/]+/g, '/')
    const i = t.toLowerCase().indexOf(normOld.toLowerCase())
    if (i < 0) continue
    const fixed = normNew + t.slice(i + normOld.length)
    try {
      unlinkSync(p)
      symlinkSync(fixed, p, 'junction')
    } catch { /* 单个失败不影响其它 */ }
  }
  // 2) .bin 里的绝对路径
  const bin = join(nm, '.bin')
  for (const name of readdirSyncSafe(bin)) {
    const p = join(bin, name)
    try {
      const buf = readFileSync(p)
      const text = buf.toString('utf8')
      if (!text.toLowerCase().includes(normOld.toLowerCase())) continue
      const re = new RegExp(normOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      writeFileSync(p, text.replace(re, normNew))
    } catch { /* 二进制或读不了就跳过 */ }
  }
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

async function setRuntimePath(petDir, nextDir) {
  if (isRunning()) return { ok: false, error: '请先关闭桌宠再改安装位置' }
  const from = runtimeDir()
  const to = nextDir && String(nextDir).trim() ? String(nextDir).trim() : join(configBase(), 'runtime')
  const norm = (v) => v.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const nf = norm(from), nt = norm(to)
  if (nf === nt) return { ok: true, unchanged: true, runtimeDir: to }
  if (nt.startsWith(nf + '/') || nf.startsWith(nt + '/')) {
    return { ok: false, error: '新位置不能是当前位置的子目录（也不能反过来），换个不相干的空目录' }
  }
  if (existsSync(join(to, 'node_modules', 'electron', 'package.json'))) {
    return { ok: false, error: `目标目录里已经有依赖了，换个空目录：${to}` }
  }
  const prev = customRuntimeDir()
  try {
    // 把现有运行时搬到新位置。
    // 同盘：直接改名（瞬间完成）——绝不能用 cpSync 复制，pnpm 的 junction 复制时
    //       需要创建符号链接，普通权限会 EPERM，用户看到的就是「搬移失败」。
    // 跨盘：改名不可行，退化为「在新位置重新装依赖」（走本地缓存，不重下整包）。
    if (existsSync(join(from, 'node_modules'))) {
      const parent = dirname(to)
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
      if (existsSync(to)) return { ok: false, error: `目标目录已存在，换个空目录：${to}` }

      const sameVolume = (process.platform === 'win32')
        ? (from.slice(0, 2).toLowerCase() === to.slice(0, 2).toLowerCase())
        : dirname(from).split('/')[1] === dirname(to).split('/')[1]
      if (sameVolume) {
        renameSync(from, to)                 // 同盘：改名，不复制、不重下
        repairLinksAfterMove(from, to)       // 再把里面的绝对路径链接改成新路径
      } else {
        // 跨盘：没有快捷方式可走，只能在新位置重新链接依赖（pnpm 会复用本地 store 的文件）
        saveRuntimeDir(to === join(configBase(), 'runtime') ? '' : to)
        const installRes = await installDeps()
        if (!installRes || installRes.ok === false) {
          saveRuntimeDir(prev)
          return { ok: false, error: `新位置装依赖失败：${(installRes && installRes.error) || '未知原因'}。已退回原位置。` }
        }
        try { rmSync(from, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
    } else {
      mkdirSync(to, { recursive: true })
    }
    saveRuntimeDir(to === join(configBase(), 'runtime') ? '' : to)
    const link = join(petDir, 'node_modules')
    try { unlinkSync(link) } catch { try { rmSync(link, { recursive: false, force: true }) } catch { /* 忽略 */ } }
    const linkRes = linkNodeModules(petDir)
    if (!linkRes.ok) { saveRuntimeDir(prev); return { ok: false, error: `链接失败：${linkRes.reason}` } }

    // 验证：新位置真的能拿到 electron
    const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
    if (!existsSync(join(link, 'electron', 'dist', exeName)) && !existsSync(join(link, 'electron', exeName))) {
      return {
        ok: false,
        error: '搬过去了，但新位置找不到 electron（链接没能修好）。请在新位置点一次「安装依赖」，已经缓存过，不会重新下载整包。',
        runtimeDir: to,
      }
    }
    // 旧目录清掉（删不掉就留着，不影响使用）
    try { rmSync(from, { recursive: true, force: true }) } catch { /* 忽略 */ }
    return { ok: true, runtimeDir: to, moved: true }
  } catch (err) {
    saveRuntimeDir(prev)
    const msg = String(err?.message ?? err)
    if (/EPERM|EACCES|EBUSY/i.test(msg)) {
      return { ok: false, error: `搬移失败：文件被占用或没有权限（先彻底关掉桌宠再试）。原始错误：${msg}` }
    }
    if (/ENOSPC/i.test(msg)) {
      return { ok: false, error: `搬移失败：目标磁盘空间不够（约需 200 MB）。原始错误：${msg}` }
    }
    return { ok: false, error: `搬移失败：${msg}` }
  }
}

/** 把 pet/node_modules 变成指向 runtime 的 junction（真目录会先搬过去）。 */
function linkNodeModules(petDir) {
  const runtime = runtimeDir()
  const target = join(runtime, 'node_modules')
  if (!existsSync(target)) return { ok: false, reason: '运行时依赖还没装好' }
  const link = join(petDir, 'node_modules')
  let st
  try { st = lstatSync(link) } catch { st = null }
  if (st) {
    if (st.isSymbolicLink()) return { ok: true, reused: true }
    // 旧布局：真目录。这里必须处理掉，否则插件目录里会一直留着那份 500MB+
    if (existsSync(join(link, 'electron'))) {
      try {
        if (!existsSync(target)) {
          renameSync(link, target)          // runtime 还没有：直接搬过去
        } else {
          // runtime 已经有了（重复的一份）：把旧的整体挪进临时区。
          // 用 rename 而不是删除——里面可能有被句柄占住的 asar，删不掉。
          const trash = join(tmpdir(), `whale-pet-old-node_modules-${Date.now()}`)
          renameSync(link, trash)
        }
      } catch (err) {
        return { ok: false, reason: `清理旧依赖失败：${err?.message ?? err}` }
      }
    } else {
      return { ok: true, reused: true }
    }
  }
  try {
    symlinkSync(target, link, 'junction')
    return { ok: true, moved: true }
  } catch (err) {
    return { ok: false, reason: `建链接失败：${err?.message ?? err}` }
  }
}

/** 安装过程的输出落盘位置（失败时靠它排查）。 */
const INSTALL_LOG = join(tmpdir(), 'whale-pet-install.log')

/** 跑一个命令，超时就杀掉；输出写进 INSTALL_LOG。 */
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let stdio = 'ignore'
    let fd
    try {
      fd = openSync(INSTALL_LOG, 'a')
      stdio = ['ignore', fd, fd]
    } catch { stdio = 'ignore' }
    // windowsHide：node/pnpm 是控制台程序，不藏起来会弹黑框闪一下
    const child = spawn(cmd, args, { stdio, windowsHide: true, ...opts })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      reject(new Error('安装超时（10 分钟），请检查网络后手动安装'))
    }, 10 * 60 * 1000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}`))
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * 运行时其实已经装好了（比如插件刚更新、package 目录被换掉，链接丢了），
 * 这时不该再让用户点「安装依赖」重新下载——直接把链接接回去就行。
 * @returns {{ok: boolean, relinked?: boolean, reason?: string}}
 */
function ensureRuntimeLinked() {
  const { dir: petDir } = resolvePet()
  if (!petDir) return { ok: false, reason: '找不到桌宠目录' }
  const runtime = runtimeDir()
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
  const hasRuntime = existsSync(join(runtime, 'node_modules', 'electron', 'dist', exeName))
    || existsSync(join(runtime, 'node_modules', 'electron', exeName))
  if (!hasRuntime) return { ok: false, reason: '运行时还没下载过' }
  const linkRes = linkNodeModules(petDir)
  if (!linkRes.ok) return { ok: false, reason: linkRes.reason }
  const electron = resolveElectron(petDir)
  return { ok: Boolean(electron), relinked: true }
}

/** 按需安装桌宠依赖（主要是 electron，约 180MB）。
 *
 * 为什么不在 postinstall 里做：pnpm 10+ 默认拦截依赖的构建脚本，
 * 插件从 git/npm 装下来时 postinstall 不会执行。所以改成用户点按钮
 * 时再装，进度也能反馈到界面。
 *
 * 两个坑：
 * 1. 本机可能没有 npm（DSH 只带 pnpm），所以优先用运行时的 pnpm；
 * 2. pnpm 10+ 会拦掉 electron 的构建脚本，二进制不会下载 —— 装完之后
 *    要自己补跑一次 electron 的 install.js，否则 node_modules 看着齐了、
 *    实际没有 electron.exe。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function installDeps() {
  if (state.installing) return { ok: false, error: '正在安装中，请稍候…' }
  const { dir: petDir } = resolvePet()
  if (!petDir) {
    return { ok: false, error: '找不到桌宠目录，无法安装依赖' }
  }
  state.installing = true
  state.lastError = undefined
  const tools = runtimeTools()
  const runtime = runtimeDir()
  const env = { ...process.env, ELECTRON_MIRROR }
  try {
    mkdirSync(runtime, { recursive: true })
    // 依赖清单从插件里复制一份到运行时目录（首次安装时）
    const srcPkg = join(petDir, 'package.json')
    const dstPkg = join(runtime, 'package.json')
    if (existsSync(srcPkg) && !existsSync(dstPkg)) {
      try { copyFileSync(srcPkg, dstPkg) } catch { /* 复制失败就用现有的 */ }
    }

    const hasPnpm = existsSync(tools.node) && existsSync(tools.pnpm)
    if (hasPnpm) {
      try {
        await runCommand(tools.node, [tools.pnpm, 'install', '--no-frozen-lockfile'], { cwd: runtime, env })
      } catch (err) {
        // pnpm 10+ 会因为「拦掉 electron 的构建脚本」返回非零，但包其实装上了
        if (!existsSync(join(runtime, 'node_modules', 'electron', 'package.json'))) throw err
      }
    } else {
      await runCommand('npm', ['install', '--no-audit', '--no-fund'], { cwd: runtime, env, shell: true })
    }

    // 补下载 electron 二进制（pnpm 拦了构建脚本，这一步不能省）
    const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron'
    if (!existsSync(join(runtime, 'node_modules', 'electron', 'dist', exeName))) {
      const installer = join(runtime, 'node_modules', 'electron', 'install.js')
      if (existsSync(installer)) {
        if (hasPnpm) await runCommand(tools.node, [installer], { cwd: dirname(installer), env })
        else await runCommand(process.execPath, [installer], { cwd: dirname(installer), env })
      }
    }

    // 把 pet/node_modules 指到运行时（卸载时就只需要删一个链接）
    const linked = linkNodeModules(petDir)
    if (!linked.ok) return { ok: false, error: `依赖装好了，但没能接到插件目录：${linked.reason}` }

    // 装完再验一次
    const { electron } = resolvePet()
    if (!electron) {
      return { ok: false, error: `依赖装完了但仍找不到 electron（可能被网络或安全软件拦了下载）。详细输出在 ${INSTALL_LOG}。` }
    }
    return { ok: true }
  } catch (err) {
    const msg = err?.message ?? String(err)
    state.lastError = `依赖安装失败：${msg}`
    return { ok: false, error: `${state.lastError}。详细输出在 ${INSTALL_LOG}，也可手动在 ${runtime} 执行 npm install。` }
  } finally {
    state.installing = false
  }
}

/** 读取凭据文件里的一个值（最小化逐行解析）。 */
async function readCredential(key) {
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
  try {
    const text = await readFile(file, 'utf8')
    const m = new RegExp('^\\s*' + key + ':\\s*(.+?)\\s*$', 'm').exec(text)
    return m ? m[1].replace(/^["']|["']$/g, '') : undefined
  } catch {
    return undefined
  }
}

/** 查询 DeepSeek 余额。 */
async function queryBalance() {
  const key = await readCredential('DEEPSEEK_API_KEY')
  if (!key) return { ok: false, error: '未找到 DEEPSEEK_API_KEY（请检查 ~/.dsh/.credentials.yaml）' }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    if (res.status === 401) return { ok: false, error: 'API Key 无效或已失效' }
    if (!res.ok) return { ok: false, error: `余额接口 HTTP ${res.status}` }
    const body = await res.json()
    const info = (body.balance_infos && body.balance_infos[0]) || {}
    return {
      ok: true,
      available: body.is_available === true,
      currency: info.currency || 'CNY',
      total: Number(info.total_balance ?? 0),
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
    }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

/** 方法表。 */
const METHODS = {
  status: async () => {
    const { dir, electron } = resolvePet()
    // 顺带刷新发现文件：DSH 可能刚重启过（端口变了），让手动启动的桌宠也能跟上。
    const dshUrl = publishDiscovery()
    return {
      ok: true,
      running: isRunning(),
      startedAt: state.startedAt,
      error: state.lastError,
      petDir: dir,
      // 让界面能区分「找不到目录」和「目录在但依赖没装」
      ready: Boolean(dir && electron),
      installing: Boolean(state.installing),
      // 面板里直接告诉用户当前 DSH 地址，连不上时不用自己去查端口。
      dshUrl,
      // 运行时（electron 那 180MB）装在哪，面板里显示出来，用户可以改
      runtimeDir: runtimeDir(),
      // 桌宠崩溃时的现场在这里看，排查顺序：先看这个文件。
      electronLog: ELECTRON_LOG,
    }
  },
  start: async () => startPet(),
  stop: async () => stopPet(),
  install: async () => {
    // 先看本地是不是已经有运行时：有就只重新接链接，省掉 180MB 的下载
    const relinked = ensureRuntimeLinked()
    if (relinked.ok) return { ok: true, relinked: true }
    return installDeps()
  },
  setRuntimeDir: async (args) => {
    const { dir } = resolvePet()
    return setRuntimePath(dir, args && args.dir)
  },
  balance: async () => queryBalance(),
}

/** 处理一次 RPC 请求。 */
async function handleRpc(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    return
  }
  let body = ''
  try {
    body = await new Promise((resolve, reject) => {
      let acc = ''
      try { req.setEncoding('utf8') } catch { /* 忽略 */ }
      req.on('data', (chunk) => { acc += chunk })
      req.on('end', () => resolve(acc))
      req.on('error', reject)
    })
    const { method, args } = JSON.parse(body || '{}')
    const fn = METHODS[method]
    if (!fn) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `unknown method ${method}` }))
      return
    }
    const result = await fn(args)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result ?? { ok: true }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
  }
}

/** 注册路由与围栏。 */
function mountRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) return () => {}
  webServerService = webServer
  // 插件就绪即写入一次发现文件；listen 可能稍后才完成，再补两次（端口由 OS 分配）。
  publishDiscovery()
  const retries = [setTimeout(publishDiscovery, 1500), setTimeout(publishDiscovery, 5000)]

  const unregister = webServer.register({
    kind: 'exact',
    path: ROUTE,
    // 新版 DSH 的路由默认要求认证（auth: 'required'），未声明的老路由会被准入层
    // 直接拦掉（面板看到的就是 HTTP 400）。这条路由自己做了 cookie 校验，
    // 所以显式声明匿名，让请求能进到我们的 handler 里。
    auth: 'anonymous',
    handler: async (req, res) => {
      try {
        // 每次请求都实时取 connection（服务可能晚于本插件就绪）。
        // 注意：不能用 ctx.root —— 新版 DSH 里没 inject 'root' 时读它会直接抛
        // 「cannot get property "root" without inject」，整个 handler 就挂了。
        let connection
        try { connection = ctx.get('connection') } catch { connection = undefined }
        let rejection
        if (connection && typeof connection.requestRejection === 'function') {
          try { rejection = connection.requestRejection(req) } catch (e) { rejection = undefined }
        } else {
          // 拿不到围栏服务时，退化为「无 cookie 一律拒绝」，绝不裸奔
          const cookie = req.headers && req.headers.cookie
          rejection = cookie ? undefined : 401
        }
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await handleRpc(req, res)
      } catch (err) {
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
        } catch { /* 已经发过响应 */ }
      }
    },
  })
  return () => {
    for (const timer of retries) clearTimeout(timer)
    unregister()
  }
}

export function apply(ctx) {
  // 插件一加载就把「运行时依赖 → 插件目录」的链接接上。
  // 之前只在点「启动」时才接，结果重装之后面板先看到的还是「需要安装依赖」，
  // 用户得白点一次（其实依赖一直在 %APPDATA% 里，只是没连过来）。
  // 历史遗留：老版本会在 pet/node_modules 建一条指向运行时的 junction。
  // 它现在已经不需要了（依赖改走模块搜索路径），留着反而会让「卸载插件」卡住
  // —— pnpm 会顺着链接往里删。这里主动摘掉，只删链接、不动运行时。
  try {
    for (const dir of petDirCandidates()) {
      if (!dir) continue
      const link = join(dir, 'node_modules')
      let st = null
      try { st = lstatSync(link) } catch { st = null }
      if (st && st.isSymbolicLink()) {
        try { unlinkSync(link) } catch { try { rmSync(link, { recursive: false, force: true }) } catch { /* 忽略 */ } }
      }
    }
  } catch { /* 摘不掉不影响使用 */ }

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => mountRoute(webCtx), 'whale-pet: rpc route')
  })
  // 插件卸载时收掉桌宠进程，不留孤儿。
  // 还要把 pet/node_modules 那个 junction 摘掉：它指向插件目录之外的运行时，
  // 留给 pnpm 去删的话，会顺着链接往里走——轻则删不掉（用户看到「卸载失败」），
  // 重则把 D 盘那 180MB 一起删掉。摘链接只影响链接本身，目标目录不动。
  ctx.effect(() => () => {
    stopPet()
    try {
      for (const dir of petDirCandidates()) {
        if (!dir) continue
        const link = join(dir, 'node_modules')
        let st = null
        try { st = lstatSync(link) } catch { st = null }
        if (st && st.isSymbolicLink()) {
          try { unlinkSync(link) } catch { try { rmSync(link, { recursive: false, force: true }) } catch { /* 忽略 */ } }
        }
      }
    } catch { /* 摘不掉也不该影响卸载 */ }
  }, 'whale-pet: stop pet and detach runtime link on dispose')
}

// 仅供自测用（不属于插件对外接口）：验证「改安装位置」的搬移逻辑
export const __testing = { runtimeDir, setRuntimePath, configBase, ensureRuntimeLinked }

export const name = 'dsh-3d-whale-pet'
export const inject = ['webServer', 'connection']