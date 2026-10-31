// 应用管理的 SSH 密钥：生成（ed25519 / rsa-4096）、导入已有私钥、导出、删除；私钥（及口令）经 safeStorage 加密存 keys.json，
// 只在主进程解密（连接时由 HostStore.appKey 取用），渲染层只拿公钥/指纹。
// 「部署公钥」：用该主机现有认证临时连上，经独立 exec 通道幂等追加到 ~/.ssh/authorized_keys；
// 「切换为此密钥」：先只用这把密钥测试连接，通过才改主机认证。
import ssh2 from 'ssh2'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readJson, writeJson, type Encryptor, type HostStore } from '@lingshell/config'
import type { KeyDeployResult, SshConnectOpts, SshKeyGenType, SshKeySummary } from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'

const { utils } = ssh2 as unknown as { utils: typeof import('ssh2').utils }
type Parsed = import('ssh2').ParsedKey

interface KeyRecord extends Omit<SshKeySummary, 'hasPassphrase'> {
  privateKeyCipher: string
  passphraseCipher?: string
}

/** 解析私钥 → 类型/公钥行/指纹。带口令没给 → passphrase_required；口令错 → passphrase_wrong */
export function keyInfo(privateKey: string, comment: string, passphrase?: string): Pick<SshKeySummary, 'type' | 'publicKey' | 'fingerprint'> {
  const r = utils.parseKey(privateKey, passphrase || undefined)
  if (r instanceof Error) {
    if (/no passphrase/i.test(r.message)) throw new Error(`passphrase_required: ${tr('该私钥有口令，请填写口令')}`)
    throw new Error(passphrase ? `passphrase_wrong: ${tr('口令错误，或私钥格式不支持')}` : `invalid_key: ${tr('无法识别的私钥（{err}）', { err: r.message })}`)
  }
  const k: Parsed = Array.isArray(r) ? r[0] : r
  if (!k?.isPrivateKey()) throw new Error(`invalid_key: ${tr('这是公钥，请选择私钥文件')}`)
  const blob = k.getPublicSSH()
  return {
    type: typeLabel(k),
    publicKey: `${k.type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    fingerprint: fingerprintOf(blob),
  }
}

/** OpenSSH 风格指纹：SHA256:<base64 无填充> */
export const fingerprintOf = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')

function typeLabel(k: Parsed): string {
  if (k.type === 'ssh-ed25519') return 'ED25519'
  if (k.type === 'ssh-rsa') {
    try { return `RSA-${createPublicKey(k.getPublicPEM()).asymmetricKeyDetails?.modulusLength ?? ''}`.replace(/-$/, '') } catch { return 'RSA' }
  }
  const ec = /^ecdsa-sha2-nistp(\d+)$/.exec(k.type)
  return ec ? `ECDSA-${ec[1]}` : k.type
}

/** 公钥注释：只留安全字符（部署命令里要引用），空则 lingshell */
export const keyComment = (name: string) => name.replace(/[^\w.@-]+/g, '-').replace(/^-+|-+$/g, '') || 'lingshell'

export class KeyStore {
  private file: string
  constructor(dir: string, private enc: Encryptor) { this.file = join(dir, 'keys.json') }

  list(): SshKeySummary[] { return this.read().map(summaryOf) }
  get(id: string): SshKeySummary { return summaryOf(this.find(id)) }

  async generate(name: string, type: SshKeyGenType, passphrase?: string): Promise<SshKeySummary> {
    const n = cleanName(name)
    const comment = keyComment(n)
    const opts = { comment, ...(type === 'rsa' ? { bits: 4096 } : {}), ...(passphrase ? { passphrase, cipher: 'aes256-ctr' } : {}) }
    const pair = await new Promise<{ private: string }>((res, rej) =>
      utils.generateKeyPair(type, opts as { bits: number }, (e, k) => (e ? rej(e) : res(k))))   // rsa-4096 要几百毫秒到几秒，异步不卡主进程
    return this.add(n, pair.private, comment, passphrase)
  }

  /** 导入私钥文本（OpenSSH / PEM / PuTTY .ppk） */
  importKey(name: string, privateKey: string, passphrase?: string): SshKeySummary {
    const n = cleanName(name)
    return this.add(n, privateKey, keyComment(n), passphrase)
  }

  delete(id: string): void { this.write(this.read().filter((k) => k.id !== id)) }

  /** 连接用：明文私钥 + 口令（仅主进程） */
  resolve(id: string): { privateKey: string; passphrase?: string } {
    const k = this.find(id)
    return { privateKey: this.dec(k.privateKeyCipher), passphrase: k.passphraseCipher ? this.dec(k.passphraseCipher) : undefined }
  }

  private add(name: string, privateKey: string, comment: string, passphrase?: string): SshKeySummary {
    const info = keyInfo(privateKey, comment, passphrase)   // 顺带校验口令
    const all = this.read()
    const dup = all.find((k) => k.fingerprint === info.fingerprint)
    if (dup) throw new Error(`key_exists: ${tr('这把密钥已在列表里（{name}）', { name: dup.name })}`)
    const rec: KeyRecord = {
      id: randomUUID(), name, ...info, createdAt: new Date().toISOString(),
      privateKeyCipher: this.encS(privateKey), ...(passphrase ? { passphraseCipher: this.encS(passphrase) } : {}),
    }
    this.write([...all, rec])
    return summaryOf(rec)
  }
  private find(id: string): KeyRecord {
    const k = this.read().find((x) => x.id === id)
    if (!k) throw new Error(`key_not_found: ${tr('应用密钥不存在（可能已删除），请编辑主机重新选择')}`)
    return k
  }
  private encS(s: string) { return this.enc.available() ? this.enc.encrypt(s) : s }
  private dec(c: string) {
    if (!this.enc.available()) return c
    try { return this.enc.decrypt(c) } catch { throw new Error(`credential_unreadable: ${tr('密钥无法解密（系统密钥变化？），请删除后重新导入')}`) }
  }
  private read(): KeyRecord[] { return readJson<KeyRecord[]>(this.file) ?? [] }
  private write(v: KeyRecord[]) { writeJson(this.file, v) }
}

function summaryOf({ privateKeyCipher: _p, passphraseCipher, ...k }: KeyRecord): SshKeySummary {
  return { ...k, hasPassphrase: !!passphraseCipher }
}
function cleanName(name: string): string {
  const n = String(name ?? '').trim().slice(0, 80)
  if (!n) throw new Error(tr('请填写密钥名称'))
  return n
}

// ── 部署公钥 ─────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const PUB_RE = /^[a-z0-9-]+ [A-Za-z0-9+/=]+( [\w.@-]+)?$/

/** 幂等追加公钥的命令：建 ~/.ssh（700）与 authorized_keys（600），已有同一把（按 类型+base64 比对，不看注释）不重复追加；
 *  文件末尾缺换行先补。脚本单行、整体交给 sh -c（登录 shell 是 fish/csh 也能跑） */
export function authorizedKeysCommand(publicKey: string): string {
  if (!PUB_RE.test(publicKey)) throw new Error('invalid_public_key')
  const [type, b64] = publicKey.split(' ')
  const script = [
    'set -e', 'umask 077', 'd="$HOME/.ssh"', 'f="$d/authorized_keys"',
    'mkdir -p "$d"', 'chmod 700 "$d"', 'touch "$f"', 'chmod 600 "$f"',
    `if grep -qF ${q(`${type} ${b64}`)} "$f"; then echo LINGSHELL_KEY_EXISTS; else`
      + ` if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi;`
      + ` printf '%s\\n' ${q(publicKey)} >> "$f"; echo LINGSHELL_KEY_ADDED; fi`,
    'if command -v restorecon >/dev/null 2>&1; then restorecon -R "$d" >/dev/null 2>&1 || true; fi',   // SELinux 上下文
  ].join('; ')
  return `sh -c ${q(script)}`
}

export function parseDeployOutput(code: number | null, output: string): KeyDeployResult {
  if (code === 0 && output.includes('LINGSHELL_KEY_ADDED')) return { added: true }
  if (code === 0 && output.includes('LINGSHELL_KEY_EXISTS')) return { added: false }
  throw new Error(tr('部署失败（退出码 {code}）：{out}', { code: code ?? tr('rc|无'), out: output.trim().slice(-500) || tr('无输出') }))
}

/** 只用这把密钥认证的连接参数（去掉密码 / agent，测试才有意义） */
export function withOnlyKey(o: SshConnectOpts, k: { privateKey: string; passphrase?: string }): SshConnectOpts {
  const { password: _p, agent: _a, agentForward: _f, loginCommands: _l, ...rest } = o
  return { ...rest, privateKey: k.privateKey, passphrase: k.passphrase }
}

// ── IPC ─────────────────────────────────────────────

export interface SshKeysIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  keys: KeyStore
  hosts: Pick<HostStore, 'list' | 'save' | 'resolveConnectOpts' | 'credentials'>
  pickFile(): Promise<string | undefined>
  saveFile(defaultName: string, content: string): Promise<string | undefined>
  /** 临时连上跑一条命令，跑完断开 */
  exec(o: SshConnectOpts, command: string): Promise<{ code: number | null; output: string }>
  test(o: SshConnectOpts): Promise<void>
  audit(hostId: string, title: string, command: string, exitCode: number | null): void
}

// msg 是 tk() 标过的完整报错，抛出时再翻译
const str = (v: unknown, msg: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr(msg)); return v }

export function registerSshKeys(d: SshKeysIpcDeps): void {
  let picked: string | undefined   // 导入的私钥文件路径只留在主进程
  const hostOf = (id: string) => {
    const h = d.hosts.list().find((x) => x.id === id)
    if (!h) throw new Error(`host_not_found: ${tr('主机不存在')}`)
    return h
  }
  d.handle('keys:list', () => d.keys.list())
  d.handle('keys:generate', (_e, name, type, pp) => d.keys.generate(str(name, tk('非法的名称')), type === 'rsa' ? 'rsa' : 'ed25519', typeof pp === 'string' && pp ? pp : undefined))
  d.handle('keys:pickImport', async () => {
    const p = await d.pickFile()
    if (!p) return undefined
    const text = await readFile(p, 'utf8')
    if (!/PRIVATE KEY-----|^PuTTY-User-Key-File/m.test(text)) throw new Error(tr('不是私钥文件（应为 OpenSSH / PEM / PuTTY .ppk 私钥）'))
    picked = p
    let needPassphrase = false
    try { keyInfo(text, '') } catch (e) { needPassphrase = /passphrase_required/.test(String(e)) ; if (!needPassphrase) throw e }
    return { fileName: basename(p), needPassphrase }
  })
  d.handle('keys:importPicked', async (_e, name, pp) => {
    if (!picked) throw new Error(tr('请先选择私钥文件'))
    const r = d.keys.importKey(str(name, tk('非法的名称')), await readFile(picked, 'utf8'), typeof pp === 'string' && pp ? pp : undefined)
    picked = undefined
    return r
  })
  d.handle('keys:delete', (_e, id) => {
    const user = d.hosts.list().find((h) => h.keyId === id)
    if (user) throw new Error(`key_in_use: ${tr('主机「{name}」正在使用这把密钥，请先改该主机的认证方式', { name: user.label })}`)
    const cred = d.hosts.credentials.list().find((c) => c.keyId === id)
    if (cred) throw new Error(`key_in_use: ${tr('凭据「{name}」正在使用这把密钥，请先改该凭据的认证方式', { name: cred.name })}`)
    d.keys.delete(str(id, tk('非法的密钥')))
  })
  d.handle('keys:export', async (_e, id, which) => {
    const k = d.keys.get(str(id, tk('非法的密钥')))
    const base = keyComment(k.name)
    return which === 'private'
      ? d.saveFile(base, d.keys.resolve(k.id).privateKey)
      : d.saveFile(`${base}.pub`, k.publicKey + '\n')
  })
  d.handle('keys:deploy', async (_e, id, hostId) => {
    const k = d.keys.get(str(id, tk('非法的密钥'))), h = hostOf(str(hostId, tk('非法的主机')))
    const command = authorizedKeysCommand(k.publicKey)
    const r = await d.exec(d.hosts.resolveConnectOpts(h.id), command)
    d.audit(h.id, h.label, `部署公钥「${k.name}」（${k.fingerprint}）到 ~/.ssh/authorized_keys`, r.code)   // i18n-ignore 执行记录原文
    return parseDeployOutput(r.code, r.output)
  })
  d.handle('keys:useForHost', async (_e, id, hostId) => {
    const k = d.keys.get(str(id, tk('非法的密钥'))), h = hostOf(str(hostId, tk('非法的主机')))
    try { await d.test(withOnlyKey(d.hosts.resolveConnectOpts(h.id), d.keys.resolve(k.id))) }
    catch (e) { throw new Error(tr('用该密钥连接失败，未切换：{err}', { err: e instanceof Error ? e.message : String(e) })) }
    d.hosts.save({ ...h, authType: 'key', keyId: k.id, credentialId: '' })   // 改为本主机自己的密钥认证（不再用凭据）
  })
}
