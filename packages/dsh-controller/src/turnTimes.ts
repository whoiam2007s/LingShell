// 侧车：dsh 日志里没有、重启回放要用的时间。dsh 事件都带 time（轮开始/结束、工具调用/结果、用户消息都能直接用），
// 唯独流式帧不落盘（0.2 流式帧只在进程内）——由我方补记：
//   first: 每轮「模型首次返回」（首个流式块）
//   tools: 每个工具「在模型流式输出里被识别到」的时刻（早于 tool/call：那是参数完整解析后才发）
//   reasoning: 每个思考块的开始 / 结束（流里 block-start / block-end；落盘的 assistant/message 只有整步结束时刻）
// 文件：<baseDir>/chat-times/<dsh 会话 id>.json =
//   { "first": { "<turn>": epochMs }, "tools": { "<toolCallId>": epochMs }, "reasoning": { "<turn>:<step>:<块序号>": [开始, 结束] } }。
// 按 dsh id 存：上下文重置换了 dsh id 后轮号从 1 重来
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'

type Span = [number, number]
interface Times { first: Record<string, number>; tools: Record<string, number>; reasoning: Record<string, Span> }

// 只留正数时间戳；坏结构当空
const clean = (raw: unknown): Record<string, number> =>
  raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number> : {}
// 区间：两个正数且结束不早于开始
const cleanSpans = (raw: unknown): Record<string, Span> =>
  raw && typeof raw === 'object'
    ? Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n > 0) && v[1] >= v[0])) as Record<string, Span>
    : {}

export class TurnTimesStore {
  private cache = new Map<string, Times>()
  private chain = Promise.resolve()   // 写盘串行，后写的一定是最新全量
  constructor(private dir?: string) {}   // 没有数据目录（如单测）就只记内存

  private file(dshId: string) { return join(this.dir ?? '', `${encodeURIComponent(dshId)}.json`) }

  // 同步读（回放前调用）；没有 / 坏文件 → 空
  private load(dshId: string): Times {
    let t = this.cache.get(dshId)
    if (!t) {
      try {
        if (!this.dir) throw new Error('no dir')
        const raw = JSON.parse(readFileSync(this.file(dshId), 'utf8'))
        t = { first: clean(raw?.first), tools: clean(raw?.tools), reasoning: cleanSpans(raw?.reasoning) }
      } catch { t = { first: {}, tools: {}, reasoning: {} } }
      this.cache.set(dshId, t)
    }
    return t
  }

  /** 该 dsh 会话记下的每轮首次返回时间 */
  firstOf(dshId: string): Record<string, number> { return this.load(dshId).first }

  /** 该 dsh 会话记下的每个工具识别时刻（toolCallId → epochMs） */
  toolsOf(dshId: string): Record<string, number> { return this.load(dshId).tools }

  /** 该 dsh 会话记下的每个思考块开始 / 结束（reasoningKey → [开始, 结束]） */
  reasoningOf(dshId: string): Record<string, Span> { return this.load(dshId).reasoning }

  record(dshId: string, turn: number, at: number): Promise<void> {
    return this.load(dshId).first[String(turn)] === undefined ? this.put(dshId, (t) => { t.first[String(turn)] = at }) : this.chain
  }

  recordTool(dshId: string, callId: string, at: number): Promise<void> {
    return this.load(dshId).tools[callId] === undefined ? this.put(dshId, (t) => { t.tools[callId] = at }) : this.chain
  }

  // 思考块后写的覆盖：流出错重试会从块序号 0 重来，最终落盘的是最后一次
  recordReasoning(dshId: string, key: string, start: number, end: number): Promise<void> {
    if (!(start > 0) || !(end >= start)) return this.chain
    return this.put(dshId, (t) => { t.reasoning[key] = [start, end] })
  }

  private put(dshId: string, change: (t: Times) => void): Promise<void> {
    const t = this.load(dshId)
    change(t)
    if (!this.dir) return this.chain
    const dir = this.dir
    const body = JSON.stringify(t)
    this.chain = this.chain.then(() => mkdir(dir, { recursive: true })).then(() => writeFile(this.file(dshId), body)).catch(() => {})
    return this.chain
  }

  /** 分叉：把源会话里继承下来的轮 / 工具的时间拷到新 dsh 会话（轮号、callId 在分叉后不变） */
  copy(from: string, to: string, turns: ReadonlySet<number>, calls: ReadonlySet<string>): Promise<void> {
    const src = this.load(from)
    const keepTurn = (k: string) => turns.has(Number(k.split(':')[0]))
    return this.put(to, (t) => {
      t.first = Object.fromEntries(Object.entries(src.first).filter(([k]) => keepTurn(k)))
      t.tools = Object.fromEntries(Object.entries(src.tools).filter(([k]) => calls.has(k)))
      t.reasoning = Object.fromEntries(Object.entries(src.reasoning).filter(([k]) => keepTurn(k)))
    })
  }

  async remove(dshId: string): Promise<void> {
    this.cache.delete(dshId)
    await this.chain
    if (!this.dir) return
    await rm(this.file(dshId), { force: true }).catch(() => {})
  }
}
