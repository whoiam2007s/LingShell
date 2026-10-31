import { it, expect, vi } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { summarizeFleet, type FleetHost } from '@lingshell/shared'
// 直接引工具层源文件：包入口会连带加载 dsh 引擎（需 Electron 自带的 Node 才有 zstd）
import { terminalToolDefs, decideFor, type TerminalToolDeps } from '@lingshell/dsh-controller/src/terminalTools.js'
import { runOnHosts, hostRunner } from './fleetExec.js'
import { isReadOnlyCommand } from './readonlyCommand.js'

// 两台本机回环的假 sshd（同 batchExec.real.test.ts）：exec 按主机名回 uname；记录收到的 exec 与连接开关。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function fakeSshd(name: string, opts: { code?: number; hang?: boolean } = {}) {
  const execs: string[] = [], shellIn: string[] = []
  const st = { opened: 0, closed: 0 }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    st.opened++
    c.once('close', () => { st.closed++ })
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { ok().on('data', (d: Buffer) => shellIn.push(d.toString())) })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const ch = ok()
        if (opts.hang) return
        ch.write(`Linux ${name} 6.1.0 x86_64 GNU/Linux\n`)
        ch.exit(opts.code ?? 0); ch.end()
      })
    })
  })
  return new Promise<{ port: number; execs: string[]; shellIn: string[]; st: typeof st; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, execs, shellIn, st, close: () => s.close() })))
}

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

it('两台临时连接并行跑只读命令：各自结果、汇总、连接跑完即断；在线终端复用连接且不碰交互 shell', async () => {
  trustAll()
  const a = await fakeSshd('web-1'), b = await fakeSshd('web-2', { code: 3 })
  const ports: Record<string, number> = { h1: a.port, h2: b.port }
  let term: SshTerminal | undefined
  try {
    const hosts: FleetHost[] = [{ id: 'h1', label: 'web-1', group: 'web' }, { id: 'h2', label: 'web-2', group: 'web' }]
    const live: Record<string, string> = {}
    const open = hostRunner({
      liveTerminal: (id) => live[id],
      execOnTerminal: (_tid, c, o) => term!.exec(c, o),
      connectOpts: (id) => ({ host: '127.0.0.1', port: ports[id], username: 'u', password: 'p' }),
      connect: (o) => connectSsh(o),
      execOnClient: (client, c, o) => execFull(client as Parameters<typeof execFull>[0], c, o),
    })
    const rows = await runOnHosts(hosts, open, 'uname -a', 5000)
    expect(rows.map((r) => [r.host_id, r.status, r.exit_code])).toEqual([['h1', 'ok', 0], ['h2', 'fail', 3]])
    expect(rows[0].output).toBe('Linux web-1 6.1.0 x86_64 GNU/Linux\n')
    expect(rows[0].ms).toBeGreaterThanOrEqual(0)
    expect(summarizeFleet(rows)).toMatchObject({ total: 2, ok: 1, failed: ['h2'] })
    expect(a.execs).toEqual(['uname -a'])
    expect(b.execs).toEqual(['uname -a'])
    await new Promise((r) => setTimeout(r, 200))
    expect([a.st.closed, b.st.closed]).toEqual([a.st.opened, b.st.opened])   // 临时连接跑完即断

    // h1 有在线终端：复用它的连接（不新建），走独立 exec channel，交互 shell 收不到输入
    term = await SshTerminal.connect('t1', { host: '127.0.0.1', port: a.port, username: 'u', password: 'p' })
    live.h1 = 't1'
    const opened = a.st.opened
    const before = a.shellIn.join('')
    const again = await runOnHosts([hosts[0]], open, 'uptime', 5000)
    expect(again[0]).toMatchObject({ status: 'ok' })
    expect(a.st.opened).toBe(opened)
    expect(a.shellIn.join('')).toBe(before)
  } finally { term?.kill(); a.close(); b.close() }
}, 20000)

it('无人值守（巡检）临时连接：未知指纹直接失败，不弹确认框', async () => {
  let prompts = 0
  // 指纹库为空 = 第一次见到这台主机；prompt 如果被调到就说明弹框了
  setHostKeyPolicy({ lookup: () => undefined, remember: () => {}, prompt: async () => { prompts++; return true } })
  const a = await fakeSshd('web-1')
  try {
    const open = hostRunner({
      liveTerminal: () => undefined,
      execOnTerminal: () => { throw new Error('不应复用终端') },
      connectOpts: () => ({ host: '127.0.0.1', port: a.port, username: 'u', password: 'p' }),
      connect: (o) => connectSsh(o),
      execOnClient: (client, c, o) => execFull(client as Parameters<typeof execFull>[0], c, o),
    }, true)
    const rows = await runOnHosts([{ id: 'h1', label: 'web-1' }], open, 'uname -a', 5000)
    expect(rows[0].status).toBe('conn_error')
    expect(rows[0].error).toMatch(/host_key_unknown|指纹/)
    expect(a.execs).toEqual([])   // 没连上，命令没发出去
    expect(prompts).toBe(0)       // 关键：半夜不能弹指纹框
  } finally { a.close() }
}, 20000)

