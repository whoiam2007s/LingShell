import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Encryptor } from './SettingsStore.js'
import { SecretStore } from './SecretStore.js'
import { HostStore } from './HostStore.js'
import { exportConfig, importConfig, parseBundle, previewBundle } from './configBundle.js'

const fakeEnc = (tag: string): Encryptor => ({
  available: () => true,
  encrypt: (p) => `${tag}:${Buffer.from(p).toString('base64')}`,
  decrypt: (c) => { if (!c.startsWith(`${tag}:`)) throw new Error('bad'); return Buffer.from(c.slice(tag.length + 1), 'base64').toString() },
})
const A = fakeEnc('A'), B = fakeEnc('B')
const noEnc: Encryptor = { available: () => false, encrypt: () => { throw new Error('unavailable') }, decrypt: () => { throw new Error('unavailable') } }
const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sec-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true }) })

describe('SecretStore', () => {
  it('新建加密落盘，摘要不含值；留空 = 不改值；值可解密', () => {
    const d = tmp(), s = new SecretStore(d, A)
    const a = s.save({ name: 'mysql-root', description: '数据库 root', scope: 'local', value: 'S3cr3t-xyz-123' })
    expect(a).toMatchObject({ name: 'mysql-root', scope: 'local', targets: [], hasValue: true })
    expect(JSON.stringify(a)).not.toContain('S3cr3t')
    expect(readFileSync(s.file, 'utf8')).not.toContain('S3cr3t')
    const b = s.save({ id: a.id, name: 'mysql-root', description: '改说明', scope: 'hosts', targets: ['h1', 'h1'] })
    expect(b).toMatchObject({ description: '改说明', targets: ['h1'], hasValue: true, createdAt: a.createdAt })
    expect(s.resolveAll()).toEqual([{ name: 'mysql-root', value: 'S3cr3t-xyz-123' }])
  })
  it('加密不可用时明文落盘；之后加密可用：编辑不填值或启动迁移都会转成密文', () => {
    const d = tmp(), file = join(d, 'secrets.json')
    const plain = new SecretStore(d, noEnc)
    const a = plain.save({ name: 'demo', scope: 'local', value: 'S3cr3t-xyz-123' })
    expect(readFileSync(file, 'utf8')).toContain('S3cr3t-xyz-123')
    plain.save({ id: a.id, name: 'demo', scope: 'local', description: '改说明' })
    expect(readFileSync(file, 'utf8')).toContain('S3cr3t-xyz-123')   // 仍是明文
    const enc = new SecretStore(d, A)
    expect(enc.migrate()).toBe(1)
    expect(readFileSync(file, 'utf8')).not.toContain('S3cr3t-xyz-123')
    expect(enc.resolveAll()).toEqual([{ name: 'demo', value: 'S3cr3t-xyz-123' }])

    const d2 = tmp(), store2 = new SecretStore(d2, noEnc)
    const b = store2.save({ name: 'demo2', scope: 'local', value: 'Plain-2-value' })
    const after = new SecretStore(d2, A).save({ id: b.id, name: 'demo2', scope: 'local', description: '编辑' })
    expect(after.hasValue).toBe(true)
    expect(readFileSync(join(d2, 'secrets.json'), 'utf8')).not.toContain('Plain-2-value')
  })
  it('校验：名称格式 / 重名 / 值必填且至少 4 字符 / 指定范围要选目标', () => {
    const s = new SecretStore(tmp(), A)
    expect(() => s.save({ name: 'Bad Name', scope: 'all', value: 'abcd' })).toThrow(/名称只能/)
    expect(() => s.save({ name: 'a', scope: 'all' })).toThrow(/请填写值/)
    expect(() => s.save({ name: 'a', scope: 'all', value: 'abc' })).toThrow(/至少 4/)
    expect(() => s.save({ name: 'a', scope: 'group', value: 'abcd' })).toThrow(/分组/)
    s.save({ name: 'a', scope: 'all', value: 'abcd' })
    expect(() => s.save({ name: 'a', scope: 'all', value: 'abcde' })).toThrow(/同名/)
  })
})

describe('配置导出 / 导入：密钥保险箱', () => {
  const seed = () => {
    const d = tmp()
    const h = new HostStore(d, A).save({ label: 'web1', host: '10.0.0.1', port: 22, username: 'root', authType: 'password', password: 'pw' })
    const s = new SecretStore(d, A)
    s.save({ name: 'demo', description: '演示', scope: 'hosts', targets: [h.id], value: 'S3cr3t-xyz-123' })
    s.save({ name: 'tok', scope: 'group', targets: ['web'], value: 'tok-value-1' })
    return d
  }
  it('无导出密码：只导名称 / 说明 / 范围，导入后标需替换值', () => {
    const b = exportConfig(seed(), A, { sections: ['hosts', 'secrets'] }, '1.0.0')
    const text = JSON.stringify(b)
    expect(text).not.toContain('S3cr3t')
    expect(b.sections.secrets?.every((x) => x.valueOmitted)).toBe(true)
    expect(previewBundle(b).counts.secrets).toBe(2)
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(text), { hosts: 'merge', secrets: 'merge' })
    expect(r.secrets).toMatchObject({ added: 2, needValue: ['demo', 'tok'] })
    const l = new SecretStore(dst, B).list()
    const hostId = new HostStore(dst, B).list()[0].id
    expect(l.find((x) => x.name === 'demo')).toMatchObject({ hasValue: false, targets: [hostId] })   // 主机按导入后的 id 重映射
  })
  it('有导出密码：值加密进 secrets，导入后用本机加密器重新加密', () => {
    const b = exportConfig(seed(), A, { sections: ['secrets'], password: 'pw123456' }, '1.0.0')
    expect(JSON.stringify(b)).not.toContain('S3cr3t')
    const dst = tmp()
    const r = importConfig(dst, B, parseBundle(JSON.stringify(b)), { secrets: 'overwrite', password: 'pw123456' })
    expect(r.secrets).toMatchObject({ added: 2, needValue: [] })
    expect(new SecretStore(dst, B).resolveAll().map((x) => x.value).sort()).toEqual(['S3cr3t-xyz-123', 'tok-value-1'])
    expect(new SecretStore(dst, B).list().find((x) => x.name === 'demo')?.targets).toEqual([])   // 主机没一起导入：目标去掉
  })
})
