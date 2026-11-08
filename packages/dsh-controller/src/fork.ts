// 从某条消息分叉（编辑重发 / 从这里分叉 / 重新生成）：在 dsh 事件日志里找切点。
//
// 两种意图的切点不一样（0.1.6 二轮修复）：
//   includeTurn = false（默认，编辑重发 / 从用户消息分叉）：
//     切点 = 该消息之前最近的 turn/end（含）——前面的轮完整保留，这条消息所在的轮整个不要。
//   includeTurn = true（从 AI 回复分叉）：
//     切点 = 该消息**所在轮的 turn/end**——这一轮要保留。
//     以前一律取「之前」，导致从最新一条回复分叉会把刚刚那一轮整个切掉（用户反馈「丢了最新的一轮对话」）。
// 找不到更早的 turn/end（第一条消息）→ 不带历史。
// 一轮里补发的第二条消息（排队消息被并进同一轮）在 includeTurn=false 时按整轮切：同轮的前一条消息一并不带（少见，接受）。
import { tr, tk } from '@lingshell/shared'
import { userMessageView, type DshEvent } from './relay.js'

export interface ForkPoint {
  boundary?: number      // 继承到的事件 seq（含）；undefined = 空会话
  content: unknown[]     // 这条用户消息的原始内容块（重新生成时原样重发，图片引用 / 路径块都在）
  text: string           // 界面看到的原话（去掉了附件路径块）
  turns: Set<number>     // 继承下来的轮号（拷时间侧车用）
  calls: Set<string>     // 继承下来的工具 callId
}

/** 用户消息在界面上的 itemId（与 relay 一致：消息 id，缺省 user_<seq>） */
export const userMessageIdOf = (ev: DshEvent): string => String(ev.data?.id ?? `user_${ev.seq}`)

export function forkPoint(events: readonly DshEvent[], messageId: string, opts?: { includeTurn?: boolean }): ForkPoint {
  const at = events.findIndex((e) => e.type === 'user/message' && e.data?.source?.kind === 'user' && userMessageIdOf(e) === messageId)
  if (at < 0) throw new Error(tr('message_not_found: 找不到这条消息（可能已被压缩或会话已变化）'))
  let cut = -1
  if (opts?.includeTurn) {
    // 从 AI 回复分叉：保留这一轮 → 往后找该轮的 turn/end
    for (let i = at; i < events.length; i++) if (events[i].type === 'turn/end') { cut = i; break }
    if (cut < 0) {   // 这一轮还没结束（理论上界面会禁用分叉）：保守回落成「不含该轮」
      for (let i = at - 1; i >= 0; i--) if (events[i].type === 'turn/end') { cut = i; break }
    }
  } else {
    for (let i = at - 1; i >= 0; i--) if (events[i].type === 'turn/end') { cut = i; break }
  }
  const turns = new Set<number>(), calls = new Set<string>()
  for (const e of events.slice(0, cut + 1)) {
    if (e.type === 'turn/start' && typeof e.data?.turn === 'number') turns.add(e.data.turn)
    else if (e.type === 'tool/call' && e.data?.callId) calls.add(String(e.data.callId))
  }
  const content = Array.isArray(events[at].data?.content) ? events[at].data.content as unknown[] : []
  return { boundary: cut >= 0 ? events[cut].seq : undefined, content, text: userMessageView(content).text, turns, calls }
}

/** 分叉会话的标题：「原标题（分叉）」，已是分叉的不再叠加（中英两种后缀都认：切换过界面语言的旧标题也不叠加） */
const FORK_SUFFIX = tk('（分叉）')
export const forkTitle = (title: string): string => {
  const suffix = tr(FORK_SUFFIX)
  return title.endsWith(FORK_SUFFIX) || title.endsWith(suffix) ? title : `${title}${suffix}`
}

/**
 * 「摘要 + 最近几轮」重组成种子事件：新会话一打开就能看到这段历史（是真实消息，不过是拷过来的）。
 *
 * 做法：取源日志末尾 N 轮（默认 2 轮）的事件 → **seq 重编成 0..n-1** → 把压缩摘要作为一段文本垫进
 * 这段历史的第一条用户消息 → 交给 dsh 官方的 buildForkSeed 补 `session/end-seed {inherited:true}` 标记
 * 和未结束轮次的收尾事件。
 *
 * 注意：
 *  - 只拷贝「整轮」的尾巴（从 turn/end 之后开始），工具调用与结果都在同一段里，surface 校验才过得去；
 *  - 摘要垫在第一条用户消息里（加 `data.content` 文本块），事件外壳不变，dsh 的 envelope 校验照过；
 *  - 返回 undefined = 没有可拷的历史（比如从第一条消息分叉），调用方退回「只带 digest」。
 */
