import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { MAX_JUMP_DEPTH, SSH_ADVANCED_DEFAULTS, tr, cleanTermType, isLegacyEncoding, planHostBatch, type HostBatchPatch, type HostBatchItem, type HostBatchUndoInfo, type HostBatchField, type SshAdvanced, type HostConfig, type HostSummary, type HostInput, type SshConnectOpts, type ProxyConfig, type ProxyInput, type ProxyOpts, type ProxySummary, type CredentialInput, type CredentialSummary } from '@lingshell/shared'
import type { Encryptor } from './SettingsStore.js'
import { readJson, writeJson } from './jsonFile.js'
import { detectSshAgent, requireSshAgent } from './sshAgent.js'
import { CredentialStore, type ResolvedAuth } from './CredentialStore.js'

// 上次批量修改的撤销记录（hosts-batch-undo.json）：每台改动前的字段值，null = 原本没有该字段
interface BatchUndo { at: string; backup: string; before: { id: string; values: Partial<Record<HostBatchField, string | number | null>> }[] }

// 主机配置持久化：hosts.json。凭据字段（密码/私钥/passphrase）字段级加密，
// host/port/user/label 明文（列表展示用）。凭据明文绝不经 IPC 回渲染层。
export class HostStore {
  private filePath: string
  /** 命名凭据（credentials.json）：主机可引用（credentialId），连接时解析 */
  readonly credentials: CredentialStore
  // detectAgent：authType=agent 的主机连接时现查系统 agent（测试注入）
  constructor(private dir: string, private enc: Encryptor, private detectAgent = detectSshAgent) {
    this.filePath = join(dir, 'hosts.json')
    this.credentials = new CredentialStore(dir, enc)
  }
  /** 应用密钥解析（主进程注入 KeyStore.resolve）：keyId → 明文私钥/口令 */
  appKey?: (keyId: string) => { privateKey: string; passphrase?: string }

  // 引用凭据的主机：用户名/认证方式以凭据为准（快照可能落后于凭据文件）
  list(): HostSummary[] {
    const creds = new Map(this.credentials.read().map((c) => [c.id, c]))
    return this.read().map((h) => {
      const c = h.credentialId ? creds.get(h.credentialId) : undefined
      return summaryOf(c ? { ...h, username: c.username, authType: c.authType } : h)
    })
  }

  /** 备注末尾追加一段（AI 提议经用户确认后调用） */
  appendNote(id: string, text: string): void {
    const all = this.read()
    const h = all.find((x) => x.id === id)
    if (!h) throw new Error('host_not_found')
    h.notes = appendNoteText(h.notes, text)
    this.write(all)
  }

