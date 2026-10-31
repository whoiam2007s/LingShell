// 左侧对话增强的 IPC：AI 提问卡（ask_user）的等待与回答、@ 引用历史会话的摘要、跨会话全文检索、输入框 `!命令`。
// 渲染层参数一律当不可信：终端只认用户可见的、命令限长；回答只认原选项里的 label（见 shared/ai/chatPlus.ts）。
import { randomUUID } from 'node:crypto'
import { normalizeAskAnswer, searchChats, tailBytes, tr, tk, type AppEvent, type AskAnswer, type AskRequest, type AuditEntry, type ChatSearchDoc, type ChatSearchHit } from '@lingshell/shared'

const ASK_TIMEOUT_MS = 10 * 60_000

export interface AskBrokerDeps {
  send(ev: AppEvent): void
  notify?(title: string, body: string): void
  sessionTitle(id: string): string
  unattended(sessionId: string): boolean
  timeoutMs?: number
}

/** 提问卡的等待表：request 发卡并等回答；answer 由界面调；超时 / signal 中止 = 未回答（null） */
export function createAskBroker(d: AskBrokerDeps) {
  const pending = new Map<string, { req: AskRequest; done: (a: AskAnswer | null, result: 'answered' | 'skipped' | 'timeout') => void }>()
  return {
    request(req: AskRequest, signal?: AbortSignal): Promise<AskAnswer | null> {
      // 巡检会话没人回答：立即按未回答返回，绝不挂起
      if (d.unattended(req.sessionId) || signal?.aborted) return Promise.resolve(null)
      const askId = randomUUID()
      const ms = d.timeoutMs ?? ASK_TIMEOUT_MS
      return new Promise((resolve) => {
        const finish = (a: AskAnswer | null, result: 'answered' | 'skipped' | 'timeout') => {
          if (!pending.delete(askId)) return
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          d.send({ type: 'ask:resolved', askId, result, ...(a ? { answer: a } : {}) })
          resolve(a)
        }
        const timer = setTimeout(() => finish(null, 'timeout'), ms)
        const onAbort = () => finish(null, 'skipped')
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(askId, { req, done: finish })
        d.send({ type: 'ask:request', askId, deadlineMs: ms, ...req })
        d.notify?.(tr('「{title}」AI 在等你选择', { title: d.sessionTitle(req.sessionId) }), req.question)
      })
    },
    /** 界面回答：answer 为 null 或全空 = 跳过。已超时 / 已答过的忽略（幂等） */
    answer(askId: string, raw: unknown): void {
      const p = pending.get(askId)
      if (!p) return
      const a = raw === null ? null : normalizeAskAnswer(p.req, raw)
      p.done(a, a ? 'answered' : 'skipped')
    },
    pendingCount: () => pending.size,
  }
}
export type AskBroker = ReturnType<typeof createAskBroker>

export interface ChatPlusDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  ask: AskBroker
  digest(sessionId: string): Promise<string>
  docs(): Promise<ChatSearchDoc[]>            // 会话日志里的文本（dsh）
  auditEntries(): AuditEntry[]                 // 执行记录（含用户在容器 / 服务 / 资源管理器里的操作）
  sessionIds(): Set<string>
  // 用户可见、在运行的终端；没有返回 undefined
  terminal(id: string): { id: string; title: string } | undefined
  exec(terminalId: string, command: string): Promise<{ output: string; exitCode: number }>
  redact(text: string): string                 // 密钥保险箱回写占位符 + 按「发给 AI 前脱敏」设置脱敏
  audit(e: Omit<AuditEntry, 'at' | 'hostKey'> & { hostKey?: string }): void
}

const str = (v: unknown, what: string, max = 2000): string => { if (typeof v !== 'string' || !v.trim()) throw new Error(tr('非法的{what}', { what: tr(what) })); return v.slice(0, max) }

/**
 * 执行记录 → 检索文本：带 callId 的是 AI 工具调用，会话日志里已有；同一会话同一条命令（授权记录 + 执行记录、
 * 或日志里已有的）只留一条。seen = 会话日志里已有的「会话 \n 命令」
 */
export function auditDocs(entries: AuditEntry[], sessions: Set<string>, seen = new Set<string>()): ChatSearchDoc[] {
  const out: ChatSearchDoc[] = []
  for (const e of entries) {
    const k = `${e.sessionId}\n${e.command}`
    if (!e.command || e.callId || !sessions.has(e.sessionId) || seen.has(k)) continue
    seen.add(k)
    out.push({ sessionId: e.sessionId, kind: 'cmd', text: e.command, at: Date.parse(e.at) || undefined })
  }
  return out
}

export function registerChatPlus(d: ChatPlusDeps): void {
  d.handle('chatPlus:answerAsk', (_e, id, answer) => d.ask.answer(str(id, tk('arg|提问 id'), 100), answer))
  d.handle('chatPlus:digest', (_e, sid) => d.digest(str(sid, tk('arg|会话'), 100)))
  d.handle('chatPlus:search', async (_e, q): Promise<ChatSearchHit[]> => {
    const query = typeof q === 'string' ? q.trim().slice(0, 200) : ''
    if (!query) return []
    const sessions = d.sessionIds()
    const docs = (await d.docs()).filter((x) => sessions.has(x.sessionId))
    const seen = new Set(docs.filter((x) => x.kind === 'cmd').map((x) => `${x.sessionId}\n${x.text}`))
    return searchChats([...docs, ...auditDocs(d.auditEntries(), sessions, seen)], query)
  })
  // `!命令`：在用户指定的终端里执行（界面已做危险命令 / 生产终端确认），结果脱敏、只留末尾 4KB，记执行记录 chat_shell
  d.handle('chatPlus:runShell', async (_e, tid, cmd, sid) => {
    const command = str(cmd, tk('arg|命令'), 8000).trim()
    const t = d.terminal(str(tid, tk('arg|终端'), 100))
    if (!t) throw new Error(tr('终端不存在或已断开'))
    let r: { output: string; exitCode: number }
    try { r = await d.exec(t.id, command) } catch (e) {
      const m = String((e as Error)?.message ?? e)
      throw new Error(m.includes('terminal_busy') ? tr('终端「{title}」正忙（AI 正在执行或在跑别的），稍后再试', { title: t.title }) : m.replace(/^shell_not_supported:\s*/, ''))
    }
    d.audit({ sessionId: typeof sid === 'string' ? sid : '', terminalId: t.id, terminalTitle: t.title, command, decision: 'chat_shell', exitCode: r.exitCode })
    const tail = tailBytes(d.redact(r.output))
    return { exitCode: r.exitCode, output: tail.text, truncated: tail.truncated, terminal: t.title }
  })
}
