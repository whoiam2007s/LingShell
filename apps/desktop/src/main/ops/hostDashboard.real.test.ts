import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { dashboardCommand, latestOf, dashProblems } from '@lingshell/shared'
import { DashboardSampler } from './hostDashboard.js'
import { findBash } from '../core/index.js'

// 两台本机回环的假 sshd：exec 交给本机 bash 真跑采集命令（/proc 用本机的）；df / systemctl / docker 用 PATH 前置的假脚本，
// 磁盘使用率读各自状态目录里的文件（测试里改它模拟磁盘变满）。记录收到的 exec / shell 输入 / 连接开关。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
const dir = mkdtempSync(join(tmpdir(), 'lingshell-dash-'))
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s) }
const setDisk = (name: string, used: number) => put(join(dir, name, 'disk.txt'), String(used))

interface Fake { port: number; execs: string[]; shellIn: string[]; st: { opened: number; closed: number }; close(): void }
async function fakeSshd(name: string, failed: string, containers: string): Promise<Fake> {
  const bin = join(dir, name, 'bin')
  setDisk(name, 400)   // /data 已用 400 / 1000 = 40%
  put(join(bin, 'df'), `#!/bin/sh\nu=$(cat "${posix(join(dir, name, 'disk.txt'))}")\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/sda1 1000 300 700 30% /"\necho "/dev/sdb1 1000 $u $((1000-u)) $u% /data"\n`)
  put(join(bin, 'systemctl'), `#!/bin/sh\nprintf '${failed}'\n`)
  put(join(bin, 'docker'), `#!/bin/sh\nprintf '${containers}'\n`)
  const env = { ...process.env }
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
        // Git Bash 启动时把 /usr/bin 排到 PATH 最前，df 这种本机也有的命令要在命令里再前置一次假脚本目录
        const p = spawn(BASH!, ['-c', `export PATH="${posix(bin)}:$PATH"; ${info.command}`], { env })
        p.stdout.pipe(ch, { end: false }); p.stderr.pipe(ch.stderr, { end: false })
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, execs, shellIn, st, close: () => s.close() })))
}

let a: Fake, b: Fake
beforeAll(async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  a = await fakeSshd('web-1', '', 'running\\n')
  b = await fakeSshd('db-1', 'mysql.service loaded failed failed MySQL\\n', 'running\\nexited\\n')
})
afterAll(() => { a?.close(); b?.close(); rmSync(dir, { recursive: true, force: true }) })
const settle = () => new Promise((r) => setTimeout(r, 300))