  save(input: HostInput): HostSummary {
    const all = this.read()
    const id = input.id ?? randomUUID()
    const prev = all.find((h) => h.id === id)
    if (input.jumpHostId) this.checkJump(input.jumpHostId, id, all)
    // 基础字段校验：表单 / 导入 / 批量修改都走这里，避免存出连不上的主机（端口 Infinity / 22.5、空地址等）
    const label = String(input.label ?? '').trim()
    const host = String(input.host ?? '').trim()
    const port = input.port
    if (!label) throw new Error(`label_required: ${tr('请填写主机名称')}`)
    if (!host) throw new Error(`host_required: ${tr('请填写主机地址')}`)
    // eslint-disable-next-line no-control-regex -- 就是要拒绝控制字符
    if (/[\s\x00-\x1f]/.test(host)) throw new Error(`host_invalid: ${tr('主机地址不能含空格或控制字符')}`)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port_invalid: ${tr('端口要是 1–65535 的整数')}`)
    // 凭据：未传沿用、'' = 不用。用凭据时本条不存任何凭据密文，用户名/认证方式存凭据的快照
    const credentialId = input.credentialId !== undefined ? input.credentialId || undefined : prev?.credentialId
    const cred = credentialId ? this.credentials.get(credentialId) : undefined
    if (credentialId && !cred) throw new Error(`credential_not_found: ${tr('凭据不存在（可能已删除），请重新选择')}`)
    const enc =(plain?: string, prevCipher?: string): string | undefined => {
      if (plain == null || plain === '') return prevCipher
      return this.enc.available() ? this.enc.encrypt(plain) : plain
    }
    // 只存当前 authType 的凭据：切换类型时清掉另一类旧密文；空值沿用旧值仅限同一 authType
    const keep = prev?.authType === input.authType ? prev : undefined
    const isPw = input.authType === 'password'   // agent：不存凭据
    // 应用密钥：未传沿用旧值，'' = 改回粘贴私钥。用应用密钥时本条不存私钥（在 keys.json）
    const keyId = input.authType === 'key' ? (input.keyId !== undefined ? input.keyId || undefined : keep?.keyId) : undefined
    const isKey = input.authType === 'key' && !keyId
    const cfg: HostConfig = {
      id, label, host, port, username: String(input.username ?? '').trim(), authType: input.authType,
      passwordCipher: isPw ? enc(input.password, keep?.passwordCipher) : undefined,
      privateKeyCipher: isKey ? enc(input.privateKey, keep?.privateKeyCipher) : undefined,
      passphraseCipher: isKey ? enc(input.passphrase, keep?.passphraseCipher) : undefined,
      keyId,
      jumpHostId: input.jumpHostId || undefined,
      // 备注/分级：未传（老调用方）沿用旧值；传空串即清空（IPC 会丢掉值为 undefined 的键，所以清空用 ''）
      notes: (input.notes ?? prev?.notes)?.trim() || undefined,
      env: input.env !== undefined ? input.env || undefined : prev?.env,
      group: (input.group ?? prev?.group)?.trim() || undefined,
      encoding: legacyOrUndef(input.encoding !== undefined ? input.encoding : prev?.encoding),   // utf8 不存
      persistSession: (input.persistSession ?? prev?.persistSession) || undefined,   // 关 = 不存
      loginCommands: (input.loginCommands ?? prev?.loginCommands)?.trim() || undefined,
      agentForward: (input.agentForward ?? prev?.agentForward) || undefined,
      advanced: cleanAdvanced(input.advanced !== undefined ? input.advanced : prev?.advanced),
      // 代理：未传沿用；'default' = 跟随全局（不存）
      proxy: input.proxy === undefined ? prev?.proxy : input.proxy === 'default' ? undefined : input.proxy === 'none' ? 'none' : this.proxyCfg(input.proxy, prev?.proxy),
      // ProxyCommand：未传沿用、'' 清空。与跳板机 / 单独设置的出站代理互斥（全局默认代理对它不生效）
      proxyCommand: (input.proxyCommand ?? prev?.proxyCommand)?.trim() || undefined,
    }
    if (cfg.proxyCommand && cfg.jumpHostId) throw new Error(`proxy_command_conflict: ${tr('ProxyCommand 与跳板机不能同时使用，请二选一')}`)
    if (cfg.proxyCommand && cfg.proxy && cfg.proxy !== 'none') throw new Error(`proxy_command_conflict: ${tr('ProxyCommand 与单独设置的出站代理不能同时使用，请把出站代理改回「跟随全局默认」或「不使用」')}`)
    if (!cred && !cfg.username) throw new Error(`username_required: ${tr('请填写用户名，或在「认证方式」里选择凭据')}`)
    if (cred) Object.assign(cfg, { username: cred.username, authType: cred.authType, passwordCipher: undefined, privateKeyCipher: undefined, passphraseCipher: undefined, keyId: undefined, credentialId })
    const next = prev ? all.map((h) => (h.id === id ? cfg : h)) : [...all, cfg]
    this.write(next)
    return summaryOf(cfg)
  }

  // 校验以 jumpHostId 为跳板是否合法：不成环（含跳回 selfId）、链深 ≤ MAX_JUMP_DEPTH、跳板存在。不合法抛错。
  checkJump(jumpHostId: string, selfId?: string, all = this.read()): void {
    const seen = new Set(selfId ? [selfId] : [])
    let cur: string | undefined = jumpHostId
    for (let depth = 1; cur; depth++) {
      if (seen.has(cur)) throw new Error(`jump_cycle: ${tr('跳板机链路成环')}`)
      if (depth > MAX_JUMP_DEPTH) throw new Error(`jump_too_deep: ${tr('跳板机最多 {n} 级', { n: MAX_JUMP_DEPTH })}`)
      const h = all.find((x) => x.id === cur)
      if (!h) throw new Error(`jump_host_not_found: ${tr('跳板机不存在')}`)
      seen.add(cur)
      cur = h.jumpHostId
    }
  }

  delete(id: string): void {
    const user = this.read().find((h) => h.jumpHostId === id)
    if (user) throw new Error(`host_in_use_as_jump: ${tr('该主机是「{host}」的跳板机，请先修改那台主机', { host: user.label })}`)
    this.write(this.read().filter((h) => h.id !== id))
  }

  // ── 凭据（经 HostStore：要同步主机快照 / 查引用）──
  /** 存凭据；引用它的主机同步用户名/认证方式快照 */
  saveCredential(input: CredentialInput): CredentialSummary {
    const c = this.credentials.save(input)
    const all = this.read()
    let changed = false
    for (const h of all) {
      if (h.credentialId !== c.id || (h.username === c.username && h.authType === c.authType)) continue
      h.username = c.username; h.authType = c.authType; changed = true
    }
    if (changed) this.write(all)
    return c
  }
  /** 新连接表单选了凭据（未保存主机）：解析成连接参数的用户名/认证部分 */
  credentialConnectOpts(id: string): Pick<SshConnectOpts, 'username' | 'password' | 'privateKey' | 'passphrase' | 'agent'> {
    const a = this.credentials.resolve(id)
    const app = a.authType === 'key' && a.keyId ? this.resolveAppKey(a.keyId) : undefined
    return {
      username: a.username, password: a.password,
      privateKey: app ? app.privateKey : a.privateKey, passphrase: app ? app.passphrase : a.passphrase,
      agent: a.authType === 'agent' ? requireSshAgent(this.detectAgent) : undefined,
    }
  }
  /** 删凭据：被主机引用时拒绝并列出主机 */
  deleteCredential(id: string): void {
    const users = this.read().filter((h) => h.credentialId === id).map((h) => tr('「{name}」', { name: h.label }))
    if (users.length) throw new Error(`credential_in_use: ${tr('以下主机正在使用该凭据：{hosts}，请先改这些主机的认证', { hosts: users.join(tr('、')) })}`)
    this.credentials.remove(id)
  }
  /** 批量让主机使用某凭据（清掉主机自己的凭据密文），返回改了几台 */
  setCredential(hostIds: string[], credentialId: string): number {
    const c = this.credentials.get(credentialId)
    if (!c) throw new Error(`credential_not_found: ${tr('凭据不存在（可能已删除）')}`)
    const ids = new Set(hostIds)
    const all = this.read().map((h): HostConfig => {
      if (!ids.has(h.id)) return h
      const { passwordCipher: _p, privateKeyCipher: _k, passphraseCipher: _pp, keyId: _id, ...rest } = h
      return { ...rest, username: c.username, authType: c.authType, credentialId }
    })
    const n = all.filter((h) => ids.has(h.id)).length
    this.write(all)
    return n
  }
  // ── 批量修改（只改非凭据字段）──
  /** 预览：每台 旧值→新值（不写文件） */
  previewBatch(ids: string[], patch: HostBatchPatch): HostBatchItem[] { return planHostBatch(this.list(), ids, patch) }
  /** 执行：先把 hosts.json 原样备份到 backups/，记下改动前的字段值供撤销，再改。返回改了几台 */
  applyBatch(ids: string[], patch: HostBatchPatch, now = new Date()): number {
    const plan = this.previewBatch(ids, patch).filter((it) => it.changes.length)
    if (!plan.length) return 0
    const all = this.read()
    const backup = join(this.dir, 'backups', `hosts-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    writeJson(backup, all)
    const before: BatchUndo['before'] = []
    for (const it of plan) {
      const h = all.find((x) => x.id === it.id)
      if (!h) continue
      const fields = it.changes.map((c) => c.field)
      before.push({ id: h.id, values: Object.fromEntries(fields.map((f) => [f, h[f] ?? null])) })
      for (const f of fields) {
        if (f === 'host') h.host = h.host.split(patch.hostFind!).join(patch.hostReplace ?? '').trim()
        else if (f === 'port') h.port = patch.port!
        else if (f === 'username') h.username = patch.username!.trim()
        else if (f === 'jumpHostId') h.jumpHostId = patch.jumpHostId || undefined
        else if (f === 'group') h.group = patch.group!.trim() || undefined
        else if (f === 'env') h.env = patch.env || undefined
      }
    }
    this.write(all)
    writeJson(this.undoPath, { at: now.toISOString(), backup, before } satisfies BatchUndo)
    return before.length
  }
  /** 上次批量修改（可撤销）；没有返回 null */
  lastBatch(): HostBatchUndoInfo | null {
    const u = readJson<BatchUndo>(this.undoPath)
    return u?.before?.length ? { at: u.at, count: u.before.length, backup: u.backup } : null
  }
  /** 撤销上次批量修改：只还原那次改过的字段（之后的其它修改保留）；已删的主机跳过、还原后跳板不合法的去掉跳板。返回还原了几台 */
  undoBatch(): number {
    const u = readJson<BatchUndo>(this.undoPath)
    if (!u?.before?.length) throw new Error(`batch_no_undo: ${tr('没有可撤销的批量修改')}`)
    const all = this.read()
    let n = 0
    for (const b of u.before) {
      const h = all.find((x) => x.id === b.id) as Record<string, unknown> | undefined
      if (!h) continue
      for (const [k, v] of Object.entries(b.values)) { if (v === null) delete h[k]; else h[k] = v }
      n++
    }
    for (const b of u.before) {
      const h = all.find((x) => x.id === b.id)
      if (h?.jumpHostId) { try { this.checkJump(h.jumpHostId, h.id, all) } catch { delete h.jumpHostId } }
    }
    this.write(all)
    rmSync(this.undoPath, { force: true })
    return n
  }
  private get undoPath() { return join(this.dir, 'hosts-batch-undo.json') }

