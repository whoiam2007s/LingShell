import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { hostStatsCommand, parseLinuxStats } from '@lingshell/shared'
import { setHostKeyPolicy } from './sshConnect.js'
import { SshTerminal } from './SshTerminal.js'

// 本机回环的假 sshd：exec 返回固定的 /proc 输出；记录 shell channel 收到的一切。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const CANNED = '@@stat1\ncpu  100 0 100 800 0 0 0 0\n@@stat2\ncpu  150 0 150 900 0 0 0 0\n@@mem\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n@@load\n0.10 0.20 0.30 1/2 3\n'

// 首连自动信任并记住（测试用）
function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

function fakeSshd(opts: { hangExec?: boolean } = {}) {
  const shellIn: string[] = []
  const execs: string[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { const st = ok(); st.on('data', (d: Buffer) => shellIn.push(d.toString())) })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const st = ok()
        if (opts.hangExec) return
        st.write(CANNED); st.stderr.write('noise\n'); st.exit(0); st.end()
      })
    })
  })
  return new Promise<{ port: number; shellIn: string[]; execs: string[]; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, shellIn, execs, close: () => s.close() })))
}

it('execRead 走独立 exec channel：拿到输出，交互 shell / onData / 命令历史都不受影响', async () => {
  trustAll()
  const srv = await fakeSshd()
  const t = await SshTerminal.connect('t1', { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  const seen: string[] = [], cmds: string[] = []
  t.onData((d) => seen.push(d)); t.onCommand((c) => cmds.push(c))
  const out = await t.execRead(hostStatsCommand('linux'), 5000)
  expect(out).toBe(CANNED)   // stderr 被丢弃
  expect(srv.execs).toEqual([hostStatsCommand('linux')])
  const s = parseLinuxStats(out, 0)
  expect(s.cpuPct).toBe(50)   // Δtotal=200，Δidle=100
  expect(s.memUsed).toBe(750 * 1024)
  expect(srv.shellIn.join('')).toBe('')
  expect(seen).toEqual([])
  expect(cmds).toEqual([])
  expect(t.busy).toBe(false)
  t.kill(); srv.close()
}, 20000)

it('execRead 超时：关 channel 并 reject，不影响后续使用', async () => {
  trustAll()
  const srv = await fakeSshd({ hangExec: true })
  const t = await SshTerminal.connect('t2', { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  await expect(t.execRead('true', 300)).rejects.toThrow('exec_timeout')
  t.kill()
  await expect(t.execRead('true', 300)).rejects.toThrow('terminal_disconnected')
  srv.close()
}, 20000)
