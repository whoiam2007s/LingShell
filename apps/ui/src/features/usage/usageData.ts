// 用量统计弹窗的纯逻辑（可测）：菜单定义、补零的每日序列、排序、占比（尾部并入「其它」）、打开弹窗的窗口事件
import { dayKey, rangeStart, tk, type UsageSummary, type UsageTotals } from '@lingshell/shared'

export type UsageView = 'overview' | 'daily' | 'source' | 'session' | 'model' | 'prices'
export const USAGE_VIEWS: { id: UsageView; label: string }[] = [
  { id: 'overview', label: tk('总览') }, { id: 'daily', label: tk('按日趋势') }, { id: 'source', label: tk('按来源') },
  { id: 'session', label: tk('按会话') }, { id: 'model', label: tk('按模型') }, { id: 'prices', label: tk('单价设置') },
]
// label 显示时再 tr()
export const SOURCES = [['chat', tk('对话')], ['inspection', tk('定时巡检')], ['other', tk('其它（会话外调用）')]] as const

// 打开弹窗（标题栏按钮 / 命令面板 / 帮助链接 / 对话头部「本会话 tokens」都走这里，组件树隔得远，用窗口事件）
export const USAGE_OPEN_EVENT = 'lingshell:usage-open'
export function openUsage(view: UsageView = 'overview'): void {
  window.dispatchEvent(new CustomEvent<UsageView>(USAGE_OPEN_EVENT, { detail: view }))
}

const empty = (): UsageTotals => ({ requests: 0, input: 0, cacheRead: 0, output: 0, unpriced: 0 })

/** 范围内每天一项，没记录的日子补 0；「全部」从第一条记录那天起 */
export function fillDays(sum: Pick<UsageSummary, 'range' | 'days'>, now = new Date()): (UsageTotals & { day: string })[] {
  const by = new Map(sum.days.map((d) => [d.day, d]))
  const first = sum.range === 'all' ? (sum.days[0] ? new Date(`${sum.days[0].day}T00:00:00`).getTime() : now.getTime()) : rangeStart(sum.range, now)
  const out: (UsageTotals & { day: string })[] = []
  for (const d = new Date(first); d.getTime() <= now.getTime(); d.setDate(d.getDate() + 1)) {
    const k = dayKey(d)
    out.push(by.get(k) ?? { ...empty(), day: k })
  }
  return out
}

export type SortDir = 'asc' | 'desc'
/** 稳定排序，不改原数组 */
export function sortRows<T>(rows: T[], key: (r: T) => number | string, dir: SortDir): T[] {
  const f = dir === 'asc' ? 1 : -1
  return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => {
    const x = key(a), y = key(b)
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return c * f || i - j
  }).map(([r]) => r)
}

/** 占比：按 value 降序，前 top-1 项保留、其余并成「其它」；总量为 0 时返回空 */
export function shares<T extends { label: string; value: number }>(items: T[], top = 6): { label: string; value: number; ratio: number; item?: T }[] {
  const sum = items.reduce((s, x) => s + x.value, 0)
  if (sum <= 0) return []
  const sorted = [...items].filter((x) => x.value > 0).sort((a, b) => b.value - a.value)
  const head = sorted.length > top ? sorted.slice(0, top - 1) : sorted
  const rest = sorted.slice(head.length).reduce((s, x) => s + x.value, 0)
  const out: { label: string; value: number; ratio: number; item?: T }[] = head.map((x) => ({ label: x.label, value: x.value, ratio: x.value / sum, item: x }))
  if (rest > 0) out.push({ label: tk('其它'), value: rest, ratio: rest / sum })   // 显示处 tr()
  return out
}
