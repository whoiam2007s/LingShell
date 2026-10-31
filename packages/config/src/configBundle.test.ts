import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostConfig } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { SettingsStore } from './SettingsStore.js'
import { HostStore } from './HostStore.js'
import { TemplateStore } from './TemplateStore.js'
import { ScheduleStore } from './ScheduleStore.js'
import { KnownHostsStore } from './KnownHostsStore.js'
import { WebhookStore } from './WebhookStore.js'
import { QuickCommandStore } from './QuickCommandStore.js'
import { AutoReplyStore } from './AutoReplyStore.js'
import { KnowledgeStore, legacyCardId } from './KnowledgeStore.js'
import { exportConfig, importConfig, parseBundle, previewBundle, sealSecrets, openSecrets, type ConfigBundle } from './configBundle.js'

// 两台「机器」的 safeStorage：前缀不同，验证导入后用的是本机加密器重新加密
const fakeEnc = (tag: string): Encryptor => ({
  available: () => true,
  encrypt: (p) => `${tag}:${Buffer.from(p).toString('base64')}`,
  decrypt: (c) => { if (!c.startsWith(`${tag}:`)) throw new Error('bad'); return Buffer.from(c.slice(tag.length + 1), 'base64').toString() },
})
const A = fakeEnc('A'), B = fakeEnc('B')
const ALL = ['hosts', 'knownHosts', 'templates', 'schedules', 'system', 'model'] as const

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cfgb-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true }) })

// 源机器：两台主机（db 经 jump 跳转）、一个 API Key、系统设置里带一个 webhook secret、各种不该导出的文件
function seed() {
  const dir = tmp()
  const hs = new HostStore(dir, A)
  const jump = hs.save({ label: 'jump', host: 'J.example', port: 22, username: 'ops', authType: 'password', password: 'PW_JUMP_123' })
  const db = hs.save({ label: 'db', host: 'db.internal', port: 2222, username: 'root', authType: 'key', privateKey: 'KEY_DB_PRIVATE', passphrase: 'PASS_DB', jumpHostId: jump.id, group: '生产', notes: 'n', encoding: 'gbk' })
  new SettingsStore(dir, A).save({ provider: 'deepseek', model: 'm1', baseUrl: 'https://x', apiKey: 'sk-SECRETAPIKEY0000000000', system: { webhooks: [{ url: 'https://hook', secret: 'WH_SECRET' }] } as never })
  new TemplateStore(dir).save({ name: '自定义', prompt: 'p' })
  new ScheduleStore(dir).save({ name: '巡检', prompt: 'x', targets: ['local', db.id], when: { kind: 'interval', hours: 6 }, enabled: true })
  new KnownHostsStore(dir).put('db.internal:2222', 'ssh-ed25519', 'SHA256:aaa')
  for (const f of ['audit.jsonl', 'command-history.json', 'sessions.json', 'layout.json', 'api.json', 'auth.json']) writeFileSync(join(dir, f), '"FORBIDDEN_MARK"')
  return { dir, jump, db }
}

describe('密码加密', () => {
  it('往返 + 错误密码', () => {
    const box = sealSecrets('{"a":1}', 'correct horse')
    expect(openSecrets(box, 'correct horse')).toBe('{"a":1}')
    expect(() => openSecrets(box, 'wrong')).toThrow(/wrong_password/)
    expect(sealSecrets('x', 'p').salt).not.toBe(sealSecrets('x', 'p').salt)   // 每次随机盐
  })
})

