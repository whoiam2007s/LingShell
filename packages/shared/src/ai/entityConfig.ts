// 四类可配置实体（Skill / 数据库连接 / 模型配置 / MCP 服务）的 AI 读写规格：
// 结构校验、敏感值处理、列表摘要。纯逻辑、可单测；落盘由主进程实现。
//
// 两条硬规则（用户定的）：
// 1. **敏感值不拒绝**：env / headers 里疑似密钥的键，值改写成中文占位注释，让用户自己去设置页补真值——
//    模型本来也不该编造 token，写进来的多半是假的，占位比报错更有用（骨架能跑、缺什么一眼看见）。
// 2. **密码式字段只收引用**：数据库连接的密码只接受密钥保险箱里的名称，绝不接受明文。
import { tr } from '../i18n/i18n.js'
import { sanitizeDbConn, type DbConn } from '../db/dbQuick.js'
import {
  MODEL_PROFILE_ID_RE, PROVIDERS, THINKING_LEVELS, protocolOf,
  type SkillInput, type ThinkingLevel,
} from '../protocol/types.js'

export type AiConfigKind = 'skill' | 'db_connection' | 'model_profile' | 'mcp_server'

export const AI_CONFIG_KINDS: AiConfigKind[] = ['skill', 'db_connection', 'model_profile', 'mcp_server']
export const isAiConfigKind = (v: unknown): v is AiConfigKind =>
  typeof v === 'string' && (AI_CONFIG_KINDS as string[]).includes(v)

/* i18n-ignore 下面两块是给模型看的固定名词与提示（不进界面翻译），逐行标注 */
export const AI_CONFIG_KIND_LABEL: Record<AiConfigKind, string> = {
  skill: 'Skill',
  db_connection: '数据库连接',   // i18n-ignore 给模型的输出
  model_profile: '模型配置',   // i18n-ignore 给模型的输出
  mcp_server: 'MCP 服务',   // i18n-ignore 给模型的输出
}

/** 每类一句话说明（工具描述 / 错误提示里复用，告诉模型这类东西存在哪儿） */
export const AI_CONFIG_KIND_HINT: Record<AiConfigKind, string> = {
  skill: '本地 Skill 库（设置 → Skills 里的那些），一个 skill = 一段可复用的操作说明 + 触发描述',   // i18n-ignore 给模型的输出
  db_connection: '数据库快查用的连接（设置 → 数据库），密码只存密钥保险箱里的名称',   // i18n-ignore 给模型的输出
  model_profile: '设置 → 模型配置里的多套模型（供应商 / 模型名 / 地址 / 思考深度）',   // i18n-ignore 给模型的输出
  mcp_server: '设置 → MCP 里的外部工具服务（stdio 命令或 http 地址）',   // i18n-ignore 给模型的输出
}

export type CheckResult<T> = { ok: true; value: T } | { ok: false; error: string }

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

// ── 敏感值 → 中文占位 ────────────────────────────────────────────────
// 键名像密钥才动（TOKEN / SECRET / PASSWORD / API_KEY / AUTHORIZATION / COOKIE …）；
// LOG_LEVEL、BASE_URL 这类普通变量原样保留，不能被误伤。
const SECRET_KEY_RE = /(token|secret|passw|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|authorization|cookie|signature|dsn)/i
export const looksSensitiveKey = (k: string): boolean => SECRET_KEY_RE.test(k)

/** 给用户看的中文占位：值本身不携带任何信息，只提示这里该填什么 */
export const placeholderOf = (key: string): string =>
  tr('请替换成真实的 {key}（AI 不填写敏感值）', { key })

/**
 * 把一张键值表里的敏感值换成中文占位。
 * 返回 masked = 被替换的键名（工具结果里要告诉用户「这几个键留了占位，去设置页补」）。
 */
export function sanitizeSecretMap(m: Record<string, string>): { value: Record<string, string>; masked: string[] } {
  const value: Record<string, string> = {}
  const masked: string[] = []
  for (const [k, v] of Object.entries(m)) {
    if (looksSensitiveKey(k)) {
      value[k] = placeholderOf(k)
      if (v !== value[k]) masked.push(k)
    } else {
      value[k] = v
    }
  }
  return { value, masked }
}

/** 给模型 / 用户的一句话提示：哪些键留了占位 */
export const maskedNote = (masked: string[], where = ''): string =>
  masked.length
    ? tr('{where}里的 {keys} 留了中文占位，需要用户自己在设置页补真实值（AI 不填写敏感值）', {
      where, keys: masked.join('、'),   // i18n-ignore 列表分隔符（中文顿号）
    })
    : ''

