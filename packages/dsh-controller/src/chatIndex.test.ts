import { describe, it, expect } from 'vitest'
import { withContextBlocks, withPathsBlock } from '@lingshell/shared'
import { searchDocs, sessionDigest } from './chatIndex.js'
import { userMessageView, type DshEvent } from './relay.js'

const ev = (type: string, data?: any, time = 1000): Omit<DshEvent, 'seq'> => ({ type, time, data })
const user = (id: string, text: string, kind = 'user') => ev('user/message', { id, source: { kind }, content: [{ type: 'text', text }] })
const ai = (turn: number, step: number, ...texts: string[]) => ev('assistant/message', { turn, step, message: { content: [{ type: 'reasoning', text: '想想' }, ...texts.map((text) => ({ type: 'text', text }))] } })
const seq = (xs: Omit<DshEvent, 'seq'>[]): DshEvent[] => xs.map((e, i) => ({ ...e, seq: i }))

const ctx = withContextBlocks('nginx 502 了', [{ kind: 'context', ctx: 'terminal', name: 'web1', text: '用户指定在终端「web1」上操作。' }])
const log = seq([
  ev('turn/start', { turn: 1 }), ev('step/start', { step: 1 }), user('u1', withPathsBlock(ctx, [{ kind: 'file', path: '/etc/nginx/nginx.conf' }], 'linux')), user('p1', '快照', 'plugin'),
  ai(1, 1, '先看看日志'), ev('tool/call', { callId: 'c1', name: 'exec_in_terminal', arguments: JSON.stringify({ terminal_id: 't', command: 'tail -n 50 /var/log/nginx/error.log' }) }),
  ev('step/start', { step: 2 }), ai(1, 2, 'upstream 挂了，已 reload 恢复'), ev('turn/end', { turn: 1 }),
  ev('turn/start', { turn: 2 }), ev('step/start', { step: 1 }), user('u2', '谢谢'), ai(2, 1, '不客气'), ev('turn/end', { turn: 2 }),
])

describe('userMessageView：上下文块', () => {
  it('原话里剥出上下文标签与路径附件', () => {
    const v = userMessageView(log[2].data.content)
    expect(v.text).toBe('nginx 502 了')
    expect(v.attachments).toEqual([
      { kind: 'context', ctx: 'terminal', name: 'web1', text: '用户指定在终端「web1」上操作。' },
      { kind: 'file', name: 'nginx.conf', path: '/etc/nginx/nginx.conf' },
    ])
  })
})

describe('searchDocs', () => {
  it('用户原话（去掉附件块）/ AI 文本块 / 命令，itemId 与界面一致', () => {
    const d = searchDocs('s1', log)
    expect(d.map((x) => [x.kind, x.itemId, x.text])).toEqual([
      ['user', 'u1', 'nginx 502 了'],
      ['ai', 'blk_1_1_1', '先看看日志'],
      ['cmd', 'c1', 'tail -n 50 /var/log/nginx/error.log'],
      ['ai', 'blk_1_2_1', 'upstream 挂了，已 reload 恢复'],
      ['user', 'u2', '谢谢'],
      ['ai', 'blk_2_1_1', '不客气'],
    ])
    expect(d.every((x) => x.sessionId === 's1' && x.at === 1000)).toBe(true)
  })
})

describe('sessionDigest', () => {
  it('没有压缩摘要：每轮「用户问题 + 最后一段 AI 回复」', () => {
    expect(sessionDigest(log)).toBe('用户：nginx 502 了\nAI：upstream 挂了，已 reload 恢复\n\n用户：谢谢\nAI：不客气')
  })
  it('有压缩摘要优先用最后一次的', () => {
    const l = seq([...log, ev('compaction/summary', { summary: [{ type: 'text', text: '旧摘要' }] }), ev('compaction/summary', { summary: [{ type: 'text', text: '新摘要' }] })])
    expect(sessionDigest(l)).toBe('（较早对话的压缩摘要）\n新摘要')
  })
  it('超长：从最近往前取到 max 字为止，单轮截断', () => {
    const many = seq(Array.from({ length: 30 }, (_, i) => [user(`u${i}`, `问题${i} ${'x'.repeat(400)}`), ai(i, 1, `回答${i} ${'y'.repeat(800)}`)]).flat())
    const d = sessionDigest(many, 2000)
    expect(d.length).toBeLessThanOrEqual(2001)
    expect(d).toContain('问题29')
    expect(d).not.toContain('问题0 ')
    expect(d).toContain('…')
  })
  it('空会话返回空串', () => { expect(sessionDigest([])).toBe('') })
})