describe('导出', () => {
  it('不设密码：不含任何凭据与禁止导出的数据，主机标记凭据缺失', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: [...ALL] }, '1.0.0')
    const text = JSON.stringify(b)
    for (const s of ['FORBIDDEN_MARK', 'PW_JUMP_123', 'KEY_DB_PRIVATE', 'PASS_DB', 'SECRETAPIKEY', 'WH_SECRET', 'Cipher', '"A:']) expect(text).not.toContain(s)
    expect(b.secrets).toBeUndefined()
    expect(b.sections.hosts!.every((h) => h.credentialsOmitted)).toBe(true)
    expect(b.sections.system).toEqual({})   // 旧版 system.webhooks 的地址也是凭据，不设密码不导出
    expect(b.sections.model).toEqual({ provider: 'deepseek', model: 'm1', baseUrl: 'https://x', defaultProfileId: 'default', profiles: [{ id: 'default', name: '默认', provider: 'deepseek', model: 'm1', baseUrl: 'https://x', keyOmitted: true }] })
    expect(previewBundle(b)).toMatchObject({ hasSecrets: false, credentialsOmitted: 2, counts: { hosts: 2, knownHosts: 1, schedules: 1, system: 1, model: 1 } })
    expect(previewBundle(b).proxyCommands).toBeUndefined()
  })

  it('带 ProxyCommand 的主机：预览逐条列出命令；导入后保留', () => {
    const dir = tmp()
    new HostStore(dir, A).save({ label: 'cf', host: 'ssh.example.com', port: 22, username: 'u', authType: 'agent', proxyCommand: 'cloudflared access ssh --hostname %h' })
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: ['hosts'] }, '1.0.0')))
    expect(previewBundle(b).proxyCommands).toEqual([{ label: 'cf', command: 'cloudflared access ssh --hostname %h' }])
    const dst = tmp()
    importConfig(dst, B, b, { hosts: 'merge' })
    expect(new HostStore(dst, B).list()[0].proxyCommand).toBe('cloudflared access ssh --hostname %h')
  })

  it('设密码：凭据只在加密块里；只导出勾选的节', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: ['hosts', 'model'], password: 'pw123456' }, '1.0.0')
    const text = JSON.stringify(b)
    for (const s of ['PW_JUMP_123', 'KEY_DB_PRIVATE', 'SECRETAPIKEY', 'FORBIDDEN_MARK']) expect(text).not.toContain(s)
    expect(Object.keys(b.sections).sort()).toEqual(['hosts', 'model'])
    expect(b.secrets).toBeDefined()
    expect(b.sections.hosts!.some((h) => h.credentialsOmitted)).toBe(false)
  })
})

describe('模型单价随 model 节往返', () => {
  it('设过才导出；导入时带了才替换，没带保留本机', () => {
    const { dir } = seed()
    const prices = { currency: 'USD' as const, models: [{ provider: 'deepseek', model: 'm1', input: 1, output: 2 }] }
    new SettingsStore(dir, A).saveUsagePrices(prices)
    const b = exportConfig(dir, A, { sections: ['model'] }, '1.0.0')
    expect(b.sections.model?.prices).toEqual(prices)
    const dst = tmp()
    importConfig(dst, B, b, { model: true })
    expect(new SettingsStore(dst, B).getUsagePrices()).toEqual(prices)
    // 旧版导出（无 prices）不抹掉本机单价
    importConfig(dst, B, { ...b, sections: { model: { provider: 'deepseek', model: 'm2', baseUrl: 'https://y' } } }, { model: true })
    expect(new SettingsStore(dst, B).getUsagePrices()).toEqual(prices)
    expect(new SettingsStore(dst, B).get().model).toBe('m2')
  })
})

describe('模型配置随 model 节往返', () => {
  const two = (dir: string) => {
    const s = new SettingsStore(dir, A)
    s.save({ ...s.get(), modelProfiles: [
      { id: 'a', name: '官方', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', apiKey: 'sk-AAAA1111' },
      { id: 'b', name: '千问', provider: 'qwen', model: 'qwen-max', baseUrl: 'https://q', apiKey: 'sk-BBBB2222', contextWindow: 4096 },
    ], defaultProfileId: 'b' })
  }
  it('带密码：全部配置 + 各自 key 往返，用本机加密器重新加密；默认配置保留', () => {
    const dir = tmp(); two(dir)
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: ['model'], password: 'pw123456' }, '1.0.0')))
    expect(JSON.stringify(b)).not.toContain('sk-')
    expect(previewBundle(b).counts.model).toBe(2)
    const dst = tmp()
    const r = importConfig(dst, B, b, { password: 'pw123456', model: true })
    expect(r.apiKeys).toBe(2)
    const st = new SettingsStore(dst, B)
    expect(st.get().defaultProfileId).toBe('b')
    expect(st.get().modelProfiles!.map((x) => [x.id, x.name, x.hasApiKey, x.contextWindow])).toEqual([['a', '官方', true, 0], ['b', '千问', true, 4096]])
    expect(st.resolveProfile('a').apiKey).toBe('sk-AAAA1111')
    expect(readFileSync(join(dst, 'settings.json'), 'utf8')).toContain('"B:')
  })
  it('不设密码：不导出 key（标 keyOmitted）；导入时本机同 id 同提供商的 key 沿用', () => {
    const dir = tmp(); two(dir)
    const b = exportConfig(dir, A, { sections: ['model'] }, '1.0.0')
    expect(JSON.stringify(b)).not.toContain('sk-')
    expect(b.sections.model!.profiles!.every((x) => x.keyOmitted)).toBe(true)
    const dst = tmp()
    new SettingsStore(dst, B).save({ modelProfiles: [{ id: 'a', name: 'x', provider: 'deepseek', model: 'm', baseUrl: '', apiKey: 'sk-LOCAL' }] } as never)
    importConfig(dst, B, b, { model: true })
    const st = new SettingsStore(dst, B)
    expect(st.resolveProfile('a').apiKey).toBe('sk-LOCAL')
    expect(st.resolveProfile('b').apiKey).toBe('')
    expect(st.get().modelProfiles).toHaveLength(2)
  })
  it('接口协议随配置导出导入；缺省（旧文件）= anthropic，非法值规整，非 DeepSeek 不落', () => {
    const dir = tmp()
    new SettingsStore(dir, A).save({ modelProfiles: [{ id: 'a', name: '网关', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'http://gw', protocol: 'openai' }] } as never)
    const b = exportConfig(dir, A, { sections: ['model'] }, '1.0.0')
    expect(b.sections.model!.profiles![0].protocol).toBe('openai')
    const dst = tmp()
    importConfig(dst, B, b, { model: true })
    expect(new SettingsStore(dst, B).resolveProfile('a').protocol).toBe('openai')
    // 手改 / 旧版文件：没有或乱填 protocol
    b.sections.model!.profiles = [
      { id: 'a', name: 'x', provider: 'deepseek', model: 'm', baseUrl: '' },
      { id: 'c', name: 'y', provider: 'deepseek', model: 'm', baseUrl: '', protocol: 'zzz' as never },
      { id: 'q', name: 'z', provider: 'qwen', model: 'qwen-max', baseUrl: '', protocol: 'anthropic' },
    ]
    importConfig(dst, B, b, { model: true })
    const raw = JSON.parse(readFileSync(join(dst, 'settings.json'), 'utf8'))
    expect(raw.profiles.map((x: { protocol?: string }) => x.protocol)).toEqual(['anthropic', 'anthropic', undefined])
  })
  it('旧版文件（单套 + 按 provider 的 key）导入：换算成配置表', () => {
    const b: ConfigBundle = { format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '0.9', sections: { model: { provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://q' } },
      secrets: sealSecrets(JSON.stringify({ hosts: {}, apiKeys: { qwen: 'sk-QW', deepseek: 'sk-DS' }, fields: [] }), 'pw123456') }
    const dst = tmp()
    expect(importConfig(dst, B, b, { password: 'pw123456', model: true }).apiKeys).toBe(2)
    const st = new SettingsStore(dst, B)
    expect(st.get().modelProfiles!.map((x) => x.id)).toEqual(['default', 'legacy_deepseek'])
    expect(st.resolveProfile().apiKey).toBe('sk-QW')
    expect(st.resolveProfile('legacy_deepseek').apiKey).toBe('sk-DS')
  })
})