// ── Skill ────────────────────────────────────────────────────────────
export interface SkillDraft extends SkillInput { enabled?: boolean; modelInvocable?: boolean }

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function checkSkillInput(v: unknown): CheckResult<SkillDraft> {
  const o = obj(v)
  const name = s(o.name)
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, error: tr('skill 名称只能用小写字母、数字和连字符（如 nginx-check），最长 64 字符') }
  }
  const description = s(o.description)
  if (!description) return { ok: false, error: tr('请填写描述（AI 靠它判断什么时候用这个 skill）') }
  if (description.length > 800) return { ok: false, error: tr('描述太长了（800 字以内）') }
  const body = typeof o.body === 'string' ? o.body : ''
  if (!body.trim()) return { ok: false, error: tr('skill 正文不能为空') }
  if (body.length > 100_000) return { ok: false, error: tr('skill 正文太长了（10 万字以内）') }
  const out: SkillDraft = { name, description, body }
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.modelInvocable === 'boolean') out.modelInvocable = o.modelInvocable
  return { ok: true, value: out }
}

// ── 数据库连接 ───────────────────────────────────────────────────────
/**
 * 复用 shared 的 sanitizeDbConn（名称 / 端口 / 库名的校验都在那儿）。
 * 额外一条：secret 必须是密钥保险箱里**已存在**的名称——sanitizeDbConn 只校验字符集，
 * 分不出「密钥名」和「明文密码」。knownSecrets 由主进程传入；不传（纯逻辑单测）则不判定。
 */
export function checkDbConnInput(v: unknown, knownSecrets?: string[]): CheckResult<DbConn> {
  const c = sanitizeDbConn(v)
  if (typeof c === 'string') return { ok: false, error: c }
  if (c.secret && knownSecrets && !knownSecrets.includes(c.secret)) {
    return {
      ok: false,
      error: tr('密码字段只能填密钥保险箱里的名称，没有「{name}」。可用的有：{list}；没有任何密钥时留空，让用户自己去填。', {
        name: c.secret,
        list: knownSecrets.length ? knownSecrets.join('、') : tr('（保险箱里还没有密钥）'),   // i18n-ignore 列表分隔符（中文顿号）
      }),
    }
  }
  return { ok: true, value: c }
}

// ── 模型配置 ─────────────────────────────────────────────────────────
/** AI 能改的字段：**不含 apiKey**（密钥永不由模型写入，新建的配置要用户自己去填 key） */
export interface ModelProfileDraft {
  id?: string
  name: string
  provider: string
  model: string
  baseUrl?: string
  contextWindow?: number
  thinking?: ThinkingLevel
  protocol?: string
  multimodal?: boolean
}

export function checkModelProfileInput(v: unknown): CheckResult<ModelProfileDraft> {
  const o = obj(v)
  const provider = s(o.provider)
  if (!PROVIDERS.some((p) => p.id === provider)) {
    return { ok: false, error: tr('没有这个提供商：{v}（可用：{list}）', { v: provider || tr('（空）'), list: PROVIDERS.map((p) => p.id).join(' / ') }) }
  }
  const model = s(o.model)
  if (!model) return { ok: false, error: tr('请填写模型名（如 deepseek-chat）') }
  const out: ModelProfileDraft = { name: s(o.name).slice(0, 60) || model, provider, model }
  const id = s(o.id)
  if (id) {
    if (!MODEL_PROFILE_ID_RE.test(id)) return { ok: false, error: tr('配置 id 只能用小写字母、数字和下划线（最长 40）') }
    out.id = id
  }
  const baseUrl = s(o.baseUrl)
  if (baseUrl) {
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { ok: false, error: tr('地址要以 http:// 或 https:// 开头') }
    out.baseUrl = baseUrl
  }
  if (o.contextWindow !== undefined && o.contextWindow !== null && o.contextWindow !== '') {
    const n = Number(o.contextWindow)
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) return { ok: false, error: tr('上下文窗口要填整数（0 = 按模型自动）') }
    if (n > 0) out.contextWindow = n
  }
  if (o.thinking !== undefined && o.thinking !== null && o.thinking !== '') {
    const t = s(o.thinking) as ThinkingLevel
    if (!THINKING_LEVELS.includes(t)) return { ok: false, error: tr('思考深度只能是：{list}', { list: THINKING_LEVELS.join(' / ') }) }
    out.thinking = t
  }
  if (o.protocol !== undefined && o.protocol !== null && o.protocol !== '') {
    const p = s(o.protocol)
    if (p !== 'anthropic' && p !== 'openai' && p !== 'openai-responses') {
      return { ok: false, error: tr('接口协议只能是 anthropic / openai / openai-responses') }
    }
    out.protocol = p
  }
  if (typeof o.multimodal === 'boolean') out.multimodal = o.multimodal
  return { ok: true, value: out }
}

