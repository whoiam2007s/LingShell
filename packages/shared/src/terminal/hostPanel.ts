import type { AppLayout, HostSummary, SplitMode, Workspace } from '../protocol/index.js'
import { defaultSizes, paneCount } from './split.js'
import { tk, tr } from '../i18n/i18n.js'

// ── 主机面板 + 工作区（纯逻辑） ─────────────────────────────

export const RECENT_HOSTS_MAX = 10
/** 记一次连接：提到最前、去重、最多 10 条 */
export const pushRecentHost = (list: string[] | undefined, id: string) => [id, ...(list ?? []).filter((x) => x !== id)].slice(0, RECENT_HOSTS_MAX)
/** 收藏开关 */
export const toggleFavorite = (list: string[] | undefined, id: string) => (list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id]

/** 按 id 列表取主机（保持列表顺序，已删的主机跳过） */
export const pickHosts = (hosts: HostSummary[], ids: string[] | undefined) => (ids ?? []).map((id) => hosts.find((h) => h.id === id)).filter((h): h is HostSummary => !!h)

// ── 延迟探测（TCP 连 SSH 端口的耗时，不做认证） ──
// ms = 连上耗时；down = 连不上 / 超时；jump = 经跳板机连接，直连测不出，不测
export type ProbeResult = { state: 'ok'; ms: number } | { state: 'down' } | { state: 'jump' } | { state: 'proxy' }

export function probeLabel(r: ProbeResult | undefined): string {
  if (!r) return ''
  return r.state === 'ok' ? `${r.ms}ms` : r.state === 'down' ? tr('不可达') : r.state === 'proxy' ? tr('经代理') : tr('经跳板')
}
/** 颜色档：< 100ms 好、< 300ms 一般、其余慢；不可达单独一档 */
export function probeTone(r: ProbeResult | undefined): 'good' | 'fair' | 'slow' | 'down' | 'none' {
  if (!r || r.state === 'jump' || r.state === 'proxy') return 'none'
  if (r.state === 'down') return 'down'
  return r.ms < 100 ? 'good' : r.ms < 300 ? 'fair' : 'slow'
}

// ── 整组打开 ──
/** 生产主机多于 1 台时整组打开要确认 */
export const groupNeedsConfirm = (hosts: HostSummary[]) => hosts.filter((h) => h.env === 'prod').length > 1
/** n 个终端的默认分屏：2 左右、3 三列、4 四宫格，其余单屏（只开标签） */
export function autoSplitMode(n: number): SplitMode {
  return n === 2 ? 'cols2' : n === 3 ? 'cols3' : n === 4 ? 'grid4' : 'single'
}
export type WorkspaceLayout = Pick<Workspace, 'terminals' | 'activeTerminalIndex' | 'terminalSplit'>
/** 一组主机 → 临时工作区：每台一个 SSH 终端，≤4 台时自动分屏 */
export function groupLayout(hostIds: string[]): WorkspaceLayout {
  const mode = autoSplitMode(hostIds.length)
  return {
    terminals: hostIds.map((hostId) => ({ kind: 'ssh' as const, hostId })),
    activeTerminalIndex: 0,
    terminalSplit: mode === 'single' ? undefined : { mode, panes: Array.from({ length: paneCount(mode) }, (_, i) => i), sizes: defaultSizes(mode) },
  }
}

// ── 工作区存取 ──
/** 当前布局 → 工作区。tmux 会话名不带：打开工作区是新开一份，不去抢当前标签接着的那个远端会话 */
export function workspaceFromLayout(layout: AppLayout, name: string, id: string, now = new Date()): Workspace {
  return {
    id, name: name.trim(),
    terminals: layout.terminals.map(({ tmux: _tmux, ...t }) => t),
    activeTerminalIndex: layout.activeTerminalIndex,
    terminalSplit: layout.terminalSplit,
    savedAt: now.toISOString(),
  }
}
/** 保存：同名覆盖（保留原 id 与位置），否则追加 */
export function upsertWorkspace(list: Workspace[] | undefined, ws: Workspace): Workspace[] {
  const all = list ?? []
  const i = all.findIndex((w) => w.name === ws.name)
  return i < 0 ? [...all, ws] : all.map((w, k) => (k === i ? { ...ws, id: w.id } : w))
}
export const renameWorkspace = (list: Workspace[] | undefined, id: string, name: string) => (list ?? []).map((w) => (w.id === id ? { ...w, name: name.trim() } : w))
export const removeWorkspace = (list: Workspace[] | undefined, id: string) => (list ?? []).filter((w) => w.id !== id)
/** 工作区摘要：「3 个终端 · 四宫格」 */
const MODE_LABEL: Record<SplitMode, string> = { single: tk('单屏'), cols2: tk('左右分屏'), rows2: tk('上下分屏'), cols3: tk('三列'), grid4: tk('四宫格') }
export const workspaceSummary = (w: Workspace) => tr('{n} 个终端 · {mode}', { n: w.terminals.length, mode: tr(MODE_LABEL[w.terminalSplit?.mode ?? 'single']) })
