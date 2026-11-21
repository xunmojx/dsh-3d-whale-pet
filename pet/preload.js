// 虎鲸桌宠 - 预加载桥：窗口拖动 + gateway 通信
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petWindow', {
  // 拖动协议：主进程锁尺寸 + 相对总位移（修复缩放屏下窗口变大 bug）
  dragStart() {
    ipcRenderer.send('drag-start')
  },
  dragMove(dx, dy) {
    ipcRenderer.send('drag-move', dx, dy)
  },
  dragEnd(moved) {
    ipcRenderer.send('drag-end', !!moved)
  },
  // 右键菜单（自绘窗口）
  menuRequest() {
    ipcRenderer.send('pet:menu-request')
  },
  menuClose() {
    ipcRenderer.send('pet:menu-close')
  },
  menuAction(a) {
    ipcRenderer.send('pet:menu-action', a)
  },
  menuResize(h) {
    ipcRenderer.send('pet:menu-resize', h)
  },
  onMenuState(cb) {
    ipcRenderer.on('pet:menu-state', (_e, s) => cb(s))
  },
  /** 主进程让桌宠说一句话：{ text, ms } */
  onSay(cb) {
    ipcRenderer.on('pet:say', (_e, v) => cb(v))
  },
  /** 取名：setName('小鲸') / closeRename() / onName(cb) */
  setName(v) {
    ipcRenderer.send('pet:set-name', v)
  },
  closeRename() {
    ipcRenderer.send('pet:close-rename')
  },
  onName(cb) {
    ipcRenderer.on('pet:current-name', (_e, n) => cb(n))
  },
  /** 主窗口用：主进程把当前名字同步过来 */
  onSetName(cb) {
    ipcRenderer.on('pet:set-name', (_e, n) => cb(n))
  },
  /** 删除本地数据（配置 + 桌宠本体） */
  clearLocalData() {
    ipcRenderer.send('pet:clear-local-data')
  },
  onClearDataResult(cb) {
    ipcRenderer.on('pet:clear-local-data-result', (_e, r) => cb(r))
  },
  // 把渲染层画的图标交给主进程（任务栏图标用）
  setIcon(dataUrl) {
    ipcRenderer.send('pet:icon', dataUrl)
  },
  // 右键按下时让窗口站住，别在菜单弹出前游走
  holdStill(ms) {
    ipcRenderer.send('pet:hold-still', ms)
  },
  // ---- 小游戏：大鱼吃小鱼 ----
  dropFish(x, y) {
    ipcRenderer.send('pet:drop-fish', x, y)
  },
  exitGame() {
    ipcRenderer.send('pet:exit-game')
  },
  onFishSync(cb) {
    ipcRenderer.on('pet:fish-sync', (_e, list) => cb(list))
  },
  onFishEaten(cb) {
    ipcRenderer.on('pet:fish-eaten', (_e, p) => cb(p))
  },
  onGameMode(cb) {
    ipcRenderer.on('pet:game-mode', (_e, on) => cb(on))
  },
  // 翻滚（转圈）开始/结束：主进程据此在翻滚期间停住移动
  setSpinning(on) {
    ipcRenderer.send('pet:spinning', !!on)
  },
  // 睡觉开始/结束：睡觉时同样停在原地
  setSleeping(on) {
    ipcRenderer.send('pet:sleeping', !!on)
  },
  // 光标位置（窗口内坐标）：穿透状态下渲染层收不到鼠标事件，由主进程喂
  // 主进程通知：面板已被「点外面」收起
  onPanelClose(cb) {
    ipcRenderer.on('pet:panel-close', () => cb())
  },
  onCursor(cb) {
    ipcRenderer.on('pet:cursor', (_e, p) => cb(p))
  },
  // 光线检测结果：光标到底在不在模型轮廓内
  reportHit(v) {
    ipcRenderer.send('pet:hit', !!v)
  },
  // 左侧动作面板（喂食/爱心/睡眠）打开时，要把整个窗口恢复成可交互，
  // 否则光标一移到左边缘就触发点击穿透，按钮点不到。
  setPanelOpen(on) {
    ipcRenderer.send('pet:panel', !!on)
  },
  // 全屏点击捕手被点到（= 点了鲸鱼以外的地方）
  catcherHit() {
    ipcRenderer.send('catcher-hit')
  },
})

