import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import ssh2 from 'ssh2'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { HostStore, type Encryptor } from '@lingshell/config'
import { connectSsh, execFull, setHostKeyPolicy, testSshConnection } from '@lingshell/terminal-core'
import { KeyStore, authorizedKeysCommand, parseDeployOutput, registerSshKeys, keyInfo } from './sshKeys.js'
import { findBash } from '../core/index.js'

// 密钥库 + 部署公钥。部署用本机 shell（Windows 上是 Git Bash）真跑生成的命令，HOME 指到临时目录；
// 端到端用本机回环的假 sshd：exec 在本机 shell 里执行，公钥认证按临时 HOME 下的 authorized_keys 判断。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const bash = findBash()
const fakeEnc: Encryptor = { available: () => true, encrypt: (s) => `E(${Buffer.from(s).toString('base64')})`, decrypt: (c) => Buffer.from(c.slice(2, -1), 'base64').toString() }

let dir: string, home: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sshkeys-')); home = join(dir, 'home') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const runLocal = (command: string) => execFileSync(bash!, ['-c', command], { env: { ...process.env, HOME: home }, encoding: 'utf8' })

describe('KeyStore', () => {
  it('生成 ed25519（带口令）与 rsa-4096：列表无私钥、指纹格式、文件里是密文、可解析回明文', async () => {
    const ks = new KeyStore(dir, fakeEnc)
    const a = await ks.generate('我的 笔记本', 'ed25519', 'pp')
    const b = await ks.generate('ci', 'rsa')
    expect(a).toMatchObject({ type: 'ED25519', hasPassphrase: true })
    expect(a.publicKey).toMatch(/^ssh-ed25519 \S+ lingshell$/)   // 中文名只剩安全字符，空了用 lingshell
    expect(b).toMatchObject({ type: 'RSA-4096', hasPassphrase: false })
    expect(b.publicKey).toMatch(/^ssh-rsa \S+ ci$/)
    expect(a.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(JSON.stringify(ks.list())).not.toMatch(/PRIVATE KEY|Cipher/)
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain('PRIVATE KEY')
    const r = ks.resolve(a.id)
    expect(r.passphrase).toBe('pp')
    expect(keyInfo(r.privateKey, 'x', 'pp').fingerprint).toBe(a.fingerprint)
  }, 30000)

  it('导入：有口令要口令、口令错报错、重复导入拒绝', () => {
    const ks = new KeyStore(dir, fakeEnc)
    const enc = utils.generateKeyPairSync('ed25519', { passphrase: 'right', cipher: 'aes256-ctr', rounds: 16 }).private
    expect(() => ks.importKey('k', enc)).toThrow(/passphrase_required/)
    expect(() => ks.importKey('k', enc, 'wrong')).toThrow(/passphrase_wrong/)
    const k = ks.importKey('k', enc, 'right')
    expect(k.hasPassphrase).toBe(true)
    expect(() => ks.importKey('k2', enc, 'right')).toThrow(/key_exists/)
    expect(() => ks.importKey('pub', utils.generateKeyPairSync('ed25519').public)).toThrow(/invalid_key/)
    ks.delete(k.id)
    expect(ks.list()).toEqual([])
  })
})

describe('authorized_keys 幂等追加（本机 shell 真跑）', () => {
  it.skipIf(!bash)('建目录、追加一次、再跑不重复、补末尾换行、注释不同也算同一把', () => {
    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl LingShell'
    expect(parseDeployOutput(0, runLocal(authorizedKeysCommand(pub)))).toEqual({ added: true })
    expect(parseDeployOutput(0, runLocal(authorizedKeysCommand(pub)))).toEqual({ added: false })
    expect(parseDeployOutput(0, runLocal(authorizedKeysCommand(pub.replace('lingshell', 'other'))))).toEqual({ added: false })
    const f = join(home, '.ssh', 'authorized_keys')
    expect(readFileSync(f, 'utf8')).toBe(pub + '\n')
    writeFileSync(f, 'ssh-rsa AAAAB3Nza old')   // 末尾没换行
    runLocal(authorizedKeysCommand(pub))
    expect(readFileSync(f, 'utf8')).toBe(`ssh-rsa AAAAB3Nza old\n${pub}\n`)
  })
  it('非法公钥 / 失败输出', () => {
    expect(() => authorizedKeysCommand("ssh-ed25519 AAAA x'; rm -rf ~")).toThrow()
    expect(() => parseDeployOutput(1, 'Permission denied')).toThrow(/退出码 1/)
  })
})

// 假 sshd：密码 pw 或 authorized_keys 里的公钥可登录；exec 在本机 shell 跑（HOME=临时目录）
function fakeSshd() {
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('error', () => {})
    c.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'pw') return ctx.accept()
      if (ctx.method === 'publickey') {
        const f = join(home, '.ssh', 'authorized_keys')
        const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []
        const b64 = ctx.key.data.toString('base64')
        if (lines.some((l) => l.split(' ')[1] === b64)) return ctx.accept()   // 签名由 ssh2 校验
      }
      ctx.reject(['password', 'publickey'])
    })
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        const p = spawn(bash!, ['-c', info.command], { env: { ...process.env, HOME: home } })
        p.stdout.on('data', (d) => ch.write(d)); p.stderr.on('data', (d) => ch.stderr.write(d))
        p.on('close', (code) => { ch.exit(code ?? 1); ch.end() })
      })
    })
  })
  return new Promise<{ port: number; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
}

it.skipIf(!bash)('端到端：部署（幂等）→ 切换前先测试：已部署的密钥切换成功，未部署的拒绝且不改主机', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const sshd = await fakeSshd()
  try {
    const keys = new KeyStore(dir, fakeEnc)
    const hosts = new HostStore(dir, fakeEnc)
    hosts.appKey = (id) => keys.resolve(id)
    const h = hosts.save({ label: 'fake', host: '127.0.0.1', port: sshd.port, username: 'u', authType: 'password', password: 'pw', group: 'G' })
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audited: string[] = []
    registerSshKeys({
      handle: (ch, fn) => handlers.set(ch, fn), keys, hosts,
      pickFile: async () => undefined, saveFile: async () => undefined,
      exec: async (o, cmd) => { const c = await connectSsh(o); try { return await execFull(c.client, cmd, { timeoutMs: 20000 }) } finally { c.close() } },
      test: (o) => testSshConnection(o),
      audit: (_h, _t, cmd, code) => audited.push(`${code} ${cmd}`),
    })
    const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!(null, ...a)
    const k = await keys.generate('deploy-me', 'ed25519', 'pp')
    const other = await keys.generate('never', 'ed25519')

    expect(await call('keys:deploy', k.id, h.id)).toEqual({ added: true })
    expect(await call('keys:deploy', k.id, h.id)).toEqual({ added: false })
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(audited).toHaveLength(2)
    expect(audited[0]).toContain('deploy-me')

    await expect(call('keys:useForHost', other.id, h.id)).rejects.toThrow(/未切换/)
    expect(hosts.list()[0].authType).toBe('password')

    await call('keys:useForHost', k.id, h.id)
    const after = hosts.list()[0]
    expect(after).toMatchObject({ authType: 'key', keyId: k.id, group: 'G' })
    const o = hosts.resolveConnectOpts(h.id)
    expect(o.password).toBeUndefined()
    await testSshConnection(o)   // 换成密钥后真能连
    expect(() => call('keys:delete', k.id)).toThrow(/key_in_use/)
  } finally { sshd.close() }
}, 60000)
