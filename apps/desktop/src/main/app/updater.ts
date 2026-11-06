import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
// electron-updater 是 CJS，autoUpdater 是 getter 导出，ESM 下只能走默认导入
import electronUpdater, { type AppUpdater } from 'electron-updater'
import { tr, type UpdateStatus } from '@lingshell/shared'
import { log } from '../core/index.js'
import { notify } from './notify.js'
import { resolveUpdateSource, nextUpdateStatus } from './updateLogic.js'

export interface Updater {
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  // 用户点更新图标时才真正开始下载（autoDownload 已关）
  download(): Promise<UpdateStatus>
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
    return { status: () => status, check: async () => status, download: async () => status, install: () => {} }
  }

  const au: AppUpdater = electronUpdater.autoUpdater
  // 检测到新版本只提示、不自动下载：下载要用户点（点一下就是要装，意图明确）。
  // 这样 autoInstallOnAppQuit 打开也不会出现"用户什么都没点、退出就被装"的情况。
  au.autoDownload = false
  // 下载是用户主动点的 → 退出时装上是对的（用户点了下载就是想升级）。
  // 下载完成时也会弹窗问「现在重启 / 关闭后安装」，这里只是兜底：用户没在弹窗里选、直接关窗也能装上。
  au.autoInstallOnAppQuit = true
  au.logger = {
    info: (m: unknown) => log('info', 'main', 'updater', String(m)),
    warn: (m: unknown) => log('warn', 'main', 'updater', String(m)),
    error: (m: unknown) => log('error', 'main', 'updater', String(m)),
    debug: (m: string) => log('debug', 'main', 'updater', m),
  }
  if (src.override) {
    // 下载阶段 electron-updater 还会读 app-update.yml（取 updaterCacheDirName），
    // 这一步不在“检查”路径上：只用环境变量临时换源、包里又没打进这个文件的构建会在这里 ENOENT。
    // 给它指一个临时生成的配置（必须先设 updateConfigPath，它的 setter 会清空 clientPromise）。
    if (!existsSync(ymlPath)) {
      try {
        const tmp = join(app.getPath('temp'), 'lingshell-app-update.yml')
        writeFileSync(tmp, `provider: generic\nurl: ${src.url}\nupdaterCacheDirName: lingshell-updater\n`)
        ;(au as unknown as { updateConfigPath: string }).updateConfigPath = tmp
      } catch (e) {
        log('warn', 'main', 'updater', `临时更新配置写入失败：${String(e)}`)   // i18n-ignore 日志
      }
    }
    au.setFeedURL({ provider: 'generic', url: src.url })
  }
  log('info', 'main', 'updater', `更新源 ${src.url}${src.override ? '（环境变量 LINGSHELL_UPDATE_URL）' : ''}，当前版本 ${app.getVersion()}`)   // i18n-ignore 日志

  status = { state: 'none' }
  for (const ev of EVENTS) {
    au.on(ev, (arg?: unknown) => {
      const next = nextUpdateStatus(status, ev, arg)
      if (!next) return
      const wasDownloaded = status.state === 'downloaded'
      status = next
      emit(status)
      if (ev === 'update-downloaded' && !wasDownloaded) notify(win, tr('灵壳 {version} 已下载', { version: status.version ?? '' }), tr('点「立即重启安装」，或关闭灵壳时自动安装'))
    })
  }

  /**
   * 用户点了更新图标：真正开始下载。
   * 已经在下载 / 已下载好就只回状态，不重复触发。
   */
  const download = async (): Promise<UpdateStatus> => {
    if (status.state === 'downloading' || status.state === 'downloaded') return status
    if (status.state !== 'available') return status   // 没有待下载的版本：先让界面去 check
    try { await au.downloadUpdate() } catch (e) {
      const cur: UpdateStatus = status
      if (cur.state !== 'error') { status = nextUpdateStatus(cur, 'error', e) ?? cur; emit(status) }
    }
    return status
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
  // 之后每小时看一次：有新版会经 update:status 事件推到界面（顶栏出现更新图标）
  const hourly = setInterval(() => { void check() }, 60 * 60 * 1000)
  hourly.unref?.()   // 不因为它拖着进程不退出
  return {
    status: () => status,
    check,
    download,
    // 静默安装并重启；仅在已下载时生效
    install: () => { if (status.state === 'downloaded') au.quitAndInstall(true, true) },
  }
}
