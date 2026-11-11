// 会话标签栏 + 「…」下拉共用的纯逻辑（不含 React、DOM 访问，方便单测）。
//
// 设计约定：
//  - 标签栏只放「手动打开过」的会话（当前会话永远在），最多 MAX_TABS 个；再多收进「…」下拉。
//  - 下拉固定给「最近 RECENT_N 条」会话（按最后活跃排序），当前会话高亮主题色（不打勾）。
//  - 关闭标签 = 只是从标签栏移除，不删会话（删会话走历史抽屉）。
import type { SessionMeta } from '@lingshell/shared'

/** 标签栏最多显示多少个（再多就收进「…」） */
export const MAX_TABS = 6
/** 下拉里展示多少条最近会话 */
export const RECENT_N = 10
/** localStorage 键（只存 id 数组） */
export const TABS_KEY = 'lingshell.chat.tabs'

export interface TabInfo {
  id: string
  title: string
  /** 相对时间文案由调用方传，纯函数不碰中文 */
  when?: string
}

/** 标签上最多显示多少个字符（超出截断加省略号） */
export const TAB_TITLE_MAX = 16

/** 标签标题：去换行 + 截断；空标题返回空串（占位文案由调用方 tr() 给） */
export function tabTitle(raw: string | undefined): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > TAB_TITLE_MAX ? `${t.slice(0, TAB_TITLE_MAX)}…` : t
}

/** 最近 N 条会话：按最后活跃时间倒序，当前会话一定在里面 */
export function recentSessions(sessions: readonly SessionMeta[], activeId: string, n = RECENT_N): SessionMeta[] {
  const byTime = (a: SessionMeta, b: SessionMeta) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')
  const sorted = [...sessions].sort(byTime)
  const out = sorted.slice(0, n)
  if (activeId && !out.some((s) => s.id === activeId)) {
    const active = sessions.find((s) => s.id === activeId)
    if (active) out.unshift(active)
  }
  return out.slice(0, Math.max(1, n))
}

/** 打开一个标签：已存在就不动；新加的放末尾；超过上限时丢最久没用的（当前会话不丢） */
export function openTab(ids: readonly string[], id: string, activeId?: string, max = MAX_TABS): string[] {
  if (!id) return [...ids]
  if (ids.includes(id)) return [...ids]
  const next = [...ids, id]
  while (next.length > max) {
    const at = next.findIndex((x) => x !== activeId && x !== id)
    next.splice(at < 0 ? 0 : at, 1)
  }
  return next
}

/** 关闭一个标签（当前会话关不掉，避免空标签栏） */
export function closeTab(ids: readonly string[], id: string, activeId?: string): string[] {
  if (id === activeId) return [...ids]
  return ids.filter((x) => x !== id)
}

/** 读持久化结果：只保留仍然存在的会话，并保证当前会话在末尾 */
export function restoreTabs(raw: unknown, existing: readonly string[], activeId: string, max = MAX_TABS): string[] {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  const seen = new Set<string>()
  const kept = list.filter((id) => existing.includes(id) && !seen.has(id) && seen.add(id))
  return openTab(kept.slice(0, max), activeId, activeId, max)
}

/** 切成两个用于渲染的集合：直接显示的标签 + 收进「…」的部分 */
export function splitTabs(ids: readonly string[], max = MAX_TABS): { shown: string[]; overflow: number } {
  if (ids.length <= max) return { shown: [...ids], overflow: 0 }
  // 留一格给「…」按钮本身
  return { shown: ids.slice(0, max - 1), overflow: ids.length - (max - 1) }
}
