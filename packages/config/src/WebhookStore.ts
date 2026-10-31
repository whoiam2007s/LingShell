import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebhookInput, WebhookSummary, WebhookType } from '@lingshell/shared'
import { checkWebhookUrl, tr } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'

// 巡检告警群机器人 <dir>/webhooks.json。URL 里带 access_token/key，与签名密钥一样按 API Key 的方式加密存储；
// 加密不可用时降级明文（文件在 userData，权限受限）。UI 只拿 WebhookSummary（不含 URL/密钥）。
interface Persisted {
  id: string; name: string; type: WebhookType; enabled: boolean; urlHint: string
  urlCipher?: string; urlPlain?: string; secretCipher?: string; secretPlain?: string
}
export interface ResolvedWebhook { id: string; name: string; type: WebhookType; enabled: boolean; url: string; secret?: string }

const TYPES: WebhookType[] = ['dingtalk', 'wecom', 'feishu', 'generic']
const hintOf = (url: string) => { const u = new URL(url); return `${u.protocol}//${u.host}` }

export class WebhookStore {
  private file: string
  constructor(dir: string, private enc: Encryptor) { this.file = join(dir, 'webhooks.json') }

  private read(): Persisted[] { return readJson<Persisted[]>(this.file) ?? [] }

  list(): WebhookSummary[] {
    return this.read().map((w) => ({ id: w.id, name: w.name, type: w.type, enabled: w.enabled, urlHint: w.urlHint, hasSecret: !!(w.secretCipher || w.secretPlain) }))
  }

  save(input: WebhookInput): WebhookSummary {
    const name = input.name.trim()
    if (!name) throw new Error(tr('名称不能为空'))
    if (!TYPES.includes(input.type)) throw new Error(tr('未知的机器人类型'))
    const all = this.read()
    const i = input.id ? all.findIndex((w) => w.id === input.id) : -1
    const prev = i >= 0 ? all[i] : undefined
    const url = input.url?.trim()
    if (!url && !prev) throw new Error(tr('Webhook 地址不能为空'))
    if (url) { const bad = checkWebhookUrl(url); if (bad) throw new Error(bad) }
    const w: Persisted = { ...(prev ?? {}), id: prev?.id ?? `wh_${randomUUID().slice(0, 8)}`, name, type: input.type, enabled: input.enabled, urlHint: url ? hintOf(url) : prev!.urlHint }
    if (url) Object.assign(w, this.seal('url', url))
    const secret = input.secret?.trim()
    if (secret) Object.assign(w, this.seal('secret', secret))
    else if (input.clearSecret) { w.secretCipher = undefined; w.secretPlain = undefined }
    if (i >= 0) all[i] = w; else all.push(w)
    writeJson(this.file, all)
    return this.list().find((x) => x.id === w.id)!
  }

  delete(id: string): void { writeJson(this.file, this.read().filter((w) => w.id !== id)) }

  /** 解密出完整配置（仅主进程发送用，不经 IPC 回传） */
  resolveAll(): ResolvedWebhook[] {
    return this.read().map((w) => ({ id: w.id, name: w.name, type: w.type, enabled: w.enabled, url: this.open(w.urlCipher, w.urlPlain), secret: this.open(w.secretCipher, w.secretPlain) || undefined }))
  }

  private seal(k: 'url' | 'secret', plain: string): Partial<Persisted> {
    return this.enc.available() ? { [`${k}Cipher`]: this.enc.encrypt(plain), [`${k}Plain`]: undefined } : { [`${k}Plain`]: plain, [`${k}Cipher`]: undefined }
  }
  private open(cipher?: string, plain?: string): string {
    if (cipher && this.enc.available()) { try { return this.enc.decrypt(cipher) } catch { return '' } }
    return plain ?? ''
  }
}
