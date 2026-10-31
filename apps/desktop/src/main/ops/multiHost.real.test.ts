import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { createServer as createHttp } from 'node:http'
import { createServer as createTcp } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, appendFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSsh, execFull, execStream, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { parseLogSearch, parseProbeTargets, mergeSearchResults, cellStatus } from '@lingshell/shared'
import { MultiTails, searchHost } from './logMulti.js'
import { probeLocal, probeRemote } from './connProbe.js'
import type { Runner } from './batchExec.js'

// 本机回环的假 sshd（不连任何真实主机）：exec 交给本机 sh 真跑（Windows 上是 Git Bash 的 sh）。可起多个模拟多台主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
function fakeSshd() {
  const st = { childExit: [] as (number | null)[] }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        const p = spawn('sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'] })
        p.stdout.on('data', (d) => ch.write(d))
        p.stderr.on('data', (d) => ch.stderr.write(d))
        ch.on('data', (d: Buffer) => p.stdin.write(d))
        ch.on('end', () => p.stdin.end())
        ch.on('close', () => p.stdin.end())
        p.on('exit', (code) => { st.childExit.push(code); try { ch.exit(code ?? 0); ch.end() } catch { /* 已关 */ } })
      })
    })
  })
  return new Promise<{ port: number; st: typeof st; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, st, close: () => s.close() })))
}
function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(50); return f() }
const T0 = Date.now() - 3600_000
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()
const hasSh = spawnSync('sh', ['-c', 'command -v tail && command -v zcat && command -v timeout'], { encoding: 'utf8' }).status === 0

