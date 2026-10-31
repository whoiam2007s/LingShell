// 终端 → 聊天输入框的引用通道。两边在组件树里隔得远（TerminalView / ChatPanel），用一个窗口事件直连，免得层层传 props。
const EVT = 'lingshell:quote-to-chat'

export function quoteToChat(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVT, { detail: text }))
}

export function onQuoteToChat(h: (text: string) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<string>).detail)
  window.addEventListener(EVT, f)
  return () => window.removeEventListener(EVT, f)
}
