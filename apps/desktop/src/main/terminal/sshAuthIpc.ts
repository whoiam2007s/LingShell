// SSH 认证相关 IPC：keyboard-interactive 弹框应答（OTP / 堡垒机），全局默认出站代理读写。
// 渲染层参数一律当不可信，逐个校验类型。
import { randomUUID } from 'node:crypto'
import type { AppEvent, ProxyInput, ProxySummary, SshAuthPromptInfo } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { SshAuthPrompter } from '@lingshell/terminal-core'

export interface SshAuthIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  send(ev: AppEvent): void
  notify(title: string, body: string): void           // 窗口不在前台时提醒（后台批量/传输也可能要验证码）
  setPrompter(p: SshAuthPrompter): void
  proxy: { get(): ProxySummary | null; save(p: ProxyInput | null): ProxySummary | null }
  timeoutMs?: number
}

export const SSH_AUTH_TIMEOUT_MS = 3 * 60_000

export function registerSshAuth(d: SshAuthIpcDeps): void {
  const pending = new Map<string, (answers: string[] | null) => void>()
  const timeoutMs = d.timeoutMs ?? SSH_AUTH_TIMEOUT_MS
  d.setPrompter((info: SshAuthPromptInfo, signal: AbortSignal) => new Promise((resolve) => {
    const requestId = randomUUID()
    const done = (answers: string[] | null) => {
      if (!pending.delete(requestId)) return
      clearTimeout(timer)
      d.send({ type: 'sshAuth:resolved', requestId })
      resolve(answers)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    pending.set(requestId, done)
    signal.addEventListener('abort', () => done(null), { once: true })
    d.send({ type: 'sshAuth:prompt', requestId, info, deadlineMs: timeoutMs })
    d.notify(tr('SSH 需要二次验证'), tr('{name}（{host}）', { name: info.label, host: info.hostPort }))
  }))

  d.handle('sshAuth:answer', (_e, requestId, answers) => {
    if (typeof requestId !== 'string') throw new Error(tr('非法的请求'))
    const ok = Array.isArray(answers) && answers.every((a) => typeof a === 'string')
    pending.get(requestId)?.(ok ? answers as string[] : null)
  })
  d.handle('proxy:get', () => d.proxy.get())
  d.handle('proxy:save', (_e, p) => d.proxy.save(p === null ? null : parseProxy(p)))
}

// 代理表单校验（HostStore 再校验地址/端口范围）
export function parseProxy(v: unknown): ProxyInput {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  if (p.type !== 'http' && p.type !== 'socks5') throw new Error(`proxy_invalid: ${tr('代理类型只能是 HTTP 或 SOCKS5')}`)
  const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
  return { type: p.type, host: str(p.host) ?? '', port: Number(p.port), username: str(p.username), password: str(p.password) }
}
