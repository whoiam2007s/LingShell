import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from './HostStore.js'
import type { Encryptor } from './SettingsStore.js'

const fakeEnc: Encryptor = {
  available: () => true,
  encrypt: (p) => 'ENC(' + Buffer.from(p).toString('base64') + ')',
  decrypt: (c) => Buffer.from(c.replace(/^ENC\(|\)$/g, ''), 'base64').toString(),
}
const noAgent = () => undefined

let dir: string, s: HostStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'creds-')); s = new HostStore(dir, fakeEnc, noAgent) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('凭据', () => {
  it('存储：credentials.json 是密文、摘要无凭据；同名拒绝；留空沿用、换认证方式清旧密文', () => {
    const c = s.saveCredential({ name: '运维 root', username: 'root', authType: 'password', password: 'P@ss-1' })
    expect(c).toEqual({ id: c.id, name: '运维 root', username: 'root', authType: 'password', hasSecret: true })
    const raw = readFileSync(join(dir, 'credentials.json'), 'utf8')
    expect(raw).not.toContain('P@ss-1')
    expect(raw).toContain('ENC(')
    expect(() => s.saveCredential({ name: ' 运维 ROOT ', username: 'x', authType: 'agent' })).toThrow(/credential_name_taken/)
    expect(() => s.saveCredential({ name: 'x', username: ' ', authType: 'agent' })).toThrow(/credential_invalid/)
    s.saveCredential({ id: c.id, name: '运维 root', username: 'root', authType: 'password' })   // 留空不改
    expect(s.credentials.resolve(c.id).password).toBe('P@ss-1')
    s.saveCredential({ id: c.id, name: '运维 root', username: 'root', authType: 'key', privateKey: 'PK', passphrase: 'pp' })
    expect(s.credentials.resolve(c.id)).toEqual({ username: 'root', authType: 'key', privateKey: 'PK', passphrase: 'pp' })
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).not.toContain('passwordCipher')
  })

  it('解析优先级：引用凭据时用户名/认证全取自凭据（本条残留密文不用）；应用密钥 > 粘贴；不引用时用本条', () => {
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'cred-pw' })
    const own = s.save({ label: 'own', host: 'h1', port: 22, username: 'me', authType: 'password', password: 'own-pw' })
    const h = s.save({ label: 'a', host: 'h2', port: 22, username: 'ignored', authType: 'password', password: 'host-pw', credentialId: c.id })
    expect(s.resolveConnectOpts(h.id)).toMatchObject({ username: 'ops', password: 'cred-pw' })
    expect(readFileSync(join(dir, 'hosts.json'), 'utf8')).not.toContain(Buffer.from('host-pw').toString('base64'))   // 用凭据时本条不存密文
    expect(s.resolveConnectOpts(own.id)).toMatchObject({ username: 'me', password: 'own-pw' })
    expect(s.list().find((x) => x.id === h.id)).toMatchObject({ username: 'ops', authType: 'password', credentialId: c.id })

    // 凭据用应用密钥
    s.appKey = (id) => ({ privateKey: `APP-${id}`, passphrase: 'app-pp' })
    s.saveCredential({ id: c.id, name: 'ops', username: 'deploy', authType: 'key', keyId: 'k1' })
    const o = s.resolveConnectOpts(h.id)
    expect(o).toMatchObject({ username: 'deploy', privateKey: 'APP-k1', passphrase: 'app-pp' })
    expect(o.password).toBeUndefined()
    // 快照同步：hosts.json 里的用户名/认证方式跟着凭据变
    expect(JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8'))[1]).toMatchObject({ username: 'deploy', authType: 'key', credentialId: c.id })

    // agent 凭据：没 agent 时报错
    s.saveCredential({ id: c.id, name: 'ops', username: 'deploy', authType: 'agent' })
    expect(() => s.resolveConnectOpts(h.id)).toThrow(/agent/)

    // 改回不用凭据（''）：用本条
    s.save({ id: h.id, label: 'a', host: 'h2', port: 22, username: 'me2', authType: 'password', password: 'p2', credentialId: '' })
    expect(s.resolveConnectOpts(h.id)).toMatchObject({ username: 'me2', password: 'p2' })
    expect(() => s.save({ label: 'b', host: 'h3', port: 22, username: 'u', authType: 'agent', credentialId: 'nope' })).toThrow(/credential_not_found/)
  })

  it('改一处全生效（含跳板机）；凭据丢失时连接报错', () => {
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'old' })
    const jump = s.save({ label: 'jump', host: 'j', port: 22, username: '', authType: 'password', credentialId: c.id })
    const t = s.save({ label: 't', host: 't', port: 22, username: '', authType: 'password', credentialId: c.id, jumpHostId: jump.id })
    s.saveCredential({ id: c.id, name: 'ops', username: 'ops', authType: 'password', password: 'new' })
    const o = s.resolveConnectOpts(t.id)
    expect(o).toMatchObject({ username: 'ops', password: 'new', jump: { username: 'ops', password: 'new', host: 'j' } })
    // 手改数据删掉凭据 → 明确报错
    s.credentials.remove(c.id)
    expect(() => s.resolveConnectOpts(t.id)).toThrow(/credential_not_found/)
  })

  it('引用保护：被主机引用时禁止删除并列出主机；解除后可删', () => {
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'x' })
    s.save({ label: 'web-1', host: 'a', port: 22, username: '', authType: 'password', credentialId: c.id })
    const b = s.save({ label: 'web-2', host: 'b', port: 22, username: '', authType: 'password', credentialId: c.id })
    expect(() => s.deleteCredential(c.id)).toThrow(/credential_in_use.*「web-1」、「web-2」/)
    s.delete(b.id)
    s.save({ id: s.list()[0].id, label: 'web-1', host: 'a', port: 22, username: 'u', authType: 'agent', credentialId: '' })
    s.deleteCredential(c.id)
    expect(s.credentials.list()).toEqual([])
  })

  it('批量设置：清掉主机自己的密文与应用密钥，用户名换成凭据的；凭据不存在报错', () => {
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'cp' })
    const a = s.save({ label: 'a', host: 'a', port: 22, username: 'x', authType: 'password', password: 'ap' })
    const b = s.save({ label: 'b', host: 'b', port: 22, username: 'y', authType: 'key', keyId: 'k' })
    const other = s.save({ label: 'c', host: 'c', port: 22, username: 'z', authType: 'password', password: 'zp' })
    expect(s.setCredential([a.id, b.id], c.id)).toBe(2)
    const raw = JSON.parse(readFileSync(join(dir, 'hosts.json'), 'utf8')) as Record<string, unknown>[]
    expect(raw[0]).toMatchObject({ username: 'ops', credentialId: c.id })
    expect(raw[0].passwordCipher).toBeUndefined()
    expect(raw[1].keyId).toBeUndefined()
    expect(s.resolveConnectOpts(b.id)).toMatchObject({ username: 'ops', password: 'cp' })
    expect(s.resolveConnectOpts(other.id)).toMatchObject({ username: 'z', password: 'zp' })
    expect(() => s.setCredential([a.id], 'nope')).toThrow(/credential_not_found/)
  })

  it('knownSecrets 含未被引用的凭据的密码/私钥/口令（AI 脱敏 / 诊断包原值替换）', () => {
    s.save({ label: 'h', host: 'h', port: 22, username: 'u', authType: 'password', password: 'host-secret' })
    s.saveCredential({ name: 'pw', username: 'u', authType: 'password', password: 'cred-secret' })
    s.saveCredential({ name: 'key', username: 'u', authType: 'key', privateKey: 'KEY-BODY', passphrase: 'key-pp' })
    expect(s.knownSecrets().sort()).toEqual(['KEY-BODY', 'cred-secret', 'host-secret', 'key-pp'])
  })

  it('新连接表单选凭据：credentialConnectOpts 解析用户名/认证', () => {
    const c = s.saveCredential({ name: 'ops', username: 'ops', authType: 'password', password: 'p' })
    expect(s.credentialConnectOpts(c.id)).toEqual({ username: 'ops', password: 'p', privateKey: undefined, passphrase: undefined, agent: undefined })
  })
})
