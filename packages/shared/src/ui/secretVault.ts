// 密钥保险箱（纯逻辑）：占位符 {{secret:名称}} 的解析、可用范围校验、按引号上下文展开、输出回写。
// 明文只在主进程里经 expandSecrets 进命令；进模型 / 对话 / 记录前用 maskSecrets 换回占位符。尽力而为，不是保证。

import { tr } from '../i18n/i18n.js'

export const SECRET_NAME_RE = /^[a-z0-9_-]{1,64}$/
export const SECRET_MIN_LEN = 4          // 值至少 4 个字符：太短的串到处都是，输出里没法可靠认出来换回占位符
export const SECRET_MAX_LEN = 16_384
const REF = /\{\{secret:([a-z0-9_-]{1,64})\}\}/g
const REF_AT = /^\{\{secret:([a-z0-9_-]{1,64})\}\}/

// 可用范围：全部（本地 + 所有 SSH 主机，含临时连接）/ 仅本地终端 / 指定分组 / 指定主机（targets = 分组名或主机 id）
export type SecretScope = 'all' | 'local' | 'group' | 'hosts'
export interface SecretSummary {
  id: string; name: string; description: string
  scope: SecretScope; targets: string[]
  hasValue: boolean                      // 导入时没带值的为 false（需「替换值」后才能用）
  createdAt: string; updatedAt: string
}
// value：新建必填；编辑时留空 = 不变（值只进不出，界面只能替换不能查看）
export interface SecretInput { id?: string; name: string; description?: string; scope: SecretScope; targets?: string[]; value?: string }
export interface SecretPlain { name: string; value: string }

export const secretRef = (name: string): string => `{{secret:${name}}}`

/** 文本里引用到的密钥名（去重，按出现顺序） */
export function secretRefs(text: string): string[] {
  return [...new Set([...String(text ?? '').matchAll(REF)].map((m) => m[1]))]
}

/** 任意值（工具入参）里有没有密钥占位符 */
export function hasSecretRef(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('{{secret:') && secretRefs(v).length > 0
  if (Array.isArray(v)) return v.some(hasSecretRef)
  if (v && typeof v === 'object') return Object.values(v).some(hasSecretRef)
  return false
}

/** hostKey：'local' | 已保存主机 id | 临时连接 host:port；group：该主机的分组 */
export function secretAllowed(s: Pick<SecretSummary, 'scope' | 'targets'>, hostKey: string, group?: string): boolean {
  if (s.scope === 'all') return true
  if (s.scope === 'local') return hostKey === 'local'
  if (s.scope === 'hosts') return s.targets.includes(hostKey)
  return hostKey !== 'local' && !!group && s.targets.includes(group)
}

export function secretScopeLabel(s: Pick<SecretSummary, 'scope' | 'targets'>, hostLabel: (id: string) => string = (id) => id): string {
  if (s.scope === 'all') return tr('全部主机（含本地）')
  if (s.scope === 'local') return tr('仅本地终端')
  if (s.scope === 'group') return tr('分组：{list}', { list: s.targets.join(tr('list|、')) || tr('（未选）') })
  return tr('主机：{list}', { list: s.targets.map((t) => (t === 'local' ? tr('本地') : hostLabel(t))).join(tr('list|、')) || tr('（未选）') })
}

/**
 * 命令里引用的密钥能否在这台主机上用：能 → undefined；不能 → 原因（给模型 / 用户看，不含值）。
 * where：主机的显示名（报错用）
 */
export function checkSecretRefs(command: string, list: SecretSummary[], hostKey: string, group: string | undefined, where: string, hostLabel?: (id: string) => string): string | undefined {
  for (const name of secretRefs(command)) {
    const s = list.find((x) => x.name === name)
    if (!s) return `secret_not_found: 密钥保险箱里没有「${name}」（可用：${list.map((x) => x.name).join('、') || '无'}），已拒绝执行`   // i18n-ignore 工具报错回给模型
    if (!s.hasValue) return `secret_empty: 密钥「${name}」还没有设置值，请让用户在 设置 → 密钥保险箱 里替换值后再试，已拒绝执行`   // i18n-ignore 工具报错回给模型
    if (!secretAllowed(s, hostKey, group)) return `secret_scope: 密钥「${name}」不允许在「${where}」上使用（可用范围：${secretScopeLabel(s, hostLabel)}），已拒绝执行；请换到范围内的终端，或让用户调整该密钥的可用范围`   // i18n-ignore 工具报错回给模型
  }
  return undefined
}

