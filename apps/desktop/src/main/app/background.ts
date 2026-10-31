// 启动与后台（设置 → 通用 →「启动与后台」）：开机自启、系统托盘（关窗进托盘）、悬浮球。
// - 开机自启：系统登录项（app.setLoginItemSettings），「只进托盘」= 带 --hidden 启动（index.ts 不显示 splash 和主窗口）
// - 关窗进托盘：主窗口 close 时隐藏（第一次弹一次通知）；真正退出 = 托盘 / 悬浮球「退出」→ app.quit，
//   这时 quitting=true，关窗照常走「传输未完成」确认（transferIpc 经 shouldHideOnClose 判断是不是只是隐藏）
// - 托盘 / 悬浮球的状态由 BgStatus 旁听同一路界面事件聚合，节流 ≤ 2 次/秒刷新；纯逻辑见 trayModel.ts / ballGeometry.ts
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, screen, ipcMain, type MenuItemConstructorOptions, type NativeImage, type IpcMainEvent } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { clampBallOpacity, tr, type AppEvent, type BackgroundPatch, type BackgroundStatus, type BallView } from '@lingshell/shared'
import { BgStatus, type BgStatusDeps } from './bgStatus.js'
import { ballMenu, ballView, isOwnLoginItem, normalizeBgConfig, paintBadge, trayMenu, trayTooltip, trimLocked, type BgAction, type BgConfig, type BgSnapshot, type MenuNode } from './trayModel.js'
import { BALL_SIZE, expandBounds, fixBall, hiddenPos, snapBall, areaOf, type BallPos, type Rect } from './ballGeometry.js'

// ── 关窗 = 隐藏还是退出（index.ts / ipc.ts 的传输确认都要问这里）──
let quitting = false
let closeToTray = () => false
app.on('before-quit', () => { quitting = true })
/** 点 × 时只是藏到托盘（不是在退出应用） */
export const shouldHideOnClose = () => !quitting && closeToTray()
/** 退出被用户取消（「传输未完成」选了取消）：之后点 × 照旧进托盘 */
export const cancelQuit = () => { quitting = false }
/** 确认退出后再关窗（传输确认里「仍要退出」） */
export const beginQuit = () => { quitting = true }

export interface BackgroundDeps {
  win: BrowserWindow
  file: string                                   // background.json
  status: Omit<BgStatusDeps, 'ball'>
  send(ev: AppEvent): void
  watchdog: { readonly paused: boolean; setPaused(p: boolean): void }
  lock(): void
  theme(): { theme: string; kind: 'dark' | 'light' }
  iconPath: string                               // 应用图标 .ico
  ballPage: { url: string } | { file: string }
  ballPreload: string
  log(level: 'info' | 'warn', message: string, data?: unknown): void
}

const LOGIN_HIDDEN = '--hidden'

