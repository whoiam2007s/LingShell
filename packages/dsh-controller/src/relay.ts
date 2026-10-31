/* eslint-disable @typescript-eslint/no-explicit-any */
// 防腐层：把 DeepSeek Harness 的 session 事件翻成我方 AgentEvent。
// dsh 的事件模型很规整——
// 词汇表由实测抓取（fixture 见 __fixtures__/，抓取脚本已随 spike 删除，见 git 历史 0de8580）。
//
//   turn/start · turn/end{reason}          轮生命周期
//   step/start · step/end                  一次模型请求的边界（我方不暴露）
//   user/message                           用户消息（含系统注入的 runtime-context 快照）
//   assistant/chunk{block-start|*-delta|block-end|usage|finish}   流式
//   assistant/message                      本步的完整助手消息（blocks: reasoning|text|tool-call）
//   tool/call{callId,name,arguments} · tool/result{message.content[0]}
//   request/header · request/context · agent/inbox/spliced        我方不关心
import type { AgentEvent, ItemKind, MsgAttachment } from '@lingshell/shared'
import { splitPathsBlock, splitContextBlocks, baseName, tr, tk } from '@lingshell/shared'
import { friendlyError } from './providers.js'

export interface DshEvent { type: string; seq: number; time: number; data?: any }

// dsh 的 turn/step 是会话内自增整数，不是全局 id；拼成我方的字符串 turnId。
const turnIdOf = (turn: unknown) => `turn_${turn}`
// 助手内容块没有自己的 id，用 turn:step:blockIndex 做稳定 itemId（同一块的 delta 会归到一起）。
const blockIdOf = (turn: unknown, step: unknown, index: unknown) => `blk_${turn}_${step}_${index}`
/** 思考块在时间侧车里的键（流式块 index = assistant/message 的 content 下标） */
export const reasoningKey = (turn: unknown, step: unknown, index: unknown) => `${turn}:${step}:${index}`

const BLOCK_KIND: Record<string, ItemKind> = { reasoning: 'agent_reasoning', text: 'agent_message' }

// tool-call 的 arguments 是 JSON 字符串；坏串不能让整条流挂掉，原样兜住。
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return { _raw: raw } }
}

// content 数组里所有 text 块拼起来
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
}

/**
 * 用户消息 → 界面看到的原话 + 附件：文本末尾的路径块（发送时追加，见 shared/ai/attachments.ts）解析成文件 / 目录附件，
 * 图片块（只存存档引用）成图片附件，界面按 imageId 取存档副本显示——不依赖原图路径还在
 */
export function userMessageView(content: unknown): { text: string; attachments: MsgAttachment[] } {
  const { text: withCtx, paths } = splitPathsBlock(textOf(content))
  const { text, ctxs } = splitContextBlocks(withCtx)   // @ 引用 / 终端块（追加在原话与路径块之间）
  const attachments: MsgAttachment[] = [
    ...ctxs.map((c): MsgAttachment => ({ kind: 'context', ctx: c.ctx, name: c.name, text: c.text })),
    ...paths.map((p): MsgAttachment => ({ kind: p.kind, name: baseName(p.path), path: p.path })),
  ]
  if (Array.isArray(content)) {
    for (const b of content as any[]) {
      const a = b?.type === 'image' ? b.attachment : undefined
      if (a?.attachmentId) attachments.push({ kind: 'image', name: String(a.name ?? tr('图片')), imageId: String(a.attachmentId) })
    }
  }
  return { text, attachments }
}

/**
 * 每次模型请求的**精确**上下文大小。
 *
 * dsh 的 usage 是**按请求**给的，且 inputTokens 只算未命中缓存的部分、命中的走
 * cacheReadTokens —— 两者相加才是这次请求真正的提示词长度，且随请求单调递增。
 * 实测一轮内三次请求：463+0=463 → 96+512=608 → 81+640=721。
 *
 * 对比 CodeWhale：它只在 turn.completed 给一个把本轮所有请求**累加**的 input_tokens，
 * 根本读不出上下文（8 次工具调用的轮能报到 32 万，真实上下文才 4.6 万），我们为此只能
 * 退而求其次"只认零工具调用的轮"。这里不需要那个绕法了。
 */
