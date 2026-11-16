import { describe, expect, it } from 'vitest'
import { buildConsolidatePrompt, countAfter, parseConsolidateReply, validateConsolidateActions, type ConsolidateAction } from './knowledgeConsolidate.js'
import type { KnowledgeCard } from './knowledge.js'

const card = (id: string, title = id): KnowledgeCard => ({
  id, scope: 'host', target: 'h1', category: 'ops', source: 'ai', title, content: `${id} 的内容`, updatedAt: '2026-11-01T00:00:00.000Z',
})

const cards = [card('a'), card('b'), card('c')]

describe('知识库梳理', () => {
  it('解析模型回复：容忍 ```json 包裹与前后废话', () => {
    const r1 = parseConsolidateReply('好的，结果如下：\n{"actions":[{"kind":"merge","ids":["a","b"],"title":"合并","content":"内容","reason":"重复"}]}')
    expect(r1.actions?.length).toBe(1)
    const r2 = parseConsolidateReply('```json\n{"actions":[{"kind":"drop","ids":["c"],"reason":"过时"}]}\n```')
    expect(r2.actions?.[0]?.kind).toBe('drop')
  })

  it('解析失败要给出可读原因', () => {
    expect(parseConsolidateReply('我不知道怎么整理').error).toContain('没有按要求返回')
    expect(parseConsolidateReply('{"actions":[]}').error).toContain('没有给出任何可用的整理动作')
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