contextBridge.exposeInMainWorld('petBridge', {
  // 情绪变化：'idle' | 'working' | 'needs-input' | 'ready' | 'blocked'
  onMood(cb) {
    ipcRenderer.on('pet:mood', (_e, mood) => cb(mood))
  },
  // 深度求索（思考）状态：true = 正在想，false = 想完了
  onThinking(cb) {
    ipcRenderer.on('pet:thinking', (_e, on) => cb(!!on))
  },
  // 台词：内置 + 自定义
  // 姿势（初始角度）：渲染层调好之后存到主进程的配置里
  savePose(pose) {
    ipcRenderer.send('pet:save-pose', pose)
  },
  onPose(cb) {
    ipcRenderer.on('pet:pose', (_e, p) => cb(p))
  },
  poseWant() {
    ipcRenderer.send('pet:pose-want')
  },
  poseSet(pose) {
    ipcRenderer.send('pet:pose-set', pose)
  },
  poseClose() {
    ipcRenderer.send('pet:pose-close')
  },
  onPoseEditor(cb) {
    ipcRenderer.on('pet:pose-editor', () => cb(true))
  },
  closeLines() {
    ipcRenderer.send('pet:lines-close')
  },
  // 页面准备好后主动要一次台词（启动时那一次推送可能比监听更早）
  askLines() {
    ipcRenderer.send('pet:lines-want')
  },
  linesGet() {
    return ipcRenderer.invoke('pet:lines-get')
  },
  linesSave(payload) {
    return ipcRenderer.invoke('pet:lines-save', payload)
  },
  onLines(cb) {
    ipcRenderer.on('pet:lines', (_e, data) => cb(data))
  },
  onLinesState(cb) {
    ipcRenderer.on('pet:lines-state', (_e, data) => cb(data))
  },
  // 连接状态
  onConnection(cb) {
    ipcRenderer.on('pet:connection', (_e, info) => cb(info))
  },
  // 主进程要求中断翻滚（比如它挡住东西了，得马上让开）
  onAbortSpin(cb) {
    ipcRenderer.on('pet:abort-spin', () => cb())
  },
  // 跟随鼠标时的速度向量 { vx, vy }（归一化 -1~1），用来做侧倾/点头
  onSwim(cb) {
    ipcRenderer.on('pet:swim', (_e, v) => cb(v))
  },
  // 派活结果 / 错误
  onLog(cb) {
    ipcRenderer.on('pet:log', (_e, data) => cb(data))
  },
  onReply(cb) {
    ipcRenderer.on('pet:reply', (_e, data) => cb(data))
  },
  // 余额查询结果：{ kind: 'loading' | 'ok' | 'error', text?, data? }
  onBalance(cb) {
    ipcRenderer.on('pet:balance', (_e, data) => cb(data))
  },
  queryBalance() {
    ipcRenderer.send('pet:query-balance')
  },
  // 流式回复：{ kind: 'chunk' | 'message' | 'done', text? }
  onStream(cb) {
    ipcRenderer.on('pet:stream', (_e, data) => cb(data))
  },
  prompt(text) {
    ipcRenderer.send('pet:prompt', text)
  },
  // —— 皮肤切换 ——
  onSetSkin(cb) {
    ipcRenderer.on('pet:set-skin', (_e, name) => cb(name))
  },
  onSetCustomSkin(cb) {
    ipcRenderer.on('pet:set-custom-skin', (_e, data) => cb(data))
  },
  onSetSize(cb) {
    ipcRenderer.on('pet:set-size', (_e, v) => cb(v))
  },
  onSetDanceFreq(cb) {
    ipcRenderer.on('pet:set-dance-freq', (_e, v) => cb(v))
  },
  // —— 播放器：主窗口接收频谱/曲名，可打开播放器 ——
  onAudioFreq(cb) {
    ipcRenderer.on('pet:audio-freq', (_e, data) => cb(data))
  },
  onBeat(cb) {
    ipcRenderer.on('pet:beat', (_e, gap) => cb(gap))
  },
  onMusicComment(cb) {
    ipcRenderer.on('pet:music-comment', (_e, name) => cb(name))
  },
  openPlayer() {
    ipcRenderer.send('pet:open-player')
  },
  // —— 播放器窗口：发送频谱/曲名，窗口控制 ——
  sendAudioFreq(data) {
    ipcRenderer.send('pet:audio-freq', data)
  },
  // 播放器侧算好了节拍就直接发一拍，省得把整条频谱搬过去再算一遍
  sendBeat(gapMs) {
    ipcRenderer.send('pet:beat', gapMs)
  },
  musicComment(name) {
    ipcRenderer.send('pet:music-comment', name)
  },
  // 打开系统文件对话框选音频，返回绝对路径数组
  pickAudio() {
    return ipcRenderer.invoke('pet:pick-audio')
  },
  // 拿系统声音的桌面源 id（用于监听别的软件在放什么）
  desktopAudioSource() {
    return ipcRenderer.invoke('pet:desktop-audio-source')
  },
  minimizePlayer() {
    ipcRenderer.send('pet:minimize-player')
  },
  closePanel() {
    ipcRenderer.send('pet:close-panel')
  },
  // —— 自定义配色窗口：发送所选配色 ——
  sendCustomSkin(dark, white) {
    ipcRenderer.send('pet:set-custom-skin', { dark, white })
  },
})