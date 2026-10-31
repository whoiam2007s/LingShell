// 日志查看器的纯逻辑：环形缓冲、过滤、着色分段、问 AI 引用（LogViewer.tsx 用，可单测）
import { tr, type HighlightColor, type HighlightRule, type LogInsight } from '@lingshell/shared'

export interface LogLine { n: number; text: string; h?: number }   // n：递增序号（React key / 选中用）；h：多主机日志里来自第几台
export type LogIn = string | { text: string; h?: number }
export const DEFAULT_MAX_LINES = 10_000
export const MAX_LINES_CHOICES = [1_000, 5_000, 10_000, 50_000]
export const PAUSE_BUFFER_MAX = 50_000   // 暂停时最多攒这么多行，再多丢最早的

/** 追加新行并截到最多 max 行（丢最早的）；next 是下一个序号 */
export function appendLines(buf: LogLine[], texts: LogIn[], max: number, next: number): { lines: LogLine[]; next: number } {
  if (!texts.length) return { lines: buf.length > max ? buf.slice(-max) : buf, next }
  const add = texts.slice(-max).map((t, i) => ({ ...(typeof t === 'string' ? { text: t } : t), n: next + texts.length - Math.min(texts.length, max) + i }))
  const all = buf.concat(add)
  return { lines: all.length > max ? all.slice(all.length - max) : all, next: next + texts.length }
}

/** 多主机日志：复制 / 问 AI / 导出时每行前面加上主机名 */
export const withHost = (l: Pick<LogLine, 'text' | 'h'>, hosts?: string[]) => (hosts && l.h !== undefined ? `[${hosts[l.h] ?? l.h}] ${l.text}` : l.text)

/** 暂停缓冲：攒着新行，超上限丢最早的；dropped 累计丢弃数 */
export function bufferPaused<T = string>(p: { lines: T[]; dropped: number }, texts: T[], cap = PAUSE_BUFFER_MAX): { lines: T[]; dropped: number } {
  const all = p.lines.concat(texts)
  const over = all.length - cap
  return over > 0 ? { lines: all.slice(over), dropped: p.dropped + over } : { lines: all, dropped: p.dropped }
}

export interface FilterOpts { query: string; regex: boolean; caseSensitive: boolean }
/** 编译过滤条件：空 → 无过滤；非法正则 / 能匹配空串的正则 → error */
export function compileFilter(o: FilterOpts): { re?: RegExp; error?: string } {
  if (!o.query) return {}
  const flags = o.caseSensitive ? 'g' : 'gi'
  try {
    const re = new RegExp(o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    if (re.test('')) return { error: tr('正则会匹配空字符串') }
    return { re }
  } catch (e) { return { error: tr('正则有误：{msg}', { msg: (e as Error).message }) } }
}

const hit = (re: RegExp, s: string) => { re.lastIndex = 0; return re.test(s) }
/** 只看匹配行：按过滤筛；否则全部（匹配处另行高亮） */
export function visibleLines(lines: LogLine[], re: RegExp | undefined, onlyMatch: boolean): LogLine[] {
  return re && onlyMatch ? lines.filter((l) => hit(re, l.text)) : lines
}
export function countMatches(lines: LogLine[], re: RegExp | undefined): number {
  if (!re) return 0
  let c = 0
  for (const l of lines) if (hit(re, l.text)) c++
  return c
}

// 级别着色：复用终端的关键字高亮规则（设置 → 终端 → 关键字高亮），颜色取终端配色主题
export interface ColorRule { re: RegExp; color: HighlightColor; bold?: boolean }
export function compileColorRules(rules: HighlightRule[] | undefined): ColorRule[] {
  const out: ColorRule[] = []
  for (const r of rules ?? []) {
    if (!r.enabled || !r.pattern) continue
    try {
      const re = new RegExp(r.isRegex ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), r.caseSensitive ? 'g' : 'gi')
      if (!re.test('')) out.push({ re, color: r.color, bold: r.bold })
    } catch { /* 非法正则忽略 */ }
  }
  return out
}

