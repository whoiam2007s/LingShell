import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@lingshell/shared'
import { createRelay, createStreamAdapter, contextTokensOf, requestUsageOf, searchableTexts, type DshEvent } from './relay.js'
// 真实轨迹：实测抓的两轮对话（第一轮带工具调用，第二轮纯问答）
import fixture from './__fixtures__/turn-with-tool.json' with { type: 'json' }

const trace = fixture as unknown as DshEvent[]

function runAll(events: DshEvent[]): AgentEvent[] {
  const out: AgentEvent[] = []
  const relay = createRelay('sess_1', (e) => out.push(e))
  for (const e of events) relay(e)
  return out
}

describe('relay：真实 dsh 轨迹 → AgentEvent', () => {
  const out = runAll(trace)
  const byType = (t: string) => out.filter((e) => e.type === t)

  it('轮生命周期成对且顺序正确', () => {
    expect(byType('agent:turnStarted')).toHaveLength(2)
    expect(byType('agent:turnCompleted')).toHaveLength(2)
    expect(byType('agent:turnFailed')).toHaveLength(0)
    expect(out.findIndex((e) => e.type === 'agent:turnStarted'))
      .toBeLessThan(out.findIndex((e) => e.type === 'agent:turnCompleted'))
  })

  it('用户消息只留真人说的，滤掉系统注入的 runtime-context 快照', () => {
    const users = out.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message')
    expect(users).toHaveLength(2)   // 抓取脚本问了两句
    expect((users[0] as any).text).toContain('ls -la')
    // 系统那条 "Current runtime context..." 不该出现
    expect(users.some((u) => (u as any).text.includes('runtime context'))).toBe(false)
  })

  it('两轮各一条用户消息：都不算中途追问', () => {
    const users = out.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message') as any[]
    expect(users.map((u) => !!u.steered)).toEqual([false, false])
  })

  it('同一轮里第二条用户消息（steering 插入）标 steered；下一轮重新计数', () => {
    const um = (id: string, text: string) => ({ type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } }) as unknown as DshEvent
    const ts = (t: number) => ({ type: 'turn/start', data: { turn: t } }) as unknown as DshEvent
    const o = runAll([ts(1), um('m1', '先做 A'), um('m2', '改一下：顺便做 B'), ts(2), um('m3', '新问题')])
    const users = o.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message') as any[]
    expect(users.map((u) => [u.itemId, !!u.steered])).toEqual([['m1', false], ['m2', true], ['m3', false]])
  })

  it('工具调用：流里先识别出「生成参数中」卡，started 带解析好的入参，updated 带输出', () => {
    const prep = out.find((e) => e.type === 'agent:itemStarted' && e.kind === 'tool_call') as any
    expect(prep.phase).toBe('preparing')
    const started = out.find((e) => e.type === 'agent:itemStarted' && e.kind === 'tool_call' && !e.phase) as any
    expect(started.itemId).toBe(prep.itemId)
    expect(started.at).toBe(prep.at)
    expect(started.callAt).toBeGreaterThanOrEqual(started.at)
    expect(started.tool.name).toBe('exec_in_terminal')
    expect(started.tool.input).toEqual({ terminal_id: 'term_1', command: 'ls -la' })
    const done = out.find((e) => e.type === 'agent:itemUpdated' && e.kind === 'tool_call') as any
    expect(done.itemId).toBe(started.itemId)          // 同一 itemId，UI 才能就地更新
    expect(done.status).toBe('completed')
    expect(done.tool.output).toContain('exit_code')
  })

  it('流式：每个块 started → delta* → updated，且 delta 拼起来等于终值', () => {
    const started = out.filter((e) => e.type === 'agent:itemStarted' && e.kind !== 'tool_call')
    const updated = out.filter((e) => e.type === 'agent:itemUpdated' && (e.kind === 'agent_message' || e.kind === 'agent_reasoning'))
    expect(started.length).toBeGreaterThan(0)
    expect(started.length).toBe(updated.length)        // 开了就得关

    for (const u of updated as any[]) {
      const deltas = out.filter((e) => e.type === 'agent:itemDelta' && e.itemId === u.itemId) as any[]
      expect(deltas.map((d) => d.text).join('')).toBe(u.text)
      // delta 必须在 started 之后、updated 之前
      expect(out.indexOf(deltas[0])).toBeGreaterThan(out.findIndex((e) => e.type === 'agent:itemStarted' && (e as any).itemId === u.itemId))
      expect(out.indexOf(deltas[deltas.length - 1])).toBeLessThan(out.indexOf(u))
    }
  })

  it('reasoning 与 message 分开归类（UI 靠这个决定折不折叠）', () => {
    const kinds = new Set(out.filter((e) => e.type === 'agent:itemDelta').map((e: any) => e.kind))
    expect(kinds).toEqual(new Set(['agent_reasoning', 'agent_message']))
  })

  it('不产出无 itemId 或 kind 非法的事件', () => {
    for (const e of out as any[]) {
      if (!('itemId' in e)) continue
      expect(e.itemId).toBeTruthy()
      expect(['user_message', 'agent_message', 'agent_reasoning', 'tool_call', 'todo', 'subagent', 'auth_request']).toContain(e.kind)
    }
  })
})

