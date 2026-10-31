// 托盘 / 悬浮球的纯逻辑：状态快照 → tooltip、菜单模型（纯数据，background.ts 再转 Electron Menu）、球身样子与状态卡数据。
// 锁定时一律裁剪：不露会话标题、命令、主机，菜单只留「显示主窗口 / 退出」（悬浮球多一个「隐藏悬浮球」）。
import { BALL_OPACITIES, clampBallOpacity, tr, type BallView, type TrayUiAction } from '@lingshell/shared'

export type BgAction =
  | { type: 'show' }
  | { type: 'toggleWindow' }
  | { type: 'ui'; action: TrayUiAction }
  | { type: 'openSession'; sessionId: string }
  | { type: 'watchdogPause'; paused: boolean }
  | { type: 'toggleBall' }
  | { type: 'hideBall' }
  | { type: 'lock' }
  | { type: 'opacity'; value: number }
  | { type: 'quit' }

export interface MenuNode {
  label?: string
  type?: 'separator' | 'checkbox' | 'radio'
  checked?: boolean
  enabled?: boolean
  action?: BgAction
  submenu?: MenuNode[]
}

export interface BgApproval { approvalId: string; sessionId: string; sessionTitle: string; command: string; host?: string }
export interface BgSnapshot {
  locked: boolean
  lockEnabled: boolean
  sessions: { id: string; title: string; status: 'running' | 'waiting' }[]
  approvals: BgApproval[]
  watchdog: { paused: boolean; firing: number }
  transfers: { active: number; percent?: number }
  stats?: { title: string; cpuPct?: number; memPct?: number }
  error?: string
  hosts: { id: string; label: string }[]
  ball: boolean
  ballOpacity: number
}

