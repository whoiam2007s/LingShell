import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { processListCommand, type ProcList, type TerminalInfo } from '@lingshell/shared'
import { registerProcesses } from './processes.js'

// 本机回环的假 sshd：ps 命令回固定的 GNU ps 输出，kill 回退出码标记；记录 exec 与交互 shell 输入。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const PS = `    PID    PPID USER     %CPU %MEM   RSS     ELAPSED STAT COMMAND
   2201       1 mysql    12.5  8.1 663040  3-04:05:06 Ssl  /usr/sbin/mysqld --basedir=/usr
      1       0 root      0.0  0.1 12288 10-00:00:00 Ss   /sbin/init
`

function fakeSshd() {
  const shellIn: string[] = [], execs: string[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { ok().on('data', (d: Buffer) => shellIn.push(d.toString())) })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const ch = ok()
        ch.write(info.command.includes('kill -') ? '@@rc:0\n' : PS)
        ch.exit(0); ch.end()
      })
    })
  })
  return new Promise<{ port: number; shellIn: string[]; execs: string[]; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, shellIn, execs, close: () => s.close() })))
}

it('经独立 exec channel 列进程、发信号并记执行记录；交互 shell 不受影响', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const srv = await fakeSshd()
  const t = await SshTerminal.connect('p1', { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  try {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audits: unknown[] = []
    registerProcesses({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => (id === 'p1' ? ({ id, type: 'ssh', os: 'linux', title: 'u@127.0.0.1' } as TerminalInfo) : undefined),
      exec: () => (cmd, ms) => t.execRead(cmd, ms),
      audit: (tid, e) => audits.push({ tid, ...e }),
    })
    const list = await hs.get('processes:list')!({}, 'p1') as ProcList
    expect(list.rows.map((r) => [r.pid, r.user, r.cpu, r.command])).toEqual([[2201, 'mysql', 12.5, '/usr/sbin/mysqld --basedir=/usr'], [1, 'root', 0, '/sbin/init']])
    await hs.get('processes:signal')!({}, 'p1', 2201, 'TERM', list.rows[0].command)
    expect(srv.execs).toEqual([processListCommand(), `sh -c 'export LC_ALL=C; kill -TERM 2201 2>&1; echo "@@rc:$?"'`])
    expect(audits).toEqual([{ tid: 'p1', command: 'kill -TERM 2201  # /usr/sbin/mysqld --basedir=/usr', decision: 'process_kill', exitCode: 0 }])
    expect(srv.shellIn.join('')).toBe('')
  } finally { t.kill(); srv.close() }
}, 20000)
