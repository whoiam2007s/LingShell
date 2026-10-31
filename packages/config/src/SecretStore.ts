import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SECRET_NAME_RE, SECRET_MIN_LEN, SECRET_MAX_LEN, tr, type SecretInput, type SecretPlain, type SecretScope, type SecretSummary } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'

// 密钥保险箱 <dir>/secrets.json：值同 API Key 经系统密钥链加密（加密不可用时降级明文），名称 / 说明 / 范围明文。
// 值只进不出：UI 只拿 SecretSummary；解密只在主进程（命令展开、输出回写、复制到剪贴板）
export interface PersistedSecret extends Omit<SecretSummary, 'hasValue'> { valueCipher?: string; valuePlain?: string }

const SCOPES: SecretScope[] = ['all', 'local', 'group', 'hosts']

export class SecretStore {
  readonly file: string
  constructor(dir: string, private enc: Encryptor) { this.file = join(dir, 'secrets.json') }

  read(): PersistedSecret[] { return readJson<PersistedSecret[]>(this.file) ?? [] }
  write(all: PersistedSecret[]): void { writeJson(this.file, all) }

  list(): SecretSummary[] { return this.read().map(summaryOf) }

  save(input: SecretInput, now = new Date()): SecretSummary {
    const name = String(input?.name ?? '').trim()
    if (!SECRET_NAME_RE.test(name)) throw new Error(`secret_invalid: ${tr('名称只能用小写字母、数字、- 和 _（1–64 个字符），如 mysql-root')}`)
    if (!SCOPES.includes(input.scope)) throw new Error(`secret_invalid: ${tr('可用范围不合法')}`)
    const targets = input.scope === 'group' || input.scope === 'hosts' ? [...new Set((input.targets ?? []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))] : []
    if ((input.scope === 'group' || input.scope === 'hosts') && !targets.length) throw new Error(`secret_invalid: ${input.scope === 'group' ? tr('请至少选一个分组') : tr('请至少选一个主机')}`)
    const all = this.read()
    const i = input.id ? all.findIndex((s) => s.id === input.id) : -1
    if (input.id && i < 0) throw new Error(`secret_not_found: ${tr('密钥不存在（可能已删除）')}`)
    const prev = i >= 0 ? all[i] : undefined
    if (all.some((s) => s.name === name && s.id !== prev?.id)) throw new Error(`secret_name_taken: ${tr('已有同名密钥「{name}」', { name })}`)
    const value = typeof input.value === 'string' ? input.value : ''
    if (!prev && !value) throw new Error(`secret_invalid: ${tr('请填写值')}`)
    if (value && value.length < SECRET_MIN_LEN) throw new Error(`secret_invalid: ${tr('值至少 {n} 个字符（太短的值无法在输出里可靠识别并替换回占位符）', { n: SECRET_MIN_LEN })}`)
    if (value.length > SECRET_MAX_LEN) throw new Error(`secret_invalid: ${tr('值太长（最多 16384 个字符）')}`)
    const at = now.toISOString()
    const s: PersistedSecret = {
      id: prev?.id ?? `sec_${randomUUID().slice(0, 8)}`, name, description: String(input.description ?? '').trim().slice(0, 200),
      scope: input.scope, targets, createdAt: prev?.createdAt ?? at, updatedAt: at,
      ...(value ? this.seal(value) : prev ? this.reseal(prev) : {}),
    }
    if (prev) all[i] = s; else all.push(s)
    this.write(all)
    return summaryOf(s)
  }

  delete(id: string): void { this.write(this.read().filter((s) => s.id !== id)) }

  /** 解密全部值（仅主进程：命令展开 / 输出回写）。解不开的（系统密钥变化）跳过 */
  resolveAll(): SecretPlain[] {
    return this.read().flatMap((s) => { const v = this.open(s); return v ? [{ name: s.name, value: v }] : [] })
  }
  resolve(id: string): string | undefined { const s = this.read().find((x) => x.id === id); return s && this.open(s) }

  seal(plain: string): Pick<PersistedSecret, 'valueCipher' | 'valuePlain'> {
    return this.enc.available() ? { valueCipher: this.enc.encrypt(plain) } : { valuePlain: plain }
  }
  open(s: Pick<PersistedSecret, 'valueCipher' | 'valuePlain'>): string | undefined {
    if (s.valueCipher && this.enc.available()) { try { return this.enc.decrypt(s.valueCipher) } catch { return undefined } }
    return s.valuePlain || undefined
  }

  // 编辑时没填新值：沿用旧值。以前存入时加密不可用（明文）而现在可用了 → 顺手加密，不再一直留明文
  private reseal(prev: PersistedSecret): Pick<PersistedSecret, 'valueCipher' | 'valuePlain'> {
    if (prev.valuePlain && this.enc.available()) { try { return { valueCipher: this.enc.encrypt(prev.valuePlain) } } catch { /* 加密失败保留明文，至少值还在 */ } }
    return { valueCipher: prev.valueCipher, valuePlain: prev.valuePlain }
  }

  /** 启动时迁移：把所有还能读到的明文值改成密文（系统密钥链当时不可用留下的）。返回迁移条数 */
  migrate(): number {
    if (!this.enc.available()) return 0
    const all = this.read()
    let n = 0
    for (const s of all) {
      if (!s.valuePlain) continue
      try { s.valueCipher = this.enc.encrypt(s.valuePlain); delete s.valuePlain; n++ } catch { /* 这条留着，下次再试 */ }
    }
    if (n) this.write(all)
    return n
  }
}

export function summaryOf({ valueCipher, valuePlain, ...s }: PersistedSecret): SecretSummary {
  return { ...s, targets: s.targets ?? [], hasValue: !!(valueCipher || valuePlain) }
}