export function contextTokensOf(ev: DshEvent): number | undefined {
  const u = usageOf(ev)
  if (typeof u?.inputTokens !== 'number') return undefined
  return u.inputTokens + (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0)
}

// 一次请求的 usage 以 assistant/message.data.usage 为准（一次请求一条；旧版日志里流式 usage 块与它重复，不再读块）
function usageOf(ev: DshEvent): any {
  return ev.type === 'assistant/message' ? ev.data?.usage : undefined
}

/** 这次请求的 tokens 明细（用量统计）：input 只含未命中缓存的部分，命中的在 cacheRead */
export function requestUsageOf(ev: DshEvent): { input: number; cacheRead: number; output: number } | undefined {
  const u = usageOf(ev)
  if (typeof u?.inputTokens !== 'number') return undefined
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  return { input: u.inputTokens, cacheRead: n(u.cacheReadTokens), output: n(u.outputTokens) }
}

/**
 * 建一个会话的事件翻译器。有状态：流式块要跨 chunk 累计，故按 blockId 记已开块。
 * @param sessionId 我方会话 id
 * @param emit 每翻出一条 AgentEvent 调一次
 */
/**
 * 历史搜索用：从持久化事件里抽出用户能认出来的文字——用户消息、AI 回复正文、执行过的命令。
 * 不含推理过程和工具输出（量大且多是噪音，搜「nginx」会命中每一行日志）。
 */
export function searchableTexts(events: DshEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) {
    const d = ev.data ?? {}
    if (ev.type === 'user/message' && d.source?.kind === 'user') out.push(textOf(d.content))
    else if (ev.type === 'assistant/message') out.push(textOf(d.message?.content))
    else if (ev.type === 'tool/call') {
      // 命令；文件工具（read_file / write_file / download_file）收路径，搜文件名能找到改过它的会话
      const a = parseArgs(d.arguments) as { command?: unknown; path?: unknown } | undefined
      if (typeof a?.command === 'string') out.push(a.command)
      else if (typeof a?.path === 'string') out.push(a.path)
    }
  }
  return out.filter((t) => t.trim())
}

/**
 * dsh 0.2 起流式块不再进 session/event，改走 agent 上的 `agent/assistant-stream` 帧（start / chunk / end，进程内、不落盘）。
 * 这里把帧翻回旧词汇 assistant/chunk{turn,step,chunk} 交给 relay；usage 块丢掉——
 * 一次请求的权威 usage 在随后落盘的 assistant/message 上，避免重复计数。
 */
export function createStreamAdapter(): (frame: any) => DshEvent | undefined {
  const attempts = new Map<string, { turn: unknown; step: unknown }>()
  return (frame) => {
    const key = String(frame?.attemptId ?? '')
    if (frame?.type === 'start') { attempts.set(key, { turn: frame.turn, step: frame.step }); return undefined }
    const at = attempts.get(key)
    if (frame?.type === 'end') {
      // 一次请求的流结束：只有落成 assistant/message 才算正常（失败 / 重试落的是 assistant/attempt，或 abandoned）——
      // relay 据此把这次流里已识别、却不会再有 tool/call 的工具卡收尾
      attempts.delete(key)
      if (!at) return undefined
      const o = frame.outcome ?? {}
      return { type: 'assistant/stream-end', seq: -1, time: Number(frame.time) || 0, data: { turn: at.turn, step: at.step, ok: o.kind === 'committed' && o.eventType === 'assistant/message' } }
    }
    if (frame?.type !== 'chunk' || !at || frame.chunk?.type === 'usage') return undefined
    return { type: 'assistant/chunk', seq: -1, time: Number(frame.time) || 0, data: { turn: at.turn, step: at.step, chunk: frame.chunk } }
  }
}