describe('contextTokensOf：每次请求的精确上下文大小', () => {
  it('inputTokens + cacheReadTokens，且随请求单调递增', () => {
    const sizes = trace.map(contextTokensOf).filter((n): n is number => n !== undefined)
    expect(sizes).toEqual([463, 608, 721])            // 实测值：463+0 / 96+512 / 81+640
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
  })
  it('非 usage 事件返回 undefined', () => {
    expect(contextTokensOf({ type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } })).toBeUndefined()
    expect(contextTokensOf({ type: 'assistant/chunk', seq: 2, time: 0, data: { chunk: { type: 'text-delta', text: 'x' } } })).toBeUndefined()
  })
})

describe('requestUsageOf：每次请求的 tokens 明细（用量统计）', () => {
  it('从真实轨迹取出 input / cacheRead / output', () => {
    const us = trace.map(requestUsageOf).filter((u) => u !== undefined)
    expect(us[0]).toEqual({ input: 463, cacheRead: 0, output: 95 })
    expect(us[1]).toEqual({ input: 96, cacheRead: 512, output: 97 })
    expect(us).toHaveLength(3)
  })
  it('缺字段按 0；非 usage 事件 undefined', () => {
    expect(requestUsageOf({ type: 'assistant/message', seq: 1, time: 0, data: { usage: { inputTokens: 5 } } })).toEqual({ input: 5, cacheRead: 0, output: 0 })
    // 流式 usage 块与 assistant/message 的 usage 重复，不计
    expect(requestUsageOf({ type: 'assistant/chunk', seq: 1, time: 0, data: { chunk: { type: 'usage', usage: { inputTokens: 5 } } } })).toBeUndefined()
    expect(requestUsageOf({ type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } })).toBeUndefined()
  })
})

