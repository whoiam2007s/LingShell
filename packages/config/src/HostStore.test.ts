import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from './HostStore.js'
import type { Encryptor } from './SettingsStore.js'

const fakeEnc: Encryptor = {
  available: () => true,
  encrypt: (p) => 'ENC(' + Buffer.from(p).toString('base64') + ')',
  decrypt: (c) => Buffer.from(c.replace(/^ENC\(|\)$/g, ''), 'base64').toString(),
}

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('HostStore', () => {
  it('save 密码 → list 不含凭据 + 文件里是密文', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const summary = s.save({ label: '生产', host: '1.2.3.4', port: 22, username: 'root', authType: 'password', password: 'secret123' })
    expect(summary.label).toBe('生产')
    expect(summary).not.toHaveProperty('password')
    const list = s.list()
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('passwordCipher')
    const raw = readFileSync(join(dir, 'hosts.json'), 'utf8')
    expect(raw).not.toContain('secret123')
    expect(raw).toContain('ENC(')
  })
  it('resolveConnectOpts 解密得明文凭据', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const sum = s.save({ label: 'x', host: 'h', port: 22, username: 'u', authType: 'password', password: 'pw' })
    const opts = s.resolveConnectOpts(sum.id)
    expect(opts).toMatchObject({ host: 'h', port: 22, username: 'u', password: 'pw' })
  })
  it('应用密钥：存 keyId 不存私钥，连接时经 appKey 解析；未传沿用、空串改回粘贴私钥', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const sum = s.save({ label: 'k', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'OLD', keyId: 'k1' })
    expect(sum.keyId).toBe('k1')
    expect(readFileSync(join(dir, 'hosts.json'), 'utf8')).not.toContain('ENC(')
    expect(() => s.resolveConnectOpts(sum.id)).toThrow(/app_key_unavailable/)
    s.appKey = (id) => ({ privateKey: `PK-${id}`, passphrase: 'pp' })
    expect(s.resolveConnectOpts(sum.id)).toMatchObject({ privateKey: 'PK-k1', passphrase: 'pp' })
    s.save({ id: sum.id, label: 'k2', host: 'h', port: 22, username: 'u', authType: 'key' })
    expect(s.list()[0].keyId).toBe('k1')
    s.save({ id: sum.id, label: 'k2', host: 'h', port: 22, username: 'u', authType: 'key', keyId: '', privateKey: 'PASTED' })
    expect(s.list()[0].keyId).toBeUndefined()
    expect(s.resolveConnectOpts(sum.id).privateKey).toBe('PASTED')
    s.save({ id: sum.id, label: 'k2', host: 'h', port: 22, username: 'u', authType: 'password', password: 'p', keyId: 'k1' })
    expect(s.list()[0].keyId).toBeUndefined()   // 非私钥认证不留 keyId
  })
  it('私钥+passphrase 加密往返', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const sum = s.save({ label: 'k', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'KEYDATA', passphrase: 'pp' })
    const opts = s.resolveConnectOpts(sum.id)
    expect(opts.privateKey).toBe('KEYDATA')
    expect(opts.passphrase).toBe('pp')
    expect(opts.password).toBeUndefined()
  })
  it('agent 认证：不存凭据，连接时现查 agent（跳板同样）；无 agent → ssh_agent_unavailable', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    let agent: { kind: 'openssh'; path: string; label: string } | undefined = { kind: 'openssh', path: '\\\\.\\pipe\\openssh-ssh-agent', label: 'x' }
    const s = new HostStore(dir, fakeEnc, () => agent)
    const k = s.save({ label: 'k', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'KEYDATA' })
    // 由私钥切到 agent：旧私钥密文清掉
    s.save({ id: k.id, label: 'k', host: 'h', port: 22, username: 'u', authType: 'agent', privateKey: 'IGNORED', password: 'IGNORED' })
    const j = s.save({ label: 'j', host: 'jh', port: 22, username: 'u', authType: 'agent' })
    const t = s.save({ label: 't', host: 'th', port: 22, username: 'u', authType: 'password', password: 'pw', jumpHostId: j.id })
    expect(readFileSync(join(dir, 'hosts.json'), 'utf8')).not.toMatch(/KEYDATA|IGNORED|S0VZREFUQQ/)
    expect(s.resolveConnectOpts(k.id)).toMatchObject({ agent: agent!.path, privateKey: undefined, password: undefined })
    const opts = s.resolveConnectOpts(t.id)
    expect(opts).toMatchObject({ password: 'pw', agent: undefined, jump: { host: 'jh', agent: agent!.path } })
    agent = undefined
    expect(() => s.resolveConnectOpts(t.id)).toThrow(/^ssh_agent_unavailable/)
  })
  it('登录命令 / agent 转发 / 高级选项：存取、沿用、清空，透传到连接参数', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    let agent: { kind: 'openssh'; path: string; label: string } | undefined = { kind: 'openssh', path: 'AGENT', label: 'x' }
    const s = new HostStore(dir, fakeEnc, () => agent)
    const base = { label: 'x', host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'pw' }
    const { id } = s.save(base)
    expect(s.list()[0]).not.toHaveProperty('advanced')
    expect(s.resolveConnectOpts(id)).not.toHaveProperty('keepaliveSec')
    expect(s.resolveConnectOpts(id)).toMatchObject({ agent: undefined })
    s.save({ ...base, id, loginCommands: '  cd /app\nsource env\n', agentForward: true, advanced: { keepaliveSec: 0, readyTimeoutSec: 60, compress: true } })
    expect(s.list()[0]).toMatchObject({ loginCommands: 'cd /app\nsource env', agentForward: true, advanced: { keepaliveSec: 0, readyTimeoutSec: 60, compress: true } })
    // 密码认证 + 转发：有 agent 就带上 agent 路径
    expect(s.resolveConnectOpts(id)).toMatchObject({ password: 'pw', agent: 'AGENT', agentForward: true, loginCommands: 'cd /app\nsource env', keepaliveSec: 0, readyTimeoutMs: 60000, compress: true })
    agent = undefined   // 没有 agent：照常连，只是不转发（不像 agent 认证那样报错）
    expect(s.resolveConnectOpts(id)).toMatchObject({ agent: undefined, agentForward: true })
    s.save(base)   // 老调用方不传 → 沿用
    s.save({ ...base, id })
    expect(s.list()[0]).toMatchObject({ loginCommands: 'cd /app\nsource env', agentForward: true })
    // 清空：'' / false / 全默认或不合法的高级项 → 不存
    s.save({ ...base, id, loginCommands: '', agentForward: false, advanced: { keepaliveSec: 15, readyTimeoutSec: 1, compress: false } })
    const h = s.list().find((x) => x.id === id)!
    expect(h).not.toHaveProperty('loginCommands')
    expect(h).not.toHaveProperty('agentForward')
    expect(h).not.toHaveProperty('advanced')
  })
  it('终端类型：合法值存进高级选项并透传；默认值 / 非法字符不存', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const base = { label: 'x', host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'pw' }
    const { id } = s.save({ ...base, advanced: { termType: ' vt100 ' } })
    expect(s.list()[0].advanced).toEqual({ termType: 'vt100' })
    expect(s.resolveConnectOpts(id)).toMatchObject({ termType: 'vt100' })
    for (const termType of ['xterm-256color', 'xterm 256', 'a;rm -rf /', '']) {
      s.save({ ...base, id, advanced: { termType } })
      expect(s.list()[0]).not.toHaveProperty('advanced')
      expect(s.resolveConnectOpts(id)).not.toHaveProperty('termType')
    }
  })
  it('save 带 id → 更新而非新增', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'p1' })
    s.save({ id: a.id, label: 'a2', host: 'h', port: 22, username: 'u', authType: 'password' })
    const list = s.list()
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('a2')
    expect(s.resolveConnectOpts(a.id).password).toBe('p1')
  })
  it('delete 移除主机', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'p' })
    s.delete(a.id)
    expect(s.list()).toHaveLength(0)
  })
  it('解密失败抛 credential_unreadable，不把密文当密码返回', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'p' })
    const broken = new HostStore(dir, { ...fakeEnc, decrypt: () => { throw new Error('bad key') } })
    expect(() => broken.resolveConnectOpts(a.id)).toThrow(/^credential_unreadable/)
  })
  it('切换 authType 清掉另一类旧凭据；同类型空值沿用旧值', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'pw' })
    s.save({ id: a.id, label: 'a', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'K', passphrase: 'pp' })
    let raw = JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8'))[0]
    expect(raw.passwordCipher).toBeUndefined()
    expect(raw.privateKeyCipher).toBeDefined()
    // 切回 password 且不填密码：不复活旧密码，私钥也清掉
    s.save({ id: a.id, label: 'a', host: 'h', port: 22, username: 'u', authType: 'password' })
    raw = JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8'))[0]
    expect(raw.passwordCipher).toBeUndefined()
    expect(raw.privateKeyCipher).toBeUndefined()
    expect(raw.passphraseCipher).toBeUndefined()
  })
  it('跳板机：resolve 递归带出 jump；成环/超深/被引用删除均拒绝', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const add = (label: string, jumpHostId?: string) =>
      s.save({ label, host: label, port: 22, username: 'u', authType: 'password', password: 'p-' + label, jumpHostId }).id
    const j2 = add('j2'), j1 = add('j1', j2), t = add('t', j1)
    const o = s.resolveConnectOpts(t)
    expect(o.jump?.host).toBe('j1')
    expect(o.jump?.password).toBe('p-j1')
    expect(o.jump?.jump?.label).toBe('j2')
    expect(s.list().find((h) => h.id === t)?.jumpHostId).toBe(j1)
    // 第三级超深
    expect(() => add('x', t)).toThrow(/^jump_too_deep/)
    // 成环：j2 改为经 t 跳（t→j1→j2→t）；自跳
    expect(() => s.save({ id: j2, label: 'j2', host: 'j2', port: 22, username: 'u', authType: 'password', jumpHostId: t })).toThrow(/^jump_cycle/)
    expect(() => s.save({ id: j2, label: 'j2', host: 'j2', port: 22, username: 'u', authType: 'password', jumpHostId: j2 })).toThrow(/^jump_cycle/)
    expect(() => add('y', 'nope')).toThrow(/^jump_host_not_found/)
    // 被引用为跳板不能删
    expect(() => s.delete(j1)).toThrow(/^host_in_use_as_jump/)
    // 新连接自带跳板时剩余深度 MAX-1：经 j1(已有 1 级) 合法，经 t(已有 2 级) 超深
    expect(s.resolveConnectOpts(j1, 1).jump?.label).toBe('j2')
    expect(() => s.resolveConnectOpts(t, 1)).toThrow(/^jump_too_deep/)
  })
  it('hosts.json 损坏 → 备份为 .corrupt-*，list 为空；文件不存在不备份', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    expect(s.list()).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    writeFileSync(join(dir, 'hosts.json'), '[{"id":"x", broken', 'utf8')
    expect(s.list()).toEqual([])
    const backups = readdirSync(dir).filter((f) => f.startsWith('hosts.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe('[{"id":"x", broken')
    expect(existsSync(join(dir, 'hosts.json'))).toBe(false)
  })
  it('备注/分级：存取、编辑未传沿用、appendNote 追加', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'p', notes: 'nginx 用 systemctl', env: 'prod' })
    expect(a).toMatchObject({ notes: 'nginx 用 systemctl', env: 'prod' })
    // 老调用方不传 notes/env：沿用
    s.save({ id: a.id, label: 'a2', host: 'h', port: 22, username: 'u', authType: 'password' })
    expect(s.list()[0]).toMatchObject({ label: 'a2', notes: 'nginx 用 systemctl', env: 'prod' })
    s.appendNote(a.id, '  日志在 /var/log/app  ')
    expect(s.list()[0].notes).toBe('nginx 用 systemctl\n日志在 /var/log/app')
    // 显式清空
    s.save({ id: a.id, label: 'a2', host: 'h', port: 22, username: 'u', authType: 'password', notes: '', env: '' })
    expect(s.list()[0]).not.toHaveProperty('notes')
    expect(s.list()[0]).not.toHaveProperty('env')
    expect(() => s.appendNote('nope', 'x')).toThrow('host_not_found')
  })
  it('分组：未传沿用、空串清空、去首尾空白', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const base = { label: 'g', host: 'h', port: 22, username: 'u', authType: 'password' as const }
    const { id } = s.save({ ...base, group: ' 生产/数据库 ' })
    expect(s.list()[0].group).toBe('生产/数据库')
    s.save({ ...base, id })
    expect(s.list()[0].group).toBe('生产/数据库')
    s.save({ ...base, id, group: '' })
    expect(s.list()[0]).not.toHaveProperty('group')
  })
  it('编码：存取、未传沿用、utf8/非法值不存、带进连接参数', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const base = { label: 'e', host: 'h', port: 22, username: 'u', authType: 'password' as const }
    const { id } = s.save({ ...base, encoding: 'gbk' })
    expect(s.list()[0].encoding).toBe('gbk')
    expect(s.resolveConnectOpts(id).encoding).toBe('gbk')
    s.save({ ...base, id })
    expect(s.list()[0].encoding).toBe('gbk')
    s.save({ ...base, id, encoding: 'utf8' })
    expect(s.list()[0]).not.toHaveProperty('encoding')
    s.save({ ...base, id, encoding: 'latin1' as never })
    expect(s.list()[0]).not.toHaveProperty('encoding')
  })
  it('保持会话：缺省关；开了进摘要；未传沿用；关掉不存', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const base = { label: 'p', host: 'h', port: 22, username: 'u', authType: 'password' as const }
    const { id } = s.save(base)
    expect(s.list()[0]).not.toHaveProperty('persistSession')
    s.save({ ...base, id, persistSession: true })
    expect(s.list()[0].persistSession).toBe(true)
    s.save({ ...base, id })
    expect(s.list()[0].persistSession).toBe(true)
    s.save({ ...base, id, persistSession: false })
    expect(s.list()[0]).not.toHaveProperty('persistSession')
  })
  it('duplicate：新 id、标签加副本、凭据一并复制、插在原主机后', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const a = s.save({ label: 'a', host: 'h', port: 22, username: 'u', authType: 'password', password: 'pw', group: 'g' })
    s.save({ label: 'b', host: 'h2', port: 22, username: 'u', authType: 'agent' })
    const c = s.duplicate(a.id)
    expect(c.id).not.toBe(a.id)
    expect(c).toMatchObject({ label: 'a 副本', host: 'h', group: 'g' })
    expect(s.list().map((h) => h.label)).toEqual(['a', 'a 副本', 'b'])
    expect(s.resolveConnectOpts(c.id).password).toBe('pw')
    expect(() => s.duplicate('nope')).toThrow('host_not_found')
  })
})