export interface RelayOptions {
  // 历史回放：turn/start·turn/end 只翻成 agent:turnTiming（不发 turnStarted/Completed——孤儿 turn/start 会让前端 busy 卡死）；
  // 事件没带时间戳就不给时间（不拿「现在」冒充）
  replay?: boolean
  firstAtOf?: (turn: number) => number | undefined   // 回放：侧车里记下的该轮「模型首次返回」时间
  onFirst?: (turn: number, at: number) => void       // 实时：本轮模型首次返回（主进程据此落侧车）
  toolAtOf?: (callId: string) => number | undefined  // 回放：侧车里记下的该工具「识别时刻」
  onToolSeen?: (callId: string, at: number) => void  // 实时：在流式输出里识别到工具（主进程据此落侧车）
  reasoningAtOf?: (key: string) => [number, number] | undefined          // 回放：侧车里记下的思考块开始 / 结束
  onReasoning?: (key: string, start: number, end: number) => void        // 实时：一个思考块输出完（或流中止）
}

// 流中止时分不清是用户停止还是出错重试（都落 assistant/attempt），统一说「已中止」
const PREP_ABORTED = tk('已中止：参数还没生成完模型输出就停了（用户停止或请求出错），工具未执行')

/** 正常结束 / 用户主动停止（interrupted，或 aborted 且原因是 user）：回放时不当错误显示 */
export function isNormalEnd(reason: { kind?: string; reason?: { kind?: string }; cause?: unknown }): boolean {
  const k = reason.kind
  const by = reason.reason?.kind ?? (typeof reason.cause === 'object' ? (reason.cause as { kind?: string } | null)?.kind : reason.cause)
  return k === 'completed' || k === 'interrupted' || (k === 'aborted' && by === 'user')
}

