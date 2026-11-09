// 用量汇总：把「哪个会话 / 模型在烧钱」这类问题需要的数字整理成一段文本给 AI，
// 而不是把整串原始记录丢过去。
import type { UsageSummary, UsageTotals, UsageRange } from './usage.js'
import { cacheHitRate, totalTokens } from './usage.js'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const RANGE_LABEL: Record<UsageRange, string> = { today: '今天', '7d': '最近 7 天', '30d': '最近 30 天', all: '全部' }   // i18n-ignore 发给 AI 的话

export interface UsageDigestOpts {
  sum: UsageSummary
  /** sessionId → 会话标题 */
  sessionTitle?: (sid: string) => string | undefined
  /** 会话条数上限，默认 8 */
  topN?: number
}

export function usageDigest({ sum, sessionTitle, topN = 8 }: UsageDigestOpts): string {
  const t: UsageTotals = sum.totals
  if (!t.requests) return `【用量】${RANGE_LABEL[sum.range] ?? sum.range}还没有任何模型调用记录。`   // i18n-ignore 发给 AI 的话
  const money = (x?: number) => (x === undefined ? '未设单价' : `${sum.currency} ${x.toFixed(4)}`)   // i18n-ignore 发给 AI 的话
  const row = (label: string, u: UsageTotals & { cost?: number }) =>
    `- ${label}：${u.requests} 次 · ${totalTokens(u)} tokens（输入 ${u.input}、缓存读 ${u.cacheRead}、输出 ${u.output}）· 缓存命中 ${pct(cacheHitRate(u))} · ${money(u.cost)}`   // i18n-ignore 发给 AI 的话
  const out = [
    `【用量】范围：${RANGE_LABEL[sum.range] ?? sum.range}，共 ${t.requests} 次请求。`,   // i18n-ignore 发给 AI 的话
    row('合计', { ...t, cost: sum.sessions.reduce((a, s) => a + (s.cost ?? 0), 0) || undefined }),   // i18n-ignore 发给 AI 的话
    `按来源：对话 ${sum.bySource.chat.requests} 次 · 巡检 ${sum.bySource.inspection.requests} 次 · 其它 ${sum.bySource.other.requests} 次`,   // i18n-ignore 发给 AI 的话
    '按模型（tokens 降序）：',   // i18n-ignore 发给 AI 的话
    ...(sum.models.length ? sum.models.slice(0, topN).map((m) => row(`${m.provider}/${m.model}`, m)) : ['- 无']),   // i18n-ignore 发给 AI 的话
    '按会话（tokens 降序）：',   // i18n-ignore 发给 AI 的话
    ...(sum.sessions.length ? sum.sessions.slice(0, topN).map((s) => row(sessionTitle?.(s.sessionId) ?? s.sessionId.slice(0, 8), s)) : ['- 无']),   // i18n-ignore 发给 AI 的话
    t.unpriced ? `注意：有 ${t.unpriced} 次请求因为没设单价，成本算不出来（设置 → 用量 → 单价）。` : '',   // i18n-ignore 发给 AI 的话
    '说明：这是本地记录的调用量，不是账单；要我分析怎么省 token 可以直接问。',   // i18n-ignore 发给 AI 的话
  ].filter(Boolean)
  return out.join('\n')
}