export function digestSeed(
  events: readonly DshEvent[],
  opts?: { turns?: number; summary?: string; buildSeed?: (evts: unknown[], boundary: number) => unknown[] },
): { seed: unknown[]; inherited: number } | undefined {
  const build = opts?.buildSeed
  if (!build) return undefined
  const want = Math.max(1, opts?.turns ?? 2)
  // 只拷「完整且自洽的轮」：终点取最后一个 turn/end，起点取「倒数第 want+1 个 turn/end 之后」——
  // 这样每轮的用户消息、inbox 事件、turn/start、工具调用、结果都按原顺序整段带上；少一个事件
  // dsh 的 inbox splice 校验就会报「invalid persisted inbox splice」，会话直接起不来。
  const ends: number[] = []
  for (let i = 0; i < events.length; i++) if (events[i].type === 'turn/end') ends.push(i)
  if (!ends.length) return undefined
  const lastEnd = ends[ends.length - 1]
  const start = ends.length > want ? ends[ends.length - want - 1] + 1 : 0
  const tail = events.slice(start, lastEnd + 1)
  if (!tail.length) return undefined
  type SeedEvent = {
    type?: string; seq: number; surfaceOp?: unknown; sourceEventSeqs?: number[]
    data?: { content?: unknown[]; [k: string]: unknown }; [k: string]: unknown
  }
  const rows = tail as unknown as SeedEvent[]
  const indexOfSeq = new Map<number, number>()
  rows.forEach((e, i) => indexOfSeq.set(Number(e.seq), i))
  // 事件里引用的原始 seq：① 顶层的 sourceEventSeqs（表面替换「遮蔽了哪些事件」，
  // 工具结果的 closer 也用）；② replace 的 surfaceOp.startSeq / endSeq（被替换的当前节点范围）。
  // 注意这两个都在事件**顶层**，不在 data 里 —— 放到 data 里 dsh 根本看不到，等于没改。
  const refsOf = (e: SeedEvent): number[] => {
    const out: number[] = []
    if (Array.isArray(e.sourceEventSeqs)) out.push(...e.sourceEventSeqs.filter((n) => typeof n === 'number'))
    const op = e.surfaceOp as { startSeq?: unknown; endSeq?: unknown } | undefined
    if (op && typeof op === 'object') {
      if (typeof op.startSeq === 'number') out.push(op.startSeq)
      if (typeof op.endSeq === 'number') out.push(op.endSeq)
    }
    return out
  }
  // 严格校验：只要有一个引用落在这段外面 / 指向自己或更晚的事件，这段历史就不干净，直接放弃种子，
  // 由调用方退回「只带 digest」（历史仍以只读块显示），绝不把半截种子交给 dsh。
  for (let i = 0; i < rows.length; i++) {
    const op = rows[i].surfaceOp
    if (op !== undefined && op !== 'append') return undefined   // 压缩检查点（replace）：整段都不可靠
    for (const n of refsOf(rows[i])) {
      const j = indexOfSeq.get(n)
      if (j === undefined || j >= i) return undefined
    }
  }
  const renumbered: SeedEvent[] = rows.map((e, i) => {
    const seedEvent = { ...e, seq: i } as SeedEvent
    if (Array.isArray(e.sourceEventSeqs)) seedEvent.sourceEventSeqs = e.sourceEventSeqs.map((n) => indexOfSeq.get(n)!)
    const op = e.surfaceOp as { startSeq?: number; endSeq?: number } | undefined
    if (op && typeof op === 'object' && typeof op.startSeq === 'number' && typeof op.endSeq === 'number')
      seedEvent.surfaceOp = { op: 'replace' as const, startSeq: indexOfSeq.get(op.startSeq)!, endSeq: indexOfSeq.get(op.endSeq)! }
    return seedEvent
  })
  // 摘要挂到第一条用户消息的**末尾**、包成 <context type="session"> 块：
  // 模型照样能看到摘要（块原文随消息发出去），界面只显示成一个 chip，不再糊一整块文字进气泡。
  // 块必须落在正文最后（反解正则只匹配末尾），所以追加到最后一个文本块尾部。
  const summary = (opts?.summary ?? '').trim()
  if (summary) {
    const at = renumbered.findIndex((e) => e.type === 'user/message')
    if (at >= 0) {
      const data = (renumbered[at].data ?? {}) as { content?: unknown[] }
      const content = Array.isArray(data.content) ? [...data.content] : []
      const block = `<context type="session" name="${tr('上一会话摘要')}">\n${summary.replace(/<\/context>/g, '</ context>')}\n</context>`
      let appended = false
      for (let i = content.length - 1; i >= 0; i--) {
        const b = content[i] as { type?: string; text?: string }
        if (b?.type === 'text' && typeof b.text === 'string') {
          content[i] = { ...b, text: `${b.text.trimEnd()}\n\n${block}` }
          appended = true
          break
        }
      }
      if (!appended) content.push({ type: 'text', text: block })
      renumbered[at] = { ...renumbered[at], data: { ...data, content } }
    }
  }
  return { seed: build(renumbered, renumbered.length - 1), inherited: renumbered.length }
}
