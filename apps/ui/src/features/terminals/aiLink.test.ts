import { describe, it, expect } from 'vitest'
import { AiExecTracker, targetsOf, addAiMark, gotoAiMark, hasAiMark } from './aiMarks.js'
import { pushHit, findHitLine, ALERT_HITS_MAX, type AlertHitEntry, type AlertHitsState } from './alertHits.js'

describe('AI 命令标记关联', () => {
  it('工具开始执行登记，终端加锁时按终端取最早一条', () => {
    const t = new AiExecTracker()
    t.add({ callId: 'c1', sessionId: 's', command: 'ls', at: 0 }, ['term_a'])
    t.add({ callId: 'c2', sessionId: 's', command: 'df', at: 1 }, ['term_a', 'term_b'])
    t.add({ callId: 'c2', sessionId: 's', command: 'df', at: 1 }, ['term_b'])   // 重复登记忽略
    expect(t.size).toBe(3)
    expect(t.take('term_a', 10)?.callId).toBe('c1')
    expect(t.take('term_b', 10)?.callId).toBe('c2')
    expect(t.take('term_c', 10)).toBeUndefined()
    t.done('c2')   // 工具结束：没配上的清掉（如被拒绝、没真正执行）
    expect(t.take('term_a', 10)).toBeUndefined()
  })
  it('太久没配上的过期丢弃', () => {
    const t = new AiExecTracker()
    t.add({ callId: 'c1', sessionId: 's', command: 'ls', at: 0 }, ['x'])
    expect(t.take('x', 16 * 60_000)).toBeUndefined()
  })
  it('目标终端：exec_on_terminals 取 terminal_ids，其余取 terminal_id', () => {
    expect(targetsOf('exec_on_terminals', { terminal_ids: ['a', 'b', 3] })).toEqual(['a', 'b'])
    expect(targetsOf('exec_in_terminal', { terminal_id: 'a' })).toEqual(['a'])
    expect(targetsOf('exec_in_terminal', {})).toEqual([])
  })
  it('定位：取第一个还在的标记；都失效返回 false；注销后不再有', () => {
    let alive = false
    const off1 = addAiMark({ callId: 'k', terminalId: 'a', sessionId: 's', at: 0, goto: () => alive })
    const off2 = addAiMark({ callId: 'k', terminalId: 'b', sessionId: 's', at: 0, goto: () => true })
    expect(gotoAiMark('k')).toBe(true)
    off2()
    expect(gotoAiMark('k')).toBe(false)   // marker 被裁掉 → 「输出已不在终端缓冲里」
    alive = true
    expect(gotoAiMark('k')).toBe(true)
    off1()
    expect(hasAiMark('k')).toBe(false)
    expect(gotoAiMark('nope')).toBe(false)
  })
})

describe('告警汇总', () => {
  const e = (id: number): AlertHitEntry => ({ id, at: id, terminalId: 't', terminalTitle: 'T', rule: 'ERROR', line: `ERROR ${id}`, goto: () => true, context: () => '' })
  it('追加、超上限丢最旧、未读计数（抽屉开着算已读）', () => {
    let s: AlertHitsState = { list: [], unread: 0 }
    for (let i = 1; i <= 5; i++) s = pushHit(s, e(i), false, 3)
    expect(s.list.map((x) => x.id)).toEqual([3, 4, 5])
    expect(s.unread).toBe(3)
    s = pushHit(s, e(6), true, 3)
    expect(s.unread).toBe(0)
    expect(ALERT_HITS_MAX).toBe(500)
  })
  it('从光标往上找命中行（含跨软折行）', () => {
    const lines = ['$ make', 'ok', 'ERROR: disk full', 'done', '$ ']
    const get = (y: number) => lines[y]
    expect(findHitLine(get, 4, 'ERROR: disk full')).toBe(2)
    const wrapped = ['$ x', 'aaa ERR', 'OR here', '$ ']
    expect(findHitLine((y) => wrapped[y], 3, 'aaa ERROR here')).toBe(1)
    expect(findHitLine(get, 4, 'not there')).toBeUndefined()
    expect(findHitLine(get, 4, '  ')).toBeUndefined()
  })
  it('大输出：命中行在 400 行以前也能找到（不再误报「这一行已不在缓冲里」）', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => (i === 100 ? 'ERROR: boom' : `line ${i}`))
    expect(findHitLine((y) => lines[y], 1199, 'ERROR: boom')).toBe(100)
  })
})