describe('relay：异常轮', () => {
  it('turn/end 带 error → turnFailed，错因取 error.message', () => {
    const out = runAll([
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'error', error: { message: '炸了' } } } },
    ])
    expect(out.at(-1)).toMatchObject({ type: 'agent:turnFailed', error: '炸了' })
  })
  it('reason 无 error 字段时兜底用 kind 当错因', () => {
    const out = runAll([{ type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'cancelled' } } }])
    expect(out.at(-1)).toMatchObject({ type: 'agent:turnFailed', error: 'cancelled' })
    expect((out.at(-1) as any).stopped).toBeUndefined()
  })
  it('用户主动停止：turnFailed 带 stopped（不发出错通知），出错的不带', () => {
    const out = runAll([
      { type: 'turn/end', seq: 1, time: 0, data: { turn: 1, reason: { kind: 'interrupted' } } },
      { type: 'turn/end', seq: 2, time: 0, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      { type: 'turn/end', seq: 3, time: 0, data: { turn: 3, reason: { kind: 'error', error: { message: '炸了' } } } },
    ])
    expect(out.filter((e) => e.type === 'agent:turnFailed').map((e) => (e as any).stopped)).toEqual([true, true, undefined])
  })
  it('历史回放：出错的轮仍发 turnFailed（显示错误），正常结束 / 用户停止的不发', () => {
    const out: any[] = []
    const r = createRelay('s', (e) => out.push(e), { replay: true })
    const end = (turn: number, reason: object) => r({ type: 'turn/end', seq: turn, time: 0, data: { turn, reason } } as any)
    end(1, { kind: 'error', error: { message: '炸了' } })
    end(2, { kind: 'completed' })
    end(3, { kind: 'interrupted' })
    end(4, { kind: 'aborted', reason: { kind: 'user' } })
    end(5, { kind: 'max-tokens' })
    expect(out.filter((e) => e.type === 'agent:turnFailed').map((e) => e.error)).toEqual(['炸了', 'max-tokens'])
  })
  it('坏 JSON 的 tool arguments 不炸流，原样兜住', () => {
    const out = runAll([{ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, callId: 'c1', name: 'x', arguments: '{坏' } }])
    expect((out[0] as any).tool.input).toEqual({ _raw: '{坏' })
  })
  it('没见过 block-start 的孤儿 delta 直接丢弃（不凭空造 item）', () => {
    const out = runAll([{ type: 'assistant/chunk', seq: 1, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } }])
    expect(out).toHaveLength(0)
  })
})

