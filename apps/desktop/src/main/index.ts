import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { registerIpc } from './ipc.js'
import { initAppContext, log } from './core/index.js'
import { initSshUrl, receiveSshUrlArgv } from './app/index.js'
import { initNativeTheme, windowBg, currentTheme } from './app/index.js'
import { initLocale } from './app/index.js'
import { themeInfo, getLocale, tr } from '@lingshell/shared'

// ESM 下 __dirname 不存在；不依赖 electron-vite 的注入垫片（bundle 结构变化时会失效），
// 直接用 import.meta.url 显式派生，稳定可靠。用 here 避免与潜在注入的 __dirname 重名冲突。
const here = dirname(fileURLToPath(import.meta.url))

const isMac = process.platform === 'darwin'

let splash: BrowserWindow | null = null
let mainWin: BrowserWindow | null = null
// 启动页至少显示这么久（含应用初始化）；渲染层画出第一帧后才关（app:boot-ready）
const SPLASH_MIN_MS = 3000
let splashShownAt = 0
let bootFinished = false
// 开机自启选了「只进托盘」：带 --hidden 启动，不显示 splash 和主窗口（从托盘 / 悬浮球打开，见 background.ts）
const startHidden = process.argv.includes('--hidden')

// 启动 loading 小窗（400x300 无边框），主窗就绪前显示
function createSplash() {
  splash = new BrowserWindow({
    width: 480, height: 360,
    frame: false, transparent: true, resizable: false, movable: true, center: true,
    alwaysOnTop: true, skipTaskbar: true, show: false, title: tr('灵壳 LingShell'),
    backgroundColor: '#00000000',
  })
  // splash.html 开发时在源码 resources/，打包后在 resources/
  const candidates = [
    join(here, '../../resources/splash.html'),     // dev: out/main → apps/desktop/resources
    join(process.resourcesPath, 'splash.html'),         // 打包后
  ]
  const splashPath = candidates.find((p) => existsSync(p)) ?? candidates[0]
  // 颜色跟随当前界面主题（initNativeTheme 已读过设置）：底色 / 面板 / 强调色 / 文字色经地址参数交给启动页
  const { bg, panel, accent, text } = themeInfo(currentTheme().theme).swatch
  splash.loadFile(splashPath, { query: { bg, panel, accent, text, lang: getLocale() } })
  splash.once('ready-to-show', () => { splash?.show(); splashShownAt = Date.now() })
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    show: false,                                    // 隐藏，就绪后再显示
    title: tr('灵壳 LingShell'),                    // 页面加载前的窗口标题（任务栏 / Alt+Tab），默认会是包名 @lingshell/desktop
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    backgroundColor: windowBg(),
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  mainWin = win
  // 主窗口真正关掉 = 退出（托盘 / 悬浮球窗口不该把进程留着）
  win.on('closed', () => { mainWin = null; app.quit() })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('error', 'main', 'renderer', `did-fail-load: ${code} ${desc} url=${url}`)
  })

  // 渲染内容里的外链一律走系统浏览器，绝不在应用窗口内跳转（否则整个 UI 被导航替换）。
  // will-navigate 拦 <a href> 同窗口跳转；setWindowOpenHandler 拦 target=_blank / window.open。
  // devUrl / loadFile 的自身加载不经这两条路径，不受影响。
  // 只放行 http(s)：file:/ms-msdt:/search-ms: 之类会经系统协议处理器直接执行程序
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 主界面画出第一帧（渲染层发 app:boot-ready）且启动页已显示满 SPLASH_MIN_MS → 关 splash + 显示主窗
  const finishBoot = () => {
    if (bootFinished) return
    bootFinished = true
    const wait = startHidden ? 0 : Math.max(0, SPLASH_MIN_MS - (splashShownAt ? Date.now() - splashShownAt : 0))
    setTimeout(() => {
      log('info', 'main', 'window', `boot: closing splash (shown ${splashShownAt ? Date.now() - splashShownAt : 0}ms)${startHidden ? ', 只进托盘不显示主窗' : ', showing main window'}`)   // i18n-ignore 日志
      splash?.close(); splash = null
      if (!startHidden && !win.isDestroyed()) { win.show(); win.focus() }
    }, wait)
  }
  ipcMain.handle('app:boot-ready', () => { finishBoot(); return true })
  // 渲染层出错 / 卡住时兜底：最多等 12 秒也要把主窗显示出来
  const bootFallback = setTimeout(finishBoot, 12_000)
  win.on('closed', () => clearTimeout(bootFallback))

  const devUrl = process.env.LINGSHELL_RENDERER_URL || process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    log('info', 'main', 'window', `loading renderer URL: ${devUrl}`)
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(process.resourcesPath, 'ui', 'index.html'))
  }

  registerWindowControls(win)
  registerIpc(win)
}

function registerWindowControls(win: BrowserWindow) {
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:toggleMaximize', () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => win.close())
  ipcMain.handle('window:isMaximized', () => win.isMaximized())
  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))
  ipcMain.handle('window:platform', () => process.platform)
}

// 单实例：多开会共写 ~/.lingshell/config 下的 JSON、互相覆盖 api.json（先退的那个还会把它删掉）
// Windows 系统通知认 AppUserModelId，须与 electron-builder.yml 的 appId 一致
if (process.platform === 'win32') app.setAppUserModelId('com.lingshell.app')
// 浏览器数据目录（localStorage，以及加密已存密码 / API Key 用的钥匙）固定为 %APPDATA%\LingShell，开发版和安装版同一个：
// 两边共用 ~/.lingshell/config 里的密文，钥匙不同就互相解不开。别再改它、也别搬它：safeStorage 的密文和目录路径绑定，目录一换（哪怕整个改名过去）已存的密码全都解不开
// 命令行显式给了 --user-data-dir（隔离测试）时尊重它
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'LingShell'))

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_e, argv) => {
    const w = mainWin
    if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus() }   // 藏在托盘里的也拉出来
    receiveSshUrlArgv(argv)   // 点 ssh:// 链接唤起的第二实例：链接交给已运行的这个
  })
  initSshUrl()
  app.whenReady().then(() => {
    // 打包版去掉 Electron 默认菜单：它带 Ctrl+R 重载、Ctrl+W 关窗、Ctrl+Shift+I 开发者工具等快捷键，
    // 误按会重载界面 / 关掉应用；窗口是自绘标题栏，本来也不显示菜单。开发版保留（要用重载、开发者工具）
    if (app.isPackaged) Menu.setApplicationMenu(null)
    const { config } = initAppContext().paths
    initLocale(config)        // 界面语言最先定：后面建菜单 / 托盘 / 报错文案都按它（见 locale.ts）
    initNativeTheme(config)   // 界面主题先定好：启动页与主窗底色不闪色（见 appearance.ts）
    if (!startHidden) createSplash()
    createMainWindow()
  })
}
// 主窗口关掉即退出：IPC/控制器/ApiServer 都是一次性装配的，macOS 那种"关窗留进程、点 Dock 重建窗口"
// 会重复 ipcMain.handle 直接抛错。「关窗进托盘」只是隐藏窗口（见 background.ts），点 Dock 图标重新显示。
app.on('window-all-closed', () => app.quit())
