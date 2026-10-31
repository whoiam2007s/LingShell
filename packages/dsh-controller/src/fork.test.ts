import { describe, it, expect } from 'vitest'
import { forkPoint, forkTitle } from './fork.js'
import type { DshEvent } from './relay.js'
import { withPathsBlock } from '@lingshell/shared'

// 两轮会话的事件骨架（形状同 __fixtures__/turn-with-tool.json）
const ev = (type: string, data?: any): Omit<DshEvent, 'seq'> => ({ type, time: 1, data })
const user = (id: string, text: string, kind = 'user') => ev('user/message', { id, source: { kind }, content: [{ type: 'text', text }] })
const log: DshEvent[] = [
  ev('agent/inbox/spliced'), ev('turn/start', { turn: 1 }), ev('step/start', { step: 1 }), user('u1', '看看磁盘'), user('p1', '快照', 'plugin'),
  ev('assistant/message', {}), ev('tool/call', { callId: 'c1' }), ev('tool/result', {}), ev('step/end'), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ev('agent/inbox/spliced'), ev('turn/start', { turn: 2 }), ev('step/start', { step: 1 }),
  user('u2', withPathsBlock('再看内存', [{ kind: 'file', path: '/var/log/syslog' }], 'linux')), ev('tool/call', { callId: 'c2' }), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
].map((e, seq) => ({ ...e, seq }))

describe('forkPoint（分叉切点）', () => {
  it('第一条消息：没有更早的轮 → 空会话', () => {
    const p = forkPoint(log, 'u1')
    expect(p.boundary).toBeUndefined()
    expect(p.text).toBe('看看磁盘')
    expect(p.turns.size).toBe(0)
  })
  it('第二条消息：切在上一轮 turn/end（含），继承的轮 / 工具只到那里', () => {
    const p = forkPoint(log, 'u2')
    expect(p.boundary).toBe(9)
    expect([...p.turns]).toEqual([1])
    expect([...p.calls]).toEqual(['c1'])
    expect(p.text).toBe('再看内存')                    // 界面原话：去掉附件路径块
    expect(p.content).toEqual(log[13].data.content)   // 原样内容（重新生成时重发，附件路径块还在）
  })
  it('非用户消息 / 不存在的 id 报错', () => {
    expect(() => forkPoint(log, 'p1')).toThrow(/message_not_found/)
    expect(() => forkPoint(log, 'nope')).toThrow(/message_not_found/)
  })
  it('分叉标题不叠加', () => {
    expect(forkTitle('排查')).toBe('排查（分叉）')
    expect(forkTitle('排查（分叉）')).toBe('排查（分叉）')
  })
})
