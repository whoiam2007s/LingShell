import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
// electron-updater 是 CJS，autoUpdater 是 getter 导出，ESM 下只能走默认导入
import electronUpdater, { type AppUpdater } from 'electron-updater'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { log } from '../core/index.js'
import { notify } from './notify.js'
import { resolveUpdateSource, nextUpdateStatus } from './updateLogic.js'

export interface Updater {
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  install(): void
}

const EVENTS = ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error'] as const

// 自动更新：未配置更新源时完全不碰 autoUpdater（不实例化、不联网），状态恒为 disabled。
// 配置了：启动后检查一次（仅打包版）+ 设置页手动检查；后台下载，下完通知并等用户点「重启以更新」，绝不强制重启；
// 退出应用时也会自动安装（autoInstallOnAppQuit）。
export function initUpdater(win: BrowserWindow, emit: (s: UpdateStatus) => void): Updater {
  const ymlPath = join(process.resourcesPath, 'app-update.yml')
  const src = resolveUpdateSource({
    isPackaged: app.isPackaged,
    envUrl: process.env.LINGSHELL_UPDATE_URL,
    appUpdateYml: app.isPackaged && existsSync(ymlPath) ? readFileSync(ymlPath, 'utf8') : undefined,
  })
  let status: UpdateStatus = { state: 'disabled' }
  if (!src.enabled) {
    log('info', 'main', 'updater', app.isPackaged ? '未配置更新源，自动更新已禁用' : '开发模式，自动更新已禁用')   // i18n-ignore 日志
    return { status: () => status, check: async () => status, install: () => {} }
  }

  const au: AppUpdater = electronUpdater.autoUpdater
  au.autoDownload = true
  au.autoInstallOnAppQuit = true
  au.logger = {
    info: (m: unknown) => log('info', 'main', 'updater', String(m)),
    warn: (m: unknown) => log('warn', 'main', 'updater', String(m)),
    error: (m: unknown) => log('error', 'main', 'updater', String(m)),
    debug: (m: string) => log('debug', 'main', 'updater', m),
  }
  if (src.override) au.setFeedURL({ provider: 'generic', url: src.url })
  log('info', 'main', 'updater', `更新源 ${src.url}${src.override ? '（环境变量 LINGSHELL_UPDATE_URL）' : ''}，当前版本 ${app.getVersion()}`)   // i18n-ignore 日志

  status = { state: 'none' }
  for (const ev of EVENTS) {
    au.on(ev, (arg?: unknown) => {
      const next = nextUpdateStatus(status, ev, arg)
      if (!next) return
      const wasDownloaded = status.state === 'downloaded'
      status = next
      emit(status)
      if (ev === 'update-downloaded' && !wasDownloaded) notify(win, tr('灵壳 {version} 已下载', { version: status.version ?? '' }), tr('在 设置 → 关于 点「重启以更新」，或下次退出时自动安装'))
    })
  }

  const check = async (): Promise<UpdateStatus> => {
    // 已下载好就不再重复检查/下载
    if (status.state === 'downloaded' || status.state === 'checking' || status.state === 'downloading') return status
    try { await au.checkForUpdates() } catch (e) {
      // error 事件通常已发过；兜底一次
      if (status.state !== 'error') { status = nextUpdateStatus(status, 'error', e) ?? status; emit(status) }
    }
    return status
  }
  setTimeout(() => { void check() }, 10_000)   // 启动 10 秒后再查，不跟启动抢资源
  return {
    status: () => status,
    check,
    // 静默安装并重启；仅在已下载时生效
    install: () => { if (status.state === 'downloaded') au.quitAndInstall(true, true) },
  }
}
