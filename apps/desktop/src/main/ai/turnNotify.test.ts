import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@lingshell/shared'
import { createTurnNotifier, turnNotice } from './turnNotify.js'

function setup(o: { enabled?: boolean; unattended?: string[] } = {}) {
  const sent: [string, string, string][] = []
  const feed = createTurnNotifier({
    enabled: () => o.enabled ?? true,
    unattended: (sid) => (o.unattended ?? []).includes(sid),
    title: (sid) => (sid === 's1' ? '查磁盘' : ''),
    notify: (t, b, sid) => sent.push([t, b, sid]),
  })
  const start = (sid: string, turnId: string) => feed({ type: 'agent:turnStarted', sessionId: sid, turnId })
  return { sent, feed, start }
}

describe('AI 回合通知', () => {
  it('实时的轮：完成 / 出错各发一条，点击带会话 id', () => {
    const { sent, feed, start } = setup()
    start('s1', 't1'); feed({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 't1' })
    start('s1', 't2'); feed({ type: 'agent:turnFailed', sessionId: 's1', turnId: 't2', error: 'API 返回 401：key 无效' })
    expect(sent).toEqual([
      ['AI 已完成：查磁盘', '点击查看结果', 's1'],
      ['AI 出错：API 返回 401：key 无效', '会话「查磁盘」', 's1'],
    ])
  })
  it('回放历史（没有 turnStarted）的结束不通知；同一轮只通知一次', () => {
    const { sent, feed, start } = setup()
    feed({ type: 'agent:turnFailed', sessionId: 's1', turnId: 'old', error: '炸了' })
    feed({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 'old2' })
    start('s1', 't1')
    feed({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 't1' })
    feed({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 't1' })
    expect(sent).toHaveLength(1)
  })
  it('用户主动停止、关了开关、无人值守会话都不通知', () => {
    const stop = setup()
    stop.start('s1', 't1'); stop.feed({ type: 'agent:turnFailed', sessionId: 's1', turnId: 't1', error: '已中断', stopped: true })
    expect(stop.sent).toEqual([])
    const off = setup({ enabled: false })
    off.start('s1', 't1'); off.feed({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 't1' })
    expect(off.sent).toEqual([])
    const ua = setup({ unattended: ['s9'] })
    ua.start('s9', 't1'); ua.feed({ type: 'agent:turnCompleted', sessionId: 's9', turnId: 't1' })
    expect(ua.sent).toEqual([])
  })
  it('文案：长错误截断、空白压成一个空格；没标题时叫「会话」', () => {
    const long = 'x'.repeat(80)
    expect(turnNotice({ type: 'agent:turnFailed', sessionId: 's', turnId: 't', error: long } as AgentEvent, '')).toEqual({ title: `AI 出错：${'x'.repeat(60)}…`, body: '会话「会话」' })
    expect(turnNotice({ type: 'agent:turnFailed', sessionId: 's', turnId: 't', error: 'a\n\n b' } as AgentEvent, 'T')?.title).toBe('AI 出错：a b')
    expect(turnNotice({ type: 'agent:turnStarted', sessionId: 's', turnId: 't' }, 'T')).toBeNull()
  })
})
