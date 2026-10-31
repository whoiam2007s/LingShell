import type { HostEnv, TerminalInfo, TerminalLayoutItem, TerminalType } from '../protocol/index.js'
import { dangerCheck } from '../ai/danger.js'
import { tk } from '../i18n/i18n.js'
import { hasHidden, stripHidden } from './termAssist.js'

// 标签的用户自定义：颜色 + 重命名 + 固定（UI 状态，随布局持久化）
export interface TabMeta { color?: string; title?: string; pinned?: boolean }

// 终端 → 布局项：ssh 必须有已存主机 id 才能重连（调用方已过滤临时 ssh）；空的自定义字段不写
// tmux：保持会话的远端会话名，重启时据此接回；shell：本地终端的非默认 shell，重启按同一 shell 重开
export function toLayoutItem(type: TerminalType, hostId: string | undefined, meta?: TabMeta, tmux?: string, shell?: string, cwd?: string, baseTitle?: string): TerminalLayoutItem {
  return {
    ...(type === 'local' ? { kind: 'local', ...(shell ? { shell } : {}), ...(cwd ? { cwd } : {}) } : { kind: 'ssh', hostId, ...(tmux ? { tmux } : {}) }),
    ...(baseTitle ? { baseTitle } : {}),
    ...(meta?.color ? { color: meta.color } : {}),
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.pinned ? { pinned: true } : {}),
  }
}

// ── 终端标签颜色 ──────────────────────────────────────
// 用户可选的标签色（存 TerminalLayoutItem.color）。生产主机未选色时自动用红色。
export const TAB_COLORS = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7',
} as const
export type TabColor = keyof typeof TAB_COLORS
export const TAB_COLOR_LABEL: Record<TabColor, string> = { red: tk('红'), orange: tk('橙'), yellow: tk('黄'), green: tk('绿'), blue: tk('蓝'), purple: tk('紫') }

// 标签实际显示的色值：用户选的优先；未选且是生产主机 → 红；否则无
export function tabAccent(color: string | undefined, env?: HostEnv): string | undefined {
  if (color && color in TAB_COLORS) return TAB_COLORS[color as TabColor]
  return env === 'prod' ? TAB_COLORS.red : undefined
}

// ── SSH 断线自动重连 ──────────────────────────────────
// 第 n 次重连前等待的秒数；用完即放弃（共 8 次，累计约 4 分半）
export const RECONNECT_DELAYS_SEC = [2, 5, 10, 30, 30, 60, 60, 60]
export const reconnectDelay = (attempt: number): number | null => RECONNECT_DELAYS_SEC[attempt - 1] ?? null

// 断线原因 'shell exited' = 用户在远端 exit / logout（见 SshTerminal），不算意外断线
export const SHELL_EXITED = 'shell exited'

// off：断开且不自动重连（why：disabled 未开 / exited 远端正常退出 / cancelled 用户取消 / gaveUp 次数用完 / local 本地终端）
export type ReconnectState =
  | { phase: 'idle' }
  | { phase: 'off'; why: 'disabled' | 'exited' | 'cancelled' | 'gaveUp' | 'local' }
  | { phase: 'waiting'; attempt: number; at: number }   // at：计划发起重连的时间戳(ms)
  | { phase: 'connecting'; attempt: number }

export type ReconnectEvent =
  | { type: 'disconnected'; ssh: boolean; enabled: boolean; reason?: string; now: number }
  | { type: 'connected' }
  | { type: 'fire' }          // 倒计时到 / 用户点「立即重连」
  | { type: 'failed'; now: number }
  | { type: 'cancel' }

// 纯状态机：UI 的 hook 只负责按 waiting.at 定时发 fire、按 connecting 调后端 reconnect
export function reconnectStep(s: ReconnectState, ev: ReconnectEvent): ReconnectState {
  switch (ev.type) {
    case 'connected': return { phase: 'idle' }
    case 'disconnected':
      if (s.phase === 'waiting' || s.phase === 'connecting') return s   // 重连中又收到断线（重复事件）不重置计数
      if (!ev.ssh) return { phase: 'off', why: 'local' }
      if (ev.reason === SHELL_EXITED) return { phase: 'off', why: 'exited' }
      if (!ev.enabled) return { phase: 'off', why: 'disabled' }
      return { phase: 'waiting', attempt: 1, at: ev.now + reconnectDelay(1)! * 1000 }
    case 'fire': return s.phase === 'waiting' ? { phase: 'connecting', attempt: s.attempt } : s
    case 'failed': {
      if (s.phase !== 'connecting') return s
      const d = reconnectDelay(s.attempt + 1)
      return d === null ? { phase: 'off', why: 'gaveUp' } : { phase: 'waiting', attempt: s.attempt + 1, at: ev.now + d * 1000 }
    }
    case 'cancel': return s.phase === 'waiting' || s.phase === 'connecting' ? { phase: 'off', why: 'cancelled' } : s
  }
}

