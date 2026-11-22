import { describe, expect, it } from 'vitest'
import { buildConsolidatePrompt, countAfter, parseConsolidateReply, shouldConsolidate, validateConsolidateActions, type ConsolidateAction } from './memoryConsolidate.js'
import type { MemoryCard } from './memory.js'

const card = (id: string, title = id): MemoryCard => ({
  id, scope: 'host', target: 'h1', category: 'ops', source: 'ai', title, content: `${id} 的内容`, updatedAt: '2026-11-01T00:00:00.000Z',
})

const cards = [card('a'), card('b'), card('c')]

describe('记忆库梳理', () => {
  it('解析模型回复：容忍 ```json 包裹与前后废话', () => {
    const r1 = parseConsolidateReply('好的，结果如下：\n{"actions":[{"kind":"merge","ids":["a","b"],"title":"合并","content":"内容","reason":"重复"}]}')
    expect(r1.actions?.length).toBe(1)
    const r2 = parseConsolidateReply('```json\n{"actions":[{"kind":"drop","ids":["c"],"reason":"过时"}]}\n```')
    expect(r2.actions?.[0]?.kind).toBe('drop')
  })

  it('解析失败要给出可读原因；空清单不算失败（问题 13）', () => {
    expect(parseConsolidateReply('我不知道怎么整理').error).toContain('格式不对')
    // { actions: [] } 是合法结果：卡片本来就整齐，界面显示 empty 态而不是报错
    const empty = parseConsolidateReply('{"actions":[]}')
    expect(empty.error).toBeUndefined()
    expect(empty.actions).toEqual([])
  })

  it('不允许 create：模型编造 kind=create 会被忽略', () => {
    const r = parseConsolidateReply('{"actions":[{"kind":"create","ids":[],"title":"新卡","content":"编的","reason":"x"},{"kind":"drop","ids":["a"],"reason":"过期"}]}')
    expect(r.actions).toHaveLength(1)
    expect(r.actions?.[0]?.kind).toBe('drop')
  })

  it('校验：id 必须存在、merge 至少两张、同一张卡不能被重复引用', () => {
    const ok: ConsolidateAction[] = [{ kind: 'merge', ids: ['a', 'b'], title: '合并', content: '内容', reason: 'r' }]
    expect(validateConsolidateActions(ok, cards)).toEqual([])

    const bad: ConsolidateAction[] = [
      { kind: 'merge', ids: ['a'], title: 't', content: 'c', reason: 'r' },
      { kind: 'drop', ids: ['zzz'], reason: 'r' },
      { kind: 'update', ids: ['a', 'b'], title: 't', content: 'c', reason: 'r' },
    ]
    const errs = validateConsolidateActions(bad, cards)
    expect(errs.join('\n')).toContain('合并至少要两张卡')
    expect(errs.join('\n')).toContain('找不到卡片 zzz')
    expect(errs.join('\n')).toContain('update 只能涉及一张卡')
  })

  it('校验：合并后必须带标题和内容', () => {
    const errs = validateConsolidateActions([{ kind: 'merge', ids: ['a', 'b'], reason: 'r' }], cards)
    expect(errs.join('\n')).toContain('缺标题')
    expect(errs.join('\n')).toContain('缺内容')
  })

  it('应用后的卡片数能算出来', () => {
    expect(countAfter([{ kind: 'merge', ids: ['a', 'b', 'c'], title: 't', content: 'c', reason: 'r' }], 3)).toBe(1)
    expect(countAfter([{ kind: 'drop', ids: ['a'], reason: 'r' }], 3)).toBe(2)
    expect(countAfter([{ kind: 'update', ids: ['a'], title: 't', content: 'c', reason: 'r' }], 3)).toBe(3)
  })

  it('提示词里明确禁止凭空新增，并带上全部卡片', () => {
    const { system, user } = buildConsolidatePrompt(cards, () => '主机一')
    expect(system).toContain('绝不能凭空新增知识')
    expect(system).toContain('"kind":"merge"')
    expect(user).toContain('当前共 3 张卡')
    expect(user).toContain('id: a')
    expect(user).toContain('主机一')
  })
})

describe('shouldConsolidate（什么时候自动梳理）', () => {
  const now = Date.parse('2026-11-16T00:00:00.000Z')
  const daysAgo = (n: number) => new Date(now - n * 86400_000).toISOString()

  it('少于 2 张没必要', () => {
    expect(shouldConsolidate({ count: 0, now })).toBe(false)
    expect(shouldConsolidate({ count: 1, now })).toBe(false)
  })

  it('卡片到阈值就该跑（不管上次什么时候）', () => {
    expect(shouldConsolidate({ count: 50, lastAt: daysAgo(0.1), now })).toBe(true)
    expect(shouldConsolidate({ count: 49, lastAt: daysAgo(0.1), now })).toBe(false)
  })

  it('手动调低阈值也生效', () => {
    expect(shouldConsolidate({ count: 5, lastAt: daysAgo(0.1), now, sizeThreshold: 5 })).toBe(true)
  })

  it('超过 7 天且攒够 10 张才按时间触发', () => {
    expect(shouldConsolidate({ count: 12, lastAt: daysAgo(8), now })).toBe(true)
    expect(shouldConsolidate({ count: 12, lastAt: daysAgo(6), now })).toBe(false)
    expect(shouldConsolidate({ count: 9, lastAt: daysAgo(30), now })).toBe(false)
  })

  it('从没梳理过、攒够 10 张 → 触发', () => {
    expect(shouldConsolidate({ count: 12, now })).toBe(true)
    expect(shouldConsolidate({ count: 9, now })).toBe(false)
  })

  it('还有待处理清单且卡片数没变 → 不重复跑', () => {
    expect(shouldConsolidate({ count: 60, lastAt: daysAgo(30), pendingCount: 60, now })).toBe(false)
    // 卡片变了（新增 / 删除）→ 值得重跑
    expect(shouldConsolidate({ count: 61, lastAt: daysAgo(30), pendingCount: 60, now })).toBe(true)
  })
})
