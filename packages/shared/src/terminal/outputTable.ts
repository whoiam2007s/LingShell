// 命令输出 → 表格 / JSON 树（终端红点菜单「表格查看」、命令块旁的「⊞ 表格」用）。全是纯函数。
// 表格：有表头时按表头各列的位置切——每个词归到与它「重叠」的表头列（左对齐的值从列头起，右对齐的数字在列头末尾结束，都会和列头重叠）；
// 不和任何列头重叠的词（如 docker ps 里「Exited (0) 3 days ago」超出列头宽度的部分）归到它左边最近的列，所以列值可以含空格，最后一列吞掉剩余。
// 位置一律按显示宽度算（中文 / 全角占 2 格），和终端里看到的对齐方式一致。认不出表头时退化为按空白分隔；界面可手动切「按空白分隔 / 按固定宽度」。

import { tk, tr } from '../i18n/i18n.js'

export type TableMode = 'auto' | 'whitespace' | 'fixed'
export interface OutTable {
  columns: string[]
  rows: string[][]
  mode: 'fixed' | 'whitespace' | 'json'   // 实际用的切法
  header: boolean                          // 第一行是不是当表头用了（false 时列名是「列1、列2…」）
}
export type OutputView =
  | { kind: 'json'; value: unknown; table?: OutTable }   // table：JSON 是对象数组时也能看表格
  | { kind: 'table'; table: OutTable }
  | { kind: 'empty' }

