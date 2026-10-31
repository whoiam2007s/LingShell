import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tr, type AuthType, type CredentialConfig, type CredentialInput, type CredentialSummary } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'

// 凭据（Identity）：credentials.json，与 hosts.json 同目录、同加密规则（凭据字段级加密，名称/用户名明文）。
// 主机只存 credentialId，连接时由 HostStore.resolveConnectOpts 解析。被主机引用时的删除保护在 HostStore.deleteCredential。
export interface ResolvedAuth { username: string; authType: AuthType; password?: string; privateKey?: string; passphrase?: string; keyId?: string }

export class CredentialStore {
  readonly file: string
  constructor(dir: string, private enc: Encryptor) { this.file = join(dir, 'credentials.json') }

  list(): CredentialSummary[] { return this.read().map(credentialSummaryOf) }
  get(id: string): CredentialConfig | undefined { return this.read().find((c) => c.id === id) }

  save(input: CredentialInput): CredentialSummary {
    const all = this.read()
    const name = String(input.name ?? '').trim().slice(0, 80)
    const username = String(input.username ?? '').trim()
    if (!name) throw new Error(`credential_invalid: ${tr('请填写凭据名称')}`)
    if (!username) throw new Error(`credential_invalid: ${tr('请填写用户名')}`)
    if (!['password', 'key', 'agent'].includes(input.authType)) throw new Error(`credential_invalid: ${tr('认证方式不合法')}`)
    const id = input.id ?? randomUUID()
    if (all.some((c) => c.id !== id && c.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`credential_name_taken: ${tr('已有同名凭据「{name}」', { name })}`)
    const prev = all.find((c) => c.id === id)
    // 同 HostStore.save：只存当前认证方式的凭据；留空沿用旧值仅限同一认证方式
    const keep = prev?.authType === input.authType ? prev : undefined
    const enc = (plain?: string, prevCipher?: string) => (plain ? (this.enc.available() ? this.enc.encrypt(plain) : plain) : prevCipher)
    const keyId = input.authType === 'key' ? (input.keyId !== undefined ? input.keyId || undefined : keep?.keyId) : undefined
    const isKey = input.authType === 'key' && !keyId
    const cfg: CredentialConfig = {
      id, name, username, authType: input.authType,
      ...(input.authType === 'password' ? { passwordCipher: enc(input.password, keep?.passwordCipher) } : {}),
      ...(isKey ? { privateKeyCipher: enc(input.privateKey, keep?.privateKeyCipher), passphraseCipher: enc(input.passphrase, keep?.passphraseCipher) } : {}),
      ...(keyId ? { keyId } : {}),
    }
    this.write(prev ? all.map((c) => (c.id === id ? cfg : c)) : [...all, cfg])
    return credentialSummaryOf(cfg)
  }

  /** 直接删（不查引用；引用保护由 HostStore.deleteCredential 做） */
  remove(id: string): void { this.write(this.read().filter((c) => c.id !== id)) }

  /** 仅主进程：解密出用户名 + 认证（应用密钥只给 keyId，由 HostStore 取私钥） */
  resolve(id: string): ResolvedAuth {
    const c = this.get(id)
    if (!c) throw new Error(`credential_not_found: ${tr('主机引用的凭据不存在（可能已删除），请编辑主机重新选择')}`)
    const isKey = c.authType === 'key' && !c.keyId
    return {
      username: c.username, authType: c.authType,
      ...(c.authType === 'password' ? { password: this.dec(c.passwordCipher, c.name) } : {}),
      ...(isKey ? { privateKey: this.dec(c.privateKeyCipher, c.name), passphrase: this.dec(c.passphraseCipher, c.name) } : {}),
      ...(c.authType === 'key' && c.keyId ? { keyId: c.keyId } : {}),
    }
  }

  private dec(cipher: string | undefined, name: string): string | undefined {
    if (!cipher) return undefined
    if (!this.enc.available()) return cipher
    try { return this.enc.decrypt(cipher) }
    catch { throw new Error(`credential_unreadable: ${tr('凭据「{name}」无法解密（系统密钥变化？），请重新编辑该凭据填写', { name })}`) }
  }
  read(): CredentialConfig[] { return readJson<CredentialConfig[]>(this.file) ?? [] }
  private write(v: CredentialConfig[]): void { writeJson(this.file, v) }
}

export function credentialSummaryOf(c: CredentialConfig): CredentialSummary {
  const hasSecret = c.authType === 'agent' || (c.authType === 'password' ? !!c.passwordCipher : !!(c.keyId || c.privateKeyCipher))
  return { id: c.id, name: c.name, username: c.username, authType: c.authType, ...(c.keyId ? { keyId: c.keyId } : {}), hasSecret }
}
