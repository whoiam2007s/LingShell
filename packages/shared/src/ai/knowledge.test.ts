import { describe, it, expect } from 'vitest'
import { normalizeKnowledge, relevantCards, buildKnowledgeContext, filterKnowledge, type KnowledgeCard } from './knowledge.js'

const card = (p: Partial<KnowledgeCard>): KnowledgeCard => ({
  id: p.id ?? 'kb_x', scope: 'host', target: 'h1', title: 't', content: 'c', category: 'other', updatedAt: '2026-01-01T00:00:00Z', source: 'manual', ...p,
})

describe('normalizeKnowledge', () => {
  it('必填校验、分类回落、global 清空 target', () => {
    expect(() => normalizeKnowledge({ scope: 'host', target: '', title: 'a', content: 'b', category: 'logs', source: 'ai' })).toThrow(/主机/)
    expect(() => normalizeKnowledge({ scope: 'group', target: '', title: 'a', content: 'b', category: 'logs', source: 'ai' })).toThrow(/分组/)
    expect(() => normalizeKnowledge({ scope: 'host', target: 'h', title: ' ', content: 'b', category: 'logs', source: 'ai' })).toThrow(/标题/)
    expect(() => normalizeKnowledge({ scope: 'host', target: 'h', title: 'a', content: '', category: 'logs', source: 'ai' })).toThrow(/内容/)
    const n = normalizeKnowledge({ scope: 'global', target: 'x', title: ' 标题 ', content: ' 内容 ', category: 'bad' as never, source: 'x' as never })
    expect(n).toEqual({ scope: 'global', target: '', title: '标题', content: '内容', category: 'other', source: 'manual' })
  })
})

describe('relevantCards / buildKnowledgeContext', () => {
  const cards = [
    card({ id: 'g1', scope: 'global', target: '', title: '全局', updatedAt: '2026-01-03T00:00:00Z' }),
    card({ id: 'h1old', target: 'h1', title: '旧', updatedAt: '2026-01-01T00:00:00Z' }),
    card({ id: 'h1new', target: 'h1', title: '新', updatedAt: '2026-01-05T00:00:00Z', category: 'logs' }),
    card({ id: 'grp', scope: 'group', target: 'web', title: '组' }),
    card({ id: 'other', target: 'h2', title: '别的主机' }),
    card({ id: 'grp2', scope: 'group', target: 'db', title: '别的组' }),
  ]
  const hosts = [{ hostKey: 'h1', label: 'web-1', group: 'web' }]
  it('主机 → 分组 → 全局，段内新的在前；无关主机 / 分组不选', () => {
    expect(relevantCards(cards, hosts).map((c) => c.id)).toEqual(['h1new', 'h1old', 'grp', 'g1'])
  })
  it('注入文本带 id / 标题 / 归属 / 分类；没有相关卡返回空', () => {
    const t = buildKnowledgeContext(cards, hosts)
    expect(t).toContain('## 主机知识库')
    expect(t).toContain('[h1new] 新（主机「web-1」 · 日志位置 · 2026-01-05）')
    expect(t).toContain('分组「web」')
    expect(t).not.toContain('别的主机')
    expect(buildKnowledgeContext(cards, [{ hostKey: 'h9', label: 'x' }])).toContain('全局')   // 全局卡总是相关
    expect(buildKnowledgeContext([card({ target: 'h2' })], hosts)).toBe('')
  })
  it('总长截断：超限的卡只列标题，总长不超上限太多', () => {
    const big = Array.from({ length: 10 }, (_, i) => card({ id: `b${i}`, title: `大卡${i}`, content: 'x'.repeat(900), updatedAt: `2026-02-${String(10 + i)}T00:00:00Z` }))
    const t = buildKnowledgeContext(big, hosts, 4000)
    expect(t.length).toBeLessThan(4000 + 500)
    expect(t).toContain('[b9] 大卡9')        // 最新的展开
    expect(t).toMatch(/另有 \d+ 条因篇幅未展开/)
    const one = buildKnowledgeContext([card({ content: 'y'.repeat(3000) })], hosts)
    expect(one).toContain('（已截断）')
  })
})

describe('filterKnowledge', () => {
  const cards = [
    card({ id: 'a', title: 'Nginx 日志', content: '/var/log/nginx', category: 'logs', updatedAt: '2026-01-02T00:00:00Z' }),
    card({ id: 'b', title: '部署', content: 'docker compose up', category: 'deploy', target: 'h2' }),
    card({ id: 'c', scope: 'global', target: '', title: '值班', content: '找张三' }),
  ]
  it('按归属 / 分类 / 全文（多词全中，不分大小写）', () => {
    expect(filterKnowledge(cards, {}).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(filterKnowledge(cards, { scope: 'host', target: 'h2' }).map((c) => c.id)).toEqual(['b'])
    expect(filterKnowledge(cards, { scope: 'global' }).map((c) => c.id)).toEqual(['c'])
    expect(filterKnowledge(cards, { category: 'logs' }).map((c) => c.id)).toEqual(['a'])
    expect(filterKnowledge(cards, { q: 'NGINX var' }).map((c) => c.id)).toEqual(['a'])
    expect(filterKnowledge(cards, { q: 'nginx 张三' })).toEqual([])
  })
})