describe('HostStore 出站代理', () => {
  const base = { label: 'x', host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'pw' }
  it('主机代理：密码加密存、摘要不含密码；留空沿用；换地址清空旧密码', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const { id } = s.save({ ...base, proxy: { type: 'socks5', host: 'p', port: 1080, username: 'pu', password: 'PROXY_PW' } })
    expect(readFileSync(join(dir, 'hosts.json'), 'utf8')).not.toContain('PROXY_PW')
    expect(s.list()[0].proxy).toEqual({ type: 'socks5', host: 'p', port: 1080, username: 'pu', hasPassword: true })
    expect(s.resolveConnectOpts(id).proxy).toEqual({ type: 'socks5', host: 'p', port: 1080, username: 'pu', password: 'PROXY_PW' })
    s.save({ ...base, id, proxy: { type: 'socks5', host: 'p', port: 1080, username: 'pu' } })   // 编辑没填密码
    expect(s.resolveConnectOpts(id).proxy?.password).toBe('PROXY_PW')
    s.save({ ...base, id })                                                                     // 未传 = 沿用
    expect(s.resolveConnectOpts(id).proxy?.host).toBe('p')
    s.save({ ...base, id, proxy: { type: 'socks5', host: 'p2', port: 1080, username: 'pu' } })  // 换地址：旧密码不跟过去
    expect(s.resolveConnectOpts(id).proxy?.password).toBe('')
    expect(() => s.save({ ...base, id, proxy: { type: 'http', host: '', port: 8080 } })).toThrow(/proxy_invalid/)
  })
  it('全局默认：未设置的主机用它；none 不用；default 恢复跟随；经跳板的主机不用', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    expect(s.getDefaultProxy()).toBeNull()
    expect(s.saveDefaultProxy({ type: 'http', host: 'gp', port: 3128, username: 'g', password: 'GPW' })).toEqual({ type: 'http', host: 'gp', port: 3128, username: 'g', hasPassword: true })
    expect(readFileSync(join(dir, 'proxy.json'), 'utf8')).not.toContain('GPW')
    const a = s.save({ ...base })
    expect(s.resolveConnectOpts(a.id).proxy).toEqual({ type: 'http', host: 'gp', port: 3128, username: 'g', password: 'GPW' })
    s.save({ ...base, id: a.id, proxy: 'none' })
    expect(s.list()[0].proxy).toBe('none')
    expect(s.resolveConnectOpts(a.id).proxy).toBeUndefined()
    s.save({ ...base, id: a.id, proxy: 'default' })
    expect(s.list()[0]).not.toHaveProperty('proxy')
    const b = s.save({ ...base, label: 'b', jumpHostId: a.id })
    const ob = s.resolveConnectOpts(b.id)
    expect(ob.proxy).toBeUndefined()
    expect(ob.jump?.proxy?.host).toBe('gp')
    s.saveDefaultProxy(null)
    expect(s.getDefaultProxy()).toBeNull()
    expect(s.resolveConnectOpts(a.id).proxy).toBeUndefined()
  })
})