// ── 显示宽度 ──
export function charWidth(cp: number): number {
  if (cp < 0x1100) return 1
  if ((cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2
  return 1
}
export const strWidth = (s: string) => { let w = 0; for (const ch of s) w += charWidth(ch.codePointAt(0)!); return w }

// 一行里的词：显示列 [s, e) 和字符串下标 [i0, i1)
interface Tok { s: number; e: number; i0: number; i1: number; text: string }
function tokens(line: string): Tok[] {
  const out: Tok[] = []
  let col = 0, cur: Tok | null = null
  for (let i = 0; i < line.length;) {
    const cp = line.codePointAt(i)!, n = cp > 0xffff ? 2 : 1, w = charWidth(cp)
    if (cp === 32) { if (cur) { out.push(cur); cur = null } }
    else if (!cur) cur = { s: col, e: col + w, i0: i, i1: i + n, text: '' }
    else { cur.e = col + w; cur.i1 = i + n }
    col += w; i += n
  }
  if (cur) out.push(cur)
  for (const t of out) t.text = line.slice(t.i0, t.i1)
  return out
}

// 去控制字符、Tab 展开成空格（8 格制表位）、去行尾空白
export function outputLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const s = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return s.split('\n').map((l) => {
    if (!l.includes('\t')) return l.trimEnd()
    let o = '', w = 0
    for (const ch of l) { if (ch === '\t') { const k = 8 - (w % 8); o += ' '.repeat(k); w += k } else { o += ch; w += charWidth(ch.codePointAt(0)!) } }
    return o.trimEnd()
  })
}

// ── 认命令 ──
// 取管道第一段，去掉 sudo / env / VAR=… / time 前缀
export function baseCommand(cmd: string): string {
  let c = cmd.trim().split(/\s*\|\s*/)[0] ?? ''
  for (;;) {
    const m = /^(sudo(\s+-\S+)*|env|time|nice|command|\w+=\S*)\s+/.exec(c)
    if (!m) break
    c = c.slice(m[0].length)
  }
  return c
}
type Kind = 'docker' | 'kubectl' | 'systemctl' | 'top' | 'ls' | 'netstat' | 'generic'
export function commandKind(cmd: string): Kind | undefined {
  const c = baseCommand(cmd)
  if (/^(docker|podman|nerdctl)\s+((container|image|volume|network)\s+(ls|list|ps)|ps|images|stats|top)\b/.test(c)) return 'docker'
  if (/^(kubectl|oc|k3s\s+kubectl)\s+(\S+\s+)*get\b/.test(c)) return 'kubectl'
  if (/^systemctl\s+(\S+\s+)*(list-units|list-unit-files|list-timers|list-sockets)\b/.test(c)) return 'systemctl'
  if (/^top\b.*\s-\w*b/.test(c) || /^top\s+-b/.test(c)) return 'top'
  if (/^ll\b/.test(c) || /^ls\s+(.*\s)?-\w*l/.test(c)) return 'ls'
  if (/^netstat\b/.test(c)) return 'netstat'
  if (/^(df|ps|ss|free|lsblk|lsof|vmstat|iostat|mpstat|pidstat|w|who|last|ip\s+-br|nvidia-smi\s+--query|crictl\s+(ps|images|pods)|helm\s+(list|ls))\b/.test(c)) return 'generic'
  return undefined
}
/** 命令块旁要不要给「⊞ 表格」入口：命令可识别，或输出像 JSON */
export const tableRecognizable = (cmd: string, output?: string): boolean => !!commandKind(cmd) || (output !== undefined && parseJsonOutput(output) !== undefined)

// ── JSON ──
/** 整段是 JSON（对象 / 数组），或每行一个 JSON 对象（JSON Lines，如 docker ps --format '{{json .}}'）→ 解析结果；否则 undefined */
export function parseJsonOutput(text: string): unknown {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined
  try { return JSON.parse(t) } catch { /* 可能是 JSON Lines */ }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2 || !lines.every((l) => l[0] === '{')) return undefined
  try { return lines.map((l) => JSON.parse(l)) } catch { return undefined }
}
const isPlainObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const cellOf = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))
/** 对象数组 → 表格（列 = 各对象键的并集，按出现顺序，最多 60 列） */
export function jsonToTable(v: unknown): OutTable | undefined {
  if (!Array.isArray(v) || !v.length || !v.every(isPlainObj)) return undefined
  const cols: string[] = []
  for (const o of v) for (const k of Object.keys(o)) if (!cols.includes(k) && cols.length < 60) cols.push(k)
  return { columns: cols, rows: v.map((o) => cols.map((k) => cellOf(o[k]))), mode: 'json', header: true }
}
/** jq 风格路径：.a[2].b / .["带 空格"] */
export function jsonPath(path: (string | number)[]): string {
  const p = path.map((k) => (typeof k === 'number' ? `[${k}]` : /^[A-Za-z_][\w]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('')
  return p.startsWith('.') ? p : `.${p}`
}
/** JSON 搜索：键名 / 值（不分大小写）命中的节点及其所有祖先的路径（jsonPath），hits = 命中个数 */
export function jsonSearch(value: unknown, q: string): { keep: Set<string>; hits: number } {
  const keep = new Set<string>(), s = q.trim().toLowerCase()
  let hits = 0
  if (!s) return { keep, hits }
  const walk = (v: unknown, path: (string | number)[]): boolean => {
    const key = path.length ? String(path[path.length - 1]) : ''
    let hit = key.toLowerCase().includes(s) && typeof path[path.length - 1] === 'string'
    if (v !== null && typeof v === 'object') {
      const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)
      let child = false
      for (const [k, x] of entries) if (walk(x, [...path, k])) child = true
      if (hit) hits++
      if (hit || child) keep.add(jsonPath(path))
      return hit || child
    }
    if (String(v).toLowerCase().includes(s)) hit = true
    if (hit) { hits++; keep.add(jsonPath(path)) }
    return hit
  }
  walk(value, [])
  return { keep, hits }
}

// ── 表格解析 ──
// 单空格隔开、但其实是一个列名的表头（df / netstat / ss / docker / kubectl 等）
const PHRASES = [
  'mounted on', 'container id', 'image id', 'net i/o', 'block i/o', 'mem usage / limit', 'mem usage', 'cpu %', 'mem %',
  'local address:port', 'peer address:port', 'local address', 'foreign address', 'pid/program name', 'nominated node', 'readiness gates',
  'unit file', 'size/off', 'last login', 'vendor preset',
].map((p) => p.split(' '))

interface Col { name: string; s: number; e: number }
// 列名：单空格隔开的两个词，是已知词组，或者数据里有值从前一个词横跨进后一个词（docker 的 CONTAINER ID 下是 12 位 id）→ 合成一个列名
function headerCols(header: string, data: Tok[][] = []): Col[] {
  const t = tokens(header)
  const gaps = t.slice(1).map((x, i) => x.s - t[i].e)
  const crosses = (a: Tok, b: Tok) => data.some((ks) => ks.some((k) => k.s < a.e && k.e > b.s))
  const cols: Col[] = []
  for (let i = 0; i < t.length;) {
    let n = 1
    for (const p of PHRASES) {
      if (p.length <= n || i + p.length > t.length) continue
      if (p.every((w, k) => t[i + k].text.toLowerCase() === w && (k === 0 || gaps[i + k - 1] === 1))) n = p.length
    }
    while (i + n < t.length && gaps[i + n - 1] === 1 && crosses(t[i + n - 1], t[i + n])) n++
    cols.push({ name: header.slice(t[i].i0, t[i + n - 1].i1), s: t[i].s, e: t[i + n - 1].e })
    i += n
  }
  return cols
}

// 词 → 列：与列头重叠最多的那列；都不重叠 → 左边最近的列（列头起点 ≤ 词起点）；列号不回退（同一行里词的列号单调）
function assign(cols: Col[], toks: Tok[]): number[] {
  let prev = 0
  return toks.map((k) => {
    let best = -1, ov = 0
    cols.forEach((c, i) => { const o = Math.min(c.e, k.e) - Math.max(c.s, k.s); if (o > ov) { ov = o; best = i } })
    if (best < 0) {
      best = 0; cols.forEach((c, i) => { if (c.s <= k.s) best = i })
      // 紧贴下一列列头左边（只差 0~1 格）的短值属于下一列（Git Bash ps 的 TTY「?」比列头靠左一格）；
      // 多词值的续词离下一列至少隔着列间距（docker / kubectl 是 3 格），不受影响
      const next = cols[best + 1]
      if (next && k.s >= cols[best].e && next.s - k.e <= 1 && k.e - k.s <= next.e - next.s) best++
    }
    prev = Math.max(prev, best)
    return prev
  })
}
// 一行按列号拼回：同列的词连同中间原样的空格一起取
function rowByCols(line: string, toks: Tok[], idx: number[], n: number): string[] {
  const out: string[] = Array(n).fill('')
  for (let c = 0; c < n; c++) {
    const ks = toks.filter((_, i) => idx[i] === c)
    if (ks.length) out[c] = line.slice(ks[0].i0, ks[ks.length - 1].i1)
  }
  return out
}

function fixedWithHeader(header: string, data: string[]): OutTable {
  let cols = headerCols(header, data.map(tokens))
  // 第一列没有列头（free 的 Mem: / Swap:）：词整个落在第一个列头左边 → 补一个空名列
  if (cols[0].s > 0 && data.some((l) => { const t = tokens(l)[0]; return t && t.e <= cols[0].s })) cols = [{ name: '', s: 0, e: 0 }, ...cols]
  const rows = data.map((l) => { const t = tokens(l); return rowByCols(l, t, assign(cols, t), cols.length) })
  return { columns: cols.map((c) => c.name), rows, mode: 'fixed', header: true }
}

// 没表头的固定宽度：所有行在同一显示列都是空格 → 列分隔；词按起点落进哪段算哪列
function fixedNoHeader(data: string[]): OutTable {
  const toks = data.map(tokens)
  const W = Math.max(0, ...toks.map((t) => t.at(-1)?.e ?? 0))
  const used = new Uint8Array(W)
  for (const t of toks) for (const k of t) used.fill(1, k.s, k.e)
  const segs: Col[] = []
  for (let p = 0; p < W; p++) {
    if (!used[p]) continue
    const s = p
    while (p < W && used[p]) p++
    segs.push({ name: tr('列{n}', { n: segs.length + 1 }), s, e: p })
  }
  const rows = data.map((l, r) => rowByCols(l, toks[r], toks[r].map((k) => Math.max(0, segs.findIndex((c) => k.s >= c.s && k.s < c.e))), segs.length))
  return { columns: segs.map((c) => c.name), rows, mode: 'fixed', header: false }
}

// 按空白分隔：有表头时列数 = 表头列数，最后一列吞掉剩余；没表头时列数 = 最多的那行（最多 60 列）
function byWhitespace(header: string | undefined, data: string[], fixedNames?: string[]): OutTable {
  const names = fixedNames ?? (header !== undefined ? headerCols(header, data.map(tokens)).map((c) => c.name) : undefined)
  const n = names?.length ?? Math.min(60, Math.max(1, ...data.map((l) => tokens(l).length)))
  const rows = data.map((l) => {
    const t = tokens(l), r = Array<string>(n).fill('')
    t.forEach((k, i) => { if (i < n - 1) r[i] = k.text })
    if (t.length >= n) r[n - 1] = l.slice(t[n - 1].i0)
    return r
  })
  return { columns: names ?? Array.from({ length: n }, (_, i) => tr('列{n}', { n: i + 1 })), rows, mode: 'whitespace', header: !!names }
}

// 像不像表头：至少 2 列；没有纯数字 / 大小这类值；不是 ls -l 的权限串
function looksHeader(line: string): boolean {
  const t = tokens(line).map((k) => k.text)
  if (t.length < 2 || /^[-dlcbps][-rwxsStT]{9}/.test(t[0])) return false
  // 1K-blocks（df）这种以数字开头的列名放行：只拦能当数值 / 时间 / 版本号的
  return t.every((x) => cellNumber(x) === undefined && !/^[-+]?\d[\d.:/,]*$/.test(x))
}

const LS_PERM = /^[-dlcbpsD?][-rwxsStTl]{9}[.+@]?$/
function lsTable(lines: string[]): OutTable | undefined {
  const data = lines.filter((l) => LS_PERM.test(tokens(l)[0]?.text ?? ''))
  if (!data.length) return undefined
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(tokens(data[0])[5]?.text ?? '')
  const columns = (iso ? [tk('权限'), tk('链接数'), tk('所有者'), tk('ls|组'), tk('大小'), tk('日期'), tk('时间'), tk('ls|名称')] : [tk('权限'), tk('链接数'), tk('所有者'), tk('ls|组'), tk('大小'), tk('ls|月'), tk('ls|日'), tk('时间/年'), tk('ls|名称')]).map((c) => tr(c))
  const n = columns.length
  return {
    columns, mode: 'whitespace', header: true,
    rows: data.map((l) => { const t = tokens(l), r = Array<string>(n).fill(''); t.forEach((k, i) => { if (i < n - 1) r[i] = k.text }); if (t.length >= n) r[n - 1] = l.slice(t[n - 1].i0); return r }),
  }
}

const SYSTEMCTL_UNITS = ['UNIT', 'LOAD', 'ACTIVE', 'SUB', 'DESCRIPTION']
const HEADER_HINT: Partial<Record<Kind, RegExp>> = { top: /^\s*PID\s.*\bCOMMAND\b/, netstat: /^Proto\b/ }

/** 把一条命令的输出切成表格 / JSON。mode：auto 自动；whitespace / fixed 手动指定切法（JSON 不受影响） */
export function analyzeOutput(text: string, command = '', mode: TableMode = 'auto'): OutputView {
  const json = parseJsonOutput(text)
  if (json !== undefined && json !== null && typeof json === 'object') return { kind: 'json', value: json, table: jsonToTable(json) }
  const kind = commandKind(command) ?? 'generic'
  let lines = outputLines(text)
  // systemctl 的 ● 前缀（失败的单元）去掉，别把列挤歪
  if (kind === 'systemctl') lines = lines.map((l) => l.replace(/^([●*]) /, '  '))
  while (lines.length && !lines[0].trim()) lines.shift()
  if (kind === 'ls' && mode === 'auto') { const t = lsTable(lines); if (t) return { kind: 'table', table: t } }
  // 表头：特定命令按特征找（top 前面有摘要、netstat 前面有一行说明），否则第一行
  const hint = HEADER_HINT[kind]
  const hi = hint ? Math.max(0, lines.findIndex((l) => hint.test(l))) : 0
  lines = lines.slice(hi)
  // 分组表头（vmstat 的 procs -----memory----- …）：丢掉，用下一行当表头
  if (lines.length > 2 && /-{3,}/.test(lines[0]) && !/^[-\s]+$/.test(lines[0])) lines = lines.slice(1)
  // 数据到第一个空行为止（systemctl 的图例、kubectl 多种资源的第二张表等不算）；netstat -a 的 UNIX 套接字段同样截掉
  const end = lines.findIndex((l, i) => i > 0 && (!l.trim() || /^Active (UNIX|Internet|Bluetooth)/.test(l)))
  lines = end > 0 ? lines.slice(0, end) : lines
  if (!lines.length || !lines.some((l) => l.trim())) return { kind: 'empty' }
  const hasHeader = lines.length > 1 && looksHeader(lines[0]) && (kind !== 'systemctl' || /^\s*(UNIT|NEXT|LISTEN)\b/.test(lines[0]))
  const header = hasHeader ? lines[0] : undefined
  const data = (hasHeader ? lines.slice(1) : lines).filter((l) => l.trim())
  // systemctl list-units --no-legend：没表头，列是固定的 5 个
  if (!hasHeader && kind === 'systemctl' && mode !== 'fixed' && data.every((l) => /\.\w+\s/.test(l.trim()))) {
    const t = byWhitespace(undefined, data.map((l) => l.trim()), SYSTEMCTL_UNITS)
    return { kind: 'table', table: t }
  }
  if (mode === 'whitespace') return { kind: 'table', table: byWhitespace(header, data) }
  if (header !== undefined) return { kind: 'table', table: fixedWithHeader(header, data) }
  return { kind: 'table', table: mode === 'fixed' ? fixedNoHeader(data) : byWhitespace(undefined, data) }
}

// ── 排序 / 过滤 / 导出 ──
const UNIT_POW: Record<string, number> = { '': 0, k: 1, m: 2, g: 3, t: 4, p: 5, e: 6 }
const DUR: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }
const DUR_RE = /^(\d+(?:\.\d+)?(?:ms|[smhdwy]))+$/
/** 一列是不是时长（kubectl AGE 的 5m / 2d3h / 45s）：是的话 5m 按 5 分钟算，不按 5MB */
export const isDurationColumn = (values: string[]) => { const v = values.map((x) => x.trim()).filter(Boolean); return v.length > 0 && v.every((x) => DUR_RE.test(x)) }
/** 单元格的数值：整数 / 小数 / 千分位 / 百分比 / 大小（1.2G、512K、10MB、3.5GiB，按 1024 进位）/ 时长（[[d-]hh:]mm:ss、0:01.23）；认不出 undefined */
export function cellNumber(s: string, duration = false): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  if (duration) {
    if (!DUR_RE.test(t)) return undefined
    let v = 0
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|[smhdwy])/g)) v += Number(m[1]) * DUR[m[2]]
    return v
  }
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''))
  const n = /^([-+]?\d+(?:\.\d+)?|[-+]?\.\d+)\s?(%|([kmgtpe])(i?b)?|b)?$/i.exec(t)
  if (n) return Number(n[1]) * (n[3] ? 1024 ** UNIT_POW[n[3].toLowerCase()] : 1)
  const tm = /^(?:(\d+)-)?(\d+):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/.exec(t)
  if (tm) {
    const parts = [tm[2], tm[3], tm[4]].filter((x) => x !== undefined).map(Number)
    const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
    return Number(tm[1] ?? 0) * 86400 + sec + (tm[5] ? Number(`0.${tm[5]}`) : 0)
  }
  return undefined
}
/** 某列的比较函数（升序）：都是数值按数值；数值排在文字前；文字按自然顺序（含数字的按数字大小）；空值永远最后由调用方处理 */
export function columnComparator(values: string[]): (a: string, b: string) => number {
  const dur = isDurationColumn(values)
  return (a, b) => {
    const x = cellNumber(a, dur), y = cellNumber(b, dur)
    if (x !== undefined && y !== undefined) return x - y
    if (x !== undefined) return -1
    if (y !== undefined) return 1
    return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })
  }
}
/** 排序后的行号：空值不管升降序都排最后；同值保持原顺序 */
export function sortRows(rows: string[][], col: number, desc: boolean): number[] {
  const cmp = columnComparator(rows.map((r) => r[col] ?? ''))
  return rows.map((_, i) => i).sort((i, j) => {
    const a = (rows[i][col] ?? '').trim(), b = (rows[j][col] ?? '').trim()
    if (!a || !b) return !a && !b ? i - j : !a ? 1 : -1
    const d = cmp(a, b)
    return (desc ? -d : d) || i - j
  })
}
/** 过滤：全局搜索（任一列含，空格分隔的词都要命中）+ 每列过滤（该列含），都不分大小写 */
export function filterRows(rows: string[][], order: number[], global: string, perCol: Record<number, string>): number[] {
  const words = global.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const cols = Object.entries(perCol).map(([k, v]) => [Number(k), v.trim().toLowerCase()] as const).filter(([, v]) => v)
  return order.filter((i) => {
    const r = rows[i]
    if (cols.some(([c, v]) => !(r[c] ?? '').toLowerCase().includes(v))) return false
    const hay = r.join('\n').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
const csvCell = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
export const toCsv = (columns: string[], rows: string[][]) => [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
const mdCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
export function toMarkdown(columns: string[], rows: string[][]): string {
  const head = columns.map((c, i) => mdCell(c) || tr('列{n}', { n: i + 1 }))
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n') + '\n'
}
/** 「发给 AI」：命令 + Markdown 表格（行太多只放前 maxRows 行并注明；发给 AI 的话，保持中文） */
export function tableQuote(o: { title: string; command: string; columns: string[]; rows: string[][]; total: number; maxRows?: number }): string {
  const max = o.maxRows ?? 200, rows = o.rows.slice(0, max)
  const more = o.rows.length > max ? `\n（共 ${o.rows.length} 行，只附前 ${max} 行）` : o.rows.length < o.total ? `\n（已按条件过滤：${o.rows.length} / ${o.total} 行）` : ''   // i18n-ignore 发给 AI 的话
  return `终端「${o.title}」里命令 \`${o.command.replace(/`/g, "'").slice(0, 300)}\` 的输出（整理成表格）：\n\n${toMarkdown(o.columns, rows)}${more}\n`   // i18n-ignore 发给 AI 的话
}
