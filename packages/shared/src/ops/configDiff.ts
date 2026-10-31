// 配置按键对比（纯函数）：.env / properties / ini / yaml / json / toml 拍平成「键路径 → 值」，按键对齐比较两份配置，
// 不受顺序、缩进、注释影响。敏感值（键名像密码 / 令牌，或值命中脱敏规则）默认遮挡。界面见 ui/terminals/ConfigKeyCompare.tsx
import { redactSecrets } from '../ai/redact.js'
import { tk, tr } from '../i18n/i18n.js'

export type ConfigFormat = 'env' | 'properties' | 'ini' | 'yaml' | 'json' | 'toml'
export const CONFIG_FORMATS: { id: ConfigFormat; label: string }[] = [
  { id: 'env', label: '.env' }, { id: 'properties', label: 'properties' }, { id: 'ini', label: 'ini / conf' },
  { id: 'yaml', label: 'YAML' }, { id: 'json', label: 'JSON' }, { id: 'toml', label: 'TOML' },
]

export type ConfigMap = Map<string, string>
export type DiffStatus = 'same' | 'diff' | 'onlyA' | 'onlyB'
export interface ConfigDiffRow { key: string; a?: string; b?: string; status: DiffStatus; sensitive: boolean }

/** 按文件名认格式，认不出再看内容 */
export function detectConfigFormat(path: string, text: string): ConfigFormat {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'env'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  if (ext === 'properties') return 'properties'
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  if (ext === 'json' || ext === 'jsonc') return 'json'
  if (ext === 'toml') return 'toml'
  if (ext === 'ini' || ext === 'cfg' || ext === 'cnf') return 'ini'
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[') && /^\[\s*[{"\d\]]/.test(t)) return 'json'
  if (/^\s*\[[^\]\n]+\]\s*$/m.test(text)) return 'ini'
  if (/^\s*[\w.-]+\s*:(\s|$)/m.test(text)) return 'yaml'
  return 'env'
}

const unquote = (v: string): string => {
  const s = v.trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const body = s.slice(1, -1)
    return s[0] === '"' ? body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1') : body
  }
  return s
}
// 行内注释：引号外、前面是空白的 #（.env / yaml / toml）或 ;（ini）
function stripInlineComment(v: string, marks = '#'): string {
  let q = ''
  for (let i = 0; i < v.length; i++) {
    const c = v[i]
    if (q) { if (c === q && v[i - 1] !== '\\') q = ''; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (marks.includes(c) && (i === 0 || /\s/.test(v[i - 1]))) return v.slice(0, i).trimEnd()
  }
  return v
}

function parseEnv(text: string): ConfigMap {
  const m: ConfigMap = new Map()
  const L = text.split(/\r?\n/)
  for (let i = 0; i < L.length; i++) {
    const line = L[i].trim()
    if (!line || line.startsWith('#')) continue
    const r = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line)
    if (!r) continue
    let v = r[2]
    // 双引号值跨多行
    if (v.startsWith('"') && !/^"(?:[^"\\]|\\.)*"/.test(v)) {
      while (i + 1 < L.length) { v += '\n' + L[++i]; if (/"\s*(#.*)?$/.test(L[i])) break }
    }
    m.set(r[1], unquote(stripInlineComment(v)))
  }
  return m
}

function parseProperties(text: string): ConfigMap {
  const m: ConfigMap = new Map()
  const L = text.split(/\r?\n/)
  for (let i = 0; i < L.length; i++) {
    let line = L[i].replace(/^\s+/, '')
    if (!line || line[0] === '#' || line[0] === '!') continue
    // 行尾奇数个反斜杠 = 续行
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < L.length) line = line.slice(0, -1) + L[++i].replace(/^\s+/, '')
    const r = /^((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(line)
    const key = (r ? r[1] : line).replace(/\\(.)/g, '$1')
    m.set(key, r ? r[2].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)) : '')
  }
  return m
}

