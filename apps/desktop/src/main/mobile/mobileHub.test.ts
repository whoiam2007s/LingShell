import { describe, it, expect } from 'vitest'
import { MobileHub, toolSummary, mobileAllowBlock, MAX_ITEMS } from './mobileHub.js'

const auth = (approvalId: string, extra: Record<string, unknown> = {}) => ({
  type: 'auth:request' as const, approvalId, sessionId: 's1', terminalId: 'h1', needed: 'write' as const, reason: 'first_access' as const,
  risk: 'safe' as const, tool: 'exec_in_terminal', command: 'ls', deadlineMs: 60_000, ...extra,
})

describe('toolSummary', () => {
  it('执行命令带退出码，不带输出', () => {
    expect(toolSummary('exec_in_terminal', { command: 'df -h' }, JSON.stringify({ output: 'secret stuff', exit_code: 0 }))).toBe('执行了 df -h · 退出码 0')
    expect(toolSummary('write_file', { path: '/etc/a' }, undefined, 'failed')).toBe('修改了 /etc/a · 失败')
    expect(toolSummary('mystery', {})).toBe('调用了 mystery')
  })
})

describe('MobileHub', () => {
  it('对话：用户消息 / AI 流式文本 / 工具摘要；状态随回合与授权变化', () => {
    let t = 1000
    const h = new MobileHub(() => t)
    h.onEvent({ type: 'agent:turnStarted', sessionId: 's1', turnId: 't1' })
    expect(h.status('s1')).toBe('running')
    h.onEvent({ type: 'agent:itemUpdated', sessionId: 's1', turnId: 't1', itemId: 'u1', kind: 'user_message', status: 'completed', text: '看看磁盘' })
    h.onEvent({ type: 'agent:itemDelta', sessionId: 's1', turnId: 't1', itemId: 'a1', kind: 'agent_message', text: '好的，' })
    h.onEvent({ type: 'agent:itemDelta', sessionId: 's1', turnId: 't1', itemId: 'a1', kind: 'agent_message', text: '我来查' })
    h.onEvent({ type: 'agent:itemStarted', sessionId: 's1', turnId: 't1', itemId: 'c1', kind: 'tool_call', status: 'in_progress', tool: { toolId: 'c1', name: 'exec_in_terminal' }, phase: 'preparing' })
    h.onEvent({ type: 'agent:itemStarted', sessionId: 's1', turnId: 't1', itemId: 'c1', kind: 'tool_call', status: 'in_progress', tool: { toolId: 'c1', name: 'exec_in_terminal', input: { command: 'df -h' } } })
    t = 2000
    h.onEvent(auth('ap1'))
    expect(h.status('s1')).toBe('waiting')
    expect(h.pending('s1').map((a) => a.approvalId)).toEqual(['ap1'])
    h.onEvent({ type: 'auth:resolved', approvalId: 'ap1', result: 'allow' })
    expect(h.status('s1')).toBe('running')
    h.onEvent({ type: 'agent:itemUpdated', sessionId: 's1', turnId: 't1', itemId: 'c1', kind: 'tool_call', status: 'completed', tool: { toolId: 'c1', name: 'exec_in_terminal', output: '{"exit_code":1}' } })
    h.onEvent({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 't1' })
    expect(h.status('s1')).toBe('done')
    expect(h.items('s1').map((i) => [i.role, i.text])).toEqual([['user', '看看磁盘'], ['ai', '好的，我来查'], ['tool', '执行了 df -h · 退出码 1']])
    expect(h.updatedAt('s1')).toBe(2000)
  })
  it('只留最近 MAX_ITEMS 条；回合结束清掉残留授权；超时的授权不再列出', () => {
    let t = 0
    const h = new MobileHub(() => t)
    for (let i = 0; i < MAX_ITEMS + 5; i++) h.onEvent({ type: 'agent:itemUpdated', sessionId: 's1', turnId: 't', itemId: `u${i}`, kind: 'user_message', status: 'completed', text: `m${i}` })
    expect(h.items('s1')).toHaveLength(MAX_ITEMS)
    expect(h.items('s1')[0].text).toBe('m5')
    h.onEvent(auth('ap2'))
    t = 61_000
    expect(h.pending('s1')).toEqual([])
    h.onEvent(auth('ap3'))
    h.onEvent({ type: 'agent:turnFailed', sessionId: 's1', turnId: 't', error: 'x' })
    expect(h.approval('ap3')).toBeUndefined()
  })
})

describe('mobileAllowBlock', () => {
  const h = new MobileHub(() => 0)
  const get = (ev: ReturnType<typeof auth>) => { h.onEvent(ev); return h.approval(ev.approvalId)! }
  it('单台执行 / 读终端可允许；生产危险命令、改文件、多主机、MCP、计划只能在电脑上允许', () => {
    expect(mobileAllowBlock(get(auth('a1')), false)).toBeUndefined()
    expect(mobileAllowBlock(get(auth('a2', { tool: 'read_terminal' })), true)).toBeUndefined()
    expect(mobileAllowBlock(get(auth('a3', { risk: 'dangerous' })), false)).toBeUndefined()
    expect(mobileAllowBlock(get(auth('a4', { risk: 'dangerous' })), true)).toMatch(/生产/)
    expect(mobileAllowBlock(get(auth('a5', { tool: 'write_file' })), false)).toMatch(/电脑/)
    expect(mobileAllowBlock(get(auth('a6', { tool: 'exec_on_terminals' })), false)).toMatch(/电脑/)
    h.onEvent({ type: 'plan:request', approvalId: 'p1', sessionId: 's1', title: 'x', steps: [], deadlineMs: 1000 })
    expect(mobileAllowBlock(h.approval('p1')!, false)).toMatch(/计划/)
  })
})