  /** 所有已知机密明文（主机自己的 + 全部凭据的），供诊断包 / AI 脱敏替换原值。解不开的跳过 */
  knownSecrets(): string[] {
    const out: string[] = []
    for (const h of this.read()) {
      try { const o = this.resolveConnectOpts(h.id); out.push(o.password ?? '', o.privateKey ?? '', o.passphrase ?? '') } catch { /* 解密失败/无 agent：只靠样式脱敏 */ }
    }
    for (const c of this.credentials.read()) {
      try { const a = this.credentials.resolve(c.id); out.push(a.password ?? '', a.privateKey ?? '', a.passphrase ?? '') } catch { /* 同上 */ }
    }
    return out.filter(Boolean)
  }

  // 仅主进程连接时调用：解密凭据组装 SshConnectOpts（含递归解析的跳板 jump）。不回传渲染层。
  // jumpsLeft：还允许几级跳板（新连接自带跳板时传 MAX-1）；seen 防环（数据被手改时兜底）。
  resolveConnectOpts(id: string, jumpsLeft = MAX_JUMP_DEPTH, seen: string[] = []): SshConnectOpts {
    const h = this.read().find((x) => x.id === id)
    if (!h) throw new Error('host_not_found')
    const dec = (cipher?: string) => this.dec(cipher)
    let jump: SshConnectOpts | undefined
    if (h.jumpHostId) {
      if (seen.includes(h.jumpHostId) || h.jumpHostId === id) throw new Error(`jump_cycle: ${tr('跳板机链路成环')}`)
      if (jumpsLeft <= 0) throw new Error(`jump_too_deep: ${tr('跳板机最多 {n} 级', { n: MAX_JUMP_DEPTH })}`)
      jump = this.resolveConnectOpts(h.jumpHostId, jumpsLeft - 1, [...seen, id])
    }
    // 出站代理：主机自己的 > 全局默认；经跳板的主机不直接建 TCP，不用代理（跳板自己的代理在 jump 里）
    // ProxyCommand：本跳由本地命令接入，同样不用代理
    const proxyCommand = jump ? undefined : h.proxyCommand
    const proxy = jump || proxyCommand || h.proxy === 'none' ? undefined : h.proxy ? this.proxyOpts(h.proxy) : this.defaultProxyOpts()
    // 认证：引用了凭据 → 全取自凭据（本条残留的密文一概不用）；否则用本条自己的
    const a: ResolvedAuth = h.credentialId ? this.credentials.resolve(h.credentialId) : {
      username: h.username, authType: h.authType,
      password: h.authType === 'password' ? dec(h.passwordCipher) : undefined,
      privateKey: h.authType === 'key' && !h.keyId ? dec(h.privateKeyCipher) : undefined,
      passphrase: h.authType === 'key' && !h.keyId ? dec(h.passphraseCipher) : undefined,
      keyId: h.authType === 'key' ? h.keyId : undefined,
    }
    const app = a.authType === 'key' && a.keyId ? this.resolveAppKey(a.keyId) : undefined
    return {
      host: h.host, port: h.port, username: a.username, label: h.label, jump,
      password: a.authType === 'password' ? a.password : undefined,
      privateKey: app ? app.privateKey : a.authType === 'key' ? a.privateKey : undefined,
      passphrase: app ? app.passphrase : a.authType === 'key' ? a.passphrase : undefined,
      // agent 认证：必须有 agent；其它认证开了转发：有 agent 就带上（供转发，也会作认证兜底），没有则转发不生效（终端里提示）
      agent: a.authType === 'agent' ? requireSshAgent(this.detectAgent) : h.agentForward ? this.detectAgent()?.path : undefined,
      encoding: h.encoding,
      ...(h.agentForward ? { agentForward: true } : {}),
      ...(h.loginCommands ? { loginCommands: h.loginCommands } : {}),
      ...(h.advanced?.keepaliveSec !== undefined ? { keepaliveSec: h.advanced.keepaliveSec } : {}),
      ...(h.advanced?.readyTimeoutSec !== undefined ? { readyTimeoutMs: h.advanced.readyTimeoutSec * 1000 } : {}),
      ...(h.advanced?.compress ? { compress: true } : {}),
      ...(h.advanced?.termType ? { termType: h.advanced.termType } : {}),
      ...(proxy ? { proxy } : {}),
      ...(proxyCommand ? { proxyCommand } : {}),
    }
  }

