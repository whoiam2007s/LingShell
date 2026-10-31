// 启动与后台（设置 → 通用 →「启动与后台」）：开机自启 / 关窗进托盘 / 悬浮球。主进程见 desktop/main/app/background.ts

/** 设置页读写的状态。openAtLogin / startHidden 是系统里登录项的实际状态（不落盘），其余存 <config>/background.json */
export interface BackgroundStatus {
  openAtLogin: boolean
  startHidden: boolean          // 开机自启时只进托盘，不弹主窗口
  loginSupported: boolean       // Linux 不支持
  startHiddenSupported: boolean // 只有 Windows 的登录项能带 --hidden；macOS 13+ 的登录项不能隐藏启动
  dev: boolean                  // 开发版：登录项注册的是 electron.exe + 参数，以安装版为准
  closeToTray: boolean          // 点窗口 × 隐藏到托盘而不退出（默认开）
  ball: boolean                 // 显示悬浮球（默认关）
  ballOpacity: number           // 40–100（%）
  ballAutoHide: boolean         // 贴边自动半隐藏（默认开）
}
export type BackgroundPatch = Partial<Pick<BackgroundStatus, 'openAtLogin' | 'startHidden' | 'closeToTray' | 'ball' | 'ballOpacity' | 'ballAutoHide'>>
export const BALL_OPACITIES = [40, 60, 80, 100] as const
export const clampBallOpacity = (v: unknown): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(100, Math.max(40, n)) : 100
}

/** 托盘 / 悬浮球菜单里要界面去做的动作（主进程先显示主窗口，再发 tray:action 事件） */
export type TrayUiAction =
  | { type: 'newSession' }
  | { type: 'newLocal' }
  | { type: 'connectHost'; hostId: string }
  | { type: 'dashboard' }
  | { type: 'settings' }
  | { type: 'focusChat' }

/** 悬浮球页面收到的状态（锁定时已裁剪，只剩 locked） */
export interface BallView {
  locked: boolean
  look: 'idle' | 'running' | 'waiting' | 'alert' | 'locked'
  badge: number
  sessionCount: number          // 进行中的会话总数（sessions 最多只带 5 条，标题栏用总数）
  theme: string                 // 界面主题 id（data-theme）
  kind: 'dark' | 'light'
  sessions: { id: string; title: string; status: 'running' | 'waiting' }[]
  approvals: { approvalId: string; sessionId: string; command: string; host?: string }[]
  watchdog: { paused: boolean; firing: number }
  transfers: { active: number; percent?: number }
  stats?: { title: string; cpuPct?: number; memPct?: number }
  error?: string                // 最近出错的会话标题
  // 悬停展开时的布局：卡片往哪边展开、球在卡片的上沿还是下沿
  expanded: boolean
  side: 'left' | 'right'
  valign: 'top' | 'bottom'
}