it('已连接主机复用终端连接、未连接主机开采样后临时连接（期间复用一条）；磁盘变满出异常；关仪表盘断开临时连接；不碰交互 shell', async () => {
  const term = await SshTerminal.connect('t1', { host: '127.0.0.1', port: a.port, username: 'u', password: 'p' })
  try {
    const ports: Record<string, number> = { h1: a.port, h2: b.port }
    let now = 1_000_000
    const s = new DashboardSampler({
      hosts: () => [{ id: 'h1' }, { id: 'h2' }],
      liveTerminal: (id) => (id === 'h1' ? 't1' : undefined),
      execOnTerminal: (_tid, c, o) => term.exec(c, o),
      connect: async (id) => {
        const conn = await connectSsh({ host: '127.0.0.1', port: ports[id], username: 'u', password: 'p' })
        return { exec: (c, o) => execFull(conn.client, c, o), close: () => conn.close() }
      },
      lastCheck: async (id) => (id === 'h2' ? { at: '2026-10-15T00:00:00Z', issues: 3 } : undefined),
      paused: () => false,
      now: () => now,
      timeoutMs: 30_000,   // 整套测试并行跑时机器很忙，别让采样被截断
    })
    const aOpened = a.st.opened

    // 仪表盘没开：什么都不采
    await s.tick()
    expect([a.execs.length, b.execs.length]).toEqual([0, 0])

    // 打开：只采已连接的 h1；h2 没开采样不连
    s.setOpen(true)
    await s.tick()
    await until(() => a.execs.length === 1)
    expect(a.execs).toEqual([dashboardCommand()])
    expect(b.st.opened).toBe(0)
    expect(a.st.opened).toBe(aOpened)   // 复用终端连接，没新建

    // h2 开采样：临时连接采一次；下个间隔再采，复用同一条连接
    s.setSampling(['h2'], true)
    await until(() => s.snapshot().then((x) => x.hosts.h2.points.length === 1))
    expect(b.execs).toEqual([dashboardCommand()])
    const bOpened = b.st.opened   // 首次见到的主机：connectSsh 先拒掉问指纹再重连，所以这里可能是 2
    now += 30_000
    await s.tick()
    expect(b.execs.length).toBe(2)
    expect(b.st.opened).toBe(bOpened)
    const snap = await s.snapshot()
    expect(snap.intervalSec).toBe(30)
    expect(snap.hosts.h1).toMatchObject({ connected: true, sampling: false })
    expect(snap.hosts.h2).toMatchObject({ connected: false, sampling: true, lastCheck: { issues: 3 } })
    expect(snap.hosts.h1.points.length).toBe(2)
    expect(snap.hosts.h2.points.length).toBe(2)
    const l2 = latestOf(snap.hosts.h2.points)
    expect(l2).toMatchObject({ disk: 40, diskMount: '/data', failed: 1, ctRunning: 1, ctTotal: 2 })
    expect(l2.cpu).toBeGreaterThanOrEqual(0)
    expect(latestOf(snap.hosts.h1.points)).toMatchObject({ failed: 0, ctRunning: 1, ctTotal: 1 })
    // CPU / 内存取自本机真实 /proc，全量并行跑测试时可能真的很忙：只断言测试能控制的项（磁盘、失败服务）
    const ctl = (ps: string[]) => ps.filter((x) => !/^(CPU|内存)/.test(x))
    expect(ctl(dashProblems(latestOf(snap.hosts.h1.points)))).toEqual([])

    // h1 磁盘到 90%：下一轮出异常
    setDisk('web-1', 900)
    now += 30_000
    await s.tick()
    const h1 = latestOf((await s.snapshot()).hosts.h1.points)
    expect(h1).toMatchObject({ disk: 90, diskMount: '/data' })
    expect(ctl(dashProblems(h1))).toEqual(['磁盘 /data 90%'])

    // 关仪表盘：临时连接断开，之后不再采；已连接终端的连接不受影响
    s.setOpen(false)
    await settle()
    expect(b.st.closed).toBe(b.st.opened)
    expect(b.execs.length).toBe(3)
    now += 30_000
    await s.tick()
    expect([a.execs.length, b.execs.length]).toEqual([3, 3])
    expect(a.shellIn.join('')).toBe('')   // 从没往交互 shell 里敲
    expect(await term.exec('echo ok', { timeoutMs: 5000 })).toMatchObject({ code: 0 })

    // 再开：h2 的采样开关还在，重新连一条；关采样立即断开
    s.setOpen(true)
    await until(() => b.execs.length === 4)
    expect(b.st.opened).toBe(bOpened + 1)
    s.setSampling(['h2'], false)
    await settle()
    expect(b.st.closed).toBe(b.st.opened)
  } finally { term.kill() }
}, 60_000)

it('连不上：记错误并退避，下次重连；主机状态标签的样本灌进缓冲且同刻去重', async () => {
  const dead = await fakeSshd('dead', '', ''); dead.close()
  let now = 0, tries = 0
  const s = new DashboardSampler({
    hosts: () => [{ id: 'x' }, { id: 'h1' }],
    liveTerminal: () => undefined,
    execOnTerminal: () => Promise.reject(new Error('x')),
    connect: async () => {
      tries++
      const conn = await connectSsh({ host: '127.0.0.1', port: dead.port, username: 'u', password: 'p' })
      return { exec: (c, o) => execFull(conn.client, c, o), close: () => conn.close() }
    },
    lastCheck: async () => undefined,
    paused: () => false,
    now: () => now,
  })
  s.setOpen(true)
  s.setSampling(['x'], true)
  await until(() => s.snapshot().then((x) => !!x.hosts.x.error))
  expect((await s.snapshot()).hosts.x.points).toEqual([])
  expect(tries).toBe(1)
  // 退避：失败 1 次 → 间隔 ×2（60s）后才重连
  now += 30_000
  await s.tick()
  expect(tries).toBe(1)
  now += 30_000
  await s.tick()
  expect(tries).toBe(2)
  // ingest：同一时刻多个终端报同一份只记一次；未保存主机忽略
  const stats = { at: 5, cpuPct: 10, memUsed: 1, memTotal: 2, load: [1, 1, 1] as [number, number, number] }
  s.ingest('h1', stats); s.ingest('h1', stats); s.ingest('nope', stats); s.ingest(undefined, stats)
  const snap = await s.snapshot()
  expect(snap.hosts.h1.points).toEqual([{ at: 5, cpu: 10, mem: 50, load1: 1 }])
  expect(snap.hosts.h1.lastOkAt).toBe(5)
  expect(() => s.setInterval(20)).toThrow('15 / 30 / 60')
  s.setInterval(15)
  expect((await s.snapshot()).intervalSec).toBe(15)
  s.stop()
}, 30_000)

async function until(f: () => boolean | Promise<boolean>, ms = 20_000) {
  const t = Date.now()
  while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)) }
}
