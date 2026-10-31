import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { runPool, groupOutputs, type BatchExecResult, type BatchRow } from '@lingshell/shared'
import { runBatchHost, BatchRuns, type Runner } from './batchExec.js'

// 本机回环的假 sshd：exec 按预置结果回（stdout / stderr / 退出码），可挂起不回；记录 shell 收到的输入与断开次数。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
type Canned = { out: string; err?: string; code: number } | 'hang'

function fakeSshd(canned: Canned) {
  const shellIn: string[] = [], execs: string[] = []
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
        if (canned === 'hang') return
        ch.write(canned.out)
        if (canned.err) ch.stderr.write(canned.err)
        ch.exit(canned.code); ch.end()
      })
    })
  })
  return new Promise<{ port: number; shellIn: string[]; execs: string[]; st: typeof st; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, shellIn, execs, st, close: () => s.close() })))
}

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

// 同 ipc.ts 的临时连接：连上 → 独立 exec channel → 跑完断开
const tempConn = (port: number) => async (): Promise<Runner> => {
  const conn = await connectSsh({ host: '127.0.0.1', port, username: 'u', password: 'p' })
  return { exec: (c, o) => execFull(conn.client, c, o), close: () => conn.close() }
}

it('两台临时连接并发跑：一台成功一台非零退出，各记一条，连接都断开', async () => {
  trustAll()
  const a = await fakeSshd({ out: 'v1.2.3\n', code: 0 })
  const b = await fakeSshd({ out: 'partial\n', err: 'boom: not found\n', code: 3 })
  try {
    const hosts = [a, b], results: BatchExecResult[] = [], audited: BatchExecResult[] = []
    const runs = new BatchRuns()
    await runPool(2, 5, async (i) => {
      results[i] = await runBatchHost(tempConn(hosts[i].port), 'app --version', 5000, runs.signal('run'), (r) => audited.push(r))
    })
    expect(results[0]).toMatchObject({ status: 'ok', exitCode: 0, output: 'v1.2.3\n' })
    expect(results[1]).toMatchObject({ status: 'fail', exitCode: 3 })
    expect(results[1].output).toContain('partial\n')
    expect(results[1].output).toContain('boom: not found\n')   // stderr 一并收
    expect(audited.map((r) => r.exitCode).sort()).toEqual([0, 3])
    expect(a.execs).toEqual(['app --version'])
    expect(b.execs).toEqual(['app --version'])
    const g = groupOutputs(results.map((r): BatchRow => ({ status: r.status, result: r })))
    expect(g.majority).toBe(-1)   // 两台不同，没有多数
    await new Promise((r) => setTimeout(r, 200))
    expect([a.st.closed, b.st.closed]).toEqual([a.st.opened, b.st.opened])   // 临时连接跑完即断
    expect(a.st.opened).toBeGreaterThan(0)
  } finally { a.close(); b.close() }
}, 20000)

it('超时与取消：关 channel，标超时 / 已取消', async () => {
  trustAll()
  const h = await fakeSshd('hang')
  try {
    expect(await runBatchHost(tempConn(h.port), 'sleep 99', 300, new BatchRuns().signal('x'))).toMatchObject({ status: 'timeout' })
    const runs = new BatchRuns()
    const p = runBatchHost(tempConn(h.port), 'sleep 99', 10_000, runs.signal('r'))
    setTimeout(() => runs.cancel('r'), 300)
    expect(await p).toMatchObject({ status: 'canceled' })
  } finally { h.close() }
}, 20000)

it('复用在线终端的连接：走独立 exec channel，交互 shell 收不到任何输入', async () => {
  trustAll()
  const h = await fakeSshd({ out: 'ok\n', code: 0 })
  const t = await SshTerminal.connect('t1', { host: '127.0.0.1', port: h.port, username: 'u', password: 'p' })
  try {
    const before = h.shellIn.join('')
    const r = await runBatchHost(async () => ({ exec: (c, o) => t.exec(c, o), close() {} }), 'uptime', 5000, new BatchRuns().signal('x'))
    expect(r).toMatchObject({ status: 'ok', output: 'ok\n' })
    expect(h.shellIn.join('')).toBe(before)
    expect(t.busy).toBe(false)
  } finally { t.kill(); h.close() }
}, 20000)
