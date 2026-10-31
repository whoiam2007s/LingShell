import { describe, it, expect } from 'vitest'
import { groupTurns, isProposalCard } from './groupTurns.js'
import type { ConvItem } from './useConversation.js'

const item = (itemId: string, kind: ConvItem['kind']): ConvItem => ({ itemId, kind, status: 'completed', text: itemId })

describe('groupTurns', () => {
  it('系统提示独占一轮，不并进前后的 AI 回合', () => {
    const turns = groupTurns([item('u1', 'user_message'), item('a1', 'agent_message'), item('n1', 'system_notice'), item('a2', 'agent_message')])
    expect(turns.map((t) => t.key)).toEqual(['u1', 'n1', 'a2'])
    expect(turns[0].final.map((i) => i.itemId)).toEqual(['a1'])
    expect(turns[1].notice?.itemId).toBe('n1')
    expect(turns[1].steps).toEqual([])
  })
  it('回合的 turnId 取本轮首个带 turnId 的条目（本地乐观的用户消息没有）', () => {
    const turns = groupTurns([item('u1', 'user_message'), { ...item('t1', 'tool_call'), turnId: 'turn_2' }, { ...item('a1', 'agent_message'), turnId: 'turn_2' }])
    expect(turns[0].turnId).toBe('turn_2')
    expect(groupTurns([item('u1', 'user_message')])[0].turnId).toBeUndefined()
  })
  it('知识卡提议不收进折叠的执行过程，放在最终回复前', () => {
    const t = groupTurns([item('u1', 'user_message'), item('t1', 'tool_call'), item('k1', 'host_note'), item('t2', 'tool_call'), item('a1', 'agent_message')])[0]
    expect(t.steps.map((i) => i.itemId)).toEqual(['t1', 't2'])
    expect(t.final.map((i) => i.itemId)).toEqual(['k1', 'a1'])
  })
  it('提问卡同理：不折叠，放在最终回复前', () => {
    const t = groupTurns([item('u1', 'user_message'), item('t1', 'tool_call'), item('q1', 'ask_request'), item('t2', 'tool_call')])[0]
    expect(t.steps.map((i) => i.itemId)).toEqual(['t1', 't2'])
    expect(t.final.map((i) => i.itemId)).toEqual(['q1'])
  })
  it('快速命令 / 手册提议：工具卡留在执行过程，完成后另出预览卡放到最终回复前；进行中 / 失败的不出', () => {
    const tool = (id: string, name: string, status: ConvItem['status'] = 'completed'): ConvItem => ({ ...item(id, 'tool_call'), status, tool: { toolId: id, name } })
    const t = groupTurns([item('u1', 'user_message'), tool('t1', 'propose_runbook'), tool('t2', 'exec_in_terminal'), tool('t3', 'propose_quick_commands', 'failed'), item('a1', 'agent_message')])[0]
    expect(t.steps.map((i) => i.itemId)).toEqual(['t1', 't2', 't3'])
    expect(t.final.map((i) => i.itemId)).toEqual(['t1:proposal', 'a1'])
    expect(isProposalCard(t.final[0])).toBe(true)
    expect(isProposalCard(t.steps[0])).toBe(false)
  })
})
