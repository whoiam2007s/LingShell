import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoReplyStore } from './AutoReplyStore.js'
import type { Encryptor } from './SettingsStore.js'

const enc: Encryptor = {
  available: () => true,
  encrypt: (p) => `E:${Buffer.from(p).toString('base64')}`,
  decrypt: (c) => Buffer.from(c.slice(2), 'base64').toString('utf8'),
}
const base = { pattern: '[sudo] password for', regex: false, appendEnter: true, scope: 'all' as const, allowProd: false, enabled: true }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ar-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('AutoReplyStore', () => {
  it('没有文件时给 3 条示例，全部停用、不含密钥', () => {
    const l = new AutoReplyStore(dir, enc).list()
    expect(l).toHaveLength(3)
    expect(l.every((r) => !r.enabled)).toBe(true)
    expect(l.find((r) => r.secret)?.hasResponse).toBe(false)
  })

  it('密钥应答加密落盘、list 不回传、resolveAll 解密；留空保存保持原值', () => {
    const s = new AutoReplyStore(dir, enc)
    const r = s.save({ ...base, name: 'sudo', secret: true, response: 'PW_123456' })
    expect(r).toMatchObject({ hasResponse: true })
    expect(r.response).toBeUndefined()
    expect(JSON.stringify(s.list())).not.toContain('PW_123456')
    expect(readFileSync(s.file, 'utf8')).not.toContain('PW_123456')
    expect(s.resolveAll().find((x) => x.id === r.id)?.response).toBe('PW_123456')
    s.save({ ...base, id: r.id, name: 'sudo2', secret: true, response: '', enabled: false })
    expect(s.resolveAll().find((x) => x.id === r.id)).toMatchObject({ name: 'sudo2', response: 'PW_123456', enabled: false })
  })

  it('非密钥应答明文可回传；转成密钥时沿用并加密', () => {
    const s = new AutoReplyStore(dir, enc)
    const r = s.save({ ...base, name: 'confirm', secret: false, response: 'OK_42' })
    expect(r.response).toBe('OK_42')
    s.save({ ...base, id: r.id, name: 'confirm', secret: true })
    expect(readFileSync(s.file, 'utf8')).not.toContain('OK_42')
    const sum = s.list().find((x) => x.id === r.id)!
    expect(sum).toMatchObject({ secret: true, hasResponse: true })
    expect(sum.response).toBeUndefined()
    expect(s.resolveAll().find((x) => x.id === r.id)?.response).toBe('OK_42')
  })

  it('校验：名称、空模式、坏正则、能匹配空行的正则', () => {
    const s = new AutoReplyStore(dir, enc)
    expect(() => s.save({ ...base, name: ' ', secret: false })).toThrow('名称')
    expect(() => s.save({ ...base, name: 'x', pattern: ' ', secret: false })).toThrow()
    expect(() => s.save({ ...base, name: 'x', pattern: '(', regex: true, secret: false })).toThrow('无效')
    expect(() => s.save({ ...base, name: 'x', pattern: '.*', regex: true, secret: false })).toThrow('空行')
  })
})
