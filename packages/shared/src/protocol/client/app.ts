// AppClient 的应用级：设置、布局、系统对话框与更新、配置导出导入、应用锁、外观、启动与后台、全局热键、ssh:// 链接。主进程注册见 apps/desktop/src/main/app/register.ts，渲染层实现见 apps/ui/src/client/transports/ipc/app.ts
import type { AppSettings, AppLayout, AppInfo } from '../types.js'
import type { UpdateStatus } from '../events.js'
import type { ConfigExportOpts, ConfigPreview, ConfigImportOpts, ConfigImportReport } from '../../ops/index.js'
import type { LockStatus, UnlockResult } from '../../ui/index.js'

export interface AppApi {
  settings: {
    // 读取设置（apiKey 不回传明文，仅 hasApiKey 标记是否已配）
    get(): Promise<AppSettings>
    // 保存设置（apiKey 有值时经 safeStorage 加密存储；为空表示不修改已存的 key）
    save(settings: AppSettings): Promise<void>
  }
  // Phase 4：终端布局 + 活动会话持久化。save 浅合并（只覆盖传入字段），
  // 终端区只传 terminals、会话区只传 activeSessionId，互不抹除。
  layout: {
    get(): Promise<AppLayout>
    save(patch: Partial<AppLayout>): Promise<void>
  }
  // 系统级：目录选择器等
  system: {
    // 打开原生目录选择器，返回选中的绝对路径（取消则 undefined）
    pickDirectory(): Promise<string | undefined>
    // 弹保存框写文本文件，返回路径（取消则 undefined）
    saveTextFile(defaultName: string, content: string): Promise<string | undefined>
    // 导出脱敏诊断包（弹保存框，完成后在文件管理器定位），返回路径（取消则 undefined）
    exportDiagnostics(): Promise<string | undefined>
    // 自动更新：当前版本 + 状态；checkUpdate 触发一次检查（未配置更新源时直接返回 disabled）；
    // installUpdate 仅在 downloaded 后由用户点「重启以更新」调用。状态变化经 update:status 事件推送
    getUpdateStatus(): Promise<{ currentVersion: string; status: UpdateStatus }>
    checkUpdate(): Promise<UpdateStatus>
    installUpdate(): Promise<void>
    // 系统通知 + 任务栏闪烁（长命令完成 / 关键字告警，由终端判断该不该发）；应用锁定时主进程换成通用文案
    notify(title: string, body: string): Promise<void>
    // 版本 / 运行环境 / 数据与日志目录（只读）；打开数据目录或日志目录（主进程决定路径）
    appInfo(): Promise<AppInfo>
    openDir(which: 'data' | 'logs'): Promise<void>
    // 重启应用（切换界面语言后用）：走正常退出流程，录像 / 日志照常收尾
    relaunch(): Promise<void>
  }
  // 配置导出/导入：export 弹保存框返回路径（取消 undefined）；pickImport 弹打开框返回预览（文件路径留在主进程）；
  // import 导入最近一次 pickImport 选中的文件，密码错抛错且不写任何内容
  configBackup: {
    export(opts: ConfigExportOpts): Promise<string | undefined>
    pickImport(): Promise<{ fileName: string; preview: ConfigPreview } | undefined>
    import(opts: ConfigImportOpts): Promise<ConfigImportReport>
  }
  // 应用锁（主密码）：锁定期间主进程只放行 status/unlock/lock 等少数通道，其余抛 locked
  lock: {
    status(): Promise<LockStatus>
    lock(): Promise<void>
    unlock(password: string): Promise<UnlockResult>
    setPassword(next: string, current?: string): Promise<void>   // 首次设置不需 current；修改需当前密码
    disable(current: string): Promise<void>
  }
  // ssh:// 链接唤起（见 desktop/main/app/sshUrl.ts）：冷启动时带的链接由 UI 挂载后取走（只取一次）
  sshUrl: {
    takePending(): Promise<import('../../terminal/index.js').SshUrlTarget | null>
  }
  // 界面外观（见 desktop/main/app/appearance.ts）：即时应用原生主题 + 界面缩放（不落盘，落盘走 settings.save）
  appearance: {
    apply(look: { uiTheme?: import('../../ui/index.js').UiTheme; uiThemeDark?: import('../../ui/index.js').ThemeId; uiThemeLight?: import('../../ui/index.js').ThemeId; uiZoom?: number }): Promise<void>
  }
  // 连按两下 Alt 呼出（设置 → 通用，见 desktop/main/app/globalHotkey.ts）：检测是否在运行（registered=false 且 enabled = 不支持 / 加载失败，error 说明）
  globalHotkey: {
    status(): Promise<{ enabled: boolean; key: string | null; registered: boolean; error?: string }>
  }
  // 启动与后台（设置 → 通用，见 desktop/main/app/background.ts）：开机自启 / 关窗进托盘 / 悬浮球，改动即时生效，返回最新状态
  background: {
    status(): Promise<import('../../ui/index.js').BackgroundStatus>
    configure(patch: import('../../ui/index.js').BackgroundPatch): Promise<import('../../ui/index.js').BackgroundStatus>
  }
}