describe('导入', () => {
  it('带密码：凭据用本机加密器重新加密，跳板/巡检目标重映射，webhook secret 还原', () => {
    const { dir } = seed()
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: [...ALL], password: 'pw123456' }, '1.0.0')))
    const dst = tmp()
    const r = importConfig(dst, B, b, { password: 'pw123456', hosts: 'merge', knownHosts: true, templates: 'merge', schedules: 'merge', system: true, model: true })
    expect(r.hosts).toMatchObject({ added: 2, needCredentials: [] })
    const hs = new HostStore(dst, B)
    const db = hs.list().find((h) => h.label === 'db')!
    const jump = hs.list().find((h) => h.label === 'jump')!
    expect(db.jumpHostId).toBe(jump.id)
    expect(db.encoding).toBe('gbk')   // 编码随主机往返
    expect(jump).not.toHaveProperty('encoding')
    expect(hs.resolveConnectOpts(db.id)).toMatchObject({ encoding: 'gbk', privateKey: 'KEY_DB_PRIVATE', passphrase: 'PASS_DB', jump: { password: 'PW_JUMP_123' } })
    expect(readFileSync(join(dst, 'hosts.json'), 'utf8')).toContain('"B:')
    expect(new SettingsStore(dst, B).getApiKey()).toBe('sk-SECRETAPIKEY0000000000')
    expect(r.apiKeys).toBe(1)
    expect((new SettingsStore(dst, B).get().system as unknown as { webhooks: unknown }).webhooks).toEqual([{ url: 'https://hook', secret: 'WH_SECRET' }])
    const sch = new ScheduleStore(dst).list()[0]
    expect(sch.targets).toEqual(['local', db.id])
    expect(sch.lastRunAt).toBeUndefined()
    expect(new KnownHostsStore(dst).list()).toHaveLength(1)
  })

  it('主机代理密码：不设密码不导出密文；带密码往返后用本机加密', () => {
    const dir = tmp()
    new HostStore(dir, A).save({ label: 'p', host: 'h', port: 22, username: 'u', authType: 'password', password: 'x', proxy: { type: 'socks5', host: 'px', port: 1080, username: 'pu', password: 'PROXY_SECRET' } })
    const plain = JSON.stringify(exportConfig(dir, A, { sections: ['hosts'] }, '1.0.0'))
    expect(plain).not.toContain('passwordCipher')
    expect(plain).toContain('"px"')
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: ['hosts'], password: 'pw123456' }, '1.0.0')))
    const dst = tmp()
    importConfig(dst, B, b, { password: 'pw123456', hosts: 'merge' })
    const hs = new HostStore(dst, B)
    expect(hs.resolveConnectOpts(hs.list()[0].id).proxy).toEqual({ type: 'socks5', host: 'px', port: 1080, username: 'pu', password: 'PROXY_SECRET' })
  })

  it('密码错误：抛错且什么都不写', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: [...ALL], password: 'pw123456' }, '1.0.0')
    const dst = tmp()
    expect(() => importConfig(dst, B, b, { password: 'nope', hosts: 'merge', system: true, model: true, templates: 'merge' })).toThrow(/wrong_password/)
    for (const f of ['hosts.json', 'settings.json', 'templates.json']) expect(existsSync(join(dst, f))).toBe(false)
  })

  it('无凭据文件：主机导入后列为需重填', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: ['hosts'] }, '1.0.0')
    const r = importConfig(tmp(), B, b, { hosts: 'merge' })
    expect(r.hosts!.needCredentials.sort()).toEqual(['db', 'jump'])
  })

  it('合并：主机按 host+port+user 去重，跳板指向本机已有主机；模板/巡检按名去重；指纹冲突不替换', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: [...ALL], password: 'pw123456' }, '1.0.0')
    const dst = tmp()
    // 本机已有同一台跳板机（不同 id、不同名、大小写不同的 host），同名模板/巡检，同 host:port 不同指纹
    const mine = new HostStore(dst, B).save({ label: '我的跳板', host: 'j.example', port: 22, username: 'ops', authType: 'password', password: 'MINE' })
    new TemplateStore(dst).save({ name: '自定义', prompt: '本机版本' })
    new ScheduleStore(dst).save({ name: '巡检', prompt: '本机', targets: ['local'], when: { kind: 'daily', time: '08:00' }, enabled: false })
    new KnownHostsStore(dst).put('db.internal:2222', 'ssh-ed25519', 'SHA256:zzz')

    const r = importConfig(dst, B, b, { password: 'pw123456', hosts: 'merge', knownHosts: true, templates: 'merge', schedules: 'merge' })
    expect(r.hosts).toMatchObject({ added: 1, skipped: 1 })
    const hosts = new HostStore(dst, B).list()
    expect(hosts).toHaveLength(2)
    expect(hosts.find((h) => h.label === 'db')!.jumpHostId).toBe(mine.id)
    expect(new HostStore(dst, B).resolveConnectOpts(mine.id).password).toBe('MINE')   // 合并不动本机凭据
    expect(r.templates).toMatchObject({ added: 0, skipped: 6 })   // 5 个内置 + 自定义，两边同名
    expect(new TemplateStore(dst).list().find((t) => t.name === '自定义')!.prompt).toBe('本机版本')
    expect(r.schedules).toMatchObject({ skipped: 1 })
    expect(r.knownHosts).toEqual({ added: 0, same: 0, conflicts: [{ hostPort: 'db.internal:2222', existing: 'SHA256:zzz', incoming: 'SHA256:aaa' }] })
    expect(new KnownHostsStore(dst).get('db.internal:2222')!.fingerprint).toBe('SHA256:zzz')

    // 覆盖：保留本机 id，内容换成文件里的
    const r2 = importConfig(dst, B, b, { password: 'pw123456', hosts: 'overwrite', templates: 'overwrite', schedules: 'overwrite' })
    expect(r2.hosts).toMatchObject({ added: 0, updated: 2 })
    const raw = JSON.parse(readFileSync(join(dst, 'hosts.json'), 'utf8')) as HostConfig[]
    expect(raw.find((h) => h.id === mine.id)!.label).toBe('jump')
    expect(new HostStore(dst, B).resolveConnectOpts(mine.id).password).toBe('PW_JUMP_123')
    expect(new TemplateStore(dst).list().find((t) => t.name === '自定义')!.prompt).toBe('p')
    const sch = new ScheduleStore(dst).list()
    expect(sch).toHaveLength(1)
    expect(sch[0].targets).toEqual(['local', raw.find((h) => h.label === 'db')!.id])
  })

  it('坏条目跳过：主机字段 / 端口 / 用户名 / 调度时间 / 模板、指纹；不让坏调度进调度器', () => {
    const b: ConfigBundle = {
      format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '',
      sections: {
        hosts: [
          { id: 'h1', label: 'ok', host: 'a.example', port: 22, username: 'u', authType: 'agent' },
          { id: 'h2', label: '', host: 'b.example', port: 22, username: 'u', authType: 'agent' },
          { id: 'h3', label: 'bad-port', host: 'c.example', port: 22.5, username: 'u', authType: 'agent' },
          { id: 'h4', label: 'bad-host', host: 'a b', port: 22, username: 'u', authType: 'agent' },
          { id: 'h5', label: 'no-user', host: 'd.example', port: 22, username: '', authType: 'agent' },
          { id: 'h6', label: 'bad-auth', host: 'e.example', port: 22, username: 'u', authType: 'weird' as never },
        ],
        templates: [{ id: 't1', name: 'ok', prompt: 'p' }, { id: 't2', name: 'bad', prompt: 3 as never }, { id: 't3', name: '', prompt: 'p' }],
        schedules: [
          { id: 's1', name: 'bad-when', prompt: 'p', targets: ['local'], when: { kind: 'daily', time: '25:00' } as never, enabled: true, createdAt: '' },
          { id: 's2', name: 'bad-targets', prompt: 'p', targets: 'local' as never, when: { kind: 'interval', hours: 1 }, enabled: true, createdAt: '' },
          { id: 's3', name: 'ok', prompt: 'p', targets: ['local'], when: { kind: 'interval', hours: 1 }, enabled: true, createdAt: '' },
        ],
        knownHosts: [
          { hostPort: 'x:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:ok', firstSeen: '' },
          { hostPort: '', keyType: 'x', fingerprint: 'y', firstSeen: '' },
        ],
      },
    }
    const dst = tmp()
    const r = importConfig(dst, B, b, { hosts: 'merge', templates: 'merge', schedules: 'merge', knownHosts: true })
    expect(r.hosts).toMatchObject({ added: 1, skipped: 5 })
    expect(r.templates).toMatchObject({ added: 1, skipped: 2 })
    expect(r.schedules).toMatchObject({ added: 1, skipped: 2 })
    expect(r.knownHosts).toMatchObject({ added: 1 })
    expect(new HostStore(dst, B).list().map((h) => h.label)).toEqual(['ok'])
    expect(new ScheduleStore(dst).list().map((x) => x.name)).toEqual(['ok'])
    expect(new KnownHostsStore(dst).list().map((x) => x.hostPort)).toEqual(['x:22'])
  })

  it('ProxyCommand 与跳板 / 单独代理冲突：导入后保留 ProxyCommand、去掉另两个', () => {
    const b: ConfigBundle = {
      format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '',
      sections: {
        hosts: [
          { id: 'a', label: 'a', host: 'a.example', port: 22, username: 'u', authType: 'agent', proxyCommand: 'nc %h %p' },
          { id: 'b', label: 'b', host: 'b.example', port: 22, username: 'u', authType: 'agent', jumpHostId: 'a', proxyCommand: 'nc %h %p', proxy: { type: 'socks5', host: 'p', port: 1080, username: 'u' } },
        ],
      },
    }
    const dst = tmp()
    importConfig(dst, B, b, { hosts: 'merge' })
    const h = new HostStore(dst, B).list().find((x) => x.label === 'b')!
    expect(h.proxyCommand).toBe('nc %h %p')
    expect(h.jumpHostId).toBeUndefined()
    expect(h.proxy).toBeUndefined()
  })

  it('keyId 不随配置导入：应用密钥去掉，主机 / 凭据都标记需要重填', () => {
    const b: ConfigBundle = {
      format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '',
      sections: {
        hosts: [{ id: 'h', label: 'k', host: 'k.example', port: 22, username: 'u', authType: 'key', keyId: 'app_key_1' }],
        credentials: [{ id: 'c', name: 'kc', username: 'u', authType: 'key', keyId: 'app_key_2' }],
      },
    }
    const dst = tmp()
    const r = importConfig(dst, B, b, { hosts: 'merge' })
    expect(r.hosts!.needCredentials).toEqual(expect.arrayContaining(['k', '凭据「kc」']))
    expect(JSON.parse(readFileSync(join(dst, 'hosts.json'), 'utf8'))[0].keyId).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dst, 'credentials.json'), 'utf8'))[0].keyId).toBeUndefined()
  })

  it('加密段里的坏类型 / 原型路径被忽略，不会写坏数据', () => {
    const b: ConfigBundle = {
      format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '',
      sections: { hosts: [{ id: 'h1', label: 'x', host: 'x.example', port: 22, username: 'u', authType: 'password' }] },
      secrets: sealSecrets(JSON.stringify({ hosts: { h1: { password: 42 } }, fields: [{ path: ['__proto__', 'polluted'], value: 'yes' }, { path: ['system', 'x'], value: 5 }] }), 'pw123456'),
    }
    const dst = tmp()
    const r = importConfig(dst, B, b, { password: 'pw123456', hosts: 'merge' })
    expect(r.hosts!.needCredentials).toEqual(['x'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('不设密码导出：旧版 system.webhooks 的地址与密钥都不导出', () => {
    const { dir } = seed()
    const b = exportConfig(dir, A, { sections: ['system'] }, '1')
    const text = JSON.stringify(b)
    expect(text).not.toContain('WH_SECRET')
    expect(text).not.toContain('https://hook')
  })

  it('跳板/巡检目标在文件和本机都找不到：去掉', () => {
    const b: ConfigBundle = {
      format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '',
      sections: {
        hosts: [{ id: 'h1', label: 'x', host: 'x', port: 22, username: 'u', authType: 'agent', jumpHostId: 'ghost' }],
        schedules: [{ id: 's', name: 's', prompt: 'p', targets: ['ghost'], when: { kind: 'interval', hours: 1 }, enabled: true, createdAt: '' }],
      },
    }
    const dst = tmp()
    const r = importConfig(dst, B, b, { hosts: 'merge', schedules: 'merge' })
    expect(new HostStore(dst, B).list()[0].jumpHostId).toBeUndefined()
    expect(r.schedules).toMatchObject({ added: 0, skipped: 1, droppedTargets: 1 })
  })
})

describe('parseBundle', () => {
  it('校验格式与版本', () => {
    expect(() => parseBundle('not json')).toThrow(/invalid_file/)
    expect(() => parseBundle(JSON.stringify({ format: 'other', version: 1, sections: {} }))).toThrow(/invalid_file/)
    expect(() => parseBundle(JSON.stringify({ format: 'lingshell-config', version: 2, sections: {} }))).toThrow(/unsupported_version/)
    expect(() => parseBundle(JSON.stringify({ format: 'lingshell-config', sections: {} }))).toThrow(/unsupported_version/)
    expect(parseBundle(JSON.stringify({ format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '', sections: {} })).version).toBe(1)
  })
  it('节的基本形状不对直接拒绝（预览 / 导入不再半路抛异常）', () => {
    const wrap = (sections: unknown) => JSON.stringify({ format: 'lingshell-config', version: 1, exportedAt: '', appVersion: '', sections })
    expect(() => parseBundle(wrap({ hosts: {} }))).toThrow(/hosts/)
    expect(() => parseBundle(wrap({ schedules: 'x' }))).toThrow(/schedules/)
    expect(() => parseBundle(wrap({ system: [] }))).toThrow(/system/)
    expect(() => parseBundle(wrap({ model: null }))).toThrow(/model/)
  })
})

describe('告警机器人', () => {
  it('无密码不导出；带密码导出导入后用本机加密，巡检推送目标重映射', () => {
    const dir = tmp()
    const wh = new WebhookStore(dir, A).save({ name: '值班群', type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=TOKEN_X', secret: 'SEC_WH', enabled: true })
    new ScheduleStore(dir).save({ name: '巡检', prompt: 'x', targets: ['local'], when: { kind: 'interval', hours: 6 }, enabled: true, notifyWebhooks: [wh.id, 'gone'] })
    expect(exportConfig(dir, A, { sections: ['webhooks'] }, '1').sections.webhooks).toBeUndefined()

    const b = exportConfig(dir, A, { sections: ['webhooks', 'schedules'], password: 'pw123456' }, '1')
    expect(JSON.stringify(b)).not.toMatch(/TOKEN_X|SEC_WH/)
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(JSON.stringify(b)), { password: 'pw123456', webhooks: 'merge', schedules: 'merge' })
    expect(r.webhooks).toMatchObject({ added: 1 })
    const [got] = new WebhookStore(dst, B).resolveAll()
    expect(got).toMatchObject({ name: '值班群', url: 'https://oapi.dingtalk.com/robot/send?access_token=TOKEN_X', secret: 'SEC_WH' })
    expect(readFileSync(join(dst, 'webhooks.json'), 'utf8')).not.toContain('TOKEN_X')
    expect(new ScheduleStore(dst).list()[0].notifyWebhooks).toEqual([got.id])
  })
})

describe('自动应答', () => {
  const base = { regex: false, appendEnter: true, allowProd: false, enabled: true }
  const seedAr = () => {
    const dir = tmp()
    const h = new HostStore(dir, A).save({ label: 'web', host: 'web.example', port: 22, username: 'ops', authType: 'agent' })
    const s = new AutoReplyStore(dir, A)
    s.save({ ...base, name: 'sudo', pattern: '[sudo] password for', secret: true, response: 'SUDO_PW_9', scope: [h.id, 'local', 'gone'] })
    s.save({ ...base, name: 'yes', pattern: 'continue connecting', secret: false, response: 'yes', scope: 'all' })
    return dir
  }

  it('带密码往返：密钥应答加密进 secrets、导入后本机加密；作用主机重映射', () => {
    const b = exportConfig(seedAr(), A, { sections: ['hosts', 'autoReplies'], password: 'pw123456' }, '1')
    expect(JSON.stringify(b)).not.toContain('SUDO_PW_9')
    expect(previewBundle(b).counts.autoReplies).toBe(5)   // 3 条内置示例 + 2
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(JSON.stringify(b)), { password: 'pw123456', hosts: 'merge', autoReplies: 'merge' })
    expect(r.autoReplies).toMatchObject({ added: 2, skipped: 3, needResponse: [] })
    const st = new AutoReplyStore(dst, B)
    const hostId = new HostStore(dst, B).list()[0].id
    const sudo = st.resolveAll().find((x) => x.name === 'sudo')!
    expect(sudo).toMatchObject({ response: 'SUDO_PW_9', enabled: true, scope: [hostId, 'local'] })
    expect(st.resolveAll().find((x) => x.name === 'yes')?.response).toBe('yes')
    expect(readFileSync(st.file, 'utf8')).not.toContain('SUDO_PW_9')
    expect(JSON.stringify(st.list())).not.toContain('SUDO_PW_9')
  })

  it('无密码：密钥应答不导出，导入后停用待重填；非密钥规则照常', () => {
    const b = exportConfig(seedAr(), A, { sections: ['autoReplies'] }, '1')
    expect(JSON.stringify(b)).not.toContain('SUDO_PW_9')
    expect(b.secrets).toBeUndefined()
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(JSON.stringify(b)), { autoReplies: 'merge' })
    expect(r.autoReplies?.needResponse).toEqual(['sudo'])
    const got = new AutoReplyStore(dst, B).resolveAll()
    expect(got.find((x) => x.name === 'sudo')).toMatchObject({ enabled: false, response: undefined })
    expect(got.find((x) => x.name === 'yes')).toMatchObject({ enabled: true, response: 'yes' })
  })
})

describe('快速命令', () => {
  it('导出导入往返；按组名合并，当前组/显示开关保留本机', () => {
    const src = tmp(), qs = new QuickCommandStore(src)
    const d = qs.get()
    d.sets[0].commands[0].command = 'df -hT'
    d.sets.push({ id: 's_db', name: '数据库', commands: [{ id: 'c1', label: '连接数', command: 'ss -tn | grep {{端口}} | wc -l', appendEnter: true, target: 'broadcast', variants: { windows: 'netstat -an | grep {{端口}} | wc -l' }, strict: true }] })
    qs.save(d)
    const b = parseBundle(JSON.stringify(exportConfig(src, A, { sections: ['quickCommands'] }, '1')))
    expect(previewBundle(b).counts.quickCommands).toBe(2)

    const dst = tmp(), local = new QuickCommandStore(dst)
    local.save({ ...local.get(), barVisible: false })
    expect(importConfig(dst, B, b, { quickCommands: 'merge' }).quickCommands).toEqual({ added: 1, updated: 0, skipped: 1 })
    let got = local.get()
    expect(got.sets.map((s) => s.name)).toEqual(['常用', '数据库'])
    expect(got.sets[0].commands[0].command).toBe('df -h')   // 同名保留本机
    expect(got.sets[1].commands[0]).toMatchObject({ label: '连接数', target: 'broadcast', variants: { windows: 'netstat -an | grep {{端口}} | wc -l' }, strict: true })
    expect(got.barVisible).toBe(false)

    expect(importConfig(dst, B, b, { quickCommands: 'overwrite' }).quickCommands).toEqual({ added: 0, updated: 2, skipped: 0 })
    got = local.get()
    expect(got.sets[0].commands[0].command).toBe('df -hT')
    expect(got.sets[0].commands[1].variants?.windows).toContain('powershell.exe')   // 内置分系统版本也带过去
    expect(new Set(got.sets.flatMap((s) => s.commands.map((c) => c.id))).size).toBe(5)
  })
})

describe('命名凭据随主机节导出导入', () => {
  function seedCreds() {
    const dir = tmp()
    const hs = new HostStore(dir, A)
    const c = hs.saveCredential({ name: '运维', username: 'ops', authType: 'password', password: 'CRED_PW_999' })
    const k = hs.saveCredential({ name: 'deploy', username: 'dep', authType: 'key', privateKey: 'CRED_KEY_BODY', passphrase: 'CRED_PP' })
    const jump = hs.save({ label: 'jump', host: 'j', port: 22, username: '', authType: 'password', credentialId: c.id })
    hs.save({ label: 'web', host: 'w', port: 22, username: '', authType: 'password', credentialId: c.id, jumpHostId: jump.id })
    hs.save({ label: 'ci', host: 'ci', port: 22, username: '', authType: 'password', credentialId: k.id })
    return { dir, c }
  }

  it('无导出密码：凭据只导出名称/用户名/认证方式，不含密文；导入后报需重填', () => {
    const { dir } = seedCreds()
    const b = exportConfig(dir, A, { sections: ['hosts'] }, '1.0.0')
    const text = JSON.stringify(b)
    for (const s of ['CRED_PW_999', 'CRED_KEY_BODY', 'CRED_PP', 'Cipher', '"A:']) expect(text).not.toContain(s)
    expect(b.sections.credentials!.map((c) => [c.name, c.username, c.credentialsOmitted])).toEqual([['运维', 'ops', true], ['deploy', 'dep', true]])
    expect(b.sections.hosts!.some((h) => h.credentialsOmitted)).toBe(false)   // 引用凭据的主机本身没凭据
    expect(previewBundle(b).credentialsOmitted).toBe(2)
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(JSON.stringify(b)), { hosts: 'merge' })
    expect(r.hosts!.needCredentials.sort()).toEqual(['凭据「deploy」', '凭据「运维」'])
  })

  it('设导出密码：往返后凭据用本机加密、主机引用重映射、跳板链仍可解析；同名合并保留本机', () => {
    const { dir } = seedCreds()
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: ['hosts'], password: 'pw123456' }, '1.0.0')))
    const dst = tmp()
    const pre = new HostStore(dst, B).saveCredential({ name: 'deploy', username: 'local', authType: 'password', password: 'LOCAL_PW' })
    const r = importConfig(dst, B, b, { password: 'pw123456', hosts: 'merge' })
    expect(r.hosts).toMatchObject({ added: 3, needCredentials: [] })
    const hs = new HostStore(dst, B)
    expect(readFileSync(join(dst, 'credentials.json'), 'utf8')).toContain('"B:')
    expect(hs.credentials.list().map((c) => c.name).sort()).toEqual(['deploy', '运维'])
    const web = hs.list().find((h) => h.label === 'web')!
    expect(hs.resolveConnectOpts(web.id)).toMatchObject({ username: 'ops', password: 'CRED_PW_999', jump: { username: 'ops', password: 'CRED_PW_999' } })
    // 同名「deploy」merge：保留本机那条，ci 主机指向它
    const ci = hs.list().find((h) => h.label === 'ci')!
    expect(ci.credentialId).toBe(pre.id)
    expect(hs.resolveConnectOpts(ci.id)).toMatchObject({ username: 'local', password: 'LOCAL_PW' })
    // overwrite：本机同名凭据被文件里的覆盖（id 不变）
    importConfig(dst, B, b, { password: 'pw123456', hosts: 'overwrite' })
    expect(new HostStore(dst, B).resolveConnectOpts(ci.id)).toMatchObject({ username: 'dep', privateKey: 'CRED_KEY_BODY', passphrase: 'CRED_PP' })
  })
})