const sq = (v: string) => v.replace(/'/g, `'\\''`)
/** 按占位符所在的引号上下文转义：单引号内 / 双引号内 / 不在引号内（整体单引号包起来）。替换后的值永远是一个字面量，不会被 shell 再解释 */
function quoteIn(q: '' | "'" | '"', v: string): string {
  if (q === "'") return sq(v)
  if (q === '"') return v.replace(/[\\"$`]/g, '\\$&')
  return `'${sq(v)}'`
}

/**
 * 把 {{secret:名称}} 换成明文（valueOf 取值，取不到就抛错）。只认 POSIX shell 的单 / 双引号与反斜杠转义；
 * heredoc 正文里不在引号内的占位符也会被单引号包起来（写进文件请改用 printf '%s' {{secret:x}}）。
 */
export function expandSecrets(command: string, valueOf: (name: string) => string): string {
  let out = '', q: '' | "'" | '"' = '', i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === '{') {
      const m = REF_AT.exec(command.slice(i, i + 80))
      if (m) { out += quoteIn(q, valueOf(m[1])); i += m[0].length; continue }
    }
    if (q === "'") { if (ch === "'") q = '' }
    else if (ch === '\\') { out += command.slice(i, i + 2); i += 2; continue }
    else if (q === '"') { if (ch === '"') q = '' }
    else if (ch === "'" || ch === '"') q = ch
    out += ch; i++
  }
  return out
}

// ── 输出回写：明文 → 占位符 ─────────────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LOOSE_MAX = 512        // 更长的值（证书 / 私钥）只做精确匹配，不逐字插可选换行
const PARTIAL_MIN = 4        // 截断边界上的残片至少这么长才换

