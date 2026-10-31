import { describe, expect, it } from 'vitest'
import type { AuditEntry, TerminalInfo } from '@lingshell/shared'
import { createAuditHelpers, findLiveTerminal } from './audit.js'

const term = (id: string, over: Partial<TerminalInfo> = {}) => ({ id, type: 'ssh', title: `T-${id}`, status: 'running', ...over }) as TerminalInfo

function setup(terms: TerminalInfo[] = [], keys: [string, string][] = [], hidden: string[] = []) {
  const added: AuditEntry[] = []
  const logs: { label: string; data: Record<string, unknown> }[] = []
  const h = createAuditHelpers({
    add: (e) => added.push(e),
    activeSessionId: () => 's1',
    terminalTitle: (id) => terms.find((t) => t.id === id)?.title,
    hostKeyOf: (id) => keys.find(([k]) => k === id)?.[1],
    hostLabel: (hk) => (hk === 'h1' ? 'Prod Web' : undefined),
    logAudit: (label, data) => logs.push({ label, data }),
    now: () => '2026-10-22T00:00:00.000Z',
  })
  const live = (hostKey: string, o: { running?: boolean; ssh?: boolean; includeHidden?: boolean } = {}) =>
    findLiveTerminal(hostKey, { ...o, terminals: () => terms, hostKeys: () => keys, isHidden: (id) => hidden.includes(id) })
  return { ...h, added, logs, live }
}

describe('执行记录 helper', () => {
  it('auditRaw：补会话 / 时间，运行日志默认去掉命令原文，执行记录保留', () => {
    const s = setup()
    const e = s.auditRaw({ command: 'mysql -psecret', decision: 'batch_exec' })
    expect(e).toEqual({ sessionId: 's1', terminalId: '', hostKey: 'local', command: 'mysql -psecret', decision: 'batch_exec', at: '2026-10-22T00:00:00.000Z' })
    expect(s.logs[0].label).toBe('batch_exec')
    expect(s.logs[0].data.command).toBeUndefined()
    expect(s.logs[0].data.at).toBeUndefined()
    expect(s.added[0].command).toBe('mysql -psecret')
  })
  it('auditRaw：logCommand 打开时日志带命令；logLabel / logExtra 生效', () => {
    const s = setup()
    s.auditRaw({ command: 'ls', decision: 'user_edit' }, { logCommand: true, logLabel: 'restore', logExtra: { status: 'ok' } })
    expect(s.logs[0]).toMatchObject({ label: 'restore', data: { command: 'ls', status: 'ok' } })
  })
  it('auditTerminal：按终端补终端名与主机；终端不在时主机回落 local', () => {
    const s = setup([term('t1')], [['t1', 'h1']])
    expect(s.auditTerminal('t1', { command: 'git push', decision: 'git_push' })).toMatchObject({ terminalId: 't1', terminalTitle: 'T-t1', hostKey: 'h1' })
    expect(s.auditTerminal('gone', { decision: 'download_allowed' })).toMatchObject({ terminalId: 'gone', hostKey: 'local' })
  })
  it('auditHost：本机显示「本机」，其它主机用主机名；显式给的字段优先', () => {
    const s = setup()
    expect(s.auditHost('local', { decision: 'db_backup' }).terminalTitle).toBe('本机')
    expect(s.auditHost('h1', { decision: 'key_deploy' }).terminalTitle).toBe('Prod Web')
    expect(s.auditHost('h1', { decision: 'key_deploy', terminalTitle: 'web-1' }).terminalTitle).toBe('web-1')
  })
})

describe('找在线终端', () => {
  it('running / 非 disconnected、hidden、ssh 三种过滤', () => {
    const terms = [term('a', { status: 'disconnected' }), term('b', { status: 'running' }), term('c', { status: 'running', type: 'local' })]
    const s = setup(terms, [['a', 'h1'], ['b', 'h1'], ['c', 'h1'], ['d', 'h1']], ['b'])
    expect(s.live('h1', { running: true })).toBe('c')                 // a 断了，b 是 hidden，c 在跑
    expect(s.live('h1', { running: true, includeHidden: true })).toBe('b')
    expect(s.live('h1', { running: true, ssh: true, includeHidden: true })).toBe('b')
    expect(s.live('h1')).toBe('c')                                   // 非 running：除 disconnected 外都算（c 是 local）
    expect(s.live('h1', { includeHidden: true })).toBe('b')
    expect(s.live('h1', { ssh: true })).toBeUndefined()              // 只有 a 是 ssh，但它断了
    expect(s.live('h2')).toBeUndefined()
  })
})
