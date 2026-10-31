// 直接发给 AI 的通道（终端「让 AI 排查」等）：不同于 quoteToChat（只放进输入框），这里会作为一条用户消息发出。
// 会话还没就绪（没有会话 / 正在新建）时先排队，ChatPanel 就绪后取走发出；App 负责没有会话时新建一个
const EVT = 'lingshell:send-to-chat'
const EVT_NEW = 'lingshell:send-to-new-chat'
let pending: string[] = []
const pendingNew: { text: string; title?: string }[] = []

export function sendToChat(text: string): void {
  pending.push(text)
  window.dispatchEvent(new Event(EVT))
}

/** 取走排队中的消息（ChatPanel 就绪时调用） */
export function takeChatSends(): string[] {
  const p = pending
  pending = []
  return p
}

export function onSendToChat(h: () => void): () => void {
  window.addEventListener(EVT, h)
  return () => window.removeEventListener(EVT, h)
}

// 开新会话再发（告警「用 AI 排查」：一事一会话，不打断手头的对话）。App 收到后新建会话（title 作会话标题），就绪后转入上面的队列发出
export function sendToNewChat(text: string, title?: string): void {
  pendingNew.push({ text, ...(title ? { title } : {}) })
  window.dispatchEvent(new Event(EVT_NEW))
}
/** 取走一条（一次事件取一条：连着点几个告警时，前一条不会被后一条顶掉） */
export function takeNewChatSend(): { text: string; title?: string } | undefined {
  return pendingNew.shift()
}
export function onSendToNewChat(h: () => void): () => void {
  window.addEventListener(EVT_NEW, h)
  return () => window.removeEventListener(EVT_NEW, h)
}
