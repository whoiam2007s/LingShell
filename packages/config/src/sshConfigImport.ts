import { readFileSync, readdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { tr, type AuthType, type HostSummary, type SshAgentInfo, type SshImportItem, type SshImportPreview, type SshImportResult } from '@lingshell/shared'
import type { HostStore } from './HostStore.js'
import { detectSshAgent } from './sshAgent.js'

// ~/.ssh/config 导入。约定：
// - 一个 Host 行多个别名 → 只取第一个非通配别名建一台主机（其余别名仅用于 ProxyJump 引用解析），避免同一台机器建多份
// - 含 * ? ! 的纯通配 Host 块不单独建主机，但其选项按 OpenSSH「先出现者生效」规则作用到匹配的主机（如 Host * 里的 User）
// - Include：支持绝对路径、~ 开头、相对 ~/.ssh 的路径，文件名部分可含 * ?；找不到的文件给警告；最多嵌套 8 层
// - Match 块不支持：整块忽略并警告；ProxyCommand 原样导入（连接时在本机执行，预览里醒目提示），与 ProxyJump 同时有时用 ProxyJump
// - 无 IdentityFile 时按 OpenSSH 默认顺序试 ~/.ssh/id_ed25519、id_ecdsa、id_rsa；都没有则导入为密码认证（稍后填密码）
//   例外：检测到系统 ssh-agent/Pageant 且默认私钥缺失或带口令 → 导入为 agent 认证（同 OpenSSH 实际行为：agent 优先）

/** 文件系统/环境注入点（测试用内存实现） */
export interface SshConfigEnv {
  home: string
  defaultUser: string
  readFile(path: string): string | undefined
  listDir(dir: string): string[]
  agent?(): SshAgentInfo | undefined   // 系统 agent 检测；缺省 = 无 agent
}

export function nodeSshConfigEnv(): SshConfigEnv {
  return {
    home: homedir(),
    defaultUser: safeUser(),
    readFile: (p) => { try { return readFileSync(p, 'utf8') } catch { return undefined } },
    listDir: (d) => { try { return readdirSync(d) } catch { return [] } },
    agent: () => detectSshAgent(),
  }
}
function safeUser(): string { try { return userInfo().username } catch { return 'root' } }

interface Block { patterns: string[]; opts: [string, string][] }   // patterns 为空 = Match 块（永不匹配）

/** 解析配置文本为 Host 块列表（含 Include 展开）。首块是 Host 行之前的全局选项（等价 Host *）。 */
export function parseSshConfig(text: string, env: SshConfigEnv, warnings: string[] = [], blocks: Block[] = [{ patterns: ['*'], opts: [] }], depth = 0): Block[] {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([^\s=]+)\s*(?:=\s*|\s)\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') blocks.push({ patterns: splitArgs(value), opts: [] })
    else if (key === 'match') {
      blocks.push({ patterns: [], opts: [] })
      warnings.push(tr('不支持 Match 块，已忽略：Match {value}', { value }))
    } else if (key === 'include') {
      if (depth >= 8) { warnings.push(tr('Include 嵌套过深，已忽略：{value}', { value })); continue }
      for (const pat of splitArgs(value)) {
        const files = expandInclude(pat, env)
        if (!files.length) warnings.push(tr('Include 文件不存在，已忽略：{path}', { path: pat }))
        for (const f of files) {
          const sub = env.readFile(f)
          if (sub == null) warnings.push(tr('Include 文件无法读取，已忽略：{path}', { path: f }))
          else parseSshConfig(sub, env, warnings, blocks, depth + 1)
        }
      }
    } else blocks[blocks.length - 1].opts.push([key, unquote(value)])
  }
  return blocks
}

function splitArgs(v: string): string[] {
  return (v.match(/"[^"]*"|\S+/g) ?? []).map(unquote).filter(Boolean)
}
function unquote(v: string): string { return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v }
function hasWildcard(p: string): boolean { return /[*?!]/.test(p) }

function globRe(p: string, flags = ''): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', flags)
}

/** ~ 展开；相对路径按 base 解析（Include 相对 ~/.ssh，IdentityFile 相对 home） */
function expandPath(p: string, env: SshConfigEnv, base: string): string {
  const s = p.replace(/%d/g, env.home).replace(/%u/g, env.defaultUser).replace(/%%/g, '%')
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return join(env.home, s.slice(1))
  return isAbsolute(s) ? s : join(base, s)
}

function expandInclude(pat: string, env: SshConfigEnv): string[] {
  const full = expandPath(pat, env, join(env.home, '.ssh'))
  const name = basename(full)
  if (!/[*?]/.test(name)) return env.readFile(full) == null ? [] : [full]
  const re = globRe(name)
  return env.listDir(dirname(full)).filter((f) => re.test(f)).sort().map((f) => join(dirname(full), f))
}