function parseIni(text: string): ConfigMap {
  const m: ConfigMap = new Map()
  let sec = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '#' || line[0] === ';') continue
    const s = /^\[([^\]]+)\]/.exec(line)
    if (s) { sec = s[1].trim(); continue }
    const r = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line)
    const key = (r ? r[1] : line).trim()
    m.set(sec ? `${sec}.${key}` : key, r ? unquote(stripInlineComment(r[2], '#;')) : '')
  }
  return m
}

function flattenValue(m: ConfigMap, prefix: string, v: unknown): void {
  if (Array.isArray(v)) {
    if (!v.length) m.set(prefix, '[]')
    v.forEach((x, i) => flattenValue(m, `${prefix}[${i}]`, x))
  } else if (v && typeof v === 'object') {
    const ks = Object.keys(v)
    if (!ks.length) m.set(prefix, '{}')
    for (const k of ks) flattenValue(m, prefix ? `${prefix}.${k}` : k, (v as Record<string, unknown>)[k])
  } else m.set(prefix, v === null ? 'null' : String(v))
}

function parseJson(text: string): ConfigMap {
  // 允许 jsonc 的整行 // 注释与结尾逗号
  const t = text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
  const m: ConfigMap = new Map()
  flattenValue(m, '', JSON.parse(t))
  return m
}

// 流式集合 / 复杂值不展开，压掉多余空白后整体比
const normFlow = (v: string) => v.replace(/\s*([,:[\]{}])\s*/g, '$1').replace(/,([\]}])/g, '$1').replace(/:(?=\S)/g, ': ').trim()

