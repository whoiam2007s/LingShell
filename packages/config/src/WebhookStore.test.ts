import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebhookStore } from './WebhookStore.js'
import type { Encryptor } from './SettingsStore.js'

const mockEnc: Encryptor = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain).toString('base64'),
  decrypt: (cipher) => Buffer.from(cipher, 'base64').toString('utf8'),
}
const URL1 = 'https://oapi.dingtalk.com/robot/send?access_token=tok123456'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wh-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('WebhookStore', () => {
  it('URL/密钥加密落盘，list 不回传，resolveAll 解密', () => {
    const s = new WebhookStore(dir, mockEnc)
    const w = s.save({ name: ' 运维群 ', type: 'dingtalk', url: URL1, secret: 'SECabc', enabled: true })
    expect(w).toEqual({ id: w.id, name: '运维群', type: 'dingtalk', enabled: true, urlHint: 'https://oapi.dingtalk.com', hasSecret: true })
    const raw = readFileSync(join(dir, 'webhooks.json'), 'utf8')
    expect(raw).not.toContain('tok123456')
    expect(raw).not.toContain('SECabc')
    expect(s.resolveAll()[0]).toMatchObject({ url: URL1, secret: 'SECabc' })
  })

  it('编辑时 url/secret 留空保留，clearSecret 清除', () => {
    const s = new WebhookStore(dir, mockEnc)
    const w = s.save({ name: 'a', type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 's1', enabled: true })
    s.save({ id: w.id, name: 'b', type: 'feishu', enabled: false })
    expect(s.resolveAll()[0]).toMatchObject({ name: 'b', enabled: false, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 's1' })
    s.save({ id: w.id, name: 'b', type: 'feishu', enabled: true, clearSecret: true })
    expect(s.list()[0].hasSecret).toBe(false)
    s.delete(w.id)
    expect(s.list()).toEqual([])
  })

  it('只允许 https，http 仅限本机', () => {
    const s = new WebhookStore(dir, mockEnc)
    expect(() => s.save({ name: 'a', type: 'generic', url: 'http://example.com/hook', enabled: true })).toThrow(/https/)
    expect(() => s.save({ name: 'a', type: 'generic', enabled: true })).toThrow()
    expect(s.save({ name: 'a', type: 'generic', url: 'http://127.0.0.1:8080/hook', enabled: true }).urlHint).toBe('http://127.0.0.1:8080')
  })
})