/** Host 模式匹配：任一否定模式命中 → 不匹配；否则任一正模式命中即匹配（不分大小写） */
export function hostMatches(patterns: string[], alias: string): boolean {
  let hit = false
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globRe(p.slice(1), 'i').test(alias)) return false }
    else if (globRe(p, 'i').test(alias)) hit = true
  }
  return hit
}

export interface SshConfigEntry {
  alias: string
  aliases: string[]        // 同一 Host 行的全部非通配别名（ProxyJump 引用解析用）
  host: string
  port: number
  user?: string
  identityFile?: string
  proxyJump?: string
  proxyCommand?: string
  warnings: string[]
}

/** 块列表 → 每个具体别名的生效配置（OpenSSH 规则：同一关键字先出现者生效） */
export function sshConfigEntries(blocks: Block[]): SshConfigEntry[] {
  const out: SshConfigEntry[] = []
  const seen = new Set<string>()
  for (const b of blocks) {
    const aliases = b.patterns.filter((p) => !hasWildcard(p))
    const alias = aliases[0]
    if (!alias || seen.has(alias.toLowerCase())) continue
    aliases.forEach((a) => seen.add(a.toLowerCase()))
    const eff = new Map<string, string>()
    for (const blk of blocks) {
      if (!hostMatches(blk.patterns, alias)) continue
      for (const [k, v] of blk.opts) if (!eff.has(k)) eff.set(k, v)
    }
    const warnings: string[] = []
    let port = 22
    if (eff.has('port')) {
      const n = Number(eff.get('port'))
      if (Number.isInteger(n) && n > 0 && n < 65536) port = n
      else warnings.push(tr('端口无效（{port}），按 22 处理', { port: String(eff.get('port')) }))
    }
    const jump = eff.get('proxyjump')
    const proxyJump = jump && jump.toLowerCase() !== 'none' ? jump : undefined
    // ProxyCommand：%h %p %r 留到连接时替换（%n 别名现在就换掉）；与 ProxyJump 同时出现时用 ProxyJump
    const pcRaw = eff.get('proxycommand')
    let proxyCommand = pcRaw && pcRaw.toLowerCase() !== 'none' ? pcRaw.replace(/%n/g, alias) : undefined
    if (proxyCommand && proxyJump) { warnings.push(tr('同时配置了 ProxyJump 与 ProxyCommand，按 ProxyJump 导入，ProxyCommand 已忽略')); proxyCommand = undefined }
    if (proxyCommand) warnings.push(`将执行本地命令（ProxyCommand）：${proxyCommand}`)   // i18n-ignore 界面按 startsWith('将执行本地命令') 过滤掉这条（SshImportDialog），改了要两边一起改
    out.push({
      alias, aliases, port, warnings,
      host: (eff.get('hostname') ?? alias).replace(/%h/g, alias),
      user: eff.get('user'),
      identityFile: eff.get('identityfile'),
      proxyJump,
      ...(proxyCommand ? { proxyCommand } : {}),
    })
  }
  return out
}

/** 私钥是否带口令（PEM ENCRYPTED / PKCS8 加密 / OpenSSH 新格式 cipher≠none / PuTTY Encryption≠none） */
export function keyNeedsPassphrase(key: string): boolean {
  if (/ENCRYPTED/.test(key)) return true
  if (/^PuTTY-User-Key-File/m.test(key)) return !/^Encryption:\s*none\s*$/m.test(key)
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/.exec(key)
  if (!m) return false
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
  const magic = 'openssh-key-v1\0'
  if (buf.length < magic.length + 4 || buf.toString('latin1', 0, magic.length) !== magic) return false
  const len = buf.readUInt32BE(magic.length)
  return buf.toString('latin1', magic.length + 4, magic.length + 4 + len) !== 'none'
}
function isPrivateKey(s: string): boolean { return /PRIVATE KEY-----|^PuTTY-User-Key-File/m.test(s) }

// 预览项 + 主进程内部数据（私钥内容、跳板解析结果），私钥不出主进程
interface Planned extends SshImportItem {
  privateKey?: string
  jumpAlias?: string       // 跳板指向本次配置里的另一别名
  jumpHostId?: string      // 跳板指向已存在主机
}

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa']

