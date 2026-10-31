import { describe, it, expect, vi } from 'vitest'
import type { AppEvent, AuditEntry, AskRequest } from '@lingshell/shared'
import { createAskBroker, registerChatPlus, auditDocs, type ChatPlusDeps } from './chatPlusIpc.js'

const req: AskRequest = { sessionId: 's1', question: '重启还是 reload？', options: [{ label: '重启' }, { label: 'reload' }], multiSelect: false, allowOther: true }

function broker(timeoutMs = 60_000, unattended = false) {
  const sent: AppEvent[] = []
  const notify = vi.fn()
  const b = createAskBroker({ send: (e) => sent.push(e), notify, sessionTitle: () => '会话A', unattended: () => unattended, timeoutMs })
  return { b, sent, notify }
}
const askIdOf = (sent: AppEvent[]) => (sent.find((e) => e.type === 'ask:request') as Extract<AppEvent, { type: 'ask:request' }>).askId

describe('createAskBroker', () => {
  it('发卡 → 回答（只认原选项）→ resolve 并发 ask:resolved', async () => {
    const { b, sent, notify } = broker()
    const p = b.request(req)
    expect(sent[0]).toMatchObject({ type: 'ask:request', sessionId: 's1', question: '重启还是 reload？', deadlineMs: 60_000 })
    expect(notify).toHaveBeenCalledWith('「会话A」AI 在等你选择', '重启还是 reload？')
    b.answer(askIdOf(sent), { selected: ['reload', '不存在'] })
    await expect(p).resolves.toEqual({ selected: ['reload'] })
    expect(sent[1]).toEqual({ type: 'ask:resolved', askId: askIdOf(sent), result: 'answered', answer: { selected: ['reload'] } })
    b.answer(askIdOf(sent), { selected: ['重启'] })   // 已答过：幂等
    expect(sent).toHaveLength(2)
    expect(b.pendingCount()).toBe(0)
  })
  it('跳过（null / 全空）= 未回答', async () => {
    const { b, sent } = broker()
    const p = b.request(req)
    b.answer(askIdOf(sent), { selected: [] })
    await expect(p).resolves.toBeNull()
    expect(sent[1]).toMatchObject({ type: 'ask:resolved', result: 'skipped' })
  })
  it('超时 = 未回答', async () => {
    vi.useFakeTimers()
    try {
      const { b, sent } = broker(1000)
      const p = b.request(req)
      vi.advanceTimersByTime(1001)
      await expect(p).resolves.toBeNull()
      expect(sent[1]).toMatchObject({ type: 'ask:resolved', result: 'timeout' })
    } finally { vi.useRealTimers() }
  })
  it('停止本轮（signal 中止）收卡', async () => {
    const { b, sent } = broker()
    const ac = new AbortController()
    const p = b.request(req, ac.signal)
    ac.abort()
    await expect(p).resolves.toBeNull()
    expect(sent[1]).toMatchObject({ type: 'ask:resolved', result: 'skipped' })
  })
  it('巡检会话不发卡，直接未回答', async () => {
    const { b, sent } = broker(60_000, true)
    await expect(b.request(req)).resolves.toBeNull()
    expect(sent).toHaveLength(0)
  })
})

function setup(over: Partial<ChatPlusDeps> = {}) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const audits: unknown[] = []
  const d: ChatPlusDeps = {
    handle: (ch, fn) => { handlers.set(ch, fn) },
    ask: createAskBroker({ send: () => {}, sessionTitle: () => '', unattended: () => false }),
    digest: async (sid) => `摘要 ${sid}`,
    docs: async () => [{ sessionId: 's1', kind: 'ai', text: 'reload nginx 恢复了', itemId: 'b1', at: 2 }, { sessionId: 'gone', kind: 'ai', text: 'nginx', at: 3 }],
    auditEntries: () => [],
    sessionIds: () => new Set(['s1', 's2']),
    terminal: (id) => (id === 't1' ? { id: 't1', title: '本地 1' } : undefined),
    exec: async () => ({ output: 'ok\n', exitCode: 0 }),
    redact: (s) => s.replace('hunter2', '[已脱敏]'),
    audit: (e) => { audits.push(e) },
    ...over,
  }
  registerChatPlus(d)
  const call = (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a))
  return { call, audits }
}

