import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import type { HostConfig, CredentialConfig, KnownHost, UsagePrices, PromptTemplate, QuickCommandSet, InspectionSchedule, ConfigExportOpts, ConfigImportOpts, ConfigImportReport, ConfigPreview, ConfigSection, MergeMode } from '@lingshell/shared'
import { DEFAULT_SETTINGS, PROVIDERS, MODEL_PROFILE_ID_RE, protocolOf, checkWebhookUrl, checkAutoReplyPattern, normalizeQuickCommands, tr, type WebhookType } from '@lingshell/shared'
import { SettingsStore, profilesOf, sanitizeProfile, sanitizeSystem, type Encryptor, type KeySlot, type PersistedProfile, type PersistedSettings } from './SettingsStore.js'
import { HostStore } from './HostStore.js'
import { CredentialStore } from './CredentialStore.js'
import { QuickCommandStore } from './QuickCommandStore.js'
import { BUILTIN_TEMPLATES } from './TemplateStore.js'
import { hostPortOf } from './KnownHostsStore.js'
import { readJson, writeJson } from './jsonFile.js'
import { AutoReplyStore, DEFAULT_AUTO_REPLIES, type PersistedAutoReply } from './AutoReplyStore.js'
import { KnowledgeStore, legacyCardId } from './KnowledgeStore.js'
import { normalizeKnowledge, type KnowledgeCard } from '@lingshell/shared'
import { SecretStore, type PersistedSecret } from './SecretStore.js'

// 配置导出/导入：单个 JSON 文件。只读写 hosts(+credentials，随主机节)/known_hosts/templates/quick-commands/schedules/settings/webhooks/auto-replies 八个文件，
// 审计、命令历史、会话、布局、api.json、录像、日志一概不碰。
// 凭据只在设了导出密码时导出：主进程解密 → 打成一个 JSON → scrypt(密码, 随机盐) 派生密钥 AES-256-GCM 加密进 secrets。
// 导入时再用本机 Encryptor（safeStorage）重新加密落盘。

export const BUNDLE_FORMAT = 'lingshell-config'
export const BUNDLE_VERSION = 1

type Creds = { password?: string; privateKey?: string; passphrase?: string }
type Path = (string | number)[]
// 主机：去掉三个 *Cipher 字段；credentialsOmitted = 原本有凭据但这次没导出（导入后需重填）
export type BundleHost = Omit<HostConfig, 'passwordCipher' | 'privateKeyCipher' | 'passphraseCipher'> & { credentialsOmitted?: true }
// 命名凭据：随「主机」节一起导出，密文规则同主机（凭据明文在 secrets.credentials）
export type BundleCredential = Omit<CredentialConfig, 'passwordCipher' | 'privateKeyCipher' | 'passphraseCipher'> & { credentialsOmitted?: true }
// prices：用量统计的模型单价（有设过才导出）。profiles：全部模型配置（不含 key；keyOmitted = 原本有 key 但这次没导出）。
// 顶层 provider/model/baseUrl 是默认配置的镜像，旧版程序导入时只认它
export type BundleProfile = Omit<PersistedProfile, 'apiKeyCipher' | 'apiKeyPlain'> & { keyOmitted?: true }
interface ModelSection { provider: string; model: string; baseUrl: string; contextWindow?: number; prices?: UsagePrices; profiles?: BundleProfile[]; defaultProfileId?: string }
export interface SecretBox { salt: string; iv: string; tag: string; data: string }
// 加密前的明文：主机凭据按导出时的主机 id；API Key 按 provider（旧版）/ profileKeys 按模型配置 id；fields = 其它节里按键名识别出的机密（如 webhook secret）
interface Secrets { hosts: Record<string, Creds>; credentials?: Record<string, Creds>; apiKeys: Record<string, string>; profileKeys?: Record<string, string>; fields: { path: Path; value: string }[]; webhooks?: Record<string, { url: string; secret?: string }>; autoReplies?: Record<string, string>; vault?: Record<string, string> }
// 密钥保险箱：名称 / 说明 / 范围明文随文件走；值只在设了导出密码时进 secrets.vault，否则标 valueOmitted（导入后需「替换值」）
export type BundleSecret = Omit<PersistedSecret, 'valueCipher' | 'valuePlain'> & { valueOmitted?: true }
// 告警机器人：URL 本身带 token，整节只在设了导出密码时导出（地址/密钥在 secrets.webhooks 里）
export interface BundleWebhook { id: string; name: string; type: WebhookType; enabled: boolean }
interface PersistedWebhook extends BundleWebhook { urlHint: string; urlCipher?: string; urlPlain?: string; secretCipher?: string; secretPlain?: string }
// 自动应答：非密钥应答明文随文件走；密钥应答只在设了导出密码时进 secrets.autoReplies，否则标 responseOmitted（导入后停用待重填）
export type BundleAutoReply = Omit<PersistedAutoReply, 'responseCipher' | 'responsePlain'> & { responseOmitted?: true }

export interface ConfigBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exportedAt: string
  appVersion: string
  sections: {
    hosts?: BundleHost[]
    credentials?: BundleCredential[]
    knownHosts?: KnownHost[]
    templates?: PromptTemplate[]
    quickCommands?: QuickCommandSet[]
    schedules?: InspectionSchedule[]
    system?: Record<string, unknown>
    model?: ModelSection
    webhooks?: BundleWebhook[]
    autoReplies?: BundleAutoReply[]
    knowledge?: KnowledgeCard[]
    secrets?: BundleSecret[]
  }
  secrets?: SecretBox
}