function parseToml(text: string): ConfigMap {
  const m: ConfigMap = new Map()
  let table = ''
  const arrCount = new Map<string, number>()
  const L = text.split(/\r?\n/)
  const keyPath = (k: string) => (k.match(/"[^"]*"|'[^']*'|[^.]+/g) ?? []).map((s) => unquote(s.trim())).join('.')
  for (let i = 0; i < L.length; i++) {
    const line = L[i].trim()
    if (!line || line.startsWith('#')) continue
    let h = /^\[\[([^\]]+)\]\]/.exec(line)
    if (h) {
      const base = keyPath(h[1]), n = arrCount.get(base) ?? 0
      arrCount.set(base, n + 1); table = `${base}[${n}]`; continue
    }
    h = /^\[([^\]]+)\]/.exec(line)
    if (h) { table = keyPath(h[1]); continue }
    const r = /^((?:"[^"]*"|'[^']*'|[^=])+?)\s*=\s*(.*)$/.exec(line)
    if (!r) continue
    let v = r[2]
    // 多行字符串 """ / ''' 与跨行数组
    const tq = v.startsWith('"""') ? '"""' : v.startsWith("'''") ? "'''" : ''
    if (tq && !v.slice(3).includes(tq)) { while (i + 1 < L.length) { v += '\n' + L[++i]; if (L[i].includes(tq)) break } }
    else if (v.startsWith('[') && (v.split('[').length > v.split(']').length)) { while (i + 1 < L.length && v.split('[').length > v.split(']').length) v += ' ' + L[++i].trim() }
    v = tq ? v.slice(3, v.lastIndexOf(tq)).replace(/^\r?\n/, '') : stripInlineComment(v)
    const key = keyPath(r[1])
    m.set(table ? `${table}.${key}` : key, tq ? v : /^[[{]/.test(v) ? normFlow(v) : unquote(v))
  }
  return m
}

// YAML：只认配置文件里常见的块结构（映射、列表、块标量 | >），流式集合整体当值；锚点 / 别名原样当文本
function parseYaml(text: string): ConfigMap {
  const m: ConfigMap = new Map()
  // 栈帧：indent = 该层所在缩进；item = 列表项帧（同缩进的下一个「-」要弹掉它）；next / listAt = 子列表下一个下标及其缩进
  type Frame = { indent: number; path: string; item?: boolean; next?: number; listAt?: number }
  const stack: Frame[] = [{ indent: -1, path: '' }]
  const L = text.split(/\r?\n/)
  const join = (p: string, k: string) => (p ? `${p}.${k}` : k)
  const scalar = (v: string) => { const s = stripInlineComment(v).trim(); return /^[[{]/.test(s) ? normFlow(s) : unquote(s) }
  const KV = /^((?:"[^"]*"|'[^']*'|[^:#'"])+?)\s*:(?:\s+(.*)|$)/
  const BLOCK = /^([|>])[+-]?\d*\s*(#.*)?$/
  // 块标量：收集比 indent 更深的行，返回值与最后一行下标
  const block = (i: number, indent: number, folded: boolean): [string, number] => {
    const out: string[] = []
    let j = i + 1, base = -1
    for (; j < L.length; j++) {
      const l = L[j]
      if (!l.trim()) { out.push(''); continue }
      const ind = l.length - l.trimStart().length
      if (ind <= indent) break
      if (base < 0) base = ind
      out.push(l.slice(base))
    }
    while (out.length && !out[out.length - 1]) { out.pop(); j-- }
    return [folded ? out.join(' ').replace(/ {2,}/g, ' ') : out.join('\n'), j - 1]
  }
  // 处理一行（列表项里的「- key: v」会以项内缩进再进来一次）；返回处理到的行下标
  const line = (i: number, ind: number, c: string): number => {
    const isItem = c === '-' || c.startsWith('- ')
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      if (top.indent > ind || (top.indent === ind && (!isItem || top.item))) stack.pop(); else break
    }
    const top = stack[stack.length - 1]
    if (isItem) {
      if (top.listAt !== ind) { top.listAt = ind; top.next = 0 }
      const path = `${top.path}[${top.next!++}]`
      const rest = c.slice(1).trimStart()
      stack.push({ indent: ind, path, item: true })
      if (!rest) return i
      if (KV.test(rest) && !/^[[{]/.test(rest)) return line(i, ind + (c.length - rest.length), rest)
      const bs = BLOCK.exec(rest)
      if (bs) { const [v, j] = block(i, ind, bs[1] === '>'); m.set(path, v); return j }
      m.set(path, scalar(rest))
      return i
    }
    const kv = KV.exec(c)
    if (!kv) return i
    const key = join(top.path, unquote(kv[1].trim()))
    const v = (kv[2] ?? '').trim()
    const bs = BLOCK.exec(v)
    if (bs) { const [s, j] = block(i, ind, bs[1] === '>'); m.set(key, s); return j }
    if (!v || v.startsWith('#') || /^&\S+$/.test(v)) { stack.push({ indent: ind, path: key }); m.set(key, ''); return i }   // 子级在后面
    m.set(key, scalar(v))
    return i
  }
  for (let i = 0; i < L.length; i++) {
    const raw = L[i], t = raw.trim()
    if (!t || t.startsWith('#') || t === '---' || t === '...' || t.startsWith('%')) continue
    i = line(i, raw.length - raw.trimStart().length, t)
  }
  // 有子级的键自身不单独列（上面先占了个空值）
  for (const k of [...m.keys()]) if (m.get(k) === '' && [...m.keys()].some((x) => x !== k && (x.startsWith(`${k}.`) || x.startsWith(`${k}[`)))) m.delete(k)
  return m
}

export function flattenConfig(text: string, fmt: ConfigFormat): ConfigMap {
  const t = text.replace(/^\uFEFF/, '')
  switch (fmt) {
    case 'env': return parseEnv(t)
    case 'properties': return parseProperties(t)
    case 'ini': return parseIni(t)
    case 'json': return parseJson(t)
    case 'toml': return parseToml(t)
    case 'yaml': return parseYaml(t)
  }
}

/** 解析失败不抛：返回错误文字 */
export function tryFlatten(text: string, fmt: ConfigFormat): { map: ConfigMap } | { error: string } {
  try { return { map: flattenConfig(text, fmt) } } catch (e) { return { error: tr('按 {fmt} 解析失败：{err}', { fmt: CONFIG_FORMATS.find((f) => f.id === fmt)?.label ?? fmt, err: e instanceof Error ? e.message : String(e) }) } }
}

// 键名里像密码 / 令牌的（取最后两段判断，避免 keyboard.layout 之类误伤）
const SENSITIVE_KEY = /(pass(word|wd|phrase)?|pwd|secret|token|credential|private|api[_-]?key|access[_-]?key|(^|[._-])key$|auth|cookie|salt|signature|dsn|connection[_-]?string)/i
export function isSensitiveKey(key: string): boolean {
  const tail = key.replace(/\[\d+\]/g, '').split('.').slice(-2).join('.')
  return SENSITIVE_KEY.test(tail)
}
/** 键名敏感，或值本身命中脱敏规则（如值里带 Bearer / 私钥 / sk-xxx） */
export const isSensitiveEntry = (key: string, ...vals: (string | undefined)[]): boolean =>
  isSensitiveKey(key) || vals.some((v) => !!v && redactSecrets(`${key}=${v}`) !== `${key}=${v}`)

export const MASK = '●●●●●●'

export function diffConfigs(a: ConfigMap, b: ConfigMap): ConfigDiffRow[] {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y))
  return keys.map((key) => {
    const va = a.get(key), vb = b.get(key)
    const status: DiffStatus = va === undefined ? 'onlyB' : vb === undefined ? 'onlyA' : va === vb ? 'same' : 'diff'
    return { key, ...(va !== undefined ? { a: va } : {}), ...(vb !== undefined ? { b: vb } : {}), status, sensitive: isSensitiveEntry(key, va, vb) }
  })
}

export const diffCounts = (rows: ConfigDiffRow[]) => ({
  same: rows.filter((r) => r.status === 'same').length, diff: rows.filter((r) => r.status === 'diff').length,
  onlyA: rows.filter((r) => r.status === 'onlyA').length, onlyB: rows.filter((r) => r.status === 'onlyB').length,
})

export const DIFF_STATUS_LABEL: Record<DiffStatus, string> = { same: tk('相同'), diff: tk('值不同'), onlyA: tk('只在 A'), onlyB: tk('只在 B') }

// 表格单元格：值包在代码里，但 | 必须转义（GFM 表格在行内代码之前就按 | 分列）；
// 围栏按内容里最长的反引号串加长，值本身带反引号也不会提前闭合
const mdCell = (s: string): string => {
  const t = s.replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|').slice(0, 200)
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((x) => x.length))
  const f = '`'.repeat(longest + 1)
  // 内容以反引号开头 / 结尾时要两侧各加一个空格（CommonMark 才会把围栏认成代码）
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : ''
  return `${f}${pad}${t}${pad}${f}`
}

/** 给 AI 的差异表：只列不同的键；敏感值一律遮挡，只说两边是否相同 */
export function configDiffQuote(rows: ConfigDiffRow[], a: string, b: string): string {
  const show = (r: ConfigDiffRow, v?: string) => (v === undefined ? tr('（无）') : r.sensitive ? `${MASK}${tr('（敏感值已遮挡）')}` : mdCell(v))
  const diff = rows.filter((r) => r.status !== 'same')
  const L = [tr('按键对比两份配置：A = {a}，B = {b}。共 {n} 个键，不同 {d} 个：', { a, b, n: rows.length, d: diff.length }), '', `| ${tr('键')} | A | B | ${tr('差异')} |`, '|---|---|---|---|']
  for (const r of diff.slice(0, 200)) L.push(`| ${mdCell(r.key)} | ${show(r, r.a)} | ${show(r, r.b)} | ${tr(DIFF_STATUS_LABEL[r.status])} |`)
  if (diff.length > 200) L.push(`| … | | | ${tr('另有 {n} 个', { n: diff.length - 200 })} |`)
  L.push('', tr('请解释这些差异可能带来的影响（如环境不同导致的行为差异），指出可能配错的项。'))
  return L.join('\n')
}