/** 这套配置的接口协议（缺省按提供商默认值） */
export const protocolOfDraft = (p: Pick<ModelProfileDraft, 'provider'> & { protocol?: unknown }) =>
  protocolOf(p.provider, p.protocol)

// ── MCP 服务 ─────────────────────────────────────────────────────────
export interface McpDraft {
  id?: string
  name: string
  enabled?: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** 被换成中文占位的 env / headers 键名 */
  masked: string[]
}

export function checkMcpServerInput(v: unknown): CheckResult<McpDraft> {
  const o = obj(v)
  const name = s(o.name)
  if (!name) return { ok: false, error: tr('MCP 服务名称不能为空') }
  if (name.length > 60) return { ok: false, error: tr('名称太长了（60 字以内）') }
  const transport = o.transport === 'http' ? 'http' : o.transport === 'stdio' ? 'stdio' : undefined
  if (!transport) return { ok: false, error: tr('transport 只能是 stdio 或 http') }
  const out: McpDraft = { name, transport, masked: [] }
  const id = s(o.id)
  if (id) out.id = id
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (transport === 'stdio') {
    const command = s(o.command)
    if (!command) return { ok: false, error: tr('stdio 方式需要填写启动命令（如 npx）') }
    out.command = command
    if (Array.isArray(o.args)) out.args = o.args.filter((x): x is string => typeof x === 'string').slice(0, 50)
    const cwd = s(o.cwd)
    if (cwd) out.cwd = cwd
  } else {
    const url = s(o.url)
    if (!url) return { ok: false, error: tr('http 方式需要填写 URL') }
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: tr('URL 要以 http:// 或 https:// 开头') }
    out.url = url
  }
  for (const field of ['env', 'headers'] as const) {
    const raw = obj(o[field])
    const m: Record<string, string> = {}
    for (const [k, val] of Object.entries(raw)) {
      if (typeof val === 'string') m[k] = val
      else if (typeof val === 'number' || typeof val === 'boolean') m[k] = String(val)
    }
    const { value, masked } = sanitizeSecretMap(m)
    if (Object.keys(value).length) out[field] = value
    out.masked.push(...masked.map((k) => `${field}.${k}`))
  }
  if (transport === 'stdio' ? !out.command : !out.url) return { ok: false, error: tr('配置不完整') }
  return { ok: true, value: out }
}

// ── 列表摘要（给模型的 list_config 输出） ─────────────────────────────
/** 一行一条，字段精简但够模型判断是否要改 / 别重复建 */
export function summarizeEntity(kind: AiConfigKind, item: Record<string, unknown>): string {
  const g = (k: string) => (typeof item[k] === 'string' ? item[k] as string : '')
  switch (kind) {
    case 'skill': {
      const flags = [item.enabled === false ? '已停用' : '', item.modelInvocable === false ? 'AI 不可调用' : ''].filter(Boolean).join('，')   // i18n-ignore 给模型的输出
      return `- ${g('name')}：${g('description')}${flags ? `（${flags}）` : ''}${g('error') ? `（有问题：${g('error')}）` : ''}`   // i18n-ignore 给模型的输出
    }
    case 'db_connection': {
      const kindName = g('kind')
      const via = g('via') === 'docker' ? `docker:${g('container')}` : '本机客户端'   // i18n-ignore 给模型的输出
      const where = [g('host'), item.port ? String(item.port) : '', g('database')].filter(Boolean).join(':')
      return `- ${g('name')}（id=${g('id')}）：${kindName} ${via}${where ? ` → ${where}` : ''}${g('secret') ? '，密码用密钥' : '，无密码'}`   // i18n-ignore 给模型的输出
    }
    case 'model_profile': {
      const cw = typeof item.contextWindow === 'number' && item.contextWindow > 0 ? `，上下文 ${item.contextWindow}` : ''   // i18n-ignore 给模型的输出
      return `- ${g('name')}（id=${g('id')}）：${g('provider')}/${g('model')} @ ${g('baseUrl')}${cw}${item.hasApiKey ? '' : '，未填 API Key'}`   // i18n-ignore 给模型的输出
    }
    case 'mcp_server': {
      const envKeys = Array.isArray(item.envKeys) ? item.envKeys as string[] : []
      const headerKeys = Array.isArray(item.headerKeys) ? item.headerKeys as string[] : []
      const conf = [...envKeys.map((k) => `env ${k}`), ...headerKeys.map((k) => `header ${k}`)].join('、')   // i18n-ignore 给模型的输出
      return `- ${g('name')}（id=${g('id')}）：${g('transport')} ${g('transport') === 'http' ? g('url') : g('command')}${item.enabled === false ? '，已停用' : ''}${conf ? `，涉及 ${conf}` : ''}`   // i18n-ignore 给模型的输出
    }
  }
}
