// 对话分叉 IPC：编辑重发 / 从这里分叉 / 重新生成（逻辑在 DshController.forkSession）。渲染层参数当不可信，逐个校验。
import { tr, type SessionInfo } from '@lingshell/shared'

export interface ChatForkDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  fork(sessionId: string, messageId: string, mode: 'fork' | 'regenerate', opts?: { includeTurn?: boolean }): Promise<{ session: SessionInfo; text: string; digest?: string }>
}

export function registerChatFork(d: ChatForkDeps): void {
  d.handle('agent:forkSession', (_e, sessionId, messageId, mode, opts) => {
    if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) throw new Error(tr('非法的会话或消息'))
    if (mode !== 'fork' && mode !== 'regenerate') throw new Error(tr('非法的分叉方式'))
    // includeTurn：从 AI 回复分叉时带上这一轮（从用户消息编辑/分叉时不带）
    return d.fork(sessionId, messageId, mode, { includeTurn: (opts as { includeTurn?: boolean } | undefined)?.includeTurn === true })
  })
}
