// 应用级：系统对话框、更新、诊断包、配置导出导入、设置与布局、应用锁、通知、托盘 / 悬浮球、全局热键（从 ipc.ts 原样搬来，顺序不变）
import { ipcMain, dialog, app, shell, powerMonitor } from 'electron'
import { basename, join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { exportConfig, previewBundle, parseBundle, importConfig } from '@lingshell/config'
import { type ConfigExportOpts, type ConfigImportOpts, type AppLayout, type AppSettings, tr, shouldIdleLock } from '@lingshell/shared'
import type { LogLevel } from '@lingshell/platform'
import { log, archiveExt, buildDiagnostics, findBash, writeArchive, type MainContext } from '../core/index.js'
import { registerNotify } from './notifyIpc.js'
import { notify } from './notify.js'
import { hasOpenssl } from '../files/index.js'
import { initUpdater } from './updater.js'
import os from 'node:os'
import { registerSshUrl } from './sshUrl.js'
import { registerGlobalHotkey } from './globalHotkey.js'
import { registerAppInfo } from './appInfoIpc.js'
import { currentTheme } from './appearance.js'
import { beginQuit, registerBackground } from './background.js'
import type { registerOpsIpc } from '../ops/index.js'

type Deps = Pick<ReturnType<typeof registerOpsIpc>, 'watchdogs'>

export function registerAppIpc(ctx: MainContext, deps: Deps) {
  const { win, send, knownSecrets, paths, resetAutoReplyRules, sessionLogDir, sys, recUnsub, stopRecording, stopAllLogs, terminals,
    startLog, layoutStore, settings, appLock, sessionStore, unattended, hostOf, hiddenTerms, transfer, hostStore, sendTaps,
    electronEncryptor } = ctx
  const { watchdogs } = deps
  ipcMain.handle('system:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? undefined : r.filePaths[0]
  })
  // 存文本文件（会话导出 Markdown）：弹原生保存框，返回存到的路径，取消则 undefined
  ipcMain.handle('system:saveTextFile', async (_e, defaultName: string, content: string) => {
    // 过滤器跟默认文件名的扩展名走（会话报告 .md / .html、合规检查 .csv 等）；原先只认 .html、其余都当 Markdown，导出 CSV 时对话框显示「Markdown (*.md)」
    const ext = /\.([A-Za-z0-9]+)$/.exec(defaultName)?.[1]?.toLowerCase() ?? 'txt'
    const filters = [{ name: ({ md: 'Markdown', html: 'HTML', csv: 'CSV', txt: tr('文本'), json: 'JSON' } as Record<string, string>)[ext] ?? ext.toUpperCase(), extensions: [ext] }]
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
    if (r.canceled || !r.filePath) return undefined
    await writeFile(r.filePath, content, 'utf8')
    return r.filePath
  })

  // 自动更新（未配置更新源时恒为 disabled、不联网，见 updater.ts）
  const updater = initUpdater(win, (s) => send({ type: 'update:status', ...s }))
  ipcMain.handle('system:getUpdateStatus', () => ({ currentVersion: app.getVersion(), status: updater.status() }))
  ipcMain.handle('system:checkUpdate', () => updater.check())
  ipcMain.handle('system:installUpdate', () => updater.install())
  // 切换界面语言后重启：带上原来的启动参数（--hidden 除外，用户正看着窗口）
  ipcMain.handle('system:relaunch', () => { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') }); beginQuit(); app.quit() })

  // 导出诊断包（脱敏规则见 diagnostics.ts）：保存框 → 打包 → 在文件管理器里定位
  ipcMain.handle('system:exportDiagnostics', async () => {
    const ext = archiveExt()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const r = await dialog.showSaveDialog(win, { defaultPath: `lingshell-diagnostics-${stamp}.${ext}`, filters: [{ name: tr('诊断包'), extensions: [ext === 'zip' ? 'zip' : 'gz'] }] })
    if (r.canceled || !r.filePath) return undefined
    // 已知机密明文：只用来从输出（尤其日志）里抹掉
    const secrets = knownSecrets(true)
    const files = buildDiagnostics({
      ...paths, secrets,
      env: {
        appVersion: app.getVersion(), packaged: app.isPackaged, exportedAt: new Date().toISOString(),
        electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
        platform: process.platform, arch: process.arch, osRelease: os.release(), osVersion: os.version(), locale: app.getLocale(),
        dataDir: paths.root, dataDirOverride: !!process.env.LINGSHELL_DATA_DIR,
        gitBash: findBash() ?? null, openssl: await hasOpenssl(),
      },
    })
    await writeArchive(files, r.filePath)
    shell.showItemInFolder(r.filePath)
    log('info', 'main', 'diagnostics', `诊断包已导出 ${r.filePath}`)   // i18n-ignore 日志
    return r.filePath
  })

  // 配置导出/导入（格式与加密见 config/configBundle.ts）。导入文件路径只留在主进程，渲染层不能指定任意路径
  ipcMain.handle('config:export', async (_e, opts: ConfigExportOpts) => {
    const stamp = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog(win, { defaultPath: `lingshell-${stamp}.lingshell-config.json`, filters: [{ name: tr('灵壳配置'), extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return undefined
    const bundle = exportConfig(paths.config, electronEncryptor, opts, app.getVersion())
    await writeFile(r.filePath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 })   // 可能含加密凭据，同 SSH 私钥导出
    shell.showItemInFolder(r.filePath)
    log('info', 'main', 'config', `配置已导出 ${r.filePath}`, { sections: opts.sections, secrets: !!bundle.secrets })   // i18n-ignore 日志
    return r.filePath
  })
  let importPath: string | undefined
  ipcMain.handle('config:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: tr('灵壳配置'), extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return undefined
    const preview = previewBundle(parseBundle(await readFile(r.filePaths[0], 'utf8')))
    importPath = r.filePaths[0]
    return { fileName: basename(importPath), preview }
  })
  ipcMain.handle('config:import', async (_e, opts: ConfigImportOpts) => {
    if (!importPath) throw new Error(tr('请先选择配置文件'))
    const prevLogDir = sessionLogDir()
    const report = importConfig(paths.config, electronEncryptor, parseBundle(await readFile(importPath, 'utf8')), opts)
    resetAutoReplyRules()
    // 导入的系统设置与 settings:save 走同一套生效逻辑：录屏 / 会话日志隐私开关、ssh:// 协议、全局热键
    if (report.system) {
      if (!sys().terminalRecording) for (const id of [...recUnsub.keys()]) await stopRecording(id)
      if (!sys().sessionLog || sessionLogDir() !== prevLogDir) await stopAllLogs()
      for (const t of terminals.list()) startLog(t)
      sshUrl.apply()
      globalHotkey.apply()
    }
    const { password: _pw, ...logged } = opts
    log('info', 'main', 'config', `配置已导入 ${importPath}`, { opts: logged, report })   // i18n-ignore 日志
    return report
  })

  // layout handlers（终端布局 + 活动会话）
  ipcMain.handle('layout:get', () => layoutStore.get())
  ipcMain.handle('layout:save', (_e, patch: Partial<AppLayout>) => layoutStore.save(patch))

  // settings handlers
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', async (_e, s: AppSettings) => {
    const prevLogDir = sessionLogDir()
    const r = settings.save(s)
    // 关掉录屏功能 → 正在录的全部停掉
    if (!sys().terminalRecording) for (const id of [...recUnsub.keys()]) await stopRecording(id)
    // 会话日志：关了 / 换目录 → 结束现有文件；开着 → 已打开的终端补上（换目录的从新目录开新文件）
    if (!sys().sessionLog || sessionLogDir() !== prevLogDir) await stopAllLogs()
    for (const t of terminals.list()) startLog(t)
    sshUrl.apply()   // ssh:// 链接开关：注册 / 注销系统协议
    globalHotkey.apply()   // 双击 Alt 呼出：开关变了重新开 / 关检测
    return r
  })
  // 终端长命令完成 / 关键字告警的系统通知（见 notifyIpc.ts）
  registerNotify({ handle: (ch, fn) => ipcMain.handle(ch, fn), notify: (t, b) => notify(win, t, b) })
  const sshUrl = registerSshUrl({ handle: (ch, fn) => ipcMain.handle(ch, fn), send, enabled: () => sys().sshUrlHandler === true })   // ssh:// 链接唤起（见 sshUrl.ts）
  const globalHotkey = registerGlobalHotkey({ handle: (ch, fn) => ipcMain.handle(ch, fn), win, send, enabled: () => sys().globalHotkey === true, locked: () => appLock.locked })   // 全局热键呼出（见 globalHotkey.ts）
  // 关于页运行环境 + 备份与诊断页「打开数据目录 / 日志目录」（见 appInfoIpc.ts）
  registerAppInfo({ handle: (ch, fn) => ipcMain.handle(ch, fn), version: app.getVersion(), dataDir: paths.root, logsDir: paths.logs, openPath: (p) => shell.openPath(p) })

  // log handler：渲染层（web）日志经此转发，由主进程写入 web.log
  ipcMain.on('log:write', (_e, rec: { level: LogLevel; scope?: string; message: string; data?: unknown; time?: string }) => {
    log(rec.level, 'web', rec.scope ?? 'ui', rec.message, rec.data)
  })

  // ── 应用锁 ──
  ipcMain.handle('lock:status', () => appLock.status())
  ipcMain.handle('lock:lock', () => { appLock.lock() })
  ipcMain.handle('lock:unlock', (_e, pw: string) => appLock.unlock(pw))
  ipcMain.handle('lock:setPassword', async (_e, next: string, current?: string) => {
    await appLock.setPassword(next, current)
    log('info', 'main', 'lock', '主密码已设置/修改')   // i18n-ignore 日志
  })
  ipcMain.handle('lock:disable', async (_e, current: string) => {
    await appLock.disable(current)
    log('info', 'main', 'lock', '应用锁已关闭')   // i18n-ignore 日志
  })
  // 空闲自动锁：按系统空闲时间（用户在别的程序里忙也不算空闲）；系统锁屏 / 休眠时立即锁
  const idleTimer = setInterval(() => {
    if (shouldIdleLock({ enabled: appLock.enabled, locked: appLock.locked, idleMinutes: sys().lockIdleMinutes, idleSec: powerMonitor.getSystemIdleTime() })) appLock.lock()
  }, 15_000)
  idleTimer.unref()
  const lockNow = () => { appLock.lock() }
  powerMonitor.on('lock-screen', lockNow)
  powerMonitor.on('suspend', lockNow)
  // 立即锁定快捷键（默认 Ctrl+Shift+L，可在「设置 → 快捷键」改）由渲染层 App 在捕获阶段处理，走 lock:lock
  // 打包版锁定期间不许开开发者工具（默认菜单的 Ctrl+Shift+I 仍有效，开了能直接看隐藏的终端/对话 DOM）
  const noDevTools = () => { if (app.isPackaged && appLock.locked) win.webContents.closeDevTools() }
  win.webContents.on('devtools-opened', noDevTools)
  noDevTools()

  // 启动与后台：开机自启 / 托盘 / 悬浮球（见 background.ts）。状态旁听同一路界面事件
  const devUrl = process.env.LINGSHELL_RENDERER_URL || process.env.ELECTRON_RENDERER_URL
  const bg = registerBackground({
    win, file: join(paths.config, 'background.json'), send,
    status: {
      sessions: () => sessionStore.list().filter((m) => !unattended.has(m.id)).map((m) => ({ id: m.id, title: m.title })),
      hostLabelOf: (hk) => (hk === 'local' ? tr('本地') : hk.startsWith('mcp:') ? `MCP · ${hk.slice(4)}` : hostOf(hk)?.label ?? hk),
      terminalTitle: (tid) => (hiddenTerms.has(tid) ? undefined : terminals.list().find((t) => t.id === tid)?.title),
      locked: () => appLock.locked, lockEnabled: () => appLock.enabled,
      watchdog: () => ({ paused: watchdogs.paused, firing: watchdogs.firingCount() }),
      transfers: () => transfer.list(),
      hosts: () => hostStore.list().map((h) => ({ id: h.id, label: h.label })),
    },
    watchdog: watchdogs, lock: () => appLock.lock(), theme: currentTheme,
    iconPath: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico'),
    ballPage: devUrl ? { url: `${devUrl.replace(/\/$/, '')}/ball.html` } : { file: join(process.resourcesPath, 'ui', 'ball.html') },
    ballPreload: join(app.getAppPath(), 'out', 'preload', 'ball.cjs'),
    log: (lv, m, d) => log(lv, 'main', 'background', m, d),
  })
  sendTaps.push(bg.onEvent)
  return { idleTimer, lockNow }
}
