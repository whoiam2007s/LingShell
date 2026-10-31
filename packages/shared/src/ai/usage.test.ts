import { describe, it, expect } from 'vitest'
import { summarizeUsage, sessionUsage, costOf, cacheHitRate, rangeStart, dayKey, fmtTokens, fmtCost, DEFAULT_USAGE_PRICES, type UsageRecord, type UsagePrices } from './usage.js'

const NOW = new Date(2026, 9, 13, 15, 0, 0)   // 本地 2026-10-13 15:00
const at = (daysAgo: number, h = 10) => new Date(2026, 9, 13 - daysAgo, h).toISOString()
const rec = (p: Partial<UsageRecord> & { at: string }): UsageRecord => ({ sessionId: 's1', provider: 'deepseek', model: 'm1', input: 100, cacheRead: 300, output: 50, ...p })
const PRICES: UsagePrices = { currency: 'CNY', models: [{ provider: 'deepseek', model: 'm1', input: 2, cacheRead: 0.5, output: 8 }] }

describe('usage 计算', () => {
  it('花费：有单价按每 1M 算，没单价 undefined；某项不填按 0', () => {
    expect(costOf(rec({ at: at(0), input: 1_000_000, cacheRead: 2_000_000, output: 500_000 }), PRICES)).toBeCloseTo(2 + 1 + 4)
    expect(costOf(rec({ at: at(0), model: 'other' }), PRICES)).toBeUndefined()
    expect(costOf(rec({ at: at(0), input: 1_000_000, output: 1_000_000 }), { currency: 'USD', models: [{ provider: 'deepseek', model: 'm1', output: 1 }] })).toBeCloseTo(1)
  })

  it('缓存命中率 = 命中 / 全部输入；无输入为 0', () => {
    expect(cacheHitRate({ input: 100, cacheRead: 300 })).toBe(0.75)
    expect(cacheHitRate({ input: 0, cacheRead: 0 })).toBe(0)
  })

  it('范围起点：今天 = 本地零点，7 天含今天', () => {
    expect(rangeStart('today', NOW)).toBe(new Date(2026, 9, 13).getTime())
    expect(rangeStart('7d', NOW)).toBe(new Date(2026, 9, 7).getTime())
    expect(rangeStart('30d', NOW)).toBe(new Date(2026, 8, 14).getTime())
    expect(rangeStart('all', NOW)).toBe(0)
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  const records = [
    rec({ at: at(0) }),
    rec({ at: at(0, 12), sessionId: 's2', model: 'm2', input: 1000, cacheRead: 0, output: 1000 }),
    rec({ at: at(3), sessionId: 'insp', unattended: true }),
    rec({ at: at(10), sessionId: '', source: 'nl-command', input: 10, cacheRead: 0, output: 5 }),
    rec({ at: at(40) }),
  ]

  it('范围过滤 + 按天 / 会话 / 模型 / 来源聚合', () => {
    const today = summarizeUsage(records, PRICES, 'today', NOW)
    expect(today.totals.requests).toBe(2)
    expect(today.days.map((d) => d.day)).toEqual(['2026-10-13'])
    expect(today.sessions.map((s) => s.sessionId)).toEqual(['s2', 's1'])   // tokens 降序

    const w = summarizeUsage(records, PRICES, '7d', NOW)
    expect(w.totals.requests).toBe(3)
    expect(w.days.map((d) => [d.day, d.requests])).toEqual([['2026-10-10', 1], ['2026-10-13', 2]])
    expect(w.bySource.inspection.requests).toBe(1)
    expect(w.sessions.find((s) => s.sessionId === 'insp')?.unattended).toBe(true)

    const m = summarizeUsage(records, PRICES, '30d', NOW)
    expect(m.bySource).toMatchObject({ chat: { requests: 2 }, inspection: { requests: 1 }, other: { requests: 1, input: 10 } })
    expect(m.sessions.some((s) => s.sessionId === '')).toBe(false)   // 会话外调用不进会话表
    expect(m.models.map((x) => [x.model, x.requests])).toEqual([['m2', 1], ['m1', 3]])

    expect(summarizeUsage(records, PRICES, 'all', NOW).totals.requests).toBe(5)
  })

  it('花费只累计已设单价的请求，并记未设单价的次数；全没设 = undefined', () => {
    const s = summarizeUsage(records, PRICES, 'today', NOW)
    expect(s.totals.cost).toBeCloseTo((100 * 2 + 300 * 0.5 + 50 * 8) / 1e6)
    expect(s.totals.unpriced).toBe(1)
    expect(s.models.find((x) => x.model === 'm2')?.cost).toBeUndefined()
    const none = summarizeUsage(records, DEFAULT_USAGE_PRICES, 'all', NOW)
    expect(none.totals.cost).toBeUndefined()
    expect(none.totals.unpriced).toBe(5)
  })

  it('单会话累计', () => {
    const t = sessionUsage(records, PRICES, 's1')
    expect(t).toMatchObject({ requests: 2, input: 200, cacheRead: 600, output: 100 })
  })

  it('格式化', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.23k')
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(100000)).toBe('100k')
    expect(fmtTokens(1_500_000)).toBe('1.5M')
    expect(fmtCost(undefined, 'CNY')).toBe('未设置单价')
    expect(fmtCost(1.234, 'USD')).toBe('$1.23')
    expect(fmtCost(0.0012, 'CNY')).toBe('¥0.0012')
  })
})
