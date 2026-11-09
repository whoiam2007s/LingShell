import { describe, it, expect } from 'vitest'
import { usageDigest } from './usageDigest.js'
import type { UsageSummary, UsageTotals } from './usage.js'

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  requests: 0, input: 0, cacheRead: 0, output: 0, unpriced: 0, ...over,
})

const sum = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  range: '7d', currency: 'CNY',
  totals: totals({ requests: 10, input: 1000, cacheRead: 6000, output: 500 }),
  days: [], sessions: [], models: [],
  bySource: { chat: totals({ requests: 8 }), inspection: totals({ requests: 2 }), other: totals() },
  ...over,
})

describe('用量 → 上下文摘要', () => {
  it('没有调用记录时给一句人话', () => {
    const t = usageDigest({ sum: sum({ totals: totals() }) })
    expect(t).toContain('没有任何模型调用记录')
  })

  it('合计带 token 三段与缓存命中率', () => {
    const t = usageDigest({ sum: sum() })
    expect(t).toContain('共 10 次请求')
    expect(t).toContain('7500 tokens')
    expect(t).toContain('输入 1000')
    expect(t).toContain('缓存读 6000')
    expect(t).toContain('输出 500')
    expect(t).toContain('缓存命中 85.7%')
  })

  it('按模型 / 按会话列出，会话用标题而不是 id', () => {
    const t = usageDigest({
      sum: sum({
        models: [{ ...totals({ requests: 6, input: 100, cacheRead: 0, output: 50 }), provider: 'deepseek', model: 'deepseek-chat' }],
        sessions: [{ ...totals({ requests: 4, input: 10, cacheRead: 0, output: 5 }), sessionId: 'abcdef123456', unattended: false }],
      }),
      sessionTitle: (id) => (id === 'abcdef123456' ? '修 nginx 502' : undefined),
    })
    expect(t).toContain('deepseek/deepseek-chat')
    expect(t).toContain('修 nginx 502')
    expect(t).not.toContain('abcdef123456')
  })

  it('有未设单价的请求要提示', () => {
    const t = usageDigest({ sum: sum({ totals: totals({ requests: 3, unpriced: 2 }) }) })
    expect(t).toContain('2 次请求因为没设单价')
  })
})