describe('ProxyCommand', () => {
  const base = { host: 'h', port: 22, username: 'u', authType: 'password' as const, password: 'p' }
  it('保存/清空；与跳板机、单独设置的代理互斥；连接参数里不带全局代理', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    s.saveDefaultProxy({ type: 'socks5', host: 'gp', port: 1080 })
    const j = s.save({ ...base, label: 'j' })
    const a = s.save({ ...base, label: 'a', proxyCommand: ' cloudflared access ssh --hostname %h ' })
    expect(s.list().find((h) => h.id === a.id)!.proxyCommand).toBe('cloudflared access ssh --hostname %h')
    const o = s.resolveConnectOpts(a.id)
    expect(o.proxyCommand).toBe('cloudflared access ssh --hostname %h')
    expect(o.proxy).toBeUndefined()
    expect(() => s.save({ ...base, id: a.id, label: 'a', jumpHostId: j.id })).toThrow(/proxy_command_conflict/)
    expect(() => s.save({ ...base, id: a.id, label: 'a', proxy: { type: 'http', host: 'x', port: 8080 } })).toThrow(/proxy_command_conflict/)
    s.save({ ...base, id: a.id, label: 'a' })   // 未传沿用
    expect(s.list().find((h) => h.id === a.id)!.proxyCommand).toBeTruthy()
    s.save({ ...base, id: a.id, label: 'a', proxyCommand: '' })
    expect(s.list().find((h) => h.id === a.id)).not.toHaveProperty('proxyCommand')
  })
})

