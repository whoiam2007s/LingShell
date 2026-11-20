import { describe, expect, it } from 'vitest'
import { buildSessionFlow, splitTurns, type FlowInput } from './sessionFlow.js'

const user = (id: string, text: string, chips?: FlowInput['chips']): FlowInput => ({ id, kind: 'user_message', status: 'completed', text, chips })
const tool = (id: string, name: string, input?: unknown, status: FlowInput['status'] = 'completed'): FlowInput => ({ id, kind: 'tool_call', status, tool: { name, input } })
const msg = (id: string, text: string): FlowInput => ({ id, kind: 'agent_message', status: 'completed', text })

describe('buildSessionFlow', () => {
  it('一轮拆成三层：提问 / 工具与文字 / 产物', () => {
    const f = buildSessionFlow([
      user('u1', '写个页面'),
      tool('t1', 'write_file', { path: 'D:/app/index.html' }),
      tool('t2', 'exec_in_terminal', { command: 'pnpm dev\n--port 5199' }),
      msg('m1', '好了'),
    ])
    expect(f.turns).toBe(1)
    const stage = (s: number) => f.nodes.filter((n) => n.stage === s)
    expect(stage(0).map((n) => n.kind)).toEqual(['ask'])
    expect(stage(1).map((n) => n.label)).toEqual(['write', 'exec', 'AI 说明'])
    expect(stage(2).map((n) => n.label)).toEqual(['index.html'])
  })

  it('节点只放短名，完整命令进悬停与详情', () => {
    const f = buildSessionFlow([user('u', 'x'), tool('t', 'exec_in_terminal', { command: 'tail -100 app.log\nawk ...' })])
    const t = f.nodes.find((n) => n.kind === 'tool')!
    expect(t.label).toBe('exec')
    expect(t.title).toContain('exec_in_terminal')
    expect(t.title).toContain('tail -100 app.log')
    expect(t.title).not.toContain('awk')          // 只取首行
    expect(t.detail).toContain('tail -100 app.log')
  })

  it('提问携带的 chip 单独成点，ref 命中工具参数就连过去', () => {
    const f = buildSessionFlow([
      user('u', '看看这个', [{ kind: 'terminal', label: '本地 2', ref: 'term_ab12' }]),
      tool('t', 'exec_in_terminal', { command: 'ls', terminal_id: 'term_ab12' }),
    ])
    const chip = f.nodes.find((n) => n.kind === 'chip')!
    expect(chip.label).toBe('本地 2')
    expect(chip.stage).toBe(0)
    expect(f.edges.some((e) => e.from === chip.id && e.kind === 'chip')).toBe(true)
  })

  it('同一轮重复写同一个文件只出一个产物节点，两条写入线', () => {
    const f = buildSessionFlow([
      user('u', '改配置'),
      tool('t1', 'write_file', { path: '/etc/app.yml' }),
      tool('t2', 'write_file', { path: '/etc/app.yml' }),
    ])
    expect(f.nodes.filter((n) => n.kind === 'file')).toHaveLength(1)
    expect(f.edges.filter((e) => e.kind === 'write')).toHaveLength(2)
  })

  it('跨轮再写同一个文件：旧产物连到本轮的工具（接着用）', () => {
    const f = buildSessionFlow([
      user('u1', '第一版'),
      tool('t1', 'write_file', { path: 'a.ts' }),
      user('u2', '改一下'),
      tool('t2', 'write_file', { path: 'a.ts' }),
    ])
    expect(f.turns).toBe(2)
    const carry = f.edges.filter((e) => e.kind === 'carry')
    expect(carry).toHaveLength(1)
    expect(carry[0].from).toBe('0-file-a.ts')
  })

  it('一列超过上限折叠成「其余 +N」，原连线改指折叠节点', () => {
    const many = Array.from({ length: 12 }, (_, i) => tool(`t${i}`, 'exec_in_terminal', { command: `cmd ${i}` }))
    const f = buildSessionFlow([user('u', '跑一堆'), ...many], { colMax: 5 })
    const mid = f.nodes.filter((n) => n.stage === 1)
    expect(mid).toHaveLength(5)
    const more = mid.at(-1)!
    expect(more.label).toBe('其余工具')
    expect(more.count).toBe(8)          // 12 - (5-1) = 8
    expect(f.folded).toBe(7)            // 8 个里 1 个当代表，其余 7 个藏起来
    expect(f.edges.some((e) => e.to === more.id)).toBe(true)
  })

  it('失败的工具带 ok=false；没有提问时也能成型', () => {
    const f = buildSessionFlow([tool('t', 'exec_in_terminal', { command: 'x' }, 'failed')])
    expect(f.turns).toBe(1)
    expect(f.nodes.find((n) => n.kind === 'tool')!.ok).toBe(false)
    expect(f.nodes.some((n) => n.kind === 'ask')).toBe(true)
  })

  it('splitTurns：第一条不是提问的内容算进第 0 轮', () => {
    const turns = splitTurns([msg('m', '开场'), user('u', '问'), msg('m2', '答')])
    expect(turns).toHaveLength(2)
    expect(turns[0]).toHaveLength(1)
    expect(turns[1]).toHaveLength(2)
  })

  it('MCP 工具名去掉命名空间前缀后截断', () => {
    const f = buildSessionFlow([user('u', 'x'), tool('t', 'mcp__github__create_issue', {})])
    expect(f.nodes.find((n) => n.kind === 'tool')!.label).toBe('create_issue'.slice(0, 12))
  })
})