describe('relay：resume 历史回放（DshController.spawn 重连路径）', () => {
  // 重启后 dsh 把持久化日志作为构造种子载入、不再重发 session/event，我方需要手动灌 relay。
  // 这里模拟该路径：跳过 turn/* 生命周期事件（防孤儿 turn 让前端 busy 卡死），只回放 item.*，
  // 断言对话内容仍能完整重建。
  const replay: AgentEvent[] = []
  const r = createRelay('sess_1', (e) => replay.push(e), { replay: true, firstAtOf: (t) => (t === 1 ? 1787977093000 : undefined) })
  for (const e of trace) r(e)

  it('回放的时间：turn/* 只翻成 turnTiming（开始/结束取事件时间戳，首次返回取侧车），条目带事件时间，不推断首次返回', () => {
    const timing = replay.filter((e) => e.type === 'agent:turnTiming') as any[]
    expect(timing[0]).toEqual({ type: 'agent:turnTiming', sessionId: 'sess_1', turnId: 'turn_1', startedAt: 1787977092552, firstAt: 1787977093000 })
    expect(timing.find((t) => t.turnId === 'turn_1' && t.endedAt)?.endedAt).toBeGreaterThan(1787977092552)
    expect(timing.filter((t) => t.firstAt)).toHaveLength(1)   // 第二轮侧车里没有 → 不给
    const tool = replay.find((e) => e.type === 'agent:itemStarted' && e.kind === 'tool_call') as any
    const done = replay.find((e) => e.type === 'agent:itemUpdated' && e.kind === 'tool_call') as any
    expect(tool.at).toBeGreaterThan(0)
    expect(done.at).toBeGreaterThanOrEqual(tool.at)
    // 没时间戳的事件回放时不拿「现在」冒充
    const out: AgentEvent[] = []
    createRelay('s', (e) => out.push(e), { replay: true })({ type: 'tool/call', seq: 1, time: 0, data: { turn: 1, callId: 'c', name: 'x', arguments: '{}' } })
    expect((out[0] as any).at).toBeUndefined()
    expect(out).toHaveLength(1)
  })

  it('实时：首次返回只报一次并回调落侧车；缺时间戳用收到时刻', () => {
    const out: AgentEvent[] = []
    const firsts: [number, number][] = []
    const live = createRelay('s', (e) => out.push(e), { onFirst: (t, at) => firsts.push([t, at]) })
    live({ type: 'turn/start', seq: 1, time: 100, data: { turn: 3 } })
    live({ type: 'tool/call', seq: 2, time: 250, data: { turn: 3, callId: 'c1', name: 'x', arguments: '{}' } })
    live({ type: 'tool/call', seq: 3, time: 0, data: { turn: 3, callId: 'c2', name: 'x', arguments: '{}' } })
    expect(firsts).toEqual([[3, 250]])
    expect(out.filter((e) => e.type === 'agent:turnTiming')).toEqual([
      { type: 'agent:turnTiming', sessionId: 's', turnId: 'turn_3', startedAt: 100 },
      { type: 'agent:turnTiming', sessionId: 's', turnId: 'turn_3', firstAt: 250 },
    ])
    expect((out.at(-1) as any).at).toBeGreaterThan(1_000_000)   // time=0 → Date.now()
  })

  it('跳过 turn 生命周期后不再产出 turnStarted/turnCompleted，但内容完整', () => {
    expect(replay.some((e) => e.type === 'agent:turnStarted')).toBe(false)
    expect(replay.some((e) => e.type === 'agent:turnCompleted')).toBe(false)
    // 用户消息仍保留
    const users = replay.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message' && (e as any).text)
    expect(users.length).toBeGreaterThan(0)
    // 助手消息：每个文本块都开一方、收一方，且能拼出终端值
    const started = replay.filter((e) => e.type === 'agent:itemStarted' && (e as any).kind === 'agent_message')
    const updated = replay.filter((e) => e.type === 'agent:itemUpdated' && (e as any).kind === 'agent_message')
    expect(started.length).toBe(updated.length)
    for (const u of updated as any[]) {
      const deltas = replay.filter((e) => e.type === 'agent:itemDelta' && e.itemId === u.itemId) as any[]
      expect(deltas.map((d) => d.text).join('')).toBe(u.text)
    }
  })
})

describe('searchableTexts：历史搜索的文本来源', () => {
  it('只取用户消息、AI 回复正文、执行的命令；跳过系统注入、推理过程和工具输出', () => {
    const texts = searchableTexts(trace)
    expect(texts).toEqual([
      '在 term_1 上执行 `ls -la`，然后用一句话总结结果。',
      'ls -la',
      expect.stringContaining('结果显示当前目录为空'),
      '刚才那条命令的退出码是多少？只回答数字。',
      '0',
    ])
    expect(texts.some((t) => t.includes('Current runtime context'))).toBe(false)
  })
})

