import { it, expect, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, setHostKeyPolicy } from './sshConnect.js'
import { expandProxyCommand } from './proxyCommand.js'

// ProxyCommand 端到端：用 node 写的 stdio↔TCP 中继当代理命令，经它登录本机回环的假 sshd。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

const dir = mkdtempSync(join(tmpdir(), 'lingshell-pc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
// 中继：连 argv 的 host:port，stdin→socket、socket→stdout；pid 写到 argv[4]。stdin 结束也不退（验证由我们结束子进程）
const relay = join(dir, 'relay.cjs')
writeFileSync(relay, `const net = require('net'); require('fs').writeFileSync(process.argv[4], String(process.pid));
const s = net.connect(Number(process.argv[3]), process.argv[2]);
process.stdin.pipe(s, { end: false }); s.pipe(process.stdout);
s.on('error', (e) => { process.stderr.write('relay: ' + e.message); process.exit(2) });
setInterval(() => {}, 1000)`)
const fail = join(dir, 'fail.cjs')
writeFileSync(fail, `process.stderr.write('cloudflared: not logged in'); process.exit(1)`)
const q = (s: string) => `"${s}"`

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}
function fakeSshd() {
  const st = { users: [] as string[] }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => { st.users.push(ctx.username); if (ctx.method === 'password' && ctx.password === 'p') ctx.accept(); else ctx.reject(['password']) })
    c.on('error', () => {})
  })
  return new Promise<typeof st & { port: number; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r(Object.assign(st, { port: (s.address() as AddressInfo).port, close: () => s.close() }))))
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function waitDead(pid: number, ms = 5000) {
  for (let t = 0; t < ms && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100))
  return !alive(pid)
}

it('expandProxyCommand：%h %p %r %% 替换，其它 % 原样', () => {
  expect(expandProxyCommand('aws ssm start-session --target %h --parameters portNumber=%p', 'i-123', 22, 'ec2-user'))
    .toBe('aws ssm start-session --target i-123 --parameters portNumber=22')
  expect(expandProxyCommand('ssh -W %h:%p %r@jump 100%% %n', 'h', 2222, 'root')).toBe('ssh -W h:2222 root@jump 100% %n')
})

it('经 ProxyCommand（node 中继）登录假 sshd；断开后子进程被结束', async () => {
  trustAll()
  const srv = await fakeSshd()
  const pidFile = join(dir, 'pid1')
  // 地址用假的：真实连到哪由中继决定，%h 只是传给命令（同 cloudflared / ssm 的用法）
  const c = await connectSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', proxyCommand: `${q(process.execPath)} ${q(relay)} %h %p ${q(pidFile)}` })
  expect(srv.users).toContain('u')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(alive(pid)).toBe(true)
  c.close()
  expect(await waitDead(pid)).toBe(true)
  srv.close()
}, 30000)

it('认证失败也结束子进程；命令失败时错误里带它的 stderr', async () => {
  trustAll()
  const srv = await fakeSshd()
  const pidFile = join(dir, 'pid2')
  await expect(connectSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'wrong', proxyCommand: `${q(process.execPath)} ${q(relay)} %h %p ${q(pidFile)}` }))
    .rejects.toThrow(/ssh_auth_failed/)
  expect(existsSync(pidFile)).toBe(true)
  expect(await waitDead(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  await expect(connectSsh({ host: 'x', port: 22, username: 'u', password: 'p', readyTimeoutMs: 5000, proxyCommand: `${q(process.execPath)} ${q(fail)}` }))
    .rejects.toThrow(/ProxyCommand 输出：cloudflared: not logged in/)
  srv.close()
}, 30000)