export function registerBackground(d: BackgroundDeps) {
  const { win } = d
  const load = (): BgConfig => { try { return normalizeBgConfig(JSON.parse(readFileSync(d.file, 'utf8'))) } catch { return normalizeBgConfig({}) } }
  const cfg = load()
  const save = () => { try { mkdirSync(dirname(d.file), { recursive: true }); writeFileSync(d.file, JSON.stringify(cfg, null, 2), 'utf8') } catch (e) { d.log('warn', 'background.json 写入失败', { err: String(e) }) } }   // i18n-ignore 日志
  closeToTray = () => cfg.closeToTray

  const status = new BgStatus({ ...d.status, ball: () => ({ visible: cfg.ball, opacity: cfg.ballOpacity }) })

  // ── 主窗口 ──
  const showMain = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
  }
  const toggleMain = () => { if (win.isVisible() && !win.isMinimized()) win.hide(); else showMain() }
  // Windows 注销 / 关机不会触发 before-quit：标记为退出，别把关闭拦下来藏到托盘
  win.on('session-end', () => { quitting = true })
  win.on('close', (e) => {
    if (!shouldHideOnClose()) return
    e.preventDefault()
    win.hide()
    if (cfg.trayHintShown || !Notification.isSupported()) return
    cfg.trayHintShown = true; save()
    const n = new Notification({ title: tr('灵壳'), body: tr('灵壳仍在后台运行，可从托盘打开') })
    n.on('click', showMain)
    n.show()
  })
  win.on('show', () => { status.clearError(); schedule() })
  win.on('focus', () => { status.clearError(); schedule() })
  win.on('hide', () => schedule())

  // ── 开机自启：开发版注册的是 electron.exe + 应用目录（以安装版为准）──
  const loginArgs = (hidden: boolean) => [...(process.defaultApp ? [app.getAppPath()] : []), ...(hidden ? [LOGIN_HIDDEN] : [])]
  // 开发版不注册：它写进去的是 electron.exe + 源码目录，开机时没有 vite 界面服务器、只会卡在启动页；
  // 而且和安装版用同一个登录项名称，会把安装版的覆盖掉
  const loginSupported = process.platform !== 'linux' && app.isPackaged
  // macOS 13+ 的登录项不能隐藏启动（Electron 的 openAsHidden 已失效），别在设置里假装支持
  const startHiddenSupported = process.platform === 'win32'
  const loginState = () => {
    if (!loginSupported) return { openAtLogin: false, startHidden: false }
    if (!startHiddenSupported) return { openAtLogin: app.getLoginItemSettings().openAtLogin, startHidden: false }
    const h = app.getLoginItemSettings({ args: loginArgs(true) }).openAtLogin
    return { openAtLogin: h || app.getLoginItemSettings({ args: loginArgs(false) }).openAtLogin, startHidden: h }
  }
  const setLogin = (openAtLogin: boolean, hidden: boolean) => {
    if (!loginSupported) throw new Error(tr('当前系统不支持开机自启'))
    app.setLoginItemSettings({ openAtLogin, args: loginArgs(hidden) })
    d.log('info', openAtLogin ? `开机自启已开启${hidden ? '（只进托盘）' : ''}` : '开机自启已关闭')   // i18n-ignore 日志
  }

  // 安装位置变过（LingShell\LingShell → LingShell）：登录项还指着已经不存在的旧 exe，开机什么都起不来、设置里也显示没开 → 换成当前 exe，保留「只进托盘」
  if (loginSupported && process.platform === 'win32' && !loginState().openAtLogin) {
    // 只看 LingShell 自己的登录项：launchItems 是整台机器的启动项，别人的失效快捷方式不能让我们擅自开自启
    const stale = (app.getLoginItemSettings().launchItems ?? []).find((i) => i.enabled && i.path && isOwnLoginItem(i) && !existsSync(i.path.replace(/"/g, '')))
    if (stale) setLogin(true, (stale.args ?? []).includes(LOGIN_HIDDEN))
  }

  const bgStatus = (): BackgroundStatus => ({
    ...loginState(), loginSupported, startHiddenSupported, dev: !app.isPackaged,
    closeToTray: cfg.closeToTray, ball: cfg.ball, ballOpacity: cfg.ballOpacity, ballAutoHide: cfg.ballAutoHide,
  })
  const configure = (p: BackgroundPatch): BackgroundStatus => {
    const patch = (p && typeof p === 'object' ? p : {}) as BackgroundPatch
    if (typeof patch.openAtLogin === 'boolean' || typeof patch.startHidden === 'boolean') {
      const cur = loginState()
      const open = typeof patch.openAtLogin === 'boolean' ? patch.openAtLogin : cur.openAtLogin
      setLogin(open, open && startHiddenSupported && (typeof patch.startHidden === 'boolean' ? patch.startHidden : cur.startHidden))
    }
    if (typeof patch.closeToTray === 'boolean') cfg.closeToTray = patch.closeToTray
    if (typeof patch.ballAutoHide === 'boolean') cfg.ballAutoHide = patch.ballAutoHide
    if (patch.ballOpacity !== undefined) cfg.ballOpacity = clampBallOpacity(patch.ballOpacity)
    if (typeof patch.ball === 'boolean') cfg.ball = patch.ball
    save()
    applyBall()
    schedule()
    const s = bgStatus()
    d.send({ type: 'background:changed', status: s })   // 托盘 / 悬浮球里改的开关，设置页同步
    return s
  }
  ipcMain.handle('background:status', () => bgStatus())
  ipcMain.handle('background:configure', (_e, p: BackgroundPatch) => configure(p))

  // ── 菜单动作 ──
  const perform = (a: BgAction) => {
    switch (a.type) {
      case 'show': showMain(); return
      case 'toggleWindow': toggleMain(); return
      case 'ui':
        showMain()
        d.send({ type: 'tray:action', action: a.action })
        return
      case 'openSession': showMain(); d.send({ type: 'inspection:openSession', sessionId: a.sessionId }); return
      case 'watchdogPause': d.watchdog.setPaused(a.paused); schedule(); return
      case 'toggleBall': configure({ ball: !cfg.ball }); return
      case 'hideBall': configure({ ball: false }); return
      case 'lock': d.lock(); schedule(); return
      case 'opacity': configure({ ballOpacity: a.value }); return
      case 'quit': app.quit(); return
    }
  }
  const toTemplate = (nodes: MenuNode[]): MenuItemConstructorOptions[] => nodes.map((n) => n.type === 'separator' ? { type: 'separator' } : {
    label: n.label, ...(n.type ? { type: n.type } : {}), ...(n.checked !== undefined ? { checked: n.checked } : {}),
    enabled: n.enabled !== false,
    ...(n.submenu ? { submenu: toTemplate(n.submenu) } : {}),
    ...(n.action ? { click: () => perform(n.action!) } : {}),
  })

  // ── 托盘 ──
  const baseIcon = nativeImage.createFromPath(d.iconPath)
  if (baseIcon.isEmpty()) d.log('warn', '托盘图标读取失败', { path: d.iconPath })   // i18n-ignore 日志
  const iconOf = (badge: boolean): NativeImage => {
    if (baseIcon.isEmpty()) return baseIcon
    const img = nativeImage.createEmpty()
    for (const [scaleFactor, size] of [[1, 16], [2, 32]] as const) {
      const bmp = Buffer.from(baseIcon.resize({ width: size, height: size, quality: 'best' }).toBitmap())
      if (badge) paintBadge(bmp, size)
      img.addRepresentation({ scaleFactor, width: size, height: size, buffer: nativeImage.createFromBitmap(bmp, { width: size, height: size }).toPNG() })
    }
    return img
  }
  const icons = { plain: iconOf(false), badge: iconOf(true) }
  const tray = new Tray(icons.plain)
  tray.setToolTip(tr('灵壳 LingShell'))
  tray.on('click', toggleMain)
  tray.on('double-click', showMain)
  let lastTray = ''
  let lastBadge = false

  // ── 悬浮球 ──
  let ball: BrowserWindow | null = null
  let pos: BallPos = fixBall(cfg.ballPos, [])
  let hovering = false
  let hidden = false                // 当前是否半隐藏在边上
  let layout: Pick<BallView, 'expanded' | 'side' | 'valign'> = { expanded: false, side: 'right', valign: 'top' }
  let dragFrom: { x: number; y: number } | null = null
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let menuOpen = false              // 球右键菜单开着时不要自动半隐藏（鼠标在菜单上，球已经收不到 hover）
  let lastBall = ''
  const areas = (): Rect[] => {
    const p = screen.getPrimaryDisplay()
    return [p, ...screen.getAllDisplays().filter((x) => x.id !== p.id)].map((x) => x.workArea)
  }
  const place = (b: Rect) => { if (ball && !ball.isDestroyed()) ball.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }) }
  const placeBall = () => {
    const p = hidden ? hiddenPos(pos) : pos
    place({ x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE })
  }
  const maybeHide = (delay = 900) => {
    clearTimeout(hideTimer)
    if (!cfg.ballAutoHide || !pos.edge) { if (hidden) { hidden = false; placeBall() } return }
    hideTimer = setTimeout(() => { if (!hovering && !dragFrom && !layout.expanded && !menuOpen) { hidden = true; placeBall() } }, delay)
  }
  const collapse = () => {
    if (layout.expanded) { layout = { ...layout, expanded: false }; placeBall(); pushBall(true) }
  }
  const createBall = () => {
    pos = fixBall(cfg.ballPos, areas())
    ball = new BrowserWindow({
      x: pos.x, y: pos.y, width: BALL_SIZE, height: BALL_SIZE,
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
      title: tr('灵壳 悬浮球'),
      webPreferences: { preload: d.ballPreload, contextIsolation: true, nodeIntegration: false },
    })
    ball.setAlwaysOnTop(true, 'floating')
    ball.setOpacity(cfg.ballOpacity / 100)
    ball.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    ball.webContents.on('will-navigate', (e) => e.preventDefault())
    if ('url' in d.ballPage) void ball.loadURL(d.ballPage.url); else void ball.loadFile(d.ballPage.file)
    ball.once('ready-to-show', () => { ball?.showInactive(); lastBall = ''; pushBall(true); maybeHide(1500) })
    ball.on('closed', () => { ball = null; hovering = false; hidden = false; dragFrom = null })
  }
  const applyBall = () => {
    if (cfg.ball && !ball) createBall()
    else if (!cfg.ball && ball) {
      // 关掉悬浮球时把临时状态一起清掉：否则重新打开后 hovering 还是 true，球会一直不透明、也不会自动半隐藏
      stopDrag(); clearTimeout(hideTimer)
      ball.destroy(); ball = null
      layout = { ...layout, expanded: false }; hidden = false; hovering = false; dragFrom = null; lastBall = ''
    }
    if (ball) ball.setOpacity(hovering ? 1 : cfg.ballOpacity / 100)
    // 关掉「贴边自动半隐藏」：取消还没到点的收起，已经缩进去的立即划出来
    if (!cfg.ballAutoHide) { clearTimeout(hideTimer); if (hidden) { hidden = false; placeBall() } }
  }
  const pushBall = (force = false) => {
    if (!ball || ball.isDestroyed()) return
    const v = ballView(snap, { ...layout, ...d.theme() })
    const s = JSON.stringify(v)
    if (!force && s === lastBall) return
    lastBall = s
    ball.webContents.send('ball:state', v)
  }
  screen.on('display-metrics-changed', () => { if (ball) { pos = fixBall(pos, areas()); collapse(); placeBall() } })
  screen.on('display-removed', () => { if (ball) { pos = fixBall(pos, areas()); collapse(); placeBall() } })
  screen.on('display-added', () => { if (ball) { pos = fixBall(pos, areas()); placeBall() } })

  // 悬浮球页面发来的（只认悬浮球窗口自己的 webContents）
  const fromBall = (h: (...a: unknown[]) => void) => (e: IpcMainEvent, ...a: unknown[]) => { if (ball && e.sender === ball.webContents) h(...a) }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  ipcMain.on('ball:ready', fromBall(() => pushBall(true)))
  ipcMain.on('ball:enter', fromBall(() => {
    hovering = true; clearTimeout(hideTimer)
    ball?.setOpacity(1)
    if (hidden) { hidden = false; placeBall() }
  }))
  ipcMain.on('ball:leave', fromBall(() => {
    hovering = false
    ball?.setOpacity(cfg.ballOpacity / 100)
    collapse()
    maybeHide()
  }))
  ipcMain.on('ball:expand', fromBall((h) => {
    if (!hovering || dragFrom) return
    const a = areaOf(pos, areas())
    if (!a) return
    const r = expandBounds(pos, num(h), a)
    layout = { expanded: true, side: r.side, valign: r.valign }
    place(r.bounds)
    pushBall(true)
  }))
  // 拖动：主进程按系统光标位置跟随（每 8ms 一次），不靠渲染层逐帧发位移——小窗口追不上鼠标时会收不到 mousemove，球就停在原地
  let dragOff: { x: number; y: number } | null = null
  let dragTimer: ReturnType<typeof setInterval> | undefined
  const stopDrag = () => { clearInterval(dragTimer); dragTimer = undefined; dragOff = null }
  ipcMain.on('ball:dragStart', fromBall((dx, dy) => {
    collapse(); hidden = false; clearTimeout(hideTimer); dragFrom = { x: pos.x, y: pos.y }
    const c = screen.getCursorScreenPoint()
    dragOff = { x: c.x - (pos.x + num(dx)), y: c.y - (pos.y + num(dy)) }   // 按下点在球内的偏移（扣掉判定为拖动前已移动的几像素）
    clearInterval(dragTimer)
    const started = Date.now()
    dragTimer = setInterval(() => {
      if (!dragOff || Date.now() - started > 120_000) { stopDrag(); return }   // 兜底：收不到松开事件也不会一直跟着
      const p = screen.getCursorScreenPoint()
      place({ x: p.x - dragOff.x, y: p.y - dragOff.y, width: BALL_SIZE, height: BALL_SIZE })
    }, 8)
  }))
  ipcMain.on('ball:drag', fromBall(() => { /* 位置由上面的定时器跟随光标，这里不再处理 */ }))
  ipcMain.on('ball:dragEnd', fromBall(() => {
    if (!dragFrom) return
    const c = screen.getCursorScreenPoint()
    const off = dragOff ?? { x: BALL_SIZE / 2, y: BALL_SIZE / 2 }
    stopDrag()
    pos = snapBall({ x: c.x - off.x, y: c.y - off.y }, areas())
    dragFrom = null
    cfg.ballPos = pos; save()
    placeBall()
    if (!hovering) maybeHide()
  }))
  ipcMain.on('ball:click', fromBall(() => toggleMain()))
  ipcMain.on('ball:menu', fromBall(() => {
    if (!ball || menuOpen) return
    collapse()
    menuOpen = true
    Menu.buildFromTemplate(toTemplate(ballMenu(snap))).popup({ window: ball, callback: () => { menuOpen = false; if (!hovering) maybeHide() } })
  }))
  // 状态卡上的「去处理」：只认打开会话
  ipcMain.on('ball:openSession', fromBall((sid) => { if (typeof sid === 'string' && sid && !snap.locked) perform({ type: 'openSession', sessionId: sid }) }))

  // ── 刷新（节流 ≤ 2 次/秒）──
  let snap: BgSnapshot = trimLocked(status.snapshot())
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastAt = 0
  const refresh = () => {
    timer = undefined; lastAt = Date.now()
    if (win.isDestroyed()) return
    snap = trimLocked(status.snapshot())
    const model = trayMenu(snap)
    const key = JSON.stringify([trayTooltip(snap), model])
    if (key !== lastTray) {
      lastTray = key
      tray.setToolTip(trayTooltip(snap))
      tray.setContextMenu(Menu.buildFromTemplate(toTemplate(model)))
    }
    const badge = snap.approvals.length > 0
    if (badge !== lastBadge) { lastBadge = badge; tray.setImage(badge ? icons.badge : icons.plain) }
    pushBall()
  }
  function schedule() {
    if (timer) return
    timer = setTimeout(refresh, Math.max(0, 500 - (Date.now() - lastAt)))
  }
  const beat = setInterval(schedule, 2000)
  refresh()
  applyBall()

  win.on('closed', () => {
    clearInterval(beat); clearTimeout(timer); clearTimeout(hideTimer)
    if (ball && !ball.isDestroyed()) ball.destroy()
    tray.destroy()
  })
  app.on('activate', showMain)   // macOS 点 Dock 图标

  // 自测钩子（仅开发版）：主进程 inspector 里看托盘 / 悬浮球
  if (!app.isPackaged) (globalThis as Record<string, unknown>).__lingshellBg = { tray, get ball() { return ball }, menu: () => trayMenu(snap), ballMenu: () => ballMenu(snap), snap: () => snap, perform, cfg }

  return {
    onEvent: (ev: AppEvent) => { status.onEvent(ev); schedule() },
    refresh: schedule,
  }
}