  // ── 全局默认出站代理（proxy.json，密码同主机凭据加密）──
  getDefaultProxy(): ProxySummary | null {
    const p = readJson<ProxyConfig | null>(this.proxyPath)
    return p ? proxySummaryOf(p) : null
  }
  saveDefaultProxy(input: ProxyInput | null): ProxySummary | null {
    const cfg = input ? this.proxyCfg(input, readJson<ProxyConfig | null>(this.proxyPath) ?? undefined) : null
    writeJson(this.proxyPath, cfg)
    return cfg ? proxySummaryOf(cfg) : null
  }
  defaultProxyOpts(): ProxyOpts | undefined {
    const p = readJson<ProxyConfig | null>(this.proxyPath)
    return p ? this.proxyOpts(p) : undefined
  }

  private get proxyPath() { return join(this.dir, 'proxy.json') }
  // 表单 → 存储：密码留空时，同类型同地址同用户沿用旧密文；没用户名就不存密码
  private proxyCfg(p: ProxyInput, prev?: ProxyConfig | 'none'): ProxyConfig {
    const host = String(p.host ?? '').trim(), port = Number(p.port)
    if (p.type !== 'http' && p.type !== 'socks5') throw new Error(`proxy_invalid: ${tr('代理类型只能是 HTTP 或 SOCKS5')}`)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`proxy_invalid: ${tr('代理地址或端口不合法')}`)
    const username = p.username?.trim() || undefined
    const same = prev && prev !== 'none' && prev.type === p.type && prev.host === host && prev.port === port && prev.username === username
    const passwordCipher = !username ? undefined
      : p.password ? (this.enc.available() ? this.enc.encrypt(p.password) : p.password)
      : same ? prev.passwordCipher : undefined
    return { type: p.type, host, port, ...(username ? { username } : {}), ...(passwordCipher ? { passwordCipher } : {}) }
  }
  private proxyOpts(p: ProxyConfig): ProxyOpts {
    return { type: p.type, host: p.host, port: p.port, ...(p.username ? { username: p.username, password: this.dec(p.passwordCipher) ?? '' } : {}) }
  }
  private dec(cipher?: string): string | undefined {
    if (!cipher) return undefined
    if (!this.enc.available()) return cipher   // 加密不可用时存的就是明文
    // 解密失败绝不回落成密文本身（否则密文会被当密码发给 SSH，报误导性的认证失败）
    try { return this.enc.decrypt(cipher) }
    catch { throw new Error(`credential_unreadable: ${tr('凭据无法解密（系统密钥变化？），请重新编辑该主机填写')}`) }
  }
  /** 复制主机（主机面板右键）：新 id、标签加「副本」，凭据密文原样复制，插在原主机后面 */
  duplicate(id: string): HostSummary {
    const all = this.read()
    const i = all.findIndex((h) => h.id === id)
    if (i < 0) throw new Error('host_not_found')
    const copy: HostConfig = { ...all[i], id: randomUUID(), label: tr('{name} 副本', { name: all[i].label }) }
    all.splice(i + 1, 0, copy)
    this.write(all)
    return summaryOf(copy)
  }
  private resolveAppKey(keyId: string) {
    if (!this.appKey) throw new Error(`app_key_unavailable: ${tr('应用密钥不可用')}`)
    return this.appKey(keyId)
  }

  private read(): HostConfig[] { return readJson<HostConfig[]>(this.filePath) ?? [] }
  private write(hosts: HostConfig[]): void { writeJson(this.filePath, hosts) }
}