describe('批量修改', () => {
  const base = { port: 22, username: 'root', authType: 'password' as const, password: 'p' }
  it('预览 旧值→新值；使用凭据的主机跳过用户名；执行前备份；撤销只还原改过的字段', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const j = s.save({ ...base, label: 'jump', host: '10.1.0.1' })
    const a = s.save({ ...base, label: 'a', host: '10.1.0.5', group: '旧' })
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'x' })
    const b = s.save({ ...base, label: 'b', host: '10.1.0.6', credentialId: c.id })
    const patch = { hostFind: '10.1.', hostReplace: '10.8.', port: 2222, username: 'admin', jumpHostId: j.id, group: '', env: 'prod' as const }
    const plan = s.previewBatch([a.id, b.id, j.id], patch)
    const pa = plan.find((x) => x.id === a.id)!
    expect(pa.changes).toEqual([
      { field: 'host', from: '10.1.0.5', to: '10.8.0.5' }, { field: 'port', from: '22', to: '2222' }, { field: 'username', from: 'root', to: 'admin' },
      { field: 'jumpHostId', from: '直连', to: 'jump' }, { field: 'group', from: '旧', to: '' }, { field: 'env', from: '未标注', to: '生产' },
    ])
    expect(plan.find((x) => x.id === b.id)!.skipped.join()).toMatch(/使用凭据/)
    expect(plan.find((x) => x.id === j.id)!.skipped.join()).toMatch(/自己/)
    expect(s.lastBatch()).toBeNull()
    expect(s.applyBatch([a.id, b.id, j.id], patch, new Date('2026-10-14T01:02:03Z'))).toBe(3)
    const bak = readdirSync(join(dir, 'backups'))
    expect(bak).toEqual(['hosts-2026-10-14T01-02-03-000Z.json'])
    expect(JSON.parse(readFileSync(join(dir, 'backups', bak[0]), 'utf8')).find((h: { id: string }) => h.id === a.id).host).toBe('10.1.0.5')
    const after = Object.fromEntries(s.list().map((h) => [h.label, h]))
    expect(after.a).toMatchObject({ host: '10.8.0.5', port: 2222, username: 'admin', jumpHostId: j.id, env: 'prod' })
    expect(after.a).not.toHaveProperty('group')
    expect(after.b).toMatchObject({ host: '10.8.0.6', username: 'ops' })
    expect(after.jump).toMatchObject({ host: '10.8.0.1', env: 'prod' })
    expect(after.jump.jumpHostId).toBeUndefined()
    expect(s.lastBatch()).toMatchObject({ count: 3 })
    // 批量之后单独改了备注：撤销不应丢掉
    s.save({ ...base, id: a.id, label: 'a', host: '10.8.0.5', port: 2222, username: 'admin', jumpHostId: j.id, notes: '后改的' })
    expect(s.undoBatch()).toBe(3)
    const back = Object.fromEntries(s.list().map((h) => [h.label, h]))
    expect(back.a).toMatchObject({ host: '10.1.0.5', port: 22, username: 'root', group: '旧', notes: '后改的' })
    expect(back.a.jumpHostId).toBeUndefined()
    expect(back.a).not.toHaveProperty('env')
    expect(back.jump.host).toBe('10.1.0.1')
    expect(s.resolveConnectOpts(a.id).password).toBe('p')   // 凭据不受影响
    expect(s.lastBatch()).toBeNull()
    expect(() => s.undoBatch()).toThrow(/batch_no_undo/)
  })
  it('跳板成环的那台跳过跳板修改；端口不合法拒绝；ProxyCommand 主机不设跳板', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const x = s.save({ ...base, label: 'x', host: '1.1.1.1' })
    const y = s.save({ ...base, label: 'y', host: '2.2.2.2', jumpHostId: x.id })
    const p = s.save({ ...base, label: 'p', host: '3.3.3.3', proxyCommand: 'nc %h %p' })
    const plan = s.previewBatch([x.id, p.id], { jumpHostId: y.id })
    expect(plan.find((i) => i.id === x.id)!.skipped.join()).toMatch(/成环/)
    expect(plan.find((i) => i.id === p.id)!.skipped.join()).toMatch(/ProxyCommand/)
    expect(s.applyBatch([x.id, p.id], { jumpHostId: y.id })).toBe(0)
    expect(() => s.previewBatch([x.id], { port: 70000 })).toThrow(/端口/)
  })
  it('基础字段校验：名称 / 地址 / 端口 / 用户名；非法值不落盘；两端空白会被去掉', () => {
    dir = mkdtempSync(join(tmpdir(), 'hoststore-'))
    const s = new HostStore(dir, fakeEnc)
    const bad = (v: Record<string, unknown>) => () => s.save({ authType: 'password', ...v } as never)
    expect(bad({ label: '  ', host: 'h', port: 22, username: 'u' })).toThrow(/名称/)
    expect(bad({ label: 'x', host: '', port: 22, username: 'u' })).toThrow(/地址/)
    expect(bad({ label: 'x', host: 'a b', port: 22, username: 'u' })).toThrow(/空格/)
    expect(bad({ label: 'x', host: 'h', port: 65536, username: 'u' })).toThrow(/端口/)
    expect(bad({ label: 'x', host: 'h', port: 22.5, username: 'u' })).toThrow(/端口/)
    expect(bad({ label: 'x', host: 'h', port: Infinity, username: 'u' })).toThrow(/端口/)
    expect(bad({ label: 'x', host: 'h', port: 22, username: ' ' })).toThrow(/用户名/)
    expect(s.list()).toHaveLength(0)
    const ok = s.save({ label: ' 生产 ', host: ' 1.2.3.4 ', port: 22, username: ' root ', authType: 'password' })
    expect(ok).toMatchObject({ label: '生产', host: '1.2.3.4', username: 'root' })
  })
})