// ── 标签拖拽排序 ──────────────────────────────────────
// 把 from 处的元素移到插入位 to（0..n，按原列表算的「插在第 to 个之前」）；无变化返回原数组
export function moveTab<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to > list.length || to === from || to === from + 1) return list
  const n = [...list]
  const [x] = n.splice(from, 1)
  n.splice(to > from ? to - 1 : to, 0, x)
  return n
}

// ── 固定标签 ──────────────────────────────────────────
// 固定的排最前（各自保持原相对顺序）；已经有序时返回原数组
export function pinFirst<T>(list: T[], pinned: (x: T) => boolean): T[] {
  const p = list.filter(pinned)
  if (list.every((x, i) => (i < p.length) === pinned(x))) return list
  return [...p, ...list.filter((x) => !pinned(x))]
}
// 拖拽插入位限制在本区内（list 已 pinFirst）：固定标签只能在固定区里挪，普通标签不能插到固定区之前
export function clampTabDrop(pinnedCount: number, total: number, fromPinned: boolean, to: number): number {
  return fromPinned ? Math.min(to, pinnedCount) : Math.min(Math.max(to, pinnedCount), total)
}
// 固定标签只显示短名（前 6 个字，超出加 …）
export const pinnedLabel = (title: string): string => [...title].length > 6 ? `${[...title].slice(0, 6).join('')}…` : title
// 「关闭其他 / 右侧 / 全部」要关的标签：跳过固定的（list 为显示顺序）
export function closeTargets<T extends { id: string }>(list: T[], id: string, which: 'others' | 'right' | 'all', pinned: (x: T) => boolean): string[] {
  const i = list.findIndex((t) => t.id === id)
  const pick = which === 'all' ? list : which === 'others' ? list.filter((t) => t.id !== id) : list.slice(i + 1)
  return pick.filter((t) => !pinned(t)).map((t) => t.id)
}

// ── 撰写栏 ────────────────────────────────────────────
export type ComposeTarget = 'active' | 'broadcast' | 'all'
export const COMPOSE_HISTORY_MAX = 50

// 历史：最新在前，去重（重复的提到最前），最多 50 条；空白不记
export function pushComposeHistory(list: readonly string[], text: string): string[] {
  if (!text.trim()) return [...list]
  return [text, ...list.filter((x) => x !== text)].slice(0, COMPOSE_HISTORY_MAX)
}

export interface ComposePlan {
  data: string                // 实际写入的内容：与粘贴同一套换行处理（\r\n / \n → 回车），末尾补回车，逐行执行
  lines: string[]             // 要执行的非空行（确认框预览）
  sends: TerminalInfo[]       // 实际发送的终端
  skipped: TerminalInfo[]     // 断开 / AI 执行中，跳过
  prod: string[]              // 收到内容的生产终端标题
  dangerous: string[]         // 命中危险命令的行
  hidden: boolean             // 含隐藏 / 控制字符（同粘贴安全检查）
  confirm: boolean            // 需要二次确认：含危险命令 / 隐藏字符，或多行发到生产终端（同「粘贴到生产终端」）
}

/** 撰写栏发送计划：target=broadcast 且广播没开时退化为当前终端 */
export function planCompose(text: string, target: ComposeTarget, activeId: string, terms: readonly TerminalInfo[], bcast: ReadonlySet<string> | null): ComposePlan {
  const body = text.replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '')
  const lines = body.split('\n').filter((l) => l.trim())
  const picked = terms.filter((t) => target === 'all' ? true : target === 'broadcast' && bcast ? bcast.has(t.id) : t.id === activeId)
  const sends = picked.filter((t) => t.status !== 'disconnected' && !t.locked)
  const prod = sends.filter((t) => t.env === 'prod').map((t) => t.title)
  const dangerous = lines.filter((l) => dangerCheck(stripHidden(l)) === 'dangerous')
  const hidden = hasHidden(body)
  return {
    data: body.replace(/\n/g, '\r') + '\r', lines, sends,
    skipped: picked.filter((t) => !sends.includes(t)), prod, dangerous, hidden,
    confirm: dangerous.length > 0 || hidden || (prod.length > 0 && lines.length > 1),
  }
}
