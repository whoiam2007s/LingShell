// 从某条用户消息之前分叉（编辑重发 / 从这里分叉 / 重新生成）：在 dsh 事件日志里找切点。
// 切点 = 该消息之前最近的 turn/end（含）——前面的轮完整保留，这条消息所在的轮整个不要。
// 没有更早的 turn/end（第一条消息）→ 不带历史，开空会话。
// 一轮里补发的第二条消息（排队消息被并进同一轮）也按整轮切：同轮的前一条消息一并不带（少见，接受）。
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

export function forkPoint(events: readonly DshEvent[], messageId: string): ForkPoint {
  const at = events.findIndex((e) => e.type === 'user/message' && e.data?.source?.kind === 'user' && userMessageIdOf(e) === messageId)
  if (at < 0) throw new Error(tr('message_not_found: 找不到这条消息（可能已被压缩或会话已变化）'))
  let cut = -1
  for (let i = at - 1; i >= 0; i--) if (events[i].type === 'turn/end') { cut = i; break }
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