// dsh 0.2：流式块改走 agent/assistant-stream 帧，session/event 只有落盘的 assistant/message；工具结果是消息本身
describe('relay：dsh 0.2 事件词汇', () => {
  const msg = (turn: number, step: number, text: string): DshEvent => ({ type: 'assistant/message', seq: 9, time: 0, data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 5 } } })
  const frames = [
    { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 2 },
    { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: 'do' } },
    { type: 'chunk', attemptId: 'a1', revision: 4, index: 2, time: 1, chunk: { type: 'text-delta', index: 0, text: 'ne' } },
    { type: 'chunk', attemptId: 'a1', revision: 5, index: 3, time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } } },
    { type: 'chunk', attemptId: 'a1', revision: 6, index: 4, time: 1, chunk: { type: 'usage', usage: { inputTokens: 1 } } },
    { type: 'end', attemptId: 'a1', revision: 7, index: 5, outcome: { kind: 'committed' } },
  ]

  it('实时：帧翻成流式增量；随后的 assistant/message 不重复发；usage 只认 assistant/message', () => {
    const out: AgentEvent[] = []
    const relay = createRelay('s', (e) => out.push(e))
    const adapt = createStreamAdapter()
    const evs = frames.map(adapt).filter((e): e is DshEvent => !!e)
    expect(evs.some((e) => e.data?.chunk?.type === 'usage')).toBe(false)
    for (const e of evs) relay(e)
    relay(msg(1, 2, 'done'))
    expect(out.map((e) => e.type)).toEqual(['agent:itemStarted', 'agent:turnTiming', 'agent:itemDelta', 'agent:itemDelta', 'agent:itemUpdated'])
    expect(out[1]).toMatchObject({ turnId: 'turn_1', firstAt: 1 })   // 首个流式块 = 开始回答
    expect(out.at(-1)).toMatchObject({ itemId: 'blk_1_2_0', text: 'done', status: 'completed' })
    expect(contextTokensOf(msg(1, 2, 'x'))).toBe(120)
    expect(requestUsageOf(msg(1, 2, 'x'))).toEqual({ input: 100, cacheRead: 20, output: 5 })
  })

  it('回放：只有 assistant/message 时补发开始 + 完成；工具结果按消息上的 toolCallId / isError', () => {
    const out: AgentEvent[] = []
    const r = createRelay('sess_1', (e) => out.push(e), { replay: true })
    ;[
      msg(1, 1, '你好'),
      { type: 'tool/result', seq: 1, time: 0, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c9', isError: true, content: [{ type: 'text', text: 'boom' }] } } },
    ].forEach((e) => r(e as DshEvent))
    expect(out[0]).toMatchObject({ type: 'agent:itemStarted', kind: 'agent_message', itemId: 'blk_1_1_0' })
    expect(out[1]).toMatchObject({ type: 'agent:itemUpdated', text: '你好' })
    expect(out[2]).toMatchObject({ type: 'agent:itemUpdated', itemId: 'c9', status: 'failed', error: 'boom' })
  })
})