// ── 密码加密 ────────────────────────────────────────────
const kdf = (password: string, salt: Buffer) => scryptSync(password, salt, 32)

export function sealSecrets(plain: string, password: string): SecretBox {
  const salt = randomBytes(16), iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', kdf(password, salt), iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function openSecrets(box: SecretBox, password: string): string {
  try {
    const d = createDecipheriv('aes-256-gcm', kdf(password, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'))
    d.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8')
  } catch { throw new Error(`wrong_password: ${tr('密码不正确（或文件已损坏），未导入任何内容')}`) }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strRec = (v: unknown): Record<string, string> => (isRec(v) ? Object.fromEntries(Object.entries(v).filter((x): x is [string, string] => typeof x[1] === 'string')) : {})
const credsOf = (v: unknown): Record<string, Creds> => {
  if (!isRec(v)) return {}
  const out: Record<string, Creds> = {}
  for (const [k, c] of Object.entries(v)) {
    if (!isRec(c)) continue
    const pick = (x: unknown) => (typeof x === 'string' ? x : undefined)
    out[k] = { password: pick(c.password), privateKey: pick(c.privateKey), passphrase: pick(c.passphrase) }
  }
  return out
}
/** 解出来的机密数据也当不可信：类型不对的字段丢掉，别让非字符串流到 encrypt / split 里 */
function normalizeSecrets(raw: unknown): Secrets {
  const o = isRec(raw) ? raw : {}
  const fields = Array.isArray(o.fields) ? o.fields.flatMap((f) => {
    if (!isRec(f) || !Array.isArray(f.path) || typeof f.value !== 'string') return []
    const path = f.path.filter((x): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isInteger(x) && x >= 0))
    // 不允许改原型链
    if (path.length !== f.path.length || path.some((x) => x === '__proto__' || x === 'constructor' || x === 'prototype')) return []
    return [{ path: path as Path, value: f.value }]
  }) : []
  return {
    hosts: credsOf(o.hosts), credentials: credsOf(o.credentials), apiKeys: strRec(o.apiKeys), profileKeys: strRec(o.profileKeys),
    fields, webhooks: isRec(o.webhooks) ? Object.fromEntries(Object.entries(o.webhooks).flatMap(([k, w]) => (isRec(w) && typeof w.url === 'string' ? [[k, { url: w.url, ...(typeof w.secret === 'string' ? { secret: w.secret } : {}) }]] : []))) : {},
    autoReplies: strRec(o.autoReplies), vault: strRec(o.vault),
  }
}

// ── 其它节里的机密字段（如以后的 webhook secret）：按键名识别，导出时从明文里摘掉 ──
const SECRET_KEY = /secret|password|passphrase|token|cipher|apikey/i
const isCipherKey = (k: string) => /cipher$/i.test(k)

function pullSecrets(v: unknown, path: Path, out: Secrets['fields'] | null, enc: Encryptor): void {
  if (!v || typeof v !== 'object') return
  const obj = v as Record<string, unknown>
  for (const [k, x] of Object.entries(obj)) {
    const key = Array.isArray(v) ? Number(k) : k
    // 旧版 system.webhooks 里整条 URL 就是凭据（带 token），即使键名叫 url 也要按机密处理
    const secretKey = typeof x === 'string' && (SECRET_KEY.test(k) || (k === 'url' && path.includes('webhooks')))
    if (!Array.isArray(v) && secretKey) {
      delete obj[k]
      if (!out || !x) continue
      try { out.push({ path: [...path, k], value: isCipherKey(k) && enc.available() ? enc.decrypt(x) : x }) } catch { /* 解密不了就不导出 */ }
    } else pullSecrets(x, [...path, key], out, enc)
  }
}

function putSecret(root: Record<string, unknown>, path: Path, value: string, enc: Encryptor): void {
  let cur: unknown = root
  for (const k of path.slice(0, -1)) {
    cur = (cur as Record<string | number, unknown>)[k]
    if (!cur || typeof cur !== 'object') return
  }
  const last = String(path[path.length - 1])
  ;(cur as Record<string, unknown>)[last] = isCipherKey(last) && enc.available() ? enc.encrypt(value) : value
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const files = (dir: string) => ({
  hosts: join(dir, 'hosts.json'), knownHosts: join(dir, 'known_hosts.json'), templates: join(dir, 'templates.json'),
  schedules: join(dir, 'schedules.json'), settings: join(dir, 'settings.json'), webhooks: join(dir, 'webhooks.json'),
})

// ── 导出 ────────────────────────────────────────────────
export function exportConfig(dir: string, enc: Encryptor, opts: ConfigExportOpts, appVersion: string, now = new Date()): ConfigBundle {
  const f = files(dir)
  const want = new Set(opts.sections)
  const withSecrets = !!opts.password
  const sec: Secrets = { hosts: {}, apiKeys: {}, fields: [] }
  const sections: ConfigBundle['sections'] = {}
  const dec = (c?: string) => (!c ? undefined : enc.available() ? enc.decrypt(c) : c)

  if (want.has('hosts')) {
    sections.hosts = (readJson<HostConfig[]>(f.hosts) ?? []).map((h) => {
      const { passwordCipher, privateKeyCipher, passphraseCipher, ...rest } = h
      const out: BundleHost = rest
      if (!passwordCipher && !privateKeyCipher) return out
      let creds: Creds | undefined
      if (withSecrets) {
        try { creds = { password: dec(passwordCipher), privateKey: dec(privateKeyCipher), passphrase: dec(passphraseCipher) } } catch { /* 本机解不开 → 视为未导出 */ }
      }
      if (creds) sec.hosts[h.id] = creds
      else out.credentialsOmitted = true
      return out
    })
    pullSecrets(sections.hosts, ['hosts'], withSecrets ? sec.fields : null, enc)   // 主机代理密码（proxy.passwordCipher）
    const creds = new CredentialStore(dir, enc).read()
    if (creds.length) {
      sec.credentials = {}
      sections.credentials = creds.map(({ passwordCipher, privateKeyCipher, passphraseCipher, ...rest }) => {
        const out: BundleCredential = rest
        if (!passwordCipher && !privateKeyCipher) return out
        let c: Creds | undefined
        if (withSecrets) {
          try { c = { password: dec(passwordCipher), privateKey: dec(privateKeyCipher), passphrase: dec(passphraseCipher) } } catch { /* 解不开 → 视为未导出 */ }
        }
        if (c) sec.credentials![rest.id] = c
        else out.credentialsOmitted = true
        return out
      })
    }
  }
  if (want.has('knownHosts')) sections.knownHosts = readJson<KnownHost[]>(f.knownHosts) ?? []
  if (want.has('templates')) sections.templates = readJson<PromptTemplate[]>(f.templates) ?? clone(BUILTIN_TEMPLATES)
  if (want.has('quickCommands')) sections.quickCommands = new QuickCommandStore(dir).get().sets
  if (want.has('schedules')) {
    sections.schedules = readJson<InspectionSchedule[]>(f.schedules) ?? []
    pullSecrets(sections.schedules, ['schedules'], withSecrets ? sec.fields : null, enc)
  }
  const p = readJson<PersistedSettings>(f.settings)
  if (want.has('system')) {
    sections.system = clone((p?.system ?? {}) as Record<string, unknown>)
    pullSecrets(sections.system, ['system'], withSecrets ? sec.fields : null, enc)
    // 旧版 system.webhooks 去掉机密后只剩空对象：不导出（带密码时由 secrets.fields 在导入时填回）
    const sys = sections.system
    if (!withSecrets && Array.isArray(sys.webhooks)) {
      const left = sys.webhooks.filter((x) => x && typeof x === 'object' && Object.keys(x as object).length)
      if (left.length) sys.webhooks = left; else delete sys.webhooks
    }
  }
  if (want.has('model')) {
    const prices = p?.usagePrices
    const { profiles, defaultProfileId } = profilesOf(p ?? null)
    const m = profiles.find((x) => x.id === defaultProfileId)!
    const store = new SettingsStore(dir, enc)
    const out: BundleProfile[] = profiles.map(({ apiKeyCipher, apiKeyPlain, ...rest }) => {
      if (!apiKeyCipher && !apiKeyPlain) return rest
      const k = withSecrets ? store.getProfileKey(rest.id) : ''
      if (k) (sec.profileKeys ??= {})[rest.id] = k
      return k ? rest : { ...rest, keyOmitted: true as const }
    })
    sections.model = {
      provider: m.provider, model: m.model, baseUrl: m.baseUrl, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(prices?.models?.length ? { prices } : {}),
      profiles: out, defaultProfileId,
    }
  }
  if (want.has('webhooks') && withSecrets) {
    sec.webhooks = {}
    sections.webhooks = []
    for (const w of readJson<PersistedWebhook[]>(f.webhooks) ?? []) {
      try {
        const url = dec(w.urlCipher) ?? w.urlPlain
        if (!url) continue
        sec.webhooks[w.id] = { url, secret: dec(w.secretCipher) ?? w.secretPlain }
        sections.webhooks.push({ id: w.id, name: w.name, type: w.type, enabled: w.enabled })
      } catch { /* 本机解不开就不导出这条 */ }
    }
  }
  if (want.has('autoReplies')) {
    const ar = new AutoReplyStore(dir, enc)
    const plain = new Map(withSecrets ? ar.resolveAll().map((r) => [r.id, r.response]) : [])
    sections.autoReplies = readJson<PersistedAutoReply[]>(ar.file)?.map(({ responseCipher: _c, responsePlain: _p, ...r }) => {
      if (!r.secret) return r
      const v = plain.get(r.id)
      if (v) (sec.autoReplies ??= {})[r.id] = v
      return v ? r : { ...r, responseOmitted: true as const }
    }) ?? []
  }
  if (want.has('knowledge')) sections.knowledge = new KnowledgeStore(dir).list()
  if (want.has('secrets')) {
    const vs = new SecretStore(dir, enc)
    sections.secrets = vs.read().map(({ valueCipher, valuePlain, ...rest }) => {
      const v = withSecrets ? vs.open({ valueCipher, valuePlain }) : undefined
      if (v) (sec.vault ??= {})[rest.id] = v
      return v ? rest : { ...rest, valueOmitted: true as const }
    })
  }
  const hasAny = Object.keys(sec.vault ?? {}).length + Object.keys(sec.profileKeys ?? {}).length + Object.keys(sec.credentials ?? {}).length + Object.keys(sec.autoReplies ?? {}).length + Object.keys(sec.webhooks ?? {}).length +Object.keys(sec.hosts).length + Object.keys(sec.apiKeys).length + sec.fields.length > 0
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now.toISOString(), appVersion, sections,
    ...(withSecrets && hasAny ? { secrets: sealSecrets(JSON.stringify(sec), opts.password!) } : {}),
  }
}

// ── 解析 / 预览 ─────────────────────────────────────────
export function parseBundle(text: string): ConfigBundle {
  let b: Partial<ConfigBundle>
  try { b = JSON.parse(text) as Partial<ConfigBundle> } catch { throw new Error(`invalid_file: ${tr('不是有效的 JSON 文件')}`) }
  if (!b || b.format !== BUNDLE_FORMAT || !b.sections || typeof b.sections !== 'object' || Array.isArray(b.sections)) throw new Error(`invalid_file: ${tr('不是灵壳配置文件')}`)
  if (typeof b.version !== 'number' || b.version > BUNDLE_VERSION) throw new Error(`unsupported_version: ${tr('配置文件版本 {version}，本程序只支持到 {max}，请升级后再导入', { version: String(b.version), max: BUNDLE_VERSION })}`)
  // 节的基本形状先查掉：坏文件在预览 / 导入里逐条读字段时不该抛出自定义错误以外的异常
  const arr = ['hosts', 'credentials', 'knownHosts', 'templates', 'quickCommands', 'schedules', 'webhooks', 'autoReplies', 'knowledge', 'secrets'] as const
  for (const k of arr) if (b.sections[k] !== undefined && !Array.isArray(b.sections[k])) throw new Error(`invalid_file: ${tr('配置文件的「{section}」节格式不对', { section: k })}`)
  for (const k of ['system', 'model'] as const) {
    const v = b.sections[k]
    if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) throw new Error(`invalid_file: ${tr('配置文件的「{section}」节格式不对', { section: k })}`)
  }
  return b as ConfigBundle
}

export function previewBundle(b: ConfigBundle): ConfigPreview {
  const s = b.sections
  const counts: Partial<Record<ConfigSection, number>> = {}
  for (const k of ['hosts', 'knownHosts', 'templates', 'quickCommands', 'schedules', 'webhooks', 'autoReplies', 'knowledge', 'secrets'] as const) if (Array.isArray(s[k])) counts[k] = s[k]!.length
  if (s.system) counts.system = 1
  if (s.model) counts.model = s.model.profiles?.length || 1
  // 带 ProxyCommand 的主机：导入后连接时会在本机执行这些命令，预览里逐条列出让用户确认
  const proxyCommands = (s.hosts ?? []).filter((h) => typeof h.proxyCommand === 'string' && h.proxyCommand.trim()).map((h) => ({ label: String(h.label), command: h.proxyCommand! }))
  return {
    exportedAt: b.exportedAt, appVersion: b.appVersion, counts, hasSecrets: !!b.secrets,
    credentialsOmitted: [...(s.hosts ?? []), ...(s.credentials ?? [])].filter((h) => h.credentialsOmitted).length,
    ...(proxyCommands.length ? { proxyCommands } : {}),
  }
}

// ── 导入 ────────────────────────────────────────────────
const hostKeyOf = (h: { host: string; port: number; username: string }) => `${hostPortOf(h.host, h.port)}|${h.username}`

/** 按 opts 选的节合并进 dir。密码错直接抛错（此前不写任何文件）；所有节算完后再统一落盘 */
export function importConfig(dir: string, enc: Encryptor, bundle: ConfigBundle, opts: ConfigImportOpts, now = new Date()): ConfigImportReport {
  const f = files(dir)
  let sec: Secrets | undefined
  if (bundle.secrets && opts.password) {
    let raw: unknown
    try { raw = JSON.parse(openSecrets(bundle.secrets, opts.password)) }
    catch (e) { throw (e as Error).message.startsWith('wrong_password') ? e : new Error(`invalid_file: ${tr('配置文件里的凭据数据已损坏')}`) }
    sec = normalizeSecrets(raw)
  }
  const s = clone(bundle.sections)
  if (sec) for (const { path, value } of sec.fields) putSecret(s as Record<string, unknown>, path, value, enc)
  const encS = (plain?: string) => (!plain ? undefined : enc.available() ? enc.encrypt(plain) : plain)
  const report: ConfigImportReport = {}
  const writes: [string, unknown][] = []

  // 主机：按 (host, port, username) 去重。idMap：文件里的 id → 本机 id（跳板与巡检目标都靠它重映射）
  // 文件里的主机先逐条校验（字段缺失 / 端口越界 / 带控制字符的直接跳过，别的节引用不到它时会自动丢弃引用）
  const hosts = readJson<HostConfig[]>(f.hosts) ?? []
  const validHosts: BundleHost[] = []
  let badHosts = 0
  for (const h of s.hosts ?? []) {
    const label = typeof h?.label === 'string' ? h.label.trim() : ''
    const host = typeof h?.host === 'string' ? h.host.trim() : ''
    // eslint-disable-next-line no-control-regex -- 与 HostStore.save 同一条规则
    if (!label || !host || /[\s\x00-\x1f]/.test(host) || !Number.isInteger(h.port) || h.port < 1 || h.port > 65535
      || (h.authType !== 'password' && h.authType !== 'key' && h.authType !== 'agent')) { badHosts++; continue }
    validHosts.push({ ...h, label, host })
  }
  const idMap = new Map<string, string>()
  for (const h of validHosts) { const ex = hosts.find((x) => hostKeyOf(x) === hostKeyOf(h)); if (ex) idMap.set(h.id, ex.id) }
  if (opts.hosts && s.hosts) {
    const r = { added: 0, updated: 0, skipped: badHosts, needCredentials: [] as string[] }
    // 凭据先导：按名称（不区分大小写）合并，credMap：文件里的凭据 id → 本机 id（同名已有的也映射过去）
    const credStore = new CredentialStore(dir, enc)
    const creds = credStore.read()
    const credMap = new Map<string, string>()
    const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    for (const c of s.credentials ?? []) {
      // 文件条目不可信：名称 / 用户名 / 认证方式不合法就跳过，别写进 credentials.json 让主机解析崩掉
      const name = typeof c?.name === 'string' ? c.name.trim() : ''
      const username = typeof c?.username === 'string' ? c.username.trim() : ''
      const authType = c?.authType
      if (!name || name.length > 80 || !username || (authType !== 'password' && authType !== 'key' && authType !== 'agent')) continue
      const ex = creds.find((x) => sameName(x.name, name))
      if (ex && opts.hosts === 'merge') { credMap.set(c.id, ex.id); continue }
      const id = ex?.id ?? randomUUID()
      credMap.set(c.id, id)
      // 应用密钥（keys.json）不随配置导出：keyId 一律去掉，按「需要重新填私钥」处理
      const { credentialsOmitted: _o, keyId: _k, ...rest } = c
      const v = sec?.credentials?.[c.id]
      const keep = !v && ex?.authType === authType ? ex : undefined
      const isPw = authType === 'password', isKey = authType === 'key'
      const cfg: CredentialConfig = {
        ...rest, id, name, username, authType,
        passwordCipher: isPw ? encS(v?.password) ?? keep?.passwordCipher : undefined,
        privateKeyCipher: isKey ? encS(v?.privateKey) ?? keep?.privateKeyCipher : undefined,
        passphraseCipher: isKey ? encS(v?.passphrase) ?? keep?.passphraseCipher : undefined,
      }
      if ((isPw && !cfg.passwordCipher) || (isKey && !cfg.privateKeyCipher)) r.needCredentials.push(tr('凭据「{name}」', { name: cfg.name }))
      if (ex) creds[creds.indexOf(ex)] = cfg; else creds.push(cfg)
    }
    if (s.credentials?.length) writes.push([credStore.file, creds])
    const written: { id: string; jump?: string }[] = []
    for (const h of validHosts) {
      const ex = hosts.find((x) => hostKeyOf(x) === hostKeyOf(h))
      if (ex && opts.hosts === 'merge') { r.skipped++; continue }
      const id = ex?.id ?? randomUUID()
      // 应用密钥不随配置导出：keyId 去掉，按需要重填私钥处理
      const { credentialsOmitted: _o, jumpHostId, credentialId: fileCred, keyId: _k, ...rest } = h
      // 引用的凭据：映射到本机；文件里没带这条凭据就去掉引用（按主机自身认证，需重填）
      const cred = fileCred ? creds.find((x) => x.id === (credMap.get(fileCred) ?? fileCred)) : undefined
      if (cred) {
        idMap.set(h.id, id)
        const cfg: HostConfig = { ...rest, id, username: cred.username, authType: cred.authType, credentialId: cred.id }
        if (ex) { hosts[hosts.indexOf(ex)] = cfg; r.updated++ } else { hosts.push(cfg); r.added++ }
        written.push({ id, jump: jumpHostId })
        continue
      }
      const username = typeof h.username === 'string' ? h.username.trim() : ''
      if (!username) { r.skipped++; continue }   // 没凭据又没用户名：连不上，跳过
      idMap.set(h.id, id)
      const c = sec?.hosts[h.id]
      // 覆盖但文件里没凭据：同认证方式时保留本机已有凭据
      const keep = !c && ex?.authType === h.authType ? ex : undefined
      const isPw = h.authType === 'password', isKey = h.authType === 'key'
      const cfg: HostConfig = {
        ...rest, id, username,
        passwordCipher: isPw ? encS(c?.password) ?? keep?.passwordCipher : undefined,
        privateKeyCipher: isKey ? encS(c?.privateKey) ?? keep?.privateKeyCipher : undefined,
        passphraseCipher: isKey ? encS(c?.passphrase) ?? keep?.passphraseCipher : undefined,
      }
      if ((isPw && !cfg.passwordCipher) || (isKey && !cfg.privateKeyCipher)) r.needCredentials.push(cfg.label)
      if (ex) { hosts[hosts.indexOf(ex)] = cfg; r.updated++ } else { hosts.push(cfg); r.added++ }
      written.push({ id, jump: jumpHostId })
    }
    // 跳板重映射：指向文件里的主机 → 换成本机 id；找不到或成环/超深就去掉跳板
    const check = new HostStore(dir, enc)
    for (const w of written) {
      const h = hosts.find((x) => x.id === w.id)!
      // ProxyCommand 与跳板机 / 单独代理互斥（HostStore.save 会拒绝）：导入时保留 ProxyCommand，去掉另两个
      if (h.proxyCommand) { delete h.jumpHostId; delete h.proxy; continue }
      h.jumpHostId = w.jump ? idMap.get(w.jump) : undefined
      if (!h.jumpHostId) { delete h.jumpHostId; continue }
      try { check.checkJump(h.jumpHostId, h.id, hosts) } catch { delete h.jumpHostId }
    }
    // 本机已有主机引用了被覆盖的凭据：同步用户名/认证方式快照
    for (const h of hosts) {
      const c = h.credentialId ? creds.find((x) => x.id === h.credentialId) : undefined
      if (c) { h.username = c.username; h.authType = c.authType }
    }
    writes.push([f.hosts, hosts])
    report.hosts = r
  }

  // 指纹：同 host:port 指纹不同不替换，报冲突
  if (opts.knownHosts && s.knownHosts) {
    const known = readJson<KnownHost[]>(f.knownHosts) ?? []
    const r = { added: 0, same: 0, conflicts: [] as { hostPort: string; existing: string; incoming: string }[] }
    for (const k of s.knownHosts) {
      // 坏条目跳过：没有 host:port / 指纹的写进去也不能用
      if (!k || typeof k !== 'object' || typeof k.hostPort !== 'string' || !k.hostPort.trim() || typeof k.fingerprint !== 'string' || !k.fingerprint.trim()) continue
      const kk: KnownHost = {
        hostPort: k.hostPort.trim(), fingerprint: k.fingerprint.trim(),
        keyType: typeof k.keyType === 'string' && k.keyType ? k.keyType : 'ssh-ed25519',
        firstSeen: typeof k.firstSeen === 'string' && k.firstSeen ? k.firstSeen : now.toISOString(),
      }
      const ex = known.find((x) => x.hostPort === kk.hostPort)
      if (!ex) { known.push(kk); r.added++ }
      else if (ex.fingerprint === kk.fingerprint) r.same++
      else r.conflicts.push({ hostPort: kk.hostPort, existing: ex.fingerprint, incoming: kk.fingerprint })
    }
    if (r.added) writes.push([f.knownHosts, known])
    report.knownHosts = r
  }

  // 按名称合并（模板 / 巡检共用）
  const byName = <T extends { id: string; name: string }>(cur: T[], incoming: T[], mode: MergeMode, make: (x: T, ex?: T) => T | undefined) => {
    const r = { added: 0, updated: 0, skipped: 0 }
    for (const x of incoming) {
      // 文件里的条目一律当不可信：没有合法 name 的直接跳过，别在 .trim() 上抛错把整次导入打断
      const name = x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name.trim() : ''
      if (!name) { r.skipped++; continue }
      const ex = cur.find((y) => y.name.trim() === name)
      if (ex && mode === 'merge') { r.skipped++; continue }
      const v = make(x, ex)
      if (!v) { r.skipped++; continue }
      if (ex) { cur[cur.indexOf(ex)] = v; r.updated++ } else { cur.push(v); r.added++ }
    }
    return r
  }
  // 告警机器人：按名合并；whMap 给巡检的 notifyWebhooks 重映射（同名已有的也映射过去）
  const localWh = readJson<PersistedWebhook[]>(f.webhooks) ?? []
  const whMap = new Map<string, string>()
  for (const w of s.webhooks ?? []) { const ex = localWh.find((y) => y.name.trim() === w.name.trim()); if (ex) whMap.set(w.id, ex.id) }
  if (opts.webhooks && s.webhooks) {
    const seal = (k: 'url' | 'secret', v?: string) => (!v ? {} : enc.available() ? { [`${k}Cipher`]: enc.encrypt(v) } : { [`${k}Plain`]: v })
    report.webhooks = byName(localWh, s.webhooks as PersistedWebhook[], opts.webhooks, (x, ex) => {
      const c = sec?.webhooks?.[x.id]
      if (!c?.url || checkWebhookUrl(c.url)) return undefined
      if (x.type !== 'dingtalk' && x.type !== 'wecom' && x.type !== 'feishu' && x.type !== 'generic') return undefined
      const id = ex?.id ?? `wh_${randomUUID().slice(0, 8)}`
      whMap.set(x.id, id)
      return { id, name: x.name.trim(), type: x.type, enabled: x.enabled !== false, urlHint: new URL(c.url).origin, ...seal('url', c.url), ...seal('secret', typeof c.secret === 'string' ? c.secret : undefined) } as PersistedWebhook
    })
    writes.push([f.webhooks, localWh])
  }
  // 自动应答：按名合并。作用主机按 idMap 重映射，本机找不到的去掉；密钥应答没带来时沿用本机同名规则的，否则停用待重填
  if (opts.autoReplies && s.autoReplies) {
    const ar = new AutoReplyStore(dir, enc)
    const cur = readJson<PersistedAutoReply[]>(ar.file) ?? clone(DEFAULT_AUTO_REPLIES)
    const localIds = new Set(hosts.map((h) => h.id))
    const needResponse: string[] = []
    const r = byName(cur, s.autoReplies, opts.autoReplies, (x, ex) => {
      if (typeof x.pattern !== 'string' || checkAutoReplyPattern(x.pattern, !!x.regex)) return undefined
      const { responseOmitted: _o, ...rest } = x as BundleAutoReply
      const scope = x.scope === 'all' ? 'all' : (Array.isArray(x.scope) ? x.scope : []).flatMap((t) => { const id = t === 'local' ? t : idMap.get(t) ?? (localIds.has(t) ? t : undefined); return id ? [id] : [] })
      const secret = x.secret === true
      const v: PersistedAutoReply = {
        ...rest, name: x.name.trim(), scope, id: ex?.id ?? `ar_${randomUUID().slice(0, 8)}`, enabled: x.enabled !== false,
        response: secret ? undefined : typeof x.response === 'string' ? x.response : '',
      }
      if (!secret) return v
      const c = sec?.autoReplies?.[x.id]
      if (c) Object.assign(v, enc.available() ? { responseCipher: enc.encrypt(c) } : { responsePlain: c })
      else if (ex?.secret && (ex.responseCipher || ex.responsePlain)) Object.assign(v, { responseCipher: ex.responseCipher, responsePlain: ex.responsePlain })
      else { v.enabled = false; needResponse.push(x.name) }
      return v
    })
    report.autoReplies = { ...r, needResponse }
    writes.push([ar.file, cur])
  }
  if (opts.templates && s.templates) {
    const cur = readJson<PromptTemplate[]>(f.templates) ?? clone(BUILTIN_TEMPLATES)
    report.templates = byName(cur, s.templates, opts.templates, (x, ex) => (typeof x.prompt === 'string'
      ? { id: ex?.id ?? `tpl_${randomUUID().slice(0, 8)}`, name: x.name.trim(), prompt: x.prompt }
      : undefined))
    writes.push([f.templates, cur])
  }
  // 快速命令：按命令组名合并；当前组 / 显示开关保留本机。落盘前整份规整（坏数据直接抛错，不写任何文件）
  if (opts.quickCommands && s.quickCommands) {
    const qs = new QuickCommandStore(dir)
    const cur = qs.get()
    report.quickCommands = byName(cur.sets, s.quickCommands, opts.quickCommands, (x, ex) => ({ ...x, id: ex?.id ?? '' }))
    writes.push([qs.file, normalizeQuickCommands(cur)])
  }
  if (opts.schedules && s.schedules) {
    const cur = readJson<InspectionSchedule[]>(f.schedules) ?? []
    const localIds = new Set(hosts.map((h) => h.id))
    let droppedTargets = 0
    const r = byName(cur, s.schedules, opts.schedules, (x, ex) => {
      // 坏调度会让主进程的 tick 直接抛错（when 不是对象 / 目标不是数组），先拦掉
      const when = x?.when
      const whenOk = !!when && typeof when === 'object' && ((when.kind === 'interval' && Number.isFinite(when.hours) && when.hours >= 1)
        || (when.kind === 'daily' && typeof when.time === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(when.time)))
      if (!whenOk || typeof x.prompt !== 'string' || !Array.isArray(x.targets) || !x.targets.every((t) => typeof t === 'string')) return undefined
      const targets = x.targets.flatMap((t) => {
        const id = t === 'local' ? t : idMap.get(t) ?? (localIds.has(t) ? t : undefined)
        if (!id) droppedTargets++
        return id ? [id] : []
      })
      if (!targets.length) return undefined
      // 新导入的从现在起算周期（lastRunAt 去掉），免得一导入就把所有巡检跑一遍
      const { lastRunAt: _l, notifyWebhooks: nw, notifyOn, ...rest } = x
      // 推送目标重映射；找不到的机器人去掉（不设 = 所有启用的，保持不设）
      const notify = nw ? { notifyWebhooks: nw.flatMap((id) => whMap.get(id) ?? (localWh.some((w) => w.id === id) ? [id] : [])) } : {}
      const extra = { ...rest, name: x.name.trim(), ...notify, ...(notifyOn === 'always' || notifyOn === 'problem' ? { notifyOn } : {}), enabled: x.enabled !== false, when, targets }
      return ex ? { ...extra, id: ex.id, createdAt: ex.createdAt, lastRunAt: ex.lastRunAt }
        : { ...extra, id: `sch_${randomUUID().slice(0, 8)}`, createdAt: now.toISOString() }
    })
    report.schedules = { ...r, droppedTargets }
    writes.push([f.schedules, cur])
  }
  // 知识库：按卡片 id 合并；主机卡的主机按 idMap 重映射（本机 / 'local' 照留），找不到的丢弃；不合法的卡跳过
  if (opts.knowledge && s.knowledge) {
    const ks = new KnowledgeStore(dir)
    const cur = ks.list()
    const localIds = new Set(hosts.map((h) => h.id))
    const r = { added: 0, updated: 0, skipped: 0, dropped: 0 }
    for (const x of s.knowledge) {
      let target: string | undefined = x?.target
      if (x?.scope === 'host') {
        target = target === 'local' ? target : idMap.get(target) ?? (localIds.has(target) ? target : undefined)
        if (!target) { r.dropped++; continue }
      }
      let card: KnowledgeCard
      try {
        const id = String(x.id ?? '').startsWith('kb_note_') && target ? legacyCardId(target) : String(x.id || `kb_${randomUUID().slice(0, 8)}`)
        card = { ...normalizeKnowledge({ ...x, target: target ?? '' }), id, updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : now.toISOString() } as KnowledgeCard
      } catch { r.skipped++; continue }
      const i = cur.findIndex((c) => c.id === card.id)
      if (i >= 0 && opts.knowledge === 'merge') { r.skipped++; continue }
      if (i >= 0) { cur[i] = card; r.updated++ } else { cur.push(card); r.added++ }
    }
    report.knowledge = r
    writes.push([ks.file, { ...(readJson<object>(ks.file) ?? {}), cards: cur }])
  }

  // 密钥保险箱：按名称合并。指定主机按 idMap 重映射（本机找不到的去掉）；值没带来时沿用本机同名的，否则留空待「替换值」
  if (opts.secrets && s.secrets) {
    const vs = new SecretStore(dir, enc)
    const cur = vs.read()
    const localIds = new Set(hosts.map((h) => h.id))
    const needValue: string[] = []
    const r = { added: 0, updated: 0, skipped: 0 }
    for (const x of s.secrets) {
      const name = String(x?.name ?? '').trim()
      if (!/^[a-z0-9_-]{1,64}$/.test(name) || !['all', 'local', 'group', 'hosts'].includes(x.scope)) { r.skipped++; continue }
      const ex = cur.find((y) => y.name === name)
      if (ex && opts.secrets === 'merge') { r.skipped++; continue }
      const targets = (Array.isArray(x.targets) ? x.targets : []).flatMap((t) => {
        if (x.scope !== 'hosts') return [String(t)]
        const id = t === 'local' ? t : idMap.get(t) ?? (localIds.has(t) ? t : undefined)
        return id ? [id] : []
      })
      const v = sec?.vault?.[x.id]
      const at = now.toISOString()
      const item: PersistedSecret = {
        id: ex?.id ?? `sec_${randomUUID().slice(0, 8)}`, name, description: String(x.description ?? '').slice(0, 200), scope: x.scope, targets,
        createdAt: ex?.createdAt ?? (typeof x.createdAt === 'string' ? x.createdAt : at), updatedAt: at,
        ...(v ? vs.seal(v) : { valueCipher: ex?.valueCipher, valuePlain: ex?.valuePlain }),
      }
      if (!item.valueCipher && !item.valuePlain) needValue.push(name)
      if (ex) { cur[cur.indexOf(ex)] = item; r.updated++ } else { cur.push(item); r.added++ }
    }
    report.secrets = { ...r, needValue }
    writes.push([vs.file, cur])
  }

  // 设置：整节替换（UI 已让用户确认）
  if ((opts.system && s.system) || (opts.model && s.model)) {
    const p: PersistedSettings = readJson<PersistedSettings>(f.settings) ?? { provider: DEFAULT_SETTINGS.provider, model: DEFAULT_SETTINGS.model, baseUrl: DEFAULT_SETTINGS.baseUrl }
    if (opts.system && s.system) { p.system = sanitizeSystem(s.system); report.system = true }
    if (opts.model && s.model) {
      const m = s.model
      // 单价：文件里带了才替换（旧版导出的没有这项，保留本机的）
      const pr = m.prices
      if (pr && Array.isArray(pr.models)) p.usagePrices = { currency: pr.currency === 'USD' ? 'USD' : 'CNY', models: pr.models }
      // 模型配置整表替换。旧版文件只有一套 + 按 provider 的 key：按老配置迁移规则换算成配置表（key 明文暂放 apiKeyPlain）
      const incoming: (BundleProfile & { key?: string })[] = m.profiles
        ? m.profiles.map((x) => ({ ...x, key: sec?.profileKeys?.[x.id] }))
        : profilesOf({
          provider: m.provider, model: m.model, baseUrl: m.baseUrl, contextWindow: m.contextWindow, apiKeyPlain: sec?.apiKeys?.deepseek,
          keys: Object.fromEntries(Object.entries(sec?.apiKeys ?? {}).filter(([k]) => k !== 'deepseek').map(([k, v]) => [k, { apiKeyPlain: v }])),
        }).profiles.map(({ apiKeyPlain, apiKeyCipher: _c, ...x }) => ({ ...x, key: apiKeyPlain }))
      const local = profilesOf(p).profiles
      const seen = new Set<string>()
      let n = 0
      const profiles: PersistedProfile[] = []
      for (const { key, keyOmitted: _o, protocol, multimodal, ...x } of incoming) {
        if (!MODEL_PROFILE_ID_RE.test(String(x.id)) || seen.has(x.id) || !PROVIDERS.some((v) => v.id === x.provider)) continue
        seen.add(x.id)
        // 没带 key：本机同 id 同提供商的配置有 key 就沿用
        const old = local.find((o) => o.id === x.id && o.provider === x.provider)
        const slot: KeySlot = key ? (enc.available() ? { apiKeyCipher: enc.encrypt(key) } : { apiKeyPlain: key }) : { apiKeyCipher: old?.apiKeyCipher, apiKeyPlain: old?.apiKeyPlain }
        if (key) n++
        // 接口协议：只有 DeepSeek 带（旧文件没有 = anthropic），非法值规整
        // 支持图片：只认布尔值（旧文件没有 = 按模型名猜）
        // 缺 model / baseUrl / name 的旧文件记录补默认值；认不出的整条丢弃（别写进磁盘把设置页读崩）
        const norm = sanitizeProfile({ ...x, ...(x.provider === 'deepseek' ? { protocol: protocolOf(x.provider, protocol) } : {}), ...(typeof multimodal === 'boolean' ? { multimodal } : {}), ...slot })
        if (norm) profiles.push(norm)
      }
      if (profiles.length) {
        const def = profiles.find((x) => x.id === (m.profiles ? m.defaultProfileId : 'default')) ?? profiles[0]
        delete p.apiKeyCipher; delete p.apiKeyPlain; delete p.keys
        Object.assign(p, { provider: def.provider, model: def.model, baseUrl: def.baseUrl, contextWindow: def.contextWindow, profiles, defaultProfileId: def.id })
        report.model = true
        report.apiKeys = n
      }
    }
    writes.push([f.settings, p])
  }

  for (const [file, data] of writes) writeJson(file, data)
  return report
}
