import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { complianceCsv, type ComplianceHostRow, type ComplianceStatus, type HostSummary, type TerminalInfo } from '@lingshell/shared'
import { registerCompliance } from './complianceIpc.js'
import { findBash } from '../core/index.js'

// 两台本机回环的假 sshd（合规 / 不合规）：exec 交给本机 Git Bash 真跑检查脚本；远端才有的命令（systemctl / getenforce / logrotate / find）
// 用各自 PATH 前置的假脚本顶上，/etc、/proc 下的文件放各自临时目录（LINGSHELL_HC_ROOT 指过去）。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
const dir = mkdtempSync(join(tmpdir(), 'lingshell-cc-'))
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s) }

type Host = { root: string; bin: string; port?: number; conn?: SshConn; close?: () => void }
const hosts: Record<'good' | 'bad', Host> = { good: { root: join(dir, 'good/root'), bin: join(dir, 'good/bin') }, bad: { root: join(dir, 'bad/root'), bin: join(dir, 'bad/bin') } }
const file = (h: Host, p: string, s: string) => put(join(h.root, p), s)
const tool = (h: Host, name: string, body: string) => put(join(h.bin, name), `#!/bin/sh\n${body}\n`)

function setupGood(h: Host) {
  // sshd_config.d 的 Include 在文件开头（首个值生效）：主文件写 yes，drop-in 写 no，应以 drop-in 为准
  file(h, 'etc/ssh/sshd_config', 'Port 2222\nPermitRootLogin yes\n')
  file(h, 'etc/ssh/sshd_config.d/49-cloud.conf', 'PermitRootLogin no\nPasswordAuthentication no\n')
  file(h, 'etc/shadow', 'root:$6$abc:19000:0:99999:7:::\nalice:$6$def:19000:0:99999:7:::\n')
  file(h, 'etc/passwd', 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash\n')
  file(h, 'proc/mounts', '/dev/sda1 / xfs rw 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev,noexec 0 0\n')
  file(h, 'etc/login.defs', 'PASS_MAX_DAYS 90\nPASS_MIN_DAYS 1\n')
  file(h, 'etc/security/pwquality.conf', '# minlen = 6\nminlen = 12\n')
  file(h, 'etc/logrotate.conf', 'weekly\n')
  file(h, 'etc/sudoers', 'root ALL=(ALL) ALL\n%wheel ALL=(ALL) ALL\n')
  file(h, 'proc/sys/net/ipv4/ip_forward', '0\n')
  file(h, 'proc/sys/net/ipv4/conf/all/accept_redirects', '0\n')
  file(h, 'proc/sys/kernel/randomize_va_space', '2\n')
  tool(h, 'sshd', 'exit 1')
  tool(h, 'systemctl', 'case "$1 $2" in "is-active firewalld"|"is-active chronyd"|"is-active auditd") echo active;; is-active*) echo inactive; exit 3;; "is-enabled dnf-automatic.timer"|"is-enabled logrotate.timer") echo enabled;; *) echo disabled; exit 1;; esac')
  tool(h, 'getenforce', 'echo Enforcing')
  tool(h, 'logrotate', 'exit 0')
  tool(h, 'find', 'exit 0')
}
function setupBad(h: Host) {
  file(h, 'etc/ssh/sshd_config', 'PermitRootLogin yes\nPasswordAuthentication yes\n')
  file(h, 'etc/shadow', 'root:$6$abc:19000:0:99999:7:::\nguest::19000:0:99999:7:::\n')
  file(h, 'etc/passwd', 'root:x:0:0:root:/root:/bin/bash\ntoor:x:0:0::/root:/bin/sh\n')
  file(h, 'proc/mounts', '/dev/sda1 / ext4 rw 0 0\n')
  file(h, 'etc/login.defs', 'PASS_MAX_DAYS   99999\n')
  file(h, 'etc/sudoers', 'ops ALL=(ALL) NOPASSWD: ALL\n')
  file(h, 'proc/sys/net/ipv4/ip_forward', '1\n')
  file(h, 'proc/sys/net/ipv4/conf/all/accept_redirects', '1\n')
  file(h, 'proc/sys/kernel/randomize_va_space', '0\n')
  tool(h, 'sshd', 'exit 1')
  tool(h, 'systemctl', 'case "$1" in is-active) echo inactive; exit 3;; *) echo disabled; exit 1;; esac')
  tool(h, 'getenforce', 'echo Disabled')
  tool(h, 'find', 'echo "$LINGSHELL_HC_ROOT/etc/bad.conf"')
  // 只有 Docker 写的转发规则、入站默认允许：不能算「防火墙已启用」
  tool(h, 'iptables', 'case "$1" in -S) echo "-P INPUT ACCEPT"; echo "-A FORWARD -j DOCKER"; echo "-A DOCKER -d 172.17.0.2/32 -j ACCEPT";; esac')
}

async function serve(h: Host) {
  const env = { ...process.env, PATH: `${h.bin};${process.env.PATH}`, LINGSHELL_HC_ROOT: posix(h.root) }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        // Git 的 bin/bash.exe 会把 /usr/bin 放到 PATH 最前：再前置一次，假 find 才能盖过系统自带的
        const p = spawn(BASH!, ['-c', `export PATH="${posix(h.bin)}:$PATH"; ${info.command}`], { env })
        p.stdout.pipe(ch, { end: false }); p.stderr.pipe(ch.stderr, { end: false })
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  h.port = (s.address() as AddressInfo).port
  h.close = () => s.close()
}

beforeAll(async () => {
  setupGood(hosts.good); setupBad(hosts.bad)
  await serve(hosts.good); await serve(hosts.bad)
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  hosts.good.conn = await connectSsh({ host: '127.0.0.1', port: hosts.good.port!, username: 'u', password: 'p' })
})
afterAll(() => { hosts.good.conn?.close(); hosts.good.close?.(); hosts.bad.close?.(); rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const saved: HostSummary[] = [
    { id: 'hg', label: 'good-1', host: '127.0.0.1', port: hosts.good.port!, username: 'u', authType: 'password', group: 'web' },
    { id: 'hb', label: 'bad-1', host: '127.0.0.1', port: hosts.bad.port!, username: 'u', authType: 'password', group: 'web' },
    { id: 'hx', label: 'down-1', host: '127.0.0.1', port: 1, username: 'u', authType: 'password' },
  ]
  registerCompliance({
    handle: (ch, fn) => { hs.set(ch, fn) },
    dir: join(dir, 'cfg'),
    terminal: (id) => (id === 'p1' ? ({ id, type: 'ssh', os: 'linux', title: 'good-1', status: 'running' } as TerminalInfo) : id === 'loc' ? ({ id, type: 'local', title: 'local', status: 'running' } as TerminalInfo) : undefined),
    hostKey: () => 'hg',
    exec: (_id, cmd, o) => execFull(hosts.good.conn!.client, cmd, o),
    hosts: () => saved,
    open: (h) => async () => {
      const port = saved.find((x) => x.id === h.id)!.port
      const conn = await connectSsh({ host: '127.0.0.1', port, username: 'u', password: 'p', readyTimeout: 3000 } as never)
      return { exec: (c, o) => execFull(conn.client, c, o), close: () => conn.close() }
    },
  })
  return <T>(ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) as Promise<T>
}
const statusOf = (r: ComplianceHostRow) => Object.fromEntries(r.results.map((x) => [x.id, x.status])) as Record<string, ComplianceStatus>

it('单机：经终端连接跑一次脚本，各条按假主机的配置判定；只支持 Linux SSH 终端', async () => {
  const call = setup()
  const r = await call<ComplianceHostRow>('compliance:run', 'p1')
  expect(r).toMatchObject({ hostId: 'hg', label: 'good-1' })
  expect(statusOf(r)).toEqual({
    ssh_root_password: 'pass', empty_password: 'pass', ssh_port: 'pass', firewall: 'pass', auto_updates: 'pass', tmp_mount: 'pass', time_sync: 'pass',
    uid0: 'pass', password_policy: 'pass', auditd: 'pass', mac: 'pass', logrotate: 'pass', etc_world_writable: 'pass', sudo_nopasswd: 'pass',
    ip_forward: 'pass', icmp_redirects: 'pass', aslr: 'pass',
  })
  await expect(call('compliance:run', 'loc')).rejects.toThrow('Linux')
}, 60_000)

it('批量：两台并行出「主机 × 条目」矩阵；连不上的整行报错；关掉的条目不跑；可导出 CSV', async () => {
  const call = setup()
  await call('compliance:setDisabled', ['ip_forward', 'nope'])
  expect(await call('compliance:config')).toEqual({ disabled: ['ip_forward'] })
  const rows = await call<ComplianceHostRow[]>('compliance:batch', ['hg', 'hb', 'hx'])
  expect(rows.map((r) => r.label)).toEqual(['good-1', 'bad-1', 'down-1'])
  expect(Object.values(statusOf(rows[0])).every((s) => s === 'pass')).toBe(true)
  expect(rows[0].results.some((x) => x.id === 'ip_forward')).toBe(false)
  const bad = statusOf(rows[1])
  expect(bad).toMatchObject({
    ssh_root_password: 'fail', empty_password: 'fail', ssh_port: 'warn', firewall: 'fail', auto_updates: 'fail', tmp_mount: 'warn', time_sync: 'fail',
    uid0: 'fail', password_policy: 'fail', auditd: 'fail', mac: 'fail', logrotate: 'fail', etc_world_writable: 'fail', sudo_nopasswd: 'fail',
    icmp_redirects: 'fail', aslr: 'fail',
  })
  expect(rows[1].results.find((x) => x.id === 'etc_world_writable')!.detail).toContain('/etc/bad.conf')
  expect(rows[1].results.find((x) => x.id === 'empty_password')!.detail).toContain('guest')
  expect(rows[2].error).toBeTruthy()
  expect(rows[2].results).toEqual([])
  const csv = complianceCsv(rows)
  expect(csv.split('\r\n').filter(Boolean)).toHaveLength(4)
  await call('compliance:setDisabled', [])
  await expect(call('compliance:batch', [])).rejects.toThrow('选择主机')
}, 90_000)