// 工具耗时起点 = 模型流式输出里识别到工具的时刻（block-start），不是参数完整后的 tool/call
describe('relay：工具识别时刻', () => {
  const chunk = (time: number, c: any, turn = 1, step = 1): DshEvent => ({ type: 'assistant/chunk', seq: -1, time, data: { turn, step, chunk: c } })
  const call = (time: number, callId: string, args = '{"command":"ls"}', turn = 1): DshEvent => ({ type: 'tool/call', seq: 1, time, data: { turn, step: 1, callId, name: 'exec_in_terminal', arguments: args } })
  const result = (time: number, callId: string): DshEvent => ({ type: 'tool/result', seq: 2, time, data: { turn: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] } } })
  const setup = () => {
    const out: AgentEvent[] = []
    const seen: [string, number][] = []
    const r = createRelay('s', (e) => out.push(e), { onToolSeen: (id, at) => seen.push([id, at]) })
    r({ type: 'turn/start', seq: 0, time: 900, data: { turn: 1 } })
    return { out, seen, r, tools: () => out.filter((e: any) => e.kind === 'tool_call') as any[] }
  }

  it('block-start → 首个 delta 出「生成参数中」卡 → tool/call 同 itemId 补参数 → result 结束', () => {
    const { r, seen, tools, out } = setup()
    r(chunk(1000, { type: 'block-start', index: 0, blockType: 'tool-call' }))
    expect(tools()).toHaveLength(0)   // 还不知道 id，不出卡
    r(chunk(1300, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'exec_in_terminal', argumentsDelta: '{"comm' }))
    r(chunk(1600, { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: 'and":"ls"}' }))
    expect(tools()).toEqual([{ type: 'agent:itemStarted', sessionId: 's', turnId: 'turn_1', itemId: 'c1', kind: 'tool_call', status: 'in_progress', phase: 'preparing', tool: { toolId: 'c1', name: 'exec_in_terminal' }, at: 1000 }])
    expect(seen).toEqual([['c1', 1000]])
    expect(out.find((e) => e.type === 'agent:turnTiming' && (e as any).firstAt)).toMatchObject({ firstAt: 1000 })
    r(chunk(1700, { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'exec_in_terminal', arguments: '{"command":"ls"}' } }))
    r(call(2000, 'c1'))
    r(result(5000, 'c1'))
    const [, started, done] = tools()
    expect(started).toMatchObject({ type: 'agent:itemStarted', itemId: 'c1', at: 1000, callAt: 2000, tool: { input: { command: 'ls' } } })
    expect(started.phase).toBeUndefined()
    expect(done).toMatchObject({ type: 'agent:itemUpdated', itemId: 'c1', status: 'completed', at: 5000 })
    expect(new Set(tools().map((t) => t.itemId))).toEqual(new Set(['c1']))   // 始终一张卡
  })

  it('多工具交错 index：各自关联自己的 block-start 时刻', () => {
    const { r, tools } = setup()
    r(chunk(1000, { type: 'block-start', index: 1, blockType: 'tool-call' }))
    r(chunk(1100, { type: 'block-start', index: 2, blockType: 'tool-call' }))
    r(chunk(1200, { type: 'tool-call-delta', index: 2, id: 'b', name: 'read_file', argumentsDelta: '{' }))
    r(chunk(1300, { type: 'tool-call-delta', index: 1, id: 'a', name: 'exec_in_terminal', argumentsDelta: '{' }))
    r(call(2000, 'a'))
    r(call(2100, 'b'))
    const prep = tools().filter((t) => t.phase === 'preparing')
    expect(prep.map((t) => [t.itemId, t.at, t.tool.name])).toEqual([['b', 1100, 'read_file'], ['a', 1000, 'exec_in_terminal']])
    const calls = tools().filter((t) => t.type === 'agent:itemStarted' && !t.phase)
    expect(calls.map((t) => [t.itemId, t.at, t.callAt])).toEqual([['a', 1000, 2000], ['b', 1100, 2100]])
  })

  it('没有 block-start 的协议：识别时刻 = 首个带 id 的 delta（空 id 的不算）', () => {
    const { r, tools, seen } = setup()
    r(chunk(1200, { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '' }))
    r(chunk(1400, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'x', argumentsDelta: '{}' }))
    r(call(1800, 'c1'))
    expect(seen).toEqual([['c1', 1400]])
    expect(tools().at(-1)).toMatchObject({ itemId: 'c1', at: 1400, callAt: 1800 })
  })

  it('流中止（落 assistant/attempt 或 abandoned）：已识别的卡转失败、停止计时；重试后 index 重新关联', () => {
    const { r, tools } = setup()
    const adapt = createStreamAdapter()
    const feed = (f: any) => { const e = adapt(f); if (e) r(e) }
    feed({ type: 'start', attemptId: 'a1', turn: 1, step: 1 })
    feed({ type: 'chunk', attemptId: 'a1', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
    feed({ type: 'chunk', attemptId: 'a1', time: 1100, chunk: { type: 'tool-call-delta', index: 0, id: 'old', name: 'x', argumentsDelta: '{"a' } })
    feed({ type: 'end', attemptId: 'a1', time: 1500, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 3 } })
    expect(tools().at(-1)).toMatchObject({ type: 'agent:itemUpdated', itemId: 'old', status: 'failed', at: 1500 })
    // 重试：同 turn/step、index 0 换了新 id
    feed({ type: 'start', attemptId: 'a2', turn: 1, step: 1 })
    feed({ type: 'chunk', attemptId: 'a2', time: 2000, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } })
    feed({ type: 'chunk', attemptId: 'a2', time: 2100, chunk: { type: 'tool-call-delta', index: 0, id: 'new', name: 'x', argumentsDelta: '{}' } })
    feed({ type: 'end', attemptId: 'a2', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
    expect(tools().at(-1)).toMatchObject({ itemId: 'new', phase: 'preparing', at: 2000 })   // 正常结束不收尾，等 tool/call
    r(call(2500, 'new'))
    expect(tools().at(-1)).toMatchObject({ itemId: 'new', at: 2000, callAt: 2500 })
  })

  it('参数中途用户中断：轮结束时还在生成参数的卡标为已中止', () => {
    const { r, tools, out } = setup()
    r(chunk(1000, { type: 'block-start', index: 0, blockType: 'tool-call' }))
    r(chunk(1100, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'x', argumentsDelta: '{' }))
    r({ type: 'turn/end', seq: 9, time: 1800, data: { turn: 1, reason: { kind: 'interrupted' } } })
    expect(tools().at(-1)).toMatchObject({ type: 'agent:itemUpdated', itemId: 'c1', status: 'failed', at: 1800, error: expect.stringContaining('已中止') })
    expect(out.at(-1)).toMatchObject({ type: 'agent:turnFailed' })
  })

  it('回放：识别时刻取侧车；侧车没有（旧会话）或晚于 tool/call 的坏值 → 退回 tool/call 时间且不拆分', () => {
    const out: AgentEvent[] = []
    const side: Record<string, number> = { c1: 1000, bad: 9999 }
    const r = createRelay('s', (e) => out.push(e), { replay: true, toolAtOf: (c) => side[c] })
    r(call(2000, 'c1')); r(result(5000, 'c1'))
    r(call(3000, 'old')); r(call(3000, 'bad'))
    const st = out.filter((e) => e.type === 'agent:itemStarted') as any[]
    expect(st[0]).toMatchObject({ itemId: 'c1', at: 1000, callAt: 2000 })
    expect(st[1].at).toBe(3000); expect(st[1].callAt).toBeUndefined()
    expect(st[2].at).toBe(3000); expect(st[2].callAt).toBeUndefined()
  })
})

