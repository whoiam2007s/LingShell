// 对话区的跨组件通道（同 quoteToChat：组件树隔得远，用模块级状态 + 窗口事件直连）：
//  - 跳到某会话的某条消息（跨会话搜索结果点击：先切会话，ChatPanel 等历史回放到了再滚过去）；
//  - 往输入框加上下文标签（「问 AI：上次怎么解决…」把检索片段作为标签附上，send=true 时直接发出）。
import type { ContextKind } from '@lingshell/shared'

export interface ChatJump { sessionId: string; itemId?: string; q?: string; at: number }
let jump: ChatJump | null = null
const JUMP_EVT = 'lingshell:chat-jump'
export function requestChatJump(j: Omit<ChatJump, 'at'>): void { jump = { ...j, at: Date.now() }; window.dispatchEvent(new Event(JUMP_EVT)) }
/** 取走属于该会话、10 秒内的跳转请求（不属于就留着，等切过去） */
export function peekChatJump(sessionId: string): ChatJump | null {
  if (jump && Date.now() - jump.at > 10_000) jump = null
  return jump?.sessionId === sessionId ? jump : null
}
export const clearChatJump = () => { jump = null }
export function onChatJump(h: () => void): () => void { window.addEventListener(JUMP_EVT, h); return () => window.removeEventListener(JUMP_EVT, h) }

export interface ChatContextPush { chips: { ctx: ContextKind; name: string; text: string }[]; text?: string; send?: boolean }
const CTX_EVT = 'lingshell:chat-context'
export function pushChatContext(p: ChatContextPush): void { window.dispatchEvent(new CustomEvent<ChatContextPush>(CTX_EVT, { detail: p })) }
export function onChatContext(h: (p: ChatContextPush) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<ChatContextPush>).detail)
  window.addEventListener(CTX_EVT, f)
  return () => window.removeEventListener(CTX_EVT, f)
}