it('连不上 / 超时 / 取消：折成该台的结果，不影响其他台', async () => {
  trustAll()
  const ok = await fakeSshd('ok'), hang = await fakeSshd('hang', { hang: true })
  const dead = await fakeSshd('dead'); dead.close()
  try {
    const ports: Record<string, number> = { ok: ok.port, hang: hang.port, dead: dead.port }
    const open = hostRunner({
      liveTerminal: () => undefined, execOnTerminal: () => Promise.reject(new Error('x')),
      connectOpts: (id) => ({ host: '127.0.0.1', port: ports[id], username: 'u', password: 'p' }),
      connect: (o) => connectSsh(o), execOnClient: (client, c, o) => execFull(client as Parameters<typeof execFull>[0], c, o),
    })
    const hs = ['ok', 'hang', 'dead'].map((id) => ({ id, label: id }))
    const rows = await runOnHosts(hs, open, 'uname -a', 500)
    expect(rows.map((r) => r.status)).toEqual(['ok', 'timeout', 'conn_error'])
    expect(rows[2].error).toBeTruthy()
    const ac = new AbortController()
    const p = runOnHosts([hs[1]], open, 'sleep 9', 10_000, ac.signal)
    setTimeout(() => ac.abort(), 300)
    expect((await p)[0].status).toBe('canceled')
  } finally { ok.close(); hang.close() }
}, 20000)

it('经工具层：只读判定拦截非只读命令（不连主机），只读命令两台并行跑完并逐台记执行记录', async () => {
  trustAll()
  const a = await fakeSshd('web-1'), b = await fakeSshd('web-2')
  try {
    const ports: Record<string, number> = { h1: a.port, h2: b.port }
    const open = hostRunner({
      liveTerminal: () => undefined, execOnTerminal: () => Promise.reject(new Error('x')),
      connectOpts: (id) => ({ host: '127.0.0.1', port: ports[id], username: 'u', password: 'p' }),
      connect: (o) => connectSsh(o), execOnClient: (client, c, o) => execFull(client as Parameters<typeof execFull>[0], c, o),
    })
    const audit = vi.fn()
    const deps = {
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local', decide: () => ({ kind: 'allow' }), grant: () => {}, audit,
      fleetHosts: () => [{ id: 'h1', label: 'web-1', group: 'web' }, { id: 'h2', label: 'web-2', group: 'web' }],
      runOnHosts: (hs: FleetHost[], c: string, ms: number, sig?: AbortSignal) => runOnHosts(hs, open, c, ms, sig),
      isReadOnly: isReadOnlyCommand,
    } as unknown as TerminalToolDeps
    expect(decideFor(deps, 's', 'run_on_hosts', { targets: ['web'], command: 'rm -f /tmp/x' })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('not_readonly') })
    const def = terminalToolDefs(deps).find((d) => d.name === 'run_on_hosts')!
    await expect(def.execute({ targets: ['web'], command: 'rm -f /tmp/x' } as never, { agent: { id: 's' } } as never)).rejects.toThrow(/not_readonly/)
    expect(a.execs).toEqual([])
    expect(decideFor(deps, 's', 'run_on_hosts', { targets: ['web'], command: 'uname -a' })).toEqual({ kind: 'allow' })
    const out = JSON.parse(await def.execute({ targets: ['web'], command: 'uname -a' } as never, { agent: { id: 's' } } as never))
    expect(out.results.map((r: { label: string; output: string }) => r.output.trim())).toEqual(['Linux web-1 6.1.0 x86_64 GNU/Linux', 'Linux web-2 6.1.0 x86_64 GNU/Linux'])
    expect(out.summary).toMatchObject({ total: 2, ok: 2, failed: [] })
    expect(audit.mock.calls.map((c) => [c[0].hostKey, c[0].decision, c[0].exitCode])).toEqual([['h1', 'fleet_exec', 0], ['h2', 'fleet_exec', 0]])
  } finally { a.close(); b.close() }
}, 20000)
