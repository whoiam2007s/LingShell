import { describe, it, expect } from 'vitest'
import type { AppEvent, SshAuthPromptInfo } from '@lingshell/shared'
import type { SshAuthPrompter } from '@lingshell/terminal-core'
import { registerSshAuth, parseProxy } from './sshAuthIpc.js'

const info: SshAuthPromptInfo = { hostPort: 'h:22', label: 'web1', role: '目标主机', name: '', instructions: '', prompts: [{ prompt: 'Code:', echo: true }] }

function setup(timeoutMs = 1000) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const events: AppEvent[] = []
  const notes: string[] = []
  let prompter: SshAuthPrompter | undefined
  registerSshAuth({
    handle: (ch, fn) => { handlers.set(ch, fn) }, send: (ev) => { events.push(ev) }, notify: (t, b) => { notes.push(`${t}|${b}`) },
    setPrompter: (p) => { prompter = p }, proxy: { get: () => null, save: () => null }, timeoutMs,
  })
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(null, ...a)
  return { events, notes, call, ask: (signal = new AbortController().signal) => prompter!(info, signal) }
}

describe('sshAuth IPC', () => {
  it('推事件 + 通知；应答后返回答案并发 resolved', async () => {
    const t = setup()
    const p = t.ask()
    const ev = t.events[0] as Extract<AppEvent, { type: 'sshAuth:prompt' }>
    expect(ev).toMatchObject({ type: 'sshAuth:prompt', info })
    expect(t.notes[0]).toContain('web1')
    t.call('sshAuth:answer', ev.requestId, ['42'])
    await expect(p).resolves.toEqual(['42'])
    expect(t.events[1]).toEqual({ type: 'sshAuth:resolved', requestId: ev.requestId })
  })
  it('取消 / 非法答案 / 超时 / 连接断开 → null', async () => {
    const t = setup(50)
    const p1 = t.ask()
    t.call('sshAuth:answer', (t.events[0] as { requestId: string }).requestId, null)
    await expect(p1).resolves.toBeNull()
    const p2 = t.ask()
    t.call('sshAuth:answer', (t.events[2] as { requestId: string }).requestId, [1, 2])
    await expect(p2).resolves.toBeNull()
    await expect(t.ask()).resolves.toBeNull()   // 50ms 超时
    const ac = new AbortController()
    const p4 = t.ask(ac.signal)
    ac.abort()
    await expect(p4).resolves.toBeNull()
    expect(t.events.filter((e) => e.type === 'sshAuth:resolved')).toHaveLength(4)
  })
  it('parseProxy 校验类型', () => {
    expect(parseProxy({ type: 'http', host: 'p', port: '8080', username: 1 })).toEqual({ type: 'http', host: 'p', port: 8080, username: undefined, password: undefined })
    expect(() => parseProxy({ type: 'ftp' })).toThrow(/proxy_invalid/)
  })
})