/** 生成导入计划：私钥读取、重复检测、跳板映射 */
export function planSshImport(entries: SshConfigEntry[], existing: HostSummary[], env: SshConfigEnv): Planned[] {
  const byAlias = new Map<string, SshConfigEntry>()
  for (const e of entries) for (const a of e.aliases) byAlias.set(a.toLowerCase(), e)
  const userOf = (e: SshConfigEntry) => e.user ?? env.defaultUser
  const sameTarget = (host: string, port: number, user: string | undefined) => (x: { host: string; port: number; username: string }) =>
    x.host.toLowerCase() === host.toLowerCase() && x.port === port && (user === undefined || x.username === user)

  // 单跳解析：别名 → 本配置条目；[user@]host[:port] → 已存在主机 / 本配置条目
  type Hop = { alias: string } | { hostId: string; jumpHostId?: string } | undefined
  const resolveHop = (tok: string): Hop => {
    const e = byAlias.get(tok.toLowerCase())
    if (e) return { alias: e.alias }
    const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(tok)
    if (!m) return undefined
    const host = m[2].replace(/^\[|\]$/g, ''), port = Number(m[3] ?? 22), user = m[1]
    const ex = existing.find(sameTarget(host, port, user))
    if (ex) return { hostId: ex.id, jumpHostId: ex.jumpHostId }
    const ent = entries.find((x) => sameTarget(host, port, user)({ host: x.host, port: x.port, username: userOf(x) }))
    return ent ? { alias: ent.alias } : undefined
  }
  const sameHop = (a: Hop, b: Hop) => !!a && !!b && (('alias' in a && 'alias' in b && a.alias === b.alias) || ('hostId' in a && 'hostId' in b && a.hostId === b.hostId))
  // 某跳自身的上一跳（用于校验 a,b 链：b 自己必须经 a）
  const hopParent = (h: Hop): Hop => {
    if (!h) return undefined
    if ('hostId' in h) return h.jumpHostId ? { hostId: h.jumpHostId } : undefined
    const pj = byAlias.get(h.alias.toLowerCase())?.proxyJump
    return pj && !pj.includes(',') ? resolveHop(pj.trim()) : undefined
  }

  let agentMemo: { a?: SshAgentInfo } | undefined   // agent 只检测一次
  const sysAgent = () => (agentMemo ??= { a: env.agent?.() }).a

  return entries.map((e): Planned => {
    const warnings = [...e.warnings]
    const username = userOf(e)
    if (!e.user) warnings.push(tr('未配置 User，使用本机用户名 {user}', { user: username }))

    // 私钥
    let keyFile: string | undefined, privateKey: string | undefined, keyStatus: SshImportItem['keyStatus'] = 'none'
    const candidates = e.identityFile ? [expandPath(e.identityFile, env, env.home)] : DEFAULT_KEYS.map((k) => join(env.home, '.ssh', k))
    for (const p of candidates) {
      const c = env.readFile(p)
      if (c != null && isPrivateKey(c)) { keyFile = p; privateKey = c; break }
    }
    if (privateKey) keyStatus = keyNeedsPassphrase(privateKey) ? 'encrypted' : 'ok'
    // 无 IdentityFile、默认私钥没有或带口令，而系统有 agent → 用 agent（不存私钥）
    const agent = !e.identityFile && keyStatus !== 'ok' ? sysAgent() : undefined
    if (agent) {
      keyFile = undefined; privateKey = undefined; keyStatus = 'none'
      warnings.push(tr('使用 {agent} 认证：请确认已用 ssh-add 加载密钥', { agent: agent.label }))
    } else if (keyStatus === 'encrypted') warnings.push(tr('私钥有口令：导入后请编辑主机填写私钥口令'))
    else if (e.identityFile && !privateKey) {
      keyFile = candidates[0]; keyStatus = 'missing'
      warnings.push(tr('私钥文件不存在、不可读或不是私钥：{path}，导入后请编辑主机补充凭据', { path: String(keyFile) }))
    } else if (!privateKey) warnings.push(tr('未找到私钥，导入为密码认证：连接前请编辑主机填写密码'))
    const authType: AuthType = agent ? 'agent' : privateKey || keyStatus === 'missing' ? 'key' : 'password'

    // 跳板
    let jumpAlias: string | undefined, jumpHostId: string | undefined
    if (e.proxyJump) {
      const toks = e.proxyJump.split(',').map((s) => s.trim()).filter(Boolean)
      const direct = resolveHop(toks[toks.length - 1])
      if (toks.length > 2) warnings.push(tr('跳板链 {chain} 超过 2 级，已忽略跳板', { chain: e.proxyJump }))
      else if (!direct) warnings.push(tr('跳板 {jump} 无法对应到已有/导入的主机，已忽略跳板', { jump: toks[toks.length - 1] }))
      else if (toks.length === 2 && !sameHop(hopParent(direct), resolveHop(toks[0]))) warnings.push(tr('跳板链 {chain} 无法映射（{last} 自身不经 {first}），已忽略跳板', { chain: e.proxyJump, last: toks[1], first: toks[0] }))
      else if ('alias' in direct) {
        if (direct.alias === e.alias) warnings.push(tr('跳板指向自身，已忽略'))
        else jumpAlias = direct.alias
      } else jumpHostId = direct.hostId
    }

    return {
      alias: e.alias, host: e.host, port: e.port, username, authType, keyFile, keyStatus,
      jump: e.proxyJump && (jumpAlias || jumpHostId) ? e.proxyJump : undefined,
      existingId: existing.find(sameTarget(e.host, e.port, username))?.id,
      warnings, privateKey, jumpAlias, jumpHostId,
      ...(e.proxyCommand ? { proxyCommand: e.proxyCommand } : {}),
    }
  })
}