// 思考时长：块级开始（block-start）→ 结束（block-end），实时回调落侧车，回放取侧车
describe('relay：思考块时间', () => {
  const chunk = (time: number, c: any, turn = 1, step = 1): DshEvent => ({ type: 'assistant/chunk', seq: -1, time, data: { turn, step, chunk: c } })
  const msg = (time: number, content: any[], turn = 1, step = 1): DshEvent => ({ type: 'assistant/message', seq: 5, time, data: { turn, step, message: { role: 'assistant', content } } })
  const reasoningEvs = (out: AgentEvent[]) => out.filter((e: any) => e.kind === 'agent_reasoning' && e.type !== 'agent:itemDelta') as any[]
  const setup = () => {
    const out: AgentEvent[] = []
    const spans: [string, number, number][] = []
    const r = createRelay('s', (e) => out.push(e), { onReasoning: (k, s, e) => spans.push([k, s, e]) })
    r({ type: 'turn/start', seq: 0, time: 900, data: { turn: 1 } })
    return { out, spans, r }
  }

  it('多个思考块：各自的开始 / 结束关联到自己的 index，assistant/message 不覆盖时间', () => {
    const { r, out, spans } = setup()
    r(chunk(1000, { type: 'block-start', index: 0, blockType: 'reasoning' }))
    r(chunk(1200, { type: 'reasoning-delta', index: 0, text: '先看' }))
    r(chunk(2500, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先看' } }))
    r(chunk(2600, { type: 'block-start', index: 1, blockType: 'text' }))
    r(chunk(2700, { type: 'block-end', index: 1, block: { type: 'text', text: '嗯' } }))
    r(chunk(3000, { type: 'block-start', index: 2, blockType: 'reasoning' }))
    r(chunk(4000, { type: 'block-end', index: 2, block: { type: 'reasoning', text: '再想' } }))
    r(msg(5000, [{ type: 'reasoning', text: '先看' }, { type: 'text', text: '嗯' }, { type: 'reasoning', text: '再想' }]))
    expect(spans).toEqual([['1:1:0', 1000, 2500], ['1:1:2', 3000, 4000]])
    expect(reasoningEvs(out).map((e) => [e.type, e.itemId, e.at])).toEqual([
      ['agent:itemStarted', 'blk_1_1_0', 1000], ['agent:itemUpdated', 'blk_1_1_0', 2500],
      ['agent:itemStarted', 'blk_1_1_2', 3000], ['agent:itemUpdated', 'blk_1_1_2', 4000],
    ])
  })

  it('流中止（没落成 assistant/message）：开着的思考块就地收尾、停止计时并落侧车；重试同 index 后写覆盖', () => {
    const { r, out, spans } = setup()
    const adapt = createStreamAdapter()
    const feed = (f: any) => { const e = adapt(f); if (e) r(e) }
    feed({ type: 'start', attemptId: 'a1', turn: 1, step: 1 })
    feed({ type: 'chunk', attemptId: 'a1', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    feed({ type: 'chunk', attemptId: 'a1', time: 1100, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })
    feed({ type: 'end', attemptId: 'a1', time: 1500, outcome: { kind: 'committed', eventType: 'assistant/attempt' } })
    expect(reasoningEvs(out).at(-1)).toMatchObject({ type: 'agent:itemUpdated', itemId: 'blk_1_1_0', status: 'completed', text: '', at: 1500 })
    expect(spans).toEqual([['1:1:0', 1000, 1500]])
    feed({ type: 'start', attemptId: 'a2', turn: 1, step: 1 })
    feed({ type: 'chunk', attemptId: 'a2', time: 2000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    feed({ type: 'chunk', attemptId: 'a2', time: 2600, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想好' } } })
    expect(spans.at(-1)).toEqual(['1:1:0', 2000, 2600])
  })

  it('用户中断：轮结束时还开着的思考块收尾', () => {
    const { r, out, spans } = setup()
    r(chunk(1000, { type: 'block-start', index: 0, blockType: 'reasoning' }))
    r({ type: 'turn/end', seq: 9, time: 1800, data: { turn: 1, reason: { kind: 'interrupted' } } })
    expect(reasoningEvs(out).at(-1)).toMatchObject({ type: 'agent:itemUpdated', status: 'completed', at: 1800 })
    expect(spans).toEqual([['1:1:0', 1000, 1800]])
  })

  it('回放：思考块时间取侧车；侧车没有（旧会话）不给时间，正文块仍用事件时间', () => {
    const out: AgentEvent[] = []
    const side: Record<string, [number, number]> = { '1:1:0': [1000, 2500] }
    const r = createRelay('s', (e) => out.push(e), { replay: true, reasoningAtOf: (k) => side[k] })
    r(msg(5000, [{ type: 'reasoning', text: '先看' }, { type: 'text', text: '嗯' }, { type: 'reasoning', text: '再想' }]))
    const rs = reasoningEvs(out)
    expect(rs.map((e) => [e.type, e.itemId, e.at])).toEqual([
      ['agent:itemStarted', 'blk_1_1_0', 1000], ['agent:itemUpdated', 'blk_1_1_0', 2500],
      ['agent:itemStarted', 'blk_1_1_2', undefined], ['agent:itemUpdated', 'blk_1_1_2', undefined],
    ])
    expect(rs[3].text).toBe('再想')   // 字数由内容直接算
    expect(out.find((e: any) => e.kind === 'agent_message' && e.type === 'agent:itemUpdated')).toMatchObject({ at: 5000 })
  })

  it('实时但没流过（流帧丢失 / 非流式）：思考块不拿整步结束时刻冒充', () => {
    const { r, out, spans } = setup()
    r(msg(5000, [{ type: 'reasoning', text: 'x' }]))
    expect(reasoningEvs(out).map((e) => e.at)).toEqual([undefined, undefined])
    expect(spans).toEqual([])
  })
})
