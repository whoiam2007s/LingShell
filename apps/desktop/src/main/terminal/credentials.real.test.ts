import { it, expect, afterEach } from 'vitest'
import ssh2 from 'ssh2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { HostStore, type Encryptor } from '@lingshell/config'
import { REDACTED, redactToolText } from '@lingshell/shared'
import { setHostKeyPolicy, testSshConnection } from '@lingshell/terminal-core'
import { registerCredentials } from './credentialsIpc.js'

// 命名凭据端到端：两台主机引用同一凭据，经 IPC 改凭据密码后两台都用新密码登录本机回环假 sshd。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const fakeEnc: Encryptor = { available: () => true, encrypt: (s) => `E(${Buffer.from(s).toString('base64')})`, decrypt: (c) => Buffer.from(c.slice(2, -1), 'base64').toString() }

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// 假 sshd：只认用户 ops + 当前密码
function fakeSshd(pw: { v: string }) {
  const seen: string[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('error', () => {})
    c.on('authentication', (ctx) => {
      if (ctx.method === 'password') seen.push(`${ctx.username}:${ctx.password}`)
      if (ctx.method === 'password' && ctx.username === 'ops' && ctx.password === pw.v) return ctx.accept()
      ctx.reject(['password'])
    })
    c.on('ready', () => c.end())
  })
  return new Promise<{ port: number; seen: string[]; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, seen, close: () => s.close() })))
}

it('两台主机绑同一凭据：改凭据密码后都能连上；引用中禁止删除；脱敏含凭据密码', async () => {
  dir = mkdtempSync(join(tmpdir(), 'creds-real-'))
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const pw = { v: 'old-Pass-1' }
  const sshd = await fakeSshd(pw)
  try {
    const hosts = new HostStore(dir, fakeEnc, () => undefined)
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerCredentials({ handle: (ch, fn) => handlers.set(ch, fn), hosts })
    const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(null, ...a)

    const c = await call('credentials:save', { name: '运维', username: 'ops', authType: 'password', password: 'old-Pass-1' }) as { id: string }
    const a = hosts.save({ label: 'a', host: '127.0.0.1', port: sshd.port, username: 'wrong', authType: 'password', password: 'wrong' })
    const b = hosts.save({ label: 'b', host: '127.0.0.1', port: sshd.port, username: 'wrong', authType: 'password', password: 'wrong' })
    await expect(testSshConnection(hosts.resolveConnectOpts(a.id))).rejects.toThrow()   // 自己的凭据是错的
    expect(await call('credentials:assign', [a.id, b.id], c.id)).toBe(2)               // 批量设置凭据
    for (const h of [a, b]) await testSshConnection(hosts.resolveConnectOpts(h.id))

    // 服务器改密码 → 只改凭据一处
    pw.v = 'new-Pass-2'
    await expect(testSshConnection(hosts.resolveConnectOpts(a.id))).rejects.toThrow()
    await call('credentials:save', { id: c.id, name: '运维', username: 'ops', authType: 'password', password: 'new-Pass-2' })
    for (const h of [a, b]) await testSshConnection(hosts.resolveConnectOpts(h.id))
    expect(sshd.seen).toContain('ops:new-Pass-2')

    expect(() => call('credentials:delete', c.id)).toThrow(/「a」、「b」/)
    expect((await call('credentials:list') as unknown[])).toHaveLength(1)
    expect(JSON.stringify(await call('credentials:list'))).not.toContain('Pass')

    // AI 脱敏原值列表含凭据密码
    expect(redactToolText('mysql -uops -pnew-Pass-2', hosts.knownSecrets())).toBe(`mysql -uops -p${REDACTED}`)
  } finally { sshd.close() }
}, 60000)