export function createRelay(sessionId: string, emit: (ev: AgentEvent) => void, opts: RelayOptions = {}) {
  const openBlocks = new Map<string, ItemKind>()   // 已发过 itemStarted、还没收尾的块 → kind
  // 进行中的思考块：itemId → 侧车键 + 开始时刻（block-start）。块结束 / 流中止时回调 onReasoning 落侧车
  const reasoning = new Map<string, { key: string; start?: number }>()
  const doneBlocks = new Set<string>()   // 已发过 completed 的块（assistant/message 不再重复发）
  const firstSeen = new Set<string>()    // 已报过「首次返回」的轮
  // 工具「识别时刻」：tool-call 块的 block-start（无 id）先到，首个带 id 的 tool-call-delta 才知道是哪个工具。
  // blockStart: 块 itemId → block-start 时刻；blockCall: 块 itemId → 已关联的 callId；
  // preparing: 已出卡但还没等到 tool/call 的工具；seenAt: callId → 识别时刻（tool/call 时取用）
  const blockStart = new Map<string, number | undefined>()
  const blockCall = new Map<string, string>()
  const preparing = new Map<string, { turnId: string; stepKey: string }>()
  const seenAt = new Map<string, number>()
  let turn: unknown = 0
  let step: unknown = 0
  let usersInTurn = 0   // 本轮已出现的用户消息数：第二条起是中途追问（steering）
  // dsh 事件自带 time（落盘的也有）；实时流帧可能缺，用收到的时刻补；回放缺就是缺
  const timeOf = (ev: DshEvent) => (ev.time > 0 ? ev.time : opts.replay ? undefined : Date.now())
  // 本轮模型首次返回（首个流式块 / 工具调用 / 非流式的整条消息）。回放不推断：落盘的 assistant/message 是整步结束时刻，不是首个 token
  const first = (t: unknown, at: number | undefined) => {
    const turnId = turnIdOf(t)
    if (opts.replay || at === undefined || firstSeen.has(turnId)) return
    firstSeen.add(turnId)
    emit({ type: 'agent:turnTiming', sessionId, turnId, firstAt: at })
    opts.onFirst?.(Number(t), at)
  }
  // 已识别、但不会再有 tool/call 的工具卡（流中止 / 出错重试 / 轮结束）→ 失败收尾，停止计时
  const failPreparing = (match: (stepKey: string) => boolean, at: number | undefined, error: string) => {
    for (const [callId, p] of preparing) {
      if (!match(p.stepKey)) continue
      preparing.delete(callId)
      seenAt.delete(callId)
      emit({ type: 'agent:itemUpdated', sessionId, turnId: p.turnId, itemId: callId, kind: 'tool_call', status: 'failed', tool: { toolId: callId, name: '' }, error, at })
    }
  }
  const dropBlocks = (prefix: string) => {
    for (const k of [...blockStart.keys()]) if (k.startsWith(prefix)) blockStart.delete(k)
    for (const k of [...blockCall.keys()]) if (k.startsWith(prefix)) blockCall.delete(k)
  }
  // 思考块结束：有开始有结束才落侧车
  const endReasoning = (itemId: string, end: number | undefined) => {
    const r = reasoning.get(itemId)
    if (!r) return
    reasoning.delete(itemId)
    if (r.start !== undefined && end !== undefined) opts.onReasoning?.(r.key, r.start, Math.max(end, r.start))
  }
  // 流中止 / 轮结束时还开着的文字 / 思考块：就地收尾（保留已输出的内容），停止计时。不记 doneBlocks——重试会用同一 itemId 重开
  const closeOpen = (prefix: string, turnId: string, at: number | undefined) => {
    for (const [itemId, kind] of [...openBlocks]) {
      if (!itemId.startsWith(prefix)) continue
      openBlocks.delete(itemId)
      endReasoning(itemId, at)
      emit({ type: 'agent:itemUpdated', sessionId, turnId, itemId, kind, status: 'completed', text: '', at })
    }
  }

  return function relay(ev: DshEvent): void {
    const d = ev.data ?? {}
    const at = timeOf(ev)
    switch (ev.type) {
      case 'turn/start': {
        turn = d.turn
        usersInTurn = 0
        const turnId = turnIdOf(turn)
        if (!opts.replay) emit({ type: 'agent:turnStarted', sessionId, turnId })
        const firstAt = opts.replay ? opts.firstAtOf?.(Number(turn)) : undefined
        emit({ type: 'agent:turnTiming', sessionId, turnId, ...(at ? { startedAt: at } : {}), ...(firstAt ? { firstAt } : {}) })
        break
      }

      case 'turn/end': {
        const turnId = turnIdOf(d.turn ?? turn)
        const reason = d.reason ?? {}
        if (at) emit({ type: 'agent:turnTiming', sessionId, turnId, endedAt: at })
        // 还在「生成参数」的工具：轮都结束了也等不到 tool/call 了
        failPreparing(() => true, at, tr(PREP_ABORTED))
        closeOpen('', turnId, at)
        blockStart.clear(); blockCall.clear(); seenAt.clear(); reasoning.clear()
        if (opts.replay) {
          // 历史里出错的轮也要显示错误（用户主动停止的不算错，实时时也不显示）
          if (!isNormalEnd(reason)) emit({ type: 'agent:turnFailed', sessionId, turnId, error: friendlyError(String(reason.error?.message ?? reason.kind ?? 'unknown')) })
          openBlocks.clear(); doneBlocks.clear(); break
        }
        if (reason.kind === 'completed') emit({ type: 'agent:turnCompleted', sessionId, turnId })
        else {
          // reason.kind 见过 'error'（带 error.message）与取消类；一律走 turnFailed，把 kind 兜底成错因
          const error = reason.error?.message ?? reason.kind ?? 'unknown'
          emit({ type: 'agent:turnFailed', sessionId, turnId, error: friendlyError(String(error)), ...(isNormalEnd(reason) ? { stopped: true } : {}) })
        }
        openBlocks.clear()
        doneBlocks.clear()
        break
      }

      case 'step/start': step = d.step; break

      case 'user/message': {
        // 跳过系统注入的 runtime-context 快照（source.kind==='plugin'），那不是用户说的话
        if (d.source?.kind !== 'user') break
        const { text, attachments } = userMessageView(d.content)
        emit({
          type: 'agent:itemUpdated', sessionId, turnId: turnIdOf(turn),
          itemId: String(d.id ?? `user_${ev.seq}`),
          kind: 'user_message', status: 'completed', text, at,
          ...(attachments.length ? { attachments } : {}),
          ...(usersInTurn++ > 0 ? { steered: true } : {}),
        })
        break
      }

      case 'assistant/chunk': {
        const c = d.chunk ?? {}
        const itemId = blockIdOf(d.turn ?? turn, d.step ?? step, c.index)
        const turnId = turnIdOf(d.turn ?? turn)
        if (c.type === 'block-start') {
          const kind = BLOCK_KIND[c.blockType]
          // tool-call 块由 tool/call 事件负责，这里不重复开（但它也算模型开始返回）
          if (kind) {
            openBlocks.set(itemId, kind)
            if (kind === 'agent_reasoning') reasoning.set(itemId, { key: reasoningKey(d.turn ?? turn, d.step ?? step, c.index), start: at })
            emit({ type: 'agent:itemStarted', sessionId, turnId, itemId, kind, status: 'in_progress', at })
          } else if (c.blockType === 'tool-call') blockStart.set(itemId, at)   // 还没有 id：先记时刻，等首个 delta 关联
          first(d.turn ?? turn, at)
        } else if (c.type === 'tool-call-delta') {
          // 首个带 id 的 delta：关联出 callId，立即出卡（「生成参数中」），识别时刻取 block-start（没有 block-start 的协议用本 delta）
          const id = typeof c.id === 'string' ? c.id : ''
          const bound = blockCall.get(itemId)
          if (!bound && id) {
            const seen = blockStart.get(itemId) ?? at
            blockCall.set(itemId, id)
            if (seen !== undefined) { seenAt.set(id, seen); opts.onToolSeen?.(id, seen) }
            preparing.set(id, { turnId, stepKey: `${d.turn ?? turn}_${d.step ?? step}` })
            emit({ type: 'agent:itemStarted', sessionId, turnId, itemId: id, kind: 'tool_call', status: 'in_progress', phase: 'preparing', tool: { toolId: id, name: String(c.name ?? '') }, at: seen })
            first(d.turn ?? turn, seen)
          } else if (bound && c.name && preparing.has(bound)) {
            // 名字晚于 id 到（少见）：补上
            emit({ type: 'agent:itemStarted', sessionId, turnId, itemId: bound, kind: 'tool_call', status: 'in_progress', phase: 'preparing', tool: { toolId: bound, name: String(c.name) }, at: seenAt.get(bound) })
          }
        } else if (c.type === 'reasoning-delta' || c.type === 'text-delta') {
          if (!openBlocks.has(itemId)) break
          emit({
            type: 'agent:itemDelta', sessionId, turnId, itemId,
            kind: c.type === 'reasoning-delta' ? 'agent_reasoning' : 'agent_message',
            text: String(c.text ?? ''), at,
          })
        } else if (c.type === 'block-end') {
          if (!openBlocks.delete(itemId)) break
          const kind = BLOCK_KIND[c.block?.type]
          if (!kind) break
          doneBlocks.add(itemId)
          endReasoning(itemId, at)
          emit({
            type: 'agent:itemUpdated', sessionId, turnId, itemId,
            kind, status: 'completed', text: String(c.block?.text ?? ''), at,
          })
        }
        // usage / finish 不进 UI：usage 交给上层做水位；
        // tool-call 的参数以 tool/call 为准（带完整 arguments，不拼增量），delta 只用来提早识别
        break
      }

      // 流适配器合成：一次请求的流结束。没落成 assistant/message（出错 / 重试 / 放弃）→ 这次流里识别出的工具不会执行
      case 'assistant/stream-end': {
        const stepKey = `${d.turn ?? turn}_${d.step ?? step}`
        if (!d.ok) {
          failPreparing((k) => k === stepKey, at, tr(PREP_ABORTED))
          closeOpen(`blk_${stepKey}_`, turnIdOf(d.turn ?? turn), at)
        }
        dropBlocks(`blk_${stepKey}_`)   // 重试会从 index 0 重来，不能沿用上次的关联
        break
      }

      // 0.2：一步的完整助手消息（落盘）。实时流已经发过的块跳过；没流过的（重连回放 / 流帧丢失）一次性补发开始+完成。
      // 思考块的开始 / 结束本事件给不出（at 是整步结束时刻）：回放取侧车，没有就不给时间（界面只显示字数）
      case 'assistant/message': {
        const blocks: any[] = Array.isArray(d.message?.content) ? d.message.content : []
        const turnId = turnIdOf(d.turn ?? turn)
        blocks.forEach((b, i) => {
          const kind = BLOCK_KIND[b?.type]
          if (!kind) return
          const itemId = blockIdOf(d.turn ?? turn, d.step ?? step, i)
          if (doneBlocks.has(itemId)) return
          let start = at, end = at
          if (openBlocks.delete(itemId)) endReasoning(itemId, at)   // 流过但没等到 block-end：此刻算结束
          else {
            if (kind === 'agent_reasoning') {
              const span = opts.replay ? opts.reasoningAtOf?.(reasoningKey(d.turn ?? turn, d.step ?? step, i)) : undefined
              start = span?.[0]; end = span?.[1]
            }
            emit({ type: 'agent:itemStarted', sessionId, turnId, itemId, kind, status: 'in_progress', at: start })
          }
          doneBlocks.add(itemId)
          emit({ type: 'agent:itemUpdated', sessionId, turnId, itemId, kind, status: 'completed', text: String(b.text ?? ''), at: end })
        })
        first(d.turn ?? turn, at)   // 流帧丢失 / 非流式时的兜底（流过的轮早已记过，这里不生效）
        break
      }

      case 'tool/call': {
        // itemId 与流式阶段出的卡相同（= callId），就地补参数、切到执行中。
        // 耗时起点 = 识别时刻（实时取本次流，回放取侧车）；都没有（旧会话 / 非流式）退回本事件时间。晚于本事件的视为坏值不用
        const callId = String(d.callId)
        const seen = seenAt.get(callId) ?? (opts.replay ? opts.toolAtOf?.(callId) : undefined)
        const known = seen !== undefined && (at === undefined || seen <= at)
        const start = known ? seen : at
        preparing.delete(callId)
        seenAt.delete(callId)
        emit({
          type: 'agent:itemStarted', sessionId, turnId: turnIdOf(d.turn ?? turn),
          itemId: callId, kind: 'tool_call', status: 'in_progress',
          tool: { toolId: callId, name: String(d.name), input: parseArgs(d.arguments) }, at: start,
          ...(known && at !== undefined ? { callAt: at } : {}),   // 只有知道识别时刻才拆「生成参数 / 执行」
        })
        first(d.turn ?? turn, start)
        break
      }

      case 'tool/result': {
        // 旧日志：content 里一个 tool-result 块；0.2：消息本身就是工具结果（toolCallId / isError 在消息上，content 是文本块）
        const block = (d.message?.content ?? []).find((b: any) => b?.type === 'tool-result') ?? d.message
        const callId = String(block?.toolCallId ?? d.callId ?? '')
        if (!callId) break
        const failed = block?.isError === true
        emit({
          type: 'agent:itemUpdated', sessionId, turnId: turnIdOf(d.turn ?? turn),
          itemId: callId, kind: 'tool_call', status: failed ? 'failed' : 'completed',
          tool: { toolId: callId, name: '', output: textOf(block?.content) },
          error: failed ? textOf(block?.content) : undefined, at,
        })
        break
      }

      // step/end · request/header · request/context · agent/inbox/spliced：我方不暴露
      default: break
    }
  }
}
