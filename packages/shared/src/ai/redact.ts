// 脱敏（纯函数）：会话导出（report.ts）与「发给 AI 前脱敏」（dsh-controller/redaction.ts）共用。
// 两层：已知机密明文精确替换（redactKnown）+ 按样式识别（redactSecrets）。尽力而为，不是保证。

export const REDACTED = '[已脱敏]'   // i18n-ignore 占位符本身：发给模型、被匹配拒绝写回，不随界面语言变
const R = REDACTED

// 环境变量风格的键（全大写下划线）：某一段是 PASS/SECRET/TOKEN/…KEY 之类就算敏感
const ENV_SEG = /^(?:PASS(?:WORD|WD|PHRASE)?|SECRETS?|TOKENS?|[A-Z]*KEYS?|CREDENTIALS?)$/
function envValue(m: string, key: string, val: string): string {
  const segs = key.slice(0, -1).split('_')
  if (val.includes(R) || !segs.some((s) => ENV_SEG.test(s) || (s === 'PWD' && segs.length > 1))) return m
  const q = val[0] === '"' || val[0] === "'" ? val[0] : ''
  return `${key}${q}${R}${q}`
}

// 私钥块；没有 END 的（输出被截断）抹到末尾
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g

// 顺序有讲究：先整块（私钥）、再带前缀的（Bearer / URL 凭据 / mysql -p），最后 key=value
const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [PRIVATE_KEY_BLOCK, R],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${R}`],
  [/\b(Authorization\s*[:=]\s*(?:Basic\s+|Bearer\s+)?)(?!\[|Basic\b|Bearer\b)[^\s'",]+/gi, `$1${R}`],
  [/\b([a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${R}@`],
  [/(\b(?:mysql|mysqldump|mysqladmin)\b[^\n]*?\s-p)(?!\s)[^\s'"]+/g, `$1${R}`],
  [/(\bsshpass\s+-p\s*)(?!\[)\S+/g, `$1${R}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  // JWT：header.payload 都是 base64url 的 JSON（eyJ 开头），签名段可空（alg=none）
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, R],
  // cookie：curl -i / 开发者工具复制出来的响应头与请求头
  [/\b(Set-Cookie\s*:\s*[^=;\s]+=)[^;\r\n]+/gi, `$1${R}`],
  [/(?<![\w-])(Cookie\s*:\s*)(?!\[)[^\r\n]+/gi, `$1${R}`],
  // env / .env / docker -e：DB_PASS=… GITHUB_TOKEN="…"（值整段，含引号内空格）
  [/(?<![\w$.-])([A-Z][A-Z0-9_]*=)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g, envValue],
  // 键名以敏感词结尾（password= / api_key: / "access_token": / AWS_SECRET_ACCESS_KEY=），不碰 inputTokens: 这类
  [/\b(\w*(?:password|passwd|passphrase|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)(["']?)(?!\[已脱敏\])[^\s"'&,;]+/gi, `$1$2${R}`],
]
export function redactSecrets(text: string): string {
  return RULES.reduce((s, [re, to]) => (typeof to === 'string' ? s.replace(re, to) : s.replace(re, to)), text)
}

// 短于这个长度的已知值不替换：太短的串（如 "admin"）到处都是，替换了输出没法看
export const MIN_SECRET_LEN = 6

/** 已知机密明文精确替换（不走正则，特殊字符无需转义）。长的先换，免得短值先把长值拆碎；也换 JSON 转义后的形式 */
export function redactKnown(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>()
  for (const s of secrets) {
    if (typeof s !== 'string') continue
    for (const v of [s, s.trim()]) for (const f of [v, JSON.stringify(v).slice(1, -1)]) if (f.length >= MIN_SECRET_LEN) forms.add(f)
  }
  let out = text
  for (const f of [...forms].sort((a, b) => b.length - a.length)) if (out.includes(f)) out = out.split(f).join(R)
  return out
}

export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactSecrets(redactKnown(text, secrets))
}

/** 逐行脱敏且保持行号（配置文件解释 / 部署评审按行标注）：私钥块整块按行遮掉（首行占位、其余行置空），再逐行跑规则 */
export function redactLines(text: string, secrets: readonly string[] = []): string {
  const blocked = text.replace(PRIVATE_KEY_BLOCK, (m) => m.split('\n').map((_, i) => (i ? '' : R)).join('\n'))
  return blocked.split('\n').map((l) => redactText(l, secrets)).join('\n')
}

// 密钥保险箱占位符 {{secret:名称}} 不能被样式脱敏误伤（「secret:」会被当成 key: value 抹成 [已脱敏]）：
// 脱敏前换成私用区字符包着的序号（JSON 合法、不匹配任何规则），脱敏后换回
const SECRET_REF = /\{\{secret:[a-z0-9_-]{1,64}\}\}/g
export function keepSecretRefs(text: string, f: (s: string) => string): string {
  const keep: string[] = []
  const t = text.replace(SECRET_REF, (m) => `${keep.push(m) - 1}`)
  return keep.length ? f(t).replace(/(\d+)/g, (_, i: string) => keep[Number(i)]) : f(t)
}

/**
 * 发给模型前的统一入口：mask（密钥保险箱明文 → {{secret:名称}}）先做，且不受「发给 AI 前脱敏」开关影响；
 * secrets 为 undefined 表示开关关着，只做 mask。lines = 保持行号（逐行脱敏）；tool = 工具结果（JSON 逐字段）。
 */
export function redactAi(text: string, secrets: readonly string[] | undefined, mask?: (s: string) => string, opts: { lines?: boolean; tool?: boolean } = {}): string {
  const masked = mask ? (opts.lines ? text.split('\n').map(mask).join('\n') : mask(text)) : text
  if (!secrets) return masked
  const f = opts.lines ? (s: string) => redactLines(s, secrets) : opts.tool ? (s: string) => redactToolText(s, secrets) : (s: string) => redactText(s, secrets)
  return keepSecretRefs(masked, f)
}

// JSON 里键名本身敏感的字符串值整个换掉（分页游标 page_token 除外，换了没法翻页）
const SECRET_FIELD = /(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i
function walk(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, f))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, typeof x === 'string' && x && !x.includes(R) && SECRET_FIELD.test(k) && !/page[_-]?token$/i.test(k) ? R : walk(x, f)]))
  }
  return v
}

/**
 * 工具结果文本脱敏。是 JSON 就逐个字符串值处理再序列化回去（直接对 JSON 文本跑正则，
 * 转义后的 \n 会让「到行尾」的规则吞掉后面的字段）；没改动则原样返回（保格式、幂等）。
 */
export function redactToolText(text: string, secrets: readonly string[] = []): string {
  const f = (s: string) => redactText(s, secrets)
  if (/^\s*[[{]/.test(text)) {
    try {
      const j: unknown = JSON.parse(text)
      const out = walk(j, f)
      const s = JSON.stringify(out, null, text.includes('\n') ? 2 : undefined)
      return s === JSON.stringify(j, null, text.includes('\n') ? 2 : undefined) ? text : s
    } catch { /* 不是 JSON，按文本 */ }
  }
  return f(text)
}

/** 任意值（工具入参）里有没有占位符 */
export function hasPlaceholder(v: unknown): boolean {
  if (typeof v === 'string') return v.includes(R)
  if (Array.isArray(v)) return v.some(hasPlaceholder)
  if (v && typeof v === 'object') return Object.values(v).some(hasPlaceholder)
  return false
}
