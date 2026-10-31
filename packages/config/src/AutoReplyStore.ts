import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkAutoReplyPattern, tr, tk, type AutoReplyInput, type AutoReplySummary } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'

// 自动应答规则 <dir>/auto-replies.json。密钥应答（如 sudo 密码）按 API Key 的方式加密存储（加密不可用时降级明文）；
// 非密钥应答（yes / 回车）明文。UI 只拿 AutoReplySummary：密钥应答不回传，编辑时留空 = 不变。
export interface PersistedAutoReply extends Omit<AutoReplySummary, 'hasResponse'> { responseCipher?: string; responsePlain?: string }
export type ResolvedAutoReply = Omit<AutoReplySummary, 'hasResponse'>   // response 已解密；undefined = 未设置（不触发）

// 没有文件时的示例：全部停用、不含任何密钥，用户自己填好再开
export const DEFAULT_AUTO_REPLIES: PersistedAutoReply[] = [
  { id: 'ar_sudo', name: tk('sudo 密码'), pattern: '[sudo] password for', regex: false, secret: true, appendEnter: true, scope: [], allowProd: false, enabled: false },
  { id: 'ar_hostkey', name: tk('SSH 首次连接确认'), pattern: 'continue connecting (yes/no', regex: false, secret: false, response: 'yes', appendEnter: true, scope: 'all', allowProd: false, enabled: false },
  { id: 'ar_anykey', name: tk('按任意键继续'), pattern: 'press (any key|enter) to continue', regex: true, secret: false, response: '', appendEnter: true, scope: 'all', allowProd: false, enabled: false },
]

// 显示用：没改过名字的示例规则按界面语言显示（存盘的仍是原文）
const DEFAULT_NAMES = new Map(DEFAULT_AUTO_REPLIES.map((r) => [r.id, r.name]))
const shownName = (r: { id: string; name: string }) => (DEFAULT_NAMES.get(r.id) === r.name ? tr(r.name) : r.name)

export class AutoReplyStore {
  readonly file: string
  constructor(dir: string, private enc: Encryptor) { this.file = join(dir, 'auto-replies.json') }

  private read(): PersistedAutoReply[] { return readJson<PersistedAutoReply[]>(this.file) ?? DEFAULT_AUTO_REPLIES.map((r) => ({ ...r })) }

  list(): AutoReplySummary[] {
    return this.read().map(({ responseCipher, responsePlain, response, ...r0 }) => {
      const r = { ...r0, name: shownName(r0) }
      return r.secret ? { ...r, hasResponse: !!(responseCipher || responsePlain) } : { ...r, response, hasResponse: response !== undefined }
    })
  }

  save(input: AutoReplyInput): AutoReplySummary {
    const name = input.name.trim()
    if (!name) throw new Error(tr('名称不能为空'))
    const bad = checkAutoReplyPattern(input.pattern, input.regex)
    if (bad) throw new Error(bad)
    const scope = input.scope === 'all' ? 'all' : [...new Set(input.scope.filter((x) => typeof x === 'string' && x))]
    const all = this.read()
    const i = input.id ? all.findIndex((r) => r.id === input.id) : -1
    const prev = i >= 0 ? all[i] : undefined
    const r: PersistedAutoReply = {
      id: prev?.id ?? `ar_${randomUUID().slice(0, 8)}`, name, pattern: input.pattern, regex: input.regex, secret: input.secret,
      appendEnter: input.appendEnter, scope, allowProd: input.allowProd, enabled: input.enabled,
    }
    if (input.secret) {
      // 留空 = 保持：原来就是密钥沿用密文；原来是明文应答则转加密
      const v = input.response || (prev?.secret ? undefined : prev?.response || undefined)
      if (v) Object.assign(r, this.seal(v))
      else if (prev?.secret) { r.responseCipher = prev.responseCipher; r.responsePlain = prev.responsePlain }
    } else r.response = input.response ?? (prev && !prev.secret ? prev.response : '')
    if (i >= 0) all[i] = r; else all.push(r)
    writeJson(this.file, all)
    return this.list().find((x) => x.id === r.id)!
  }

  delete(id: string): void { writeJson(this.file, this.read().filter((r) => r.id !== id)) }

  /** 解密出应答（仅主进程触发用，不经 IPC 回传） */
  resolveAll(): ResolvedAutoReply[] {
    return this.read().map(({ responseCipher, responsePlain, response, ...r }) => ({ ...r, response: r.secret ? this.open(responseCipher, responsePlain) : response }))
  }

  private seal(plain: string): Partial<PersistedAutoReply> {
    return this.enc.available() ? { responseCipher: this.enc.encrypt(plain) } : { responsePlain: plain }
  }
  private open(cipher?: string, plain?: string): string | undefined {
    if (cipher && this.enc.available()) { try { return this.enc.decrypt(cipher) } catch { return undefined } }
    return plain || undefined
  }
}