export interface Seg { text: string; color?: HighlightColor; bold?: boolean; mark?: boolean }
type Range = { s: number; e: number }
// 不重叠的命中区间：先开始者优先，同起点按规则顺序
function ranges<T>(text: string, list: { re: RegExp; v: T }[]): (Range & { v: T })[] {
  const all: (Range & { v: T; o: number })[] = []
  list.forEach(({ re, v }, o) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue }
      all.push({ s: m.index, e: m.index + m[0].length, v, o })
    }
  })
  all.sort((a, b) => a.s - b.s || a.o - b.o)
  const out: (Range & { v: T })[] = []
  let end = 0
  for (const r of all) if (r.s >= end) { out.push(r); end = r.e }
  return out
}

/** 一行切成着色段：关键字颜色 + 过滤命中标记（两者可叠加） */
export function segments(text: string, colors: ColorRule[], filter?: RegExp): Seg[] {
  const cr = ranges(text, colors.map((c) => ({ re: c.re, v: c })))
  const mr = filter ? ranges(text, [{ re: filter, v: true }]) : []
  if (!cr.length && !mr.length) return [{ text }]
  const cuts = new Set<number>([0, text.length])
  for (const r of [...cr, ...mr]) { cuts.add(r.s); cuts.add(r.e) }
  const pts = [...cuts].sort((a, b) => a - b)
  const out: Seg[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i], e = pts[i + 1]
    const c = cr.find((r) => r.s <= s && e <= r.e)?.v
    const seg: Seg = { text: text.slice(s, e) }
    if (c) { seg.color = c.color; if (c.bold) seg.bold = true }
    if (mr.some((r) => r.s <= s && e <= r.e)) seg.mark = true
    out.push(seg)
  }
  return out
}

/** 选中行的范围（shift 点选）：返回 [from, to] 序号闭区间内、当前可见的行 */
export function pickRange(visible: LogLine[], a: number, b: number): Set<number> {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return new Set(visible.filter((l) => l.n >= lo && l.n <= hi).map((l) => l.n))
}

export const QUOTE_MAX_CHARS = 12_000
/** 问 AI：选中日志 + 来源，放进对话输入框（已脱敏的文本由调用方传入） */
export function logQuote(source: string, host: string, text: string): string {
  const body = text.length > QUOTE_MAX_CHARS ? `${tr('…（前面省略 {n} 字）', { n: text.length - QUOTE_MAX_CHARS })}\n${text.slice(-QUOTE_MAX_CHARS)}` : text
  const fence = '```'
  return `${tr('「{host}」上的日志 {source}：', { host, source })}\n${fence}\n${body.replace(/\s+$/, '')}\n${fence}\n`
}

/** 把缓冲同步进洞察归并（增量）：只处理比上次新的行，缓冲丢掉的最早行同步扣减；缓冲清空则清空。幂等，可在渲染时调用 */
export function syncInsight(x: LogInsight, lines: LogLine[], now = Date.now()): void {
  if (!lines.length) { if (x.size) x.clear(); return }
  const last = x.lastN
  let i = lines.length
  while (i > 0 && (last === undefined || lines[i - 1].n > last)) i--
  for (let k = i; k < lines.length; k++) x.add(lines[k].n, lines[k].text, now)
  x.evictBefore(lines[0].n)
}

/** 原始视图按洞察侧栏的选择再筛：某个模式 / 某段时间 */
export function insightFilter(lines: LogLine[], x: LogInsight, fp?: string, range?: { from: number; to: number }): LogLine[] {
  if (!fp && !range) return lines
  return lines.filter((l) => {
    const m = x.meta(l.n)
    if (!m) return false
    if (range && (m.t < range.from || m.t >= range.to)) return false
    return !fp || m.fp === fp
  })
}
