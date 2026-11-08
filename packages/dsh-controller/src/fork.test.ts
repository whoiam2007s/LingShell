import { describe, it, expect } from 'vitest'
import { forkPoint, forkTitle, digestSeed } from './fork.js'
import { splitContextBlocks } from '@lingshell/shared'
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

describe('digestSeed（摘要 + 最近几轮重组成种子）', () => {
  // 造一段两轮日志，第二轮里放一个带**顶层** sourceEventSeqs 的事件（dsh 的表面替换事件就是这个形状），
  // 引用 seq 6、7（都在切片内）：重编 seq 时必须跟着重写，否则 dsh 报
  //   invalid seed event at index 7: sourceEventSeqs must reference earlier events: 6282 >= current seq 7
  const build = (evts: unknown[], boundary: number) => evts.slice(0, boundary + 1)
  const mk = (): DshEvent[] => {
    const rows: any[] = [
      ev('agent/inbox/spliced'), ev('turn/start', { turn: 1 }), user('u1', '第一轮'),
      ev('assistant/message', {}), ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      ev('agent/inbox/spliced'), ev('turn/start', { turn: 2 }), user('u2', '第二轮'),
      ev('assistant/message', {}), ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    rows[8] = { ...rows[8], sourceEventSeqs: [6, 7] }
    return rows.map((e, seq) => ({ ...e, seq })) as DshEvent[]
  }

  it('引用都在切片内 → 按新下标重写，seed 从 0 连续编号', () => {
    const r = digestSeed(mk(), { turns: 1, buildSeed: build })!
    expect(r.inherited).toBe(5)                        // 源 seq 5..9 → 新 0..4
    const seed = r.seed as any[]
    expect(seed.find((e) => e.sourceEventSeqs)?.sourceEventSeqs).toEqual([1, 2])
    expect(seed.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
  })

  it('压缩检查点（replace 事件）→ 整段不可靠，退回 digest', () => {
    const events = mk()
    ;(events[8] as any).surfaceOp = { op: 'replace', startSeq: 6, endSeq: 7 }
    expect(digestSeed(events, { turns: 1, buildSeed: build })).toBeUndefined()
  })

  it('引用指向切片外 → 退回 digest（不抛错）', () => {
    const events = mk()
    ;(events[8] as any).sourceEventSeqs = [0]
    expect(digestSeed(events, { turns: 1, buildSeed: build })).toBeUndefined()
  })

  it('没有完成的轮 → undefined', () => {
    expect(digestSeed([ev('turn/start', { turn: 1 })] as DshEvent[], { buildSeed: build })).toBeUndefined()
  })

  it('摘要挂在第一条用户消息末尾的上下文块里（界面只显示 chip，不糊一屏字）', () => {
    const r = digestSeed(mk(), { turns: 1, summary: '这里是一段很长的摘要', buildSeed: build })!
    const seed = r.seed as any[]
    const msg = seed.find((e) => e.type === 'user/message')!
    const text = (msg.data.content as any[]).filter((b) => b.type === 'text').map((b) => String(b.text)).join('')
    expect(text.startsWith('第二轮')).toBe(true)          // 原话在前面
    expect(text.trimEnd().endsWith('</context>')).toBe(true)   // 上下文块在末尾才拆得掉
    const split = splitContextBlocks(text)
    expect(split.text).toBe('第二轮')
    expect(split.ctxs).toHaveLength(1)
    expect(split.ctxs[0].ctx).toBe('session')
    expect(split.ctxs[0].text).toBe('这里是一段很长的摘要')
  })
})