export const MAX_MENU_HOSTS = 30
export const MAX_MENU_APPROVALS = 15
export const MAX_CARD_SESSIONS = 5

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
export const cut = (s: string, n: number) => {
  const t = oneLine(s)
  if (t.length <= n) return t
  // 截断点落在 emoji 的代理对中间时往前退一个，别显示成半个乱码
  let end = n
  const c = t.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${t.slice(0, end)}…`
}

/** 开机自启登录项是不是本应用自己的（安装目录改名后要修的那种）：名字精确匹配，或路径里有 LingShell 目录 */
export function isOwnLoginItem(i: { name?: string; path?: string }): boolean {
  const name = (i.name ?? '').trim()
  if (/^(灵壳( ling ?shell)?|lingshell)$/i.test(name)) return true
  return /(^|[\\/])LingShell([\\/]|$)/i.test(i.path ?? '')
}
/** 菜单里的标签：Windows 原生菜单把 & 当助记符，原样显示要写成 && */
const esc = (s: string) => s.replace(/&/g, '&&')

/** 锁定时裁掉一切可能敏感的内容（会话 / 命令 / 主机 / 统计），只留锁状态与开关 */
export function trimLocked(s: BgSnapshot): BgSnapshot {
  if (!s.locked) return s
  return { ...s, sessions: [], approvals: [], watchdog: { paused: s.watchdog.paused, firing: 0 }, transfers: { active: 0 }, stats: undefined, error: undefined, hosts: [] }
}

export function trayTooltip(s: BgSnapshot): string {
  if (s.locked) return tr('灵壳（已锁定）')
  return tr('灵壳 · {s} 个会话进行中 · {a} 个待授权', { s: s.sessions.length, a: s.approvals.length })
}

/** 待授权一行：会话标题 · 命令前 40 字 */
export const approvalLabel = (a: BgApproval) => esc(`${cut(a.sessionTitle, 20)} · ${cut(a.command || tr('（无命令）'), 40)}`)

function approvalsMenu(s: BgSnapshot, label: string): MenuNode {
  const n = s.approvals.length
  if (!n) return { label: tr('{label}（{n}）', { label, n: 0 }), enabled: false }
  const items: MenuNode[] = s.approvals.slice(0, MAX_MENU_APPROVALS).map((a) => ({ label: approvalLabel(a), action: { type: 'openSession', sessionId: a.sessionId } }))
  if (n > MAX_MENU_APPROVALS) items.push({ label: tr('还有 {n} 条，请在主窗口处理', { n: n - MAX_MENU_APPROVALS }), enabled: false })
  return { label: tr('{label}（{n}）', { label, n }), submenu: items }
}

const watchdogItem = (s: BgSnapshot): MenuNode => s.watchdog.paused
  ? { label: tr('看门狗：恢复全部（已暂停）'), action: { type: 'watchdogPause', paused: false } }
  : { label: s.watchdog.firing ? tr('看门狗：暂停全部（{n} 个告警）', { n: s.watchdog.firing }) : tr('看门狗：暂停全部'), action: { type: 'watchdogPause', paused: true } }

const lockItem = (s: BgSnapshot): MenuNode => ({ label: s.lockEnabled ? tr('锁定应用') : tr('锁定应用（未启用应用锁）'), enabled: s.lockEnabled, action: { type: 'lock' } })
const SEP: MenuNode = { type: 'separator' }
// 函数而不是常量：标签要在读到界面语言之后再翻译
const SHOW = (): MenuNode => ({ label: tr('显示主窗口'), action: { type: 'show' } })
const QUIT = (): MenuNode => ({ label: tr('退出'), action: { type: 'quit' } })

export function trayMenu(s: BgSnapshot): MenuNode[] {
  if (s.locked) return [SHOW(), SEP, QUIT()]
  const hosts: MenuNode[] = s.hosts.length
    ? s.hosts.slice(0, MAX_MENU_HOSTS).map((h) => ({ label: esc(cut(h.label, 40)), action: { type: 'ui', action: { type: 'connectHost', hostId: h.id } } }))
    : [{ label: tr('还没有已保存的主机'), enabled: false }]
  if (s.hosts.length > MAX_MENU_HOSTS) hosts.push({ label: tr('还有 {n} 台，请在主机面板中打开', { n: s.hosts.length - MAX_MENU_HOSTS }), enabled: false })
  return [
    SHOW(),
    SEP,
    { label: tr('新建会话'), action: { type: 'ui', action: { type: 'newSession' } } },
    { label: tr('新建本地终端'), action: { type: 'ui', action: { type: 'newLocal' } } },
    { label: tr('连接主机'), submenu: hosts },
    approvalsMenu(s, tr('待授权')),
    SEP,
    { label: tr('仪表盘'), action: { type: 'ui', action: { type: 'dashboard' } } },
    watchdogItem(s),
    { label: tr('显示悬浮球'), type: 'checkbox', checked: s.ball, action: { type: 'toggleBall' } },
    lockItem(s),
    { label: tr('设置'), action: { type: 'ui', action: { type: 'settings' } } },
    SEP,
    QUIT(),
  ]
}

export function ballMenu(s: BgSnapshot): MenuNode[] {
  const hide: MenuNode = { label: tr('隐藏悬浮球'), action: { type: 'hideBall' } }
  if (s.locked) return [SHOW(), hide, SEP, QUIT()]
  return [
    SHOW(),
    { label: tr('快速提问'), action: { type: 'ui', action: { type: 'focusChat' } } },
    approvalsMenu(s, tr('处理待授权')),
    { label: tr('打开仪表盘'), action: { type: 'ui', action: { type: 'dashboard' } } },
    watchdogItem(s),
    lockItem(s),
    { label: tr('透明度'), submenu: BALL_OPACITIES.map((v) => ({ label: `${v}%`, type: 'radio' as const, checked: s.ballOpacity === v, action: { type: 'opacity' as const, value: v } })) },
    SEP,
    hide,
    QUIT(),
  ]
}

/** 球身样子：锁定 > 待授权（橙色闪烁 + 数字）> 看门狗报警 / 最近出错（红）> AI 运行中（蓝色转环）> 空闲（灰） */
export function ballLook(s: BgSnapshot): Pick<BallView, 'look' | 'badge'> {
  if (s.locked) return { look: 'locked', badge: 0 }
  const badge = s.approvals.length
  if (badge) return { look: 'waiting', badge }
  if (s.watchdog.firing || s.error) return { look: 'alert', badge: 0 }
  if (s.sessions.length) return { look: 'running', badge: 0 }
  return { look: 'idle', badge: 0 }
}

/** <config>/background.json：缺省 / 坏值回落默认（关窗进托盘开、悬浮球关、不透明、贴边半隐藏开） */
export interface BgConfig {
  closeToTray: boolean
  trayHintShown: boolean        // 「仍在后台运行」通知只弹一次
  ball: boolean
  ballOpacity: number
  ballAutoHide: boolean
  ballPos?: { x: number; y: number; edge?: 'left' | 'right' }
}
export function normalizeBgConfig(raw: unknown): BgConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const p = c.ballPos as Record<string, unknown> | undefined
  const pos = p && Number.isFinite(p.x) && Number.isFinite(p.y)
    ? { x: Math.round(p.x as number), y: Math.round(p.y as number), ...(p.edge === 'left' || p.edge === 'right' ? { edge: p.edge as 'left' | 'right' } : {}) } : undefined
  return {
    closeToTray: c.closeToTray !== false, trayHintShown: c.trayHintShown === true,
    ball: c.ball === true, ballOpacity: clampBallOpacity(c.ballOpacity ?? 100), ballAutoHide: c.ballAutoHide !== false,
    ...(pos ? { ballPos: pos } : {}),
  }
}

/**
 * 托盘「有待授权」图标：在 BGRA 位图右上角画一个带白边的红点（原地改写）。
 * 应用图标自带深色圆角底，红点 + 白边在深浅色任务栏上都看得清
 */
export function paintBadge(bgra: Uint8Array, size: number): void {
  const r = size * 0.22, cx = size - r - 0.5, cy = r + 0.5
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    if (d > r + 1.2) continue
    const i = (y * size + x) * 4
    const [b, g, rr] = d <= r ? [0x49, 0x51, 0xf8] : [0xff, 0xff, 0xff]   // #f85149（同 --color-danger）/ 白边
    bgra[i] = b; bgra[i + 1] = g; bgra[i + 2] = rr; bgra[i + 3] = 0xff
  }
}

/** 悬浮球页面要的数据（锁定时只剩 locked + 主题 + 布局） */
export function ballView(s: BgSnapshot, layout: Pick<BallView, 'expanded' | 'side' | 'valign' | 'theme' | 'kind'>): BallView {
  const t = trimLocked(s)
  return {
    locked: t.locked, ...ballLook(t), sessionCount: t.sessions.length, ...layout,
    sessions: t.sessions.slice(0, MAX_CARD_SESSIONS).map((x) => ({ ...x, title: cut(x.title, 40) })),
    approvals: t.approvals.slice(0, 3).map((a) => ({ approvalId: a.approvalId, sessionId: a.sessionId, command: cut(a.command || tr('（无命令）'), 60), ...(a.host ? { host: a.host } : {}) })),
    watchdog: t.watchdog, transfers: t.transfers,
    ...(t.stats ? { stats: t.stats } : {}), ...(t.error ? { error: cut(t.error, 40) } : {}),
  }
}