describe('知识库', () => {
  it('导出导入往返：主机卡按导入的主机重映射，本机找不到的主机卡丢弃；按 id 合并 / 覆盖', () => {
    const { dir, db } = seed()
    const ks = new KnowledgeStore(dir)
    ks.save({ id: 'kb_g', scope: 'global', target: '', title: '值班', content: '找张三', category: 'other', source: 'manual' })
    ks.save({ id: 'kb_h', scope: 'host', target: db.id, title: '日志', content: '/var/log/db', category: 'logs', source: 'ai' })
    ks.save({ id: 'kb_gone', scope: 'host', target: 'host-not-exported', title: 'x', content: 'y', category: 'other', source: 'manual' })
    ks.syncLegacy([{ hostKey: db.id, notes: 'n' }])
    const b = parseBundle(JSON.stringify(exportConfig(dir, A, { sections: ['hosts', 'knowledge'] }, '1.0.0')))
    expect(previewBundle(b).counts.knowledge).toBe(4)
    const dst = tmp()
    const r = importConfig(dst, B, b, { hosts: 'merge', knowledge: 'merge' })
    expect(r.knowledge).toEqual({ added: 3, updated: 0, skipped: 0, dropped: 1 })
    const newDb = new HostStore(dst, B).list().find((h) => h.label === 'db')!
    const cards = new KnowledgeStore(dst).list()
    expect(cards.find((c) => c.id === 'kb_h')?.target).toBe(newDb.id)
    expect(cards.find((c) => c.id === legacyCardId(newDb.id))?.content).toBe('n')   // 迁移卡 id 跟着新主机 id
    // 合并：同 id 保留本机；覆盖：用文件里的
    new KnowledgeStore(dst).save({ id: 'kb_g', scope: 'global', target: '', title: '本机改过', content: 'z', category: 'other', source: 'manual' })
    expect(importConfig(dst, B, b, { knowledge: 'merge' }).knowledge).toMatchObject({ skipped: 3, dropped: 1 })
    expect(new KnowledgeStore(dst).list().find((c) => c.id === 'kb_g')?.title).toBe('本机改过')
    importConfig(dst, B, b, { knowledge: 'overwrite' })
    expect(new KnowledgeStore(dst).list().find((c) => c.id === 'kb_g')?.title).toBe('值班')
  })
})