// 一个值在输出里可能出现的形式：原样、\r\n 换行、JSON 转义、被单引号转义一层 / 两层（命令回显）、双引号转义
function formsOf(v: string): string[] {
  const set = new Set([v, v.replace(/\r?\n/g, '\r\n'), JSON.stringify(v).slice(1, -1), sq(v), sq(sq(v)), v.replace(/[\\"$`]/g, '\\$&')])
  return [...set].filter((f) => f.length >= SECRET_MIN_LEN)
}

// 终端按列宽折行（读屏快照）时值会被拆到两行：短值逐字允许夹一个换行
function patternOf(f: string): RegExp {
  const parts = [...f].map((c) => (c === '\n' ? '\\r?\\n' : c === '\r' ? '\\r?' : esc(c)))
  return new RegExp(f.length <= LOOSE_MAX && !f.includes('\n') ? parts.join('(?:\\r?\\n|\\r)?') : parts.join(''), 'g')
}

type Compiled = { name: string; value: string; res: RegExp[] }
const cache = new WeakMap<readonly SecretPlain[], Compiled[]>()
function compile(list: readonly SecretPlain[]): Compiled[] {
  let c = cache.get(list)
  if (!c) {
    c = list.filter((s) => s.value && s.value.length >= SECRET_MIN_LEN)
      .map((s) => ({ name: s.name, value: s.value, res: formsOf(s.value).sort((a, b) => b.length - a.length).map(patternOf) }))
      .sort((a, b) => b.value.length - a.value.length)   // 长的先换，免得短值把长值拆碎
    cache.set(list, c)
  }
  return c
}

function maskFull(text: string, cs: Compiled[]): string {
  let out = text
  for (const c of cs) for (const re of c.res) { re.lastIndex = 0; if (re.test(out)) { re.lastIndex = 0; out = out.replace(re, secretRef(c.name)) } }
  return out
}

// 截断边界：开头是某值的后半截 / 结尾是某值的前半截（输出被截断、只保留末尾 N 字时）
function maskEdges(text: string, cs: Compiled[]): string {
  let out = text
  for (const c of cs) {
    const v = c.value
    for (let k = v.length - 1; k >= PARTIAL_MIN; k--) if (out.startsWith(v.slice(-k))) { out = secretRef(c.name) + out.slice(k); break }
    for (let k = v.length - 1; k >= PARTIAL_MIN; k--) if (out.endsWith(v.slice(0, k))) { out = out.slice(0, out.length - k) + secretRef(c.name); break }
  }
  return out
}

/** 文本回写：完整出现（含多处、跨行折断）与首尾的截断残片都换成 {{secret:名称}} */
export function maskSecrets(text: string, list: readonly SecretPlain[]): string {
  if (!text || !list.length) return text
  const cs = compile(list)
  return cs.length ? maskEdges(maskFull(text, cs), cs) : text
}

function walk(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]))
  return v
}

/** 工具结果回写：是 JSON 就逐个字符串值处理（截断残片按字段判），否则按文本；没改动原样返回 */
export function maskToolText(text: string, list: readonly SecretPlain[]): string {
  if (!text || !list.length) return text
  if (/^\s*[[{]/.test(text)) {
    try {
      const j: unknown = JSON.parse(text)
      const pretty = text.includes('\n') ? 2 : undefined
      const s = JSON.stringify(walk(j, (x) => maskSecrets(x, list)), null, pretty)
      return s === JSON.stringify(j, null, pretty) ? text : s
    } catch { /* 不是 JSON，按文本 */ }
  }
  return maskSecrets(text, list)
}

/**
 * 流式回写（终端录像）：值可能被拆在两个 chunk 里——末尾像某个值开头的部分先扣住，下个 chunk 来了拼上再判。
 * flush：终端关闭 / 停止录像时把扣住的残片（按截断残片处理）交出
 */
export class SecretStreamMasker {
  private held = ''
  constructor(private list: () => readonly SecretPlain[]) {}
  push(chunk: string): string {
    const list = this.list()
    let s = this.held + chunk
    this.held = ''
    if (!list.length) return s
    const cs = compile(list)
    s = maskFull(s, cs)
    let keep = 0
    for (const c of cs) for (let k = Math.min(c.value.length - 1, s.length); k > keep; k--) if (s.endsWith(c.value.slice(0, k))) { keep = k; break }
    this.held = s.slice(s.length - keep)
    return s.slice(0, s.length - keep)
  }
  flush(): string {
    const h = this.held
    this.held = ''
    const list = this.list()
    return h && list.length ? maskSecrets(h, list) : h
  }
}

// 给模型的系统提示段：只有名称、说明、可用范围，没有值
export function buildSecretsPrompt(list: SecretSummary[], hostLabel?: (id: string) => string): string {
  const usable = list.filter((s) => s.hasValue)
  if (!usable.length) return ''
  return [
    '## 密钥保险箱',   // i18n-ignore 注入系统提示
    '用户在密钥保险箱里存了下列密钥（密码 / token 等）。你永远看不到它们的值；需要用到时在 exec_in_terminal / exec_on_terminals / start_background 的 command 里写占位符 {{secret:名称}}，'   // i18n-ignore 注入系统提示
      + '应用在命令真正发进终端前才把它换成真实值（按所在引号自动转义成一个字面量：不在引号里时直接写，如 mysql -uroot -p{{secret:mysql-root}}；放在双引号里也可以，如 -H "Authorization: Bearer {{secret:api-token}}"）。',   // i18n-ignore 注入系统提示
    '- 工具结果、终端快照里出现的真实值会被换回占位符，所以你看到 {{secret:名称}} 是正常的，不要尝试 echo / cat / base64 等方式去获取真实值。',   // i18n-ignore 注入系统提示
    '- 每个密钥有可用范围，不在范围内的终端上使用会被直接拒绝；run_on_hosts 与 write_file 不支持占位符（要写进文件请用 exec_in_terminal 执行 printf 等命令）。',   // i18n-ignore 注入系统提示
    '- 授权卡与执行记录上显示的是占位符原文；不要把真实值写进知识卡、计划或回复。',   // i18n-ignore 注入系统提示
    ...usable.map((s) => `- {{secret:${s.name}}}${s.description ? `：${s.description}` : ''}（可用范围：${secretScopeLabel(s, hostLabel)}）`),   // i18n-ignore 注入系统提示
  ].join('\n')
}