function summaryOf(h: HostConfig): HostSummary {
  return {
    id: h.id, label: h.label, host: h.host, port: h.port, username: h.username, authType: h.authType,
    jumpHostId: h.jumpHostId,
    ...(h.notes ? { notes: h.notes } : {}), ...(h.env ? { env: h.env } : {}), ...(h.group ? { group: h.group } : {}),
    ...(h.encoding ? { encoding: h.encoding } : {}), ...(h.persistSession ? { persistSession: true } : {}),
    ...(h.loginCommands ? { loginCommands: h.loginCommands } : {}), ...(h.agentForward ? { agentForward: true } : {}),
    ...(h.advanced ? { advanced: { ...h.advanced } } : {}),
    ...(h.proxy ? { proxy: h.proxy === 'none' ? 'none' as const : proxySummaryOf(h.proxy) } : {}),
    ...(h.keyId ? { keyId: h.keyId } : {}), ...(h.credentialId ? { credentialId: h.credentialId } : {}),
    ...(h.proxyCommand ? { proxyCommand: h.proxyCommand } : {}),
  }
}

const proxySummaryOf = (p: ProxyConfig): ProxySummary => ({
  type: p.type, host: p.host, port: p.port, ...(p.username ? { username: p.username } : {}), ...(p.passwordCipher ? { hasPassword: true } : {}),
})