describe('registerChatPlus', () => {
  it('runShell：执行、脱敏、只留末尾 4KB、记执行记录', async () => {
    const big = `${'x'.repeat(5000)}\nhunter2 done`
    const { call, audits } = setup({ exec: async () => ({ output: big, exitCode: 3 }) })
    const r = await call('chatPlus:runShell', 't1', ' ls -la ', 's1') as { exitCode: number; output: string; truncated: boolean; terminal: string }
    expect(r.exitCode).toBe(3)
    expect(r.terminal).toBe('本地 1')
    expect(r.truncated).toBe(true)
    expect(r.output.endsWith('[已脱敏] done')).toBe(true)
    expect(r.output.length).toBeLessThanOrEqual(4096)
    expect(audits).toEqual([{ sessionId: 's1', terminalId: 't1', terminalTitle: '本地 1', command: 'ls -la', decision: 'chat_shell', exitCode: 3 }])
  })
  it('runShell：终端不存在 / 正忙 / 空命令报错，不记录', async () => {
    const { call, audits } = setup({ exec: async () => { throw new Error('terminal_busy') } })
    await expect(call('chatPlus:runShell', 'tx', 'ls')).rejects.toThrow('终端不存在或已断开')
    await expect(call('chatPlus:runShell', 't1', 'ls')).rejects.toThrow('正忙')
    await expect(call('chatPlus:runShell', 't1', '  ')).rejects.toThrow('非法的命令')
    expect(audits).toEqual([])
  })
  it('search：会话日志 + 执行记录（不含 AI 工具调用，那些日志里有），只认现存会话', async () => {
    const entries = [
      { at: new Date(5).toISOString(), sessionId: 's2', terminalId: '', hostKey: 'h', command: 'docker restart nginx', decision: 'docker_restart' },
      { at: new Date(6).toISOString(), sessionId: 's1', terminalId: '', hostKey: 'h', command: 'nginx -s reload', decision: 'exec_allowed', callId: 'c1' },
    ] as AuditEntry[]
    const { call } = setup({ auditEntries: () => entries })
    const r = await call('chatPlus:search', 'nginx') as { sessionId: string; kind: string; itemId?: string }[]
    expect(r.map((h) => [h.sessionId, h.kind, h.itemId])).toEqual([['s2', 'cmd', undefined], ['s1', 'ai', 'b1']])
    expect(await call('chatPlus:search', '  ')).toEqual([])
  })
  it('digest 透传', async () => {
    const { call } = setup()
    expect(await call('chatPlus:digest', 's1')).toBe('摘要 s1')
  })
  it('auditDocs：同会话同命令只留一条，日志里已有的不要', () => {
    const e = (command: string, decision: string, callId?: string) => ({ at: 'bad', sessionId: 's1', terminalId: '', hostKey: '', command, decision, ...(callId ? { callId } : {}) }) as AuditEntry
    expect(auditDocs([e('ls', 'x')], new Set(['s1']))).toEqual([{ sessionId: 's1', kind: 'cmd', text: 'ls', at: undefined }])
    // AI 的一次执行 = 授权记录（无 callId）+ 执行记录（有 callId），命令在会话日志里也有
    expect(auditDocs([e('echo 1', 'exec_allowed', 'c1'), e('echo 1', 'allow:first_access'), e('df', 'docker_x'), e('df', 'docker_x')], new Set(['s1']), new Set(['s1\necho 1'])))
      .toEqual([{ sessionId: 's1', kind: 'cmd', text: 'df', at: undefined }])
  })
})
