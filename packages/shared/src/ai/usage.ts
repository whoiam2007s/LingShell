// 用量与花费统计：每次模型请求一条记录（usage.jsonl），聚合在主进程做，UI 只拿汇总。
// 单价默认空——不内置可能过时/错误的官方价，用户自己填；没填的模型只计 tokens 不计钱。
import { tk, tr } from '../i18n/i18n.js'

export interface UsageRecord {
  at: string              // ISO 时间戳
  sessionId: string       // '' = 不属于会话的一次性调用（如自然语言转命令）
  provider: string
  model: string
  input: number           // 未命中缓存的输入 tokens
  cacheRead: number       // 命中缓存的输入 tokens
  output: number
  unattended?: boolean    // 定时巡检（无人值守）会话
  source?: string         // 非会话调用的来源标签（如 'nl-command'）
}

export type UsageCurrency = 'CNY' | 'USD'
// 每 1M tokens 的单价；某项不填按 0 算
export interface ModelPrice { provider: string; model: string; input?: number; cacheRead?: number; output?: number }
export interface UsagePrices { currency: UsageCurrency; models: ModelPrice[] }
export const DEFAULT_USAGE_PRICES: UsagePrices = { currency: 'CNY', models: [] }
// 界面内广播：单价保存后，各处显示的花费（如对话头部「本会话 tokens」）重新拉取
export const USAGE_PRICES_EVENT = 'lingshell:usage-prices'
export const CURRENCY_SYMBOL: Record<UsageCurrency, string> = { CNY: '¥', USD: '$' }

export type UsageRange = 'today' | '7d' | '30d' | 'all'
export const USAGE_RANGES: { id: UsageRange; label: string }[] = [
  { id: 'today', label: tk('今天') }, { id: '7d', label: tk('7 天') }, { id: '30d', label: tk('30 天') }, { id: 'all', label: tk('全部') },
]

export interface UsageTotals {
  requests: number
  input: number
  cacheRead: number
  output: number
  cost?: number           // 只累计已设单价的请求；一条都没设 = undefined（显示「未设置单价」）
  unpriced: number        // 没设单价的请求数
}
export interface UsageSummary {
  range: UsageRange
  currency: UsageCurrency
  totals: UsageTotals
  days: (UsageTotals & { day: string })[]                         // 本地日期 YYYY-MM-DD，升序，有记录的日子
  sessions: (UsageTotals & { sessionId: string; unattended: boolean })[]   // 按 tokens 降序，最多 topN
  models: (UsageTotals & { provider: string; model: string })[]   // 按 tokens 降序
  bySource: { chat: UsageTotals; inspection: UsageTotals; other: UsageTotals }
}

const emptyTotals = (): UsageTotals => ({ requests: 0, input: 0, cacheRead: 0, output: 0, unpriced: 0 })
export const totalTokens = (t: Pick<UsageTotals, 'input' | 'cacheRead' | 'output'>) => t.input + t.cacheRead + t.output

/** 缓存命中率 = 命中 / 全部输入；没有输入返回 0 */
export const cacheHitRate = (t: Pick<UsageTotals, 'input' | 'cacheRead'>) => {
  const all = t.input + t.cacheRead
  return all > 0 ? t.cacheRead / all : 0
}

export const priceOf = (prices: UsagePrices, provider: string, model: string) =>
  prices.models.find((p) => p.provider === provider && p.model === model)

/** 单条记录的花费；没设单价返回 undefined */
export function costOf(r: Pick<UsageRecord, 'provider' | 'model' | 'input' | 'cacheRead' | 'output'>, prices: UsagePrices): number | undefined {
  const p = priceOf(prices, r.provider, r.model)
  if (!p) return undefined
  return (r.input * (p.input ?? 0) + r.cacheRead * (p.cacheRead ?? 0) + r.output * (p.output ?? 0)) / 1_000_000
}

/** 本地日期键 YYYY-MM-DD（按用户所在时区分天） */
export function dayKey(at: string | number | Date): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 范围起点（毫秒）：今天 = 本地零点，7 天 = 含今天往前 7 个自然日；全部 = 0 */
export function rangeStart(range: UsageRange, now = new Date()): number {
  if (range === 'all') return 0
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime()
}

function add(t: UsageTotals, r: UsageRecord, cost: number | undefined): void {
  t.requests++; t.input += r.input; t.cacheRead += r.cacheRead; t.output += r.output
  if (cost === undefined) t.unpriced++
  else t.cost = (t.cost ?? 0) + cost
}

const byTokens = (a: UsageTotals, b: UsageTotals) => totalTokens(b) - totalTokens(a)

/** 按范围聚合：总计 / 每天 / 会话 / 模型 / 来源（对话·巡检·其它） */
export function summarizeUsage(records: UsageRecord[], prices: UsagePrices, range: UsageRange, now = new Date(), topN = 20): UsageSummary {
  const from = rangeStart(range, now)
  const totals = emptyTotals()
  const days = new Map<string, UsageTotals & { day: string }>()
  const sessions = new Map<string, UsageTotals & { sessionId: string; unattended: boolean }>()
  const models = new Map<string, UsageTotals & { provider: string; model: string }>()
  const bySource = { chat: emptyTotals(), inspection: emptyTotals(), other: emptyTotals() }
  for (const r of records) {
    if (from && Date.parse(r.at) < from) continue
    const cost = costOf(r, prices)
    add(totals, r, cost)
    const d = dayKey(r.at)
    add(days.get(d) ?? days.set(d, { ...emptyTotals(), day: d }).get(d)!, r, cost)
    const mk = `${r.provider}\n${r.model}`
    add(models.get(mk) ?? models.set(mk, { ...emptyTotals(), provider: r.provider, model: r.model }).get(mk)!, r, cost)
    add(!r.sessionId ? bySource.other : r.unattended ? bySource.inspection : bySource.chat, r, cost)
    if (r.sessionId) {
      const s = sessions.get(r.sessionId) ?? sessions.set(r.sessionId, { ...emptyTotals(), sessionId: r.sessionId, unattended: !!r.unattended }).get(r.sessionId)!
      add(s, r, cost)
    }
  }
  return {
    range, currency: prices.currency, totals,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    sessions: [...sessions.values()].sort(byTokens).slice(0, topN),
    models: [...models.values()].sort(byTokens),
    bySource,
  }
}

/** 某会话的累计（聊天头部「本会话 12.3k tokens」） */
export function sessionUsage(records: UsageRecord[], prices: UsagePrices, sessionId: string): UsageTotals {
  const t = emptyTotals()
  for (const r of records) if (r.sessionId === sessionId) add(t, r, costOf(r, prices))
  return t
}

/** 12345 → 12.3k；1234567 → 1.23M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

export function fmtCost(cost: number | undefined, currency: UsageCurrency): string {
  if (cost === undefined) return tr('未设置单价')
  return `${CURRENCY_SYMBOL[currency]}${cost < 0.01 && cost > 0 ? cost.toFixed(4) : cost.toFixed(2)}`
}