const legacyOrUndef = (e?: string) => (isLegacyEncoding(e) ? e : undefined)

// 高级选项只存与默认不同且合法的项；全默认 = 不存。心跳 0–3600 秒（0 = 关），超时 3–300 秒；终端类型只允许 [A-Za-z0-9._+-]
export function cleanAdvanced(a?: SshAdvanced): SshAdvanced | undefined {
  if (!a) return undefined
  const out: SshAdvanced = {}
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  if (int(a.keepaliveSec, 0, 3600) && a.keepaliveSec !== SSH_ADVANCED_DEFAULTS.keepaliveSec) out.keepaliveSec = a.keepaliveSec
  if (int(a.readyTimeoutSec, 3, 300) && a.readyTimeoutSec !== SSH_ADVANCED_DEFAULTS.readyTimeoutSec) out.readyTimeoutSec = a.readyTimeoutSec
  if (a.compress === true) out.compress = true
  const tt = cleanTermType(a.termType)
  if (tt) out.termType = tt
  return Object.keys(out).length ? out : undefined
}

/** 备注追加：另起一行接在末尾，空白不追加 */
export function appendNoteText(prev: string | undefined, text: string): string {
  const add = text.trim()
  const base = (prev ?? '').trimEnd()
  if (!add) return base
  return base ? `${base}\n${add}` : add
}