it.skipIf(!hasSh)('两台实时合流：按时间交错、标出主机；停止后两台远端 tail 都退出', async () => {
  trustAll()
  const [a, b] = [await fakeSshd(), await fakeSshd()]
  const dir = mkdtempSync(join(tmpdir(), 'logmulti-'))
  const fa = join(dir, 'a.log').replace(/\\/g, '/'), fb = join(dir, 'b.log').replace(/\\/g, '/')
  writeFileSync(fa, `${iso(1)} a1\n${iso(3)} a3\n`)
  writeFileSync(fb, `${iso(2)} b2\n${iso(4)} b4\n`)
  const conns: SshConn[] = []
  const ports: Record<string, number> = { A: a.port, B: b.port }
  const paths: Record<string, string> = { A: fa, B: fb }
  try {
    // 两台的日志路径不同：用 hostId 区分（真实场景是同一路径）
    const tails = new MultiTails(async (t, _cmd, h) => {
      const id = (t as { hostId: string }).hostId
      const conn = await connectSsh({ host: '127.0.0.1', port: ports[id], username: 'u', password: 'p' })
      conns.push(conn)
      const { logTailCommand } = await import('@lingshell/shared')
      return execStream(conn.client, logTailCommand({ kind: 'file', path: paths[id] }), h)
    })
    const id = tails.start([{ label: 'web-a', target: { kind: 'host', hostId: 'A' } }, { label: 'web-b', target: { kind: 'host', hostId: 'B' } }], { kind: 'file', path: '/x' })
    const got: { h: number; text: string }[] = []
    expect(await until(() => { got.push(...tails.poll(id).items); return got.length >= 4 })).toBe(true)
    expect(got.map((x) => `${x.h}:${x.text.split(' ')[1]}`)).toEqual(['0:a1', '1:b2', '0:a3', '1:b4'])
    appendFileSync(fb, `${iso(5)} b5\n`)
    expect(await until(() => { got.push(...tails.poll(id).items); return got.some((x) => x.text.endsWith('b5')) })).toBe(true)
    expect(got.at(-1)).toMatchObject({ h: 1 })
    tails.stop(id)
    expect(await until(() => a.st.childExit.length === 1 && b.st.childExit.length === 1)).toBe(true)
    expect(tails.size).toBe(0)
  } finally { conns.forEach((c) => c.close()); a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)

it('一台连不上：这台标结束 + 原因，另一台照常', async () => {
  const tails = new MultiTails(async (t, _c, h) => {
    if ((t as { hostId: string }).hostId === 'bad') throw new Error('认证失败')
    setTimeout(() => h.data(Buffer.from(`${iso(1)} ok\n`)), 10)
    return () => {}
  })
  const id = tails.start([{ label: 'ok', target: { kind: 'host', hostId: 'ok' } }, { label: 'bad', target: { kind: 'host', hostId: 'bad' } }], { kind: 'journal' })
  const got: string[] = []
  let hosts: { ended?: { error?: string } }[] = []
  expect(await until(() => { const r = tails.poll(id); got.push(...r.items.map((x) => x.text)); hosts = r.hosts; return got.length === 1 }, 4000)).toBe(true)
  expect(hosts[1].ended?.error).toBe('认证失败')
  expect(hosts[0].ended).toBeUndefined()
  tails.stop(id)
})

it.skipIf(!hasSh)('历史检索：轮转 + .gz、按时间段、旧文件按修改时间跳过；两台按时间归并', async () => {
  trustAll()
  const [a, b] = [await fakeSshd(), await fakeSshd()]
  const dir = mkdtempSync(join(tmpdir(), 'logsearch-'))
  const p = join(dir, 'app.log').replace(/\\/g, '/')
  writeFileSync(`${p}.2.gz`, gzipSync(`${iso(10)} ERROR gz-old in range\n${iso(11)} INFO gz noise\n`))
  writeFileSync(`${p}.1`, `${iso(20)} ERROR rotated\n\tat stack.line\n`)
  writeFileSync(p, `${iso(30)} ERROR current\n${iso(9999)} ERROR future\n`)
  writeFileSync(`${p}.9.gz`, gzipSync(`${iso(-9999)} ERROR ancient\n`))
  const old = (T0 - 86_400_000) / 1000
  utimesSync(`${p}.9.gz`, old, old)   // 修改时间早于开始时间：整个跳过
  const t2 = (T0 + 15_000) / 1000
  utimesSync(`${p}.2.gz`, t2, t2); utimesSync(`${p}.1`, t2 + 10, t2 + 10)
  const conns: SshConn[] = []
  const runner = (port: number) => async (): Promise<Runner> => {
    const c = await connectSsh({ host: '127.0.0.1', port, username: 'u', password: 'p' }); conns.push(c)
    return { exec: (cmd, o) => execFull(c.client, cmd, o), close: () => c.close() }
  }
  try {
    const q = parseLogSearch({ pattern: 'error', from: T0, to: T0 + 3600_000 }, { kind: 'file', path: p })
    const ra = await searchHost(runner(a.port), q)
    expect(ra.error).toBeUndefined()
    expect(ra.files.map((f) => f.split('/').pop())).toEqual(['app.log.2.gz', 'app.log.1', 'app.log'])
    expect(ra.lines.map((l) => l.split(' ').slice(2).join(' '))).toEqual(['gz-old in range', 'rotated', 'current'])
    const rb = await searchHost(runner(b.port), parseLogSearch({ pattern: 'rotated|current', regex: true }, { kind: 'file', path: p }))
    const merged = mergeSearchResults([ra, rb])
    expect(merged.map((x) => x.h)).toEqual([0, 0, 1, 0, 1])
    const miss = await searchHost(runner(a.port), parseLogSearch({}, { kind: 'file', path: `${dir}/nope.log` }))
    expect(miss.error).toContain('没有找到')
    // 回归：关键字不区分大小写且按字面量（点号不是通配）。-i 与 -F 同用在本机 GNU grep 3.0 会 abort，结果恒空
    const lp = join(dir, 'lit.log').replace(/\\/g, '/')
    writeFileSync(lp, `${iso(40)} ERROR aXb regex\n${iso(41)} ERROR a.b literal\n`)
    const rl = await searchHost(runner(a.port), parseLogSearch({ pattern: 'A.B' }, { kind: 'file', path: lp }))
    expect(rl.lines.map((l) => l.split(' ').slice(2).join(' '))).toEqual(['a.b literal'])
  } finally { conns.forEach((c) => c.close()); a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)

it.skipIf(!hasSh)('连通性探测：本机（Node）与假 sshd 远端脚本，开着的端口通、关着的拒绝、HTTP 状态码', async () => {
  trustAll()
  const http = createHttp((req, res) => { res.statusCode = req.url === '/bad' ? 503 : 200; res.end('x') })
  const tcp = createTcp((s) => s.end())
  const closed = createTcp()
  await Promise.all([new Promise<void>((r) => http.listen(0, '127.0.0.1', r)), new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r)), new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))])
  const hp = (http.address() as AddressInfo).port, tp = (tcp.address() as AddressInfo).port, cp = (closed.address() as AddressInfo).port
  await new Promise<void>((r) => closed.close(() => r()))   // 拿到一个肯定没人监听的端口
  const { targets } = parseProbeTargets(`127.0.0.1:${tp} 127.0.0.1:${cp} http://127.0.0.1:${hp}/ok http://127.0.0.1:${hp}/bad`)
  const checks = ['dns', 'tcp', 'http'] as const
  const sig = new AbortController().signal
  const s = await fakeSshd()
  const conns: SshConn[] = []
  try {
    const local = await probeLocal(targets, [...checks], sig)
    const remote = await probeRemote(async () => {
      const c = await connectSsh({ host: '127.0.0.1', port: s.port, username: 'u', password: 'p' }); conns.push(c)
      return { exec: (cmd, o) => execFull(c.client, cmd, o), close: () => c.close() }
    }, targets, [...checks], sig)
    expect(remote.error).toBeUndefined()
    for (const cells of [local, remote.cells]) {
      expect(cells.map(cellStatus)).toEqual(['ok', 'fail', 'ok', 'warn'])
      expect(cells[1].items.find((x) => x.check === 'tcp')?.detail).toBe('拒绝连接')
      expect(cells[3].items.find((x) => x.check === 'http')?.detail).toBe('HTTP 503')
      expect(cells[0].items[0]).toMatchObject({ check: 'dns', status: 'skip' })
    }
    expect(remote.cells[0].items[1].tool).toBe('bash')
    const conn = await probeRemote(async () => { throw new Error('认证失败') }, targets, ['tcp'], sig)
    expect(conn.error).toBe('认证失败')
  } finally { conns.forEach((c) => c.close()); s.close(); http.close(); tcp.close() }
}, 40000)
