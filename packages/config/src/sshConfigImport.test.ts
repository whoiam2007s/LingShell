import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, dirname, basename } from 'node:path'
import { parseSshConfig, sshConfigEntries, hostMatches, keyNeedsPassphrase, previewSshConfig, importSshConfig, type SshConfigEnv } from './sshConfigImport.js'
import { HostStore } from './HostStore.js'
import type { Encryptor } from './SettingsStore.js'

const HOME = normalize('/home/me')
const SSH = join(HOME, '.ssh')
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'

// 内存文件系统
function memEnv(files: Record<string, string>): SshConfigEnv {
  const m = new Map(Object.entries(files).map(([k, v]) => [normalize(k), v]))
  return {
    home: HOME, defaultUser: 'me',
    readFile: (p) => m.get(normalize(p)),
    listDir: (d) => [...m.keys()].filter((k) => dirname(k) === normalize(d)).map((k) => basename(k)),
  }
}
const entries = (text: string, env = memEnv({}), warnings: string[] = []) => sshConfigEntries(parseSshConfig(text, env, warnings))

// 构造 OpenSSH 新格式私钥（只需头部 magic + ciphername）
function opensshKey(cipher: string): string {
  const magic = Buffer.from('openssh-key-v1\0', 'latin1')
  const len = Buffer.alloc(4); len.writeUInt32BE(cipher.length)
  const b64 = Buffer.concat([magic, len, Buffer.from(cipher), Buffer.alloc(16)]).toString('base64')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`
}

describe('parseSshConfig / sshConfigEntries', () => {
  it('基本字段、关键字不分大小写、Key=value、注释、引号', () => {
    const e = entries(`
# 注释
Host web
  HostName 10.0.0.1
  port=2222
  USER = deploy
  IdentityFile "~/.ssh/web key"
host db
  hostname db.internal
`)
    expect(e).toHaveLength(2)
    expect(e[0]).toMatchObject({ alias: 'web', host: '10.0.0.1', port: 2222, user: 'deploy', identityFile: '~/.ssh/web key' })
    expect(e[1]).toMatchObject({ alias: 'db', host: 'db.internal', port: 22, user: undefined })
  })
  it('通配 Host 不建条目但其选项按先出现者生效作用到匹配主机；多别名只取第一个', () => {
    const e = entries(`
User globaluser
Host a a-alias
  HostName 1.1.1.1
  User alice
Host b
  HostName 2.2.2.2
Host *
  User star
  Port 2200
Host !b *
  IdentityFile ~/.ssh/notb
`)
    expect(e.map((x) => x.alias)).toEqual(['a', 'b'])
    expect(e[0]).toMatchObject({ user: 'globaluser', port: 2200, aliases: ['a', 'a-alias'], identityFile: '~/.ssh/notb' })
    expect(e[1]).toMatchObject({ user: 'globaluser', identityFile: undefined })
  })
  it('无 HostName 用别名；无效端口警告回落 22；ProxyCommand 导入并提示；ProxyJump none 视为无', () => {
    const e = entries('Host x\n Port abc\n ProxyCommand nc %h %p\n ProxyJump none\n')
    expect(e[0]).toMatchObject({ host: 'x', port: 22, proxyJump: undefined, proxyCommand: 'nc %h %p' })
    expect(e[0].warnings.join()).toMatch(/端口无效/)
    expect(e[0].warnings.join()).toMatch(/将执行本地命令（ProxyCommand）：nc %h %p/)
    // 与 ProxyJump 同时出现 → 用 ProxyJump；ProxyCommand none = 无
    const e2 = entries('Host y\n ProxyJump j\n ProxyCommand nc %h %p\nHost z\n ProxyCommand none\n')
    expect(e2[0].proxyJump).toBe('j')
    expect(e2[0].proxyCommand).toBeUndefined()
    expect(e2[1].proxyCommand).toBeUndefined()
  })
  it('Match 块忽略并警告', () => {
    const w: string[] = []
    const e = entries('Match host foo\n User m\nHost y\n HostName 3.3.3.3\n', memEnv({}), w)
    expect(e[0].user).toBeUndefined()
    expect(w.join()).toMatch(/Match/)
  })
  it('Include：相对 ~/.ssh、通配文件名、缺失文件警告', () => {
    const env = memEnv({
      [join(SSH, 'conf.d', '1.conf')]: 'Host i1\n HostName 1.0.0.1\n',
      [join(SSH, 'conf.d', '2.conf')]: 'Host i2\n HostName 1.0.0.2\n',
      [join(SSH, 'conf.d', 'skip.txt')]: 'Host nope\n',
      [join(HOME, 'abs.conf')]: 'Host i3\n',
    })
    const w: string[] = []
    const e = entries(`Include conf.d/*.conf\nInclude ~/abs.conf missing.conf\nHost main\n`, env, w)
    expect(e.map((x) => x.alias)).toEqual(['i1', 'i2', 'i3', 'main'])
    expect(w.join()).toMatch(/missing\.conf/)
  })
  it('hostMatches 通配与否定', () => {
    expect(hostMatches(['*.corp'], 'A.CORP')).toBe(true)
    expect(hostMatches(['web?'], 'web1')).toBe(true)
    expect(hostMatches(['*', '!db'], 'db')).toBe(false)
    expect(hostMatches([], 'x')).toBe(false)
  })
})

describe('keyNeedsPassphrase', () => {
  it('识别各格式口令', () => {
    expect(keyNeedsPassphrase(opensshKey('none'))).toBe(false)
    expect(keyNeedsPassphrase(opensshKey('aes256-ctr'))).toBe(true)
    expect(keyNeedsPassphrase('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n')).toBe(true)
    expect(keyNeedsPassphrase('-----BEGIN ENCRYPTED PRIVATE KEY-----\n')).toBe(true)
    expect(keyNeedsPassphrase('-----BEGIN RSA PRIVATE KEY-----\nMII\n')).toBe(false)
    expect(keyNeedsPassphrase('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n')).toBe(false)
    expect(keyNeedsPassphrase('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n')).toBe(true)
  })
})

describe('previewSshConfig', () => {
  const existing = [{ id: 'ex1', label: '老堡垒', host: 'bastion.example.com', port: 22, username: 'ops', authType: 'password' as const }]
  it('私钥状态、默认私钥、重复检测、跳板映射', () => {
    const env = memEnv({
      [join(SSH, 'config')]: `
Host bastion
  HostName bastion.example.com
  User ops
Host app
  HostName 10.0.0.5
  User root
  IdentityFile ~/.ssh/app_key
  ProxyJump bastion
Host enc
  User root
  IdentityFile ~/.ssh/enc_key
Host gone
  User root
  IdentityFile ~/.ssh/nokey
Host deflt
  User root
Host viaaddr
  User root
  ProxyJump ops@bastion.example.com:22
Host chain
  User root
  ProxyJump bastion,app
Host badchain
  User root
  ProxyJump app,bastion
Host unknownjump
  User root
  ProxyJump nobody@9.9.9.9
`,
      [join(SSH, 'app_key')]: KEY,
      [join(SSH, 'enc_key')]: opensshKey('aes256-ctr'),
      [join(SSH, 'id_rsa')]: KEY,
    })
    const p = previewSshConfig(existing, env)
    expect(p.found).toBe(true)
    const by = Object.fromEntries(p.items.map((i) => [i.alias, i]))
    expect(by.bastion).toMatchObject({ existingId: 'ex1', authType: 'key', keyStatus: 'ok', keyFile: join(SSH, 'id_rsa') })
    expect(by.app).toMatchObject({ authType: 'key', keyStatus: 'ok', keyFile: join(SSH, 'app_key'), jump: 'bastion', existingId: undefined })
    expect(by.enc.keyStatus).toBe('encrypted')
    expect(by.enc.warnings.join()).toMatch(/口令/)
    expect(by.gone).toMatchObject({ authType: 'key', keyStatus: 'missing' })
    expect(by.deflt.keyFile).toBe(join(SSH, 'id_rsa'))
    expect(by.viaaddr.jump).toBe('ops@bastion.example.com:22')
    expect(by.chain.jump).toBe('bastion,app')           // app 自身经 bastion → 可映射
    expect(by.badchain.jump).toBeUndefined()            // bastion 不经 app → 忽略
    expect(by.unknownjump.jump).toBeUndefined()
    expect(by.unknownjump.warnings.join()).toMatch(/无法对应/)
    expect(JSON.stringify(p)).not.toContain('PRIVATE KEY')   // 私钥内容不出主进程
  })
  it('无 User → 用本机用户名并提示；无私钥 → 密码认证', () => {
    const p = previewSshConfig([], memEnv({ [join(SSH, 'config')]: 'Host h\n' }))
    expect(p.items[0]).toMatchObject({ username: 'me', authType: 'password', keyStatus: 'none' })
    expect(p.items[0].warnings.join()).toMatch(/本机用户名/)
  })
  it('有 agent：无 IdentityFile 且默认私钥缺失/带口令 → agent；默认私钥无口令或显式 IdentityFile → 照旧', () => {
    const agent = { kind: 'openssh' as const, path: 'P', label: 'Windows OpenSSH agent' }
    const withAgent = (files: Record<string, string>) => ({ ...memEnv(files), agent: () => agent })
    const conf = { [join(SSH, 'config')]: 'Host a\n User u\nHost b\n User u\n IdentityFile ~/.ssh/nope\n' }
    let by = Object.fromEntries(previewSshConfig([], withAgent(conf)).items.map((i) => [i.alias, i]))
    expect(by.a).toMatchObject({ authType: 'agent', keyStatus: 'none', keyFile: undefined })
    expect(by.a.warnings.join()).toMatch(/Windows OpenSSH agent/)
    expect(by.b).toMatchObject({ authType: 'key', keyStatus: 'missing' })
    by = Object.fromEntries(previewSshConfig([], withAgent({ ...conf, [join(SSH, 'id_ed25519')]: opensshKey('aes256-ctr') })).items.map((i) => [i.alias, i]))
    expect(by.a).toMatchObject({ authType: 'agent', keyStatus: 'none' })
    expect(by.a.warnings.join()).not.toMatch(/口令/)
    by = Object.fromEntries(previewSshConfig([], withAgent({ ...conf, [join(SSH, 'id_ed25519')]: KEY })).items.map((i) => [i.alias, i]))
    expect(by.a).toMatchObject({ authType: 'key', keyStatus: 'ok' })
  })
  it('配置文件不存在 → found=false', () => {
    expect(previewSshConfig([], memEnv({}))).toMatchObject({ found: false, items: [] })
  })
})

describe('importSshConfig', () => {
  const enc: Encryptor = { available: () => false, encrypt: (s) => s, decrypt: (s) => s }
  let dir: string
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })
  const cfg = `
Host j1
  HostName 1.1.1.1
  User u
Host j2
  HostName 2.2.2.2
  User u
  ProxyJump j1
Host t
  HostName 3.3.3.3
  User u
  IdentityFile ~/.ssh/k
  ProxyJump j2
Host deep
  HostName 4.4.4.4
  User u
  ProxyJump t
`
  const env = () => memEnv({ [join(SSH, 'config')]: cfg, [join(SSH, 'k')]: KEY })

  it('按勾选导入，跳板先存并映射 jumpHostId，私钥写入', () => {
    dir = mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s = new HostStore(dir, enc)
    const r = importSshConfig(s, ['t', 'j2', 'j1'], env())
    expect(r.imported).toBe(3)
    const by = Object.fromEntries(s.list().map((h) => [h.label, h]))
    expect(by.t.jumpHostId).toBe(by.j2.id)
    expect(by.j2.jumpHostId).toBe(by.j1.id)
    expect(s.resolveConnectOpts(by.t.id).privateKey).toBe(KEY)
  })
  it('重新导入已存在的主机：跳过，不再复制一份', () => {
    dir = mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s = new HostStore(dir, enc)
    expect(importSshConfig(s, ['j1'], env()).imported).toBe(1)
    const r = importSshConfig(s, ['j1'], env())
    expect(r.imported).toBe(0)
    expect(r.warnings.join()).toMatch(/已有相同主机/)
    expect(s.list()).toHaveLength(1)
  })
  it('跳板未勾选且不存在 → 忽略跳板并警告；超 2 级 → 去掉跳板仍导入', () => {
    dir = mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s = new HostStore(dir, enc)
    const r1 = importSshConfig(s, ['j2'], env())
    expect(r1.warnings.join()).toMatch(/未勾选/)
    expect(s.list()[0].jumpHostId).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
    dir =mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s2 = new HostStore(dir, enc)
    const r2 = importSshConfig(s2, ['deep', 't', 'j2', 'j1'], env())
    expect(r2.imported).toBe(4)
    expect(r2.warnings.join()).toMatch(/跳板无法使用/)
    expect(s2.list().find((h) => h.label === 'deep')!.jumpHostId).toBeUndefined()
  })
  it('跳板未勾选但已存在同目标主机 → 挂到已有主机', () => {
    dir = mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s = new HostStore(dir, enc)
    const ex = s.save({ label: '已有 j1', host: '1.1.1.1', port: 22, username: 'u', authType: 'password' })
    importSshConfig(s, ['j2'], env())
    expect(s.list().find((h) => h.label === 'j2')!.jumpHostId).toBe(ex.id)
  })
  it('ProxyCommand：预览带命令并警告「将执行本地命令」；导入后连接参数带上（%h %p 留到连接时替换）', () => {
    dir = mkdtempSync(join(tmpdir(), 'sshimp-'))
    const s = new HostStore(dir, enc)
    const e = memEnv({ [join(SSH, 'config')]: 'Host cf\n HostName ssh.example.com\n User u\n ProxyCommand cloudflared access ssh --hostname %h\n' })
    const p = previewSshConfig([], e)
    expect(p.items[0].proxyCommand).toBe('cloudflared access ssh --hostname %h')
    expect(p.items[0].warnings.join()).toMatch(/将执行本地命令/)
    importSshConfig(s, ['cf'], e)
    const h = s.list()[0]
    expect(h.proxyCommand).toBe('cloudflared access ssh --hostname %h')
    expect(s.resolveConnectOpts(h.id)).toMatchObject({ proxyCommand: 'cloudflared access ssh --hostname %h' })
  })
})