function configPath(env: SshConfigEnv): string { return join(env.home, '.ssh', 'config') }

function load(existing: HostSummary[], env: SshConfigEnv): { found: boolean; warnings: string[]; plan: Planned[] } {
  const text = env.readFile(configPath(env))
  if (text == null) return { found: false, warnings: [], plan: [] }
  const warnings: string[] = []
  const plan = planSshImport(sshConfigEntries(parseSshConfig(text, env, warnings)), existing, env)
  return { found: true, warnings, plan }
}

/** 预览：不含私钥内容，可安全回渲染层 */
export function previewSshConfig(existing: HostSummary[], env = nodeSshConfigEnv()): SshImportPreview {
  const { found, warnings, plan } = load(existing, env)
  const items = plan.map(({ privateKey: _k, jumpAlias: _a, jumpHostId: _j, ...item }) => item)
  return { path: configPath(env), found, items, warnings }
}

/** 按勾选别名导入。跳板先于目标保存；跳板未勾选时若已存在同目标主机则挂到它，否则忽略跳板并警告 */
export function importSshConfig(store: HostStore, aliases: string[], env = nodeSshConfigEnv()): SshImportResult {
  const { plan } = load(store.list(), env)
  const byAlias = new Map(plan.map((p) => [p.alias, p]))
  const selected = new Set(aliases)
  const saved = new Map<string, string>()     // alias → 新主机 id
  const saving = new Set<string>()
  const warnings: string[] = []
  let created = 0   // 真正新建的数量（已存在而跳过的不算）

  const save = (p: Planned): string | undefined => {
    if (saved.has(p.alias)) return saved.get(p.alias)
    // 已存在相同主机（地址 + 端口 + 用户名）：跳过，不再造一份重复的（以前重新导入会复制一份）
    if (p.existingId) { saved.set(p.alias, p.existingId); warnings.push(tr('{alias}：已有相同主机，已跳过', { alias: p.alias })); return p.existingId }
    if (saving.has(p.alias)) { warnings.push(tr('{alias}：跳板链路成环，已忽略跳板', { alias: p.alias })); return undefined }
    saving.add(p.alias)
    let jumpHostId = p.jumpHostId
    if (p.jumpAlias) {
      const j = byAlias.get(p.jumpAlias)
      if (j && selected.has(j.alias)) jumpHostId = save(j)
      else if (j?.existingId) jumpHostId = j.existingId
      else warnings.push(tr('{alias}：跳板 {jump} 未勾选导入，已忽略跳板', { alias: p.alias, jump: p.jumpAlias }))
    }
    const input = {
      label: p.alias, host: p.host, port: p.port, username: p.username, authType: p.authType,
      privateKey: p.privateKey,
      ...(p.proxyCommand ? { proxyCommand: p.proxyCommand } : {}),
    }
    let id: string | undefined
    try { id = store.save({ ...input, jumpHostId }).id; created++ }
    catch (e) {
      // 跳板超深/成环等由 HostStore 校验拒绝 → 去掉跳板再存；其它原因（字段不合法）记下来继续导后面的
      warnings.push(tr('{alias}：跳板无法使用（{error}），已忽略跳板', { alias: p.alias, error: e instanceof Error ? e.message : String(e) }))
      try { id = store.save(input).id; created++ } catch (e2) { warnings.push(tr('{alias}：导入失败（{error}），已跳过', { alias: p.alias, error: e2 instanceof Error ? e2.message : String(e2) })) }
    }
    saving.delete(p.alias)
    if (!id) return undefined
    saved.set(p.alias, id)
    return id
  }
  for (const a of aliases) {
    const p = byAlias.get(a)
    if (p) save(p); else warnings.push(tr('配置中找不到 {alias}，已跳过', { alias: a }))
  }
  return { imported: created, warnings }
}
