// 日志洞察（纯函数，LogViewer 的「洞察」侧栏用）：时间戳解析、级别识别、模式指纹、增量归并、时间分布、发给 AI 的统计摘要。
// 几万行日志也要跟得上：每行只在到达时算一次（时间 / 级别 / 指纹），之后的 Top 模式、柱状图都只用这些结果。

import { tr } from '../i18n/i18n.js'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const mon = (s: string) => MON[s.toLowerCase()]
const ms = (frac?: string) => (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0)
// 时区：Z / +08:00 / +0800；行里没写时用调用方给的默认时区（日志所在主机的 date +%z），再没有才按本机时区
let defTz: string | undefined
function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, msec: number, tzIn?: string): number {
  const tz = tzIn ?? defTz
  if (!tz) return new Date(y, mo, d, h, mi, s, msec).getTime()
  const off = tz === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.replace(':', '').slice(3, 5)))
  return Date.UTC(y, mo, d, h, mi, s, msec) - off * 60_000
}

export interface LogTime { t: number; start: number; end: number }   // start/end：时间戳在行里的位置（指纹里去掉）
type Fmt = { re: RegExp; at: (m: RegExpExecArray, now: number) => number | undefined }
const FORMATS: Fmt[] = [
  // ISO8601 / Python logging（逗号毫秒）/ Java logback / journalctl -o short-iso / nginx error.log、Go log（斜杠日期）
  { re: /(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(?: ?(Z|[+-]\d{2}:?\d{2})(?![\d:]))?/,
    at: (m) => zoned(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms(m[7]), m[8]) },
  // nginx / apache 访问日志：15/Oct/2026:10:00:01 +0800
  { re: /(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?/,
    at: (m) => mon(m[2]) === undefined ? undefined : zoned(+m[3], mon(m[2]), +m[1], +m[4], +m[5], +m[6], 0, m[7]) },
  // apache error.log：[Thu Oct 15 10:00:01.123456 2026]
  { re: /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{4})/,
    at: (m) => mon(m[1]) === undefined ? undefined : zoned(+m[7], mon(m[1]), +m[2], +m[3], +m[4], +m[5], ms(m[6])) },
  // Tomcat catalina：15-Oct-2026 10:00:01.123
  { re: /(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/,
    at: (m) => mon(m[2]) === undefined ? undefined : zoned(+m[3], mon(m[2]), +m[1], +m[4], +m[5], +m[6], ms(m[7])) },
  // syslog / journalctl 默认（short）：Oct 15 10:00:01（没有年份：取今年，比现在晚一天以上就算去年）；可带 <PRI>
  { re: /^(?:<\d{1,3}>)?([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/,
    at: (m, now) => {
      if (mon(m[1]) === undefined) return undefined
      const y = new Date(now).getFullYear()
      const t = zoned(y, mon(m[1]), +m[2], +m[3], +m[4], +m[5], ms(m[6]))
      return t > now + 86_400_000 ? zoned(y - 1, mon(m[1]), +m[2], +m[3], +m[4], +m[5], ms(m[6])) : t
    } },
  // Kubernetes klog / glog：I1015 10:00:01.123456（年份同上）
  { re: /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/,
    at: (m, now) => {
      const y = new Date(now).getFullYear()
      const t = zoned(y, +m[1] - 1, +m[2], +m[3], +m[4], +m[5], ms(m[6]))
      return t > now + 86_400_000 ? zoned(y - 1, +m[1] - 1, +m[2], +m[3], +m[4], +m[5], ms(m[6])) : t
    } },
]
const HEAD = 160   // 时间戳只在行首这一段里找

/** 时区写法合法：Z / ±HH:MM / ±HHMM */
export const isLogTz = (s: unknown): s is string => typeof s === 'string' && /^(Z|[+-]\d{2}:?\d{2})$/.test(s)

/** 解析一行里的时间戳（取最靠前的那个）；解析不出返回 undefined（调用方用接收时间）。
 *  tz：行里没写时区时按这个算（服务器在 UTC、桌面在 +08:00 时，不传会差 8 小时） */
export function parseLogTime(line: string, now = Date.now(), tz?: string): LogTime | undefined {
  const head = line.slice(0, HEAD)
  let best: LogTime | undefined
  defTz = isLogTz(tz) ? tz : undefined
  try {
    for (const f of FORMATS) {
      const m = f.re.exec(head)
      if (!m || (best && m.index >= best.start)) continue
      const t = f.at(m, now)
      if (t !== undefined && !isNaN(t)) best = { t, start: m.index, end: m.index + m[0].length }
    }
  } finally { defTz = undefined }
  return best
}

// ── 级别 ──────────────────────────────────────────
const WORD: Record<string, LogLevel> = {
  fatal: 'error', critical: 'error', crit: 'error', emerg: 'error', emergency: 'error', alert: 'error', severe: 'error', panic: 'error', error: 'error', err: 'error',
  warning: 'warn', warn: 'warn', notice: 'info', info: 'info', information: 'info', debug: 'debug', trace: 'debug', verbose: 'debug',
}
// 明确的级别标记（谁在前算谁）：大写单词 / [error]、[core:warn] / level=warn、"level":"error" / <Error>
const EXPLICIT = /\b(FATAL|CRITICAL|CRIT|EMERG|ALERT|SEVERE|PANIC|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE|VERBOSE)\b|\[(?:\w+:)?(fatal|crit|critical|alert|emerg|error|err|warn|warning|notice|info|debug|trace)\]|\b(?:level|lvl|severity)["']?\s*[=:]\s*["']?(\w+)|<(Error|Warning|Notice|Info|Debug)>/
const ACCESS = /"(?:GET|POST|PUT|DELETE|HEAD|PATCH|OPTIONS|CONNECT|TRACE) [^"]*" (\d{3}) /
const KLOG = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}/
const FALLBACK_ERR = /\b(?:error|exception|traceback|panic|fatal|segfault|oom-killer|out of memory)\b|\w(?:Exception|Error)\b/i
const FALLBACK_WARN = /\b(?:warn|warning|fail(?:ed|ure|s)?|denied|refused|timed? ?out)\b/i

/** 识别级别：访问日志按状态码（5xx 错误 / 4xx 警告），其次明确的级别标记，最后按关键字兜底；都没有 → undefined */
export function logLevel(line: string): LogLevel | undefined {
  const a = ACCESS.exec(line)
  if (a) return a[1][0] === '5' ? 'error' : a[1][0] === '4' ? 'warn' : 'info'
  const k = KLOG.exec(line)
  if (k) return ({ I: 'info', W: 'warn', E: 'error', F: 'error' } as const)[k[1] as 'I']
  const m = EXPLICIT.exec(line)
  if (m) {
    const lv = WORD[(m[1] ?? m[2] ?? m[3] ?? m[4]).toLowerCase()]
    if (lv) return lv
  }
  if (FALLBACK_ERR.test(line)) return 'error'
  if (FALLBACK_WARN.test(line)) return 'warn'
  return undefined
}

// ── 模式指纹 ──────────────────────────────────────
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g
const IPV6 = /(?<![\w:.])\[?(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d{1,5})?(?![\w:])/gi
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g
const HEX = /\b0x[0-9a-f]+\b/gi
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi   // 长十六进制串（哈希、容器 ID）与字母数字交错 ID 统一成 <id>
const PATH = /(?:\/[\w.@%+~-]+){2,}\/?/g
const MIXED_ID = /\b(?=[A-Za-z_-]*\d+[A-Za-z_-]+\d)[A-Za-z0-9_-]{4,}\b/g   // 字母数字交错的 ID（a1b2c3）；3000ms 这种数字+单位不算
const NUM = /\d+(?:\.\d+)*/g
export const FP_MAX = 240

/** 模式指纹：去掉时间戳，把 UUID / IP / 十六进制 / 路径里带数字的段 / 混合 ID / 数字换成占位符。同一条日志模板 → 同一指纹 */
export function logFingerprint(line: string, ts?: Pick<LogTime, 'start' | 'end'>): string {
  let s = ts ? `${line.slice(0, ts.start)} ${line.slice(ts.end)}` : line
  s = s.slice(0, 1000)
    .replace(UUID, '<uuid>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, (m) => (m.includes('::') || m.split(':').length > 5 ? '<ip>' : m))
    .replace(CLOCK, '<time>')
    .replace(PATH, (p) => p.split('/').map((seg) => (/\d/.test(seg) ? '<*>' : seg)).join('/'))
    .replace(HEX, '<hex>')
    .replace(HEX_ID, '<id>')
    .replace(MIXED_ID, '<id>')
    .replace(NUM, '<n>')
    .replace(/\s+/g, ' ').trim()
  return s.length > FP_MAX ? `${s.slice(0, FP_MAX)}…` : s
}

/** 续行（Java 堆栈 at …、Caused by、Python Traceback 里缩进的行）：不单独计模式，时间沿用上一行 */
export const isContinuation = (line: string) => /^\s+\S/.test(line) || /^(?:Caused by:|\.\.\. \d+ (?:more|common frames))/.test(line)

// ── 增量归并 ──────────────────────────────────────
export interface LogMeta { n: number; t: number; parsed: boolean; level?: LogLevel; fp: string; cont: boolean }
export interface LogPattern { fp: string; count: number; level?: LogLevel; error: number; warn: number; first: number; last: number; sample: string }
const SEV: Record<LogLevel, number> = { error: 3, warn: 2, info: 1, debug: 0 }
const worse = (a?: LogLevel, b?: LogLevel) => (!a ? b : !b ? a : SEV[a] >= SEV[b] ? a : b)
export const SAMPLE_MAX = 500

/**
 * 增量归并：新行到达时 add（每行只解析一次），日志缓冲丢掉最早的行时 evictBefore 同步扣减。
 * 「首次出现」是这个模式第一次进来的时间（被丢弃的旧行不回溯修正）。
 */
export class LogInsight {
  private metas: LogMeta[] = []
  private head = 0
  private lastT?: number   // 最近一行解析出的时间：没时间戳的行沿用它（没有就用接收时间）
  readonly patterns = new Map<string, LogPattern>()
  version = 0

  add(n: number, text: string, recvAt: number): LogMeta {
    const line = text.length > 4000 ? text.slice(0, 4000) : text
    const cont = isContinuation(line)
    const ts = cont ? undefined : parseLogTime(line, recvAt)
    if (ts) this.lastT = ts.t
    const meta: LogMeta = { n, t: ts?.t ?? this.lastT ?? recvAt, parsed: !!ts, level: cont ? undefined : logLevel(line), fp: cont ? '' : logFingerprint(line, ts), cont }
    // 序号不连续（缓冲一次被整段替换）：之前的都已不在缓冲里
    const tail = this.metas[this.metas.length - 1]
    if (tail && this.metas.length > this.head && n !== tail.n + 1) this.evictBefore(n)
    this.metas.push(meta)
    if (!cont && meta.fp) {
      const p = this.patterns.get(meta.fp)
      const sample = line.length > SAMPLE_MAX ? `${line.slice(0, SAMPLE_MAX)}…` : line
      if (!p) this.patterns.set(meta.fp, { fp: meta.fp, count: 1, level: meta.level, error: meta.level === 'error' ? 1 : 0, warn: meta.level === 'warn' ? 1 : 0, first: meta.t, last: meta.t, sample })
      else {
        p.count++; p.level = worse(p.level, meta.level); p.sample = sample
        if (meta.level === 'error') p.error++
        if (meta.level === 'warn') p.warn++
        if (meta.t < p.first) p.first = meta.t
        if (meta.t > p.last) p.last = meta.t
      }
    }
    this.version++
    return meta
  }

  /** 丢掉序号小于 n 的行（日志缓冲超上限 / 清屏） */
  evictBefore(n: number): void {
    let i = this.head
    while (i < this.metas.length && this.metas[i].n < n) {
      const m = this.metas[i++]
      const p = m.cont ? undefined : this.patterns.get(m.fp)
      if (!p) continue
      p.count--
      if (m.level === 'error') p.error--
      if (m.level === 'warn') p.warn--
      if (p.count <= 0) this.patterns.delete(m.fp)
    }
    if (i === this.head) return
    this.head = i
    if (this.head > 4096 && this.head * 2 > this.metas.length) { this.metas = this.metas.slice(this.head); this.head = 0 }
    this.version++
  }

  clear(): void { this.metas = []; this.head = 0; this.lastT = undefined; this.patterns.clear(); this.version++ }
  get size(): number { return this.metas.length - this.head }
  get lastN(): number | undefined { return this.metas.length > this.head ? this.metas[this.metas.length - 1].n : undefined }
  /** 某序号的行（O(1)：缓冲里序号连续） */
  meta(n: number): LogMeta | undefined {
    const first = this.metas[this.head]
    if (!first || n < first.n) return undefined
    const m = this.metas[this.head + n - first.n]
    return m?.n === n ? m : undefined
  }
  all(): LogMeta[] { return this.head ? this.metas.slice(this.head) : this.metas }

  /** Top 模式：不给时间范围用增量统计；给了就只数范围内的行 */
  top(k = 50, range?: { from: number; to: number }): LogPattern[] {
    let list: LogPattern[]
    if (!range) list = [...this.patterns.values()]
    else {
      const m = new Map<string, LogPattern>()
      for (let i = this.head; i < this.metas.length; i++) {
        const x = this.metas[i]
        if (x.cont || x.t < range.from || x.t >= range.to) continue
        const p = m.get(x.fp)
        if (!p) m.set(x.fp, { fp: x.fp, count: 1, level: x.level, error: x.level === 'error' ? 1 : 0, warn: x.level === 'warn' ? 1 : 0, first: x.t, last: x.t, sample: this.patterns.get(x.fp)?.sample ?? '' })
        else {
          p.count++; p.level = worse(p.level, x.level)
          if (x.level === 'error') p.error++
          if (x.level === 'warn') p.warn++
          if (x.t < p.first) p.first = x.t
          if (x.t > p.last) p.last = x.t
        }
      }
      list = [...m.values()]
    }
    return sortPatterns(list).slice(0, k)
  }
}

/** 排序：错误多的在前，其次警告，再按次数 */
export function sortPatterns(list: LogPattern[]): LogPattern[] {
  return list.sort((a, b) => SEV[b.level ?? 'debug'] - SEV[a.level ?? 'debug'] || b.count - a.count || b.last - a.last)
}

// ── 时间分布 ──────────────────────────────────────
export interface HistBucket { t: number; total: number; error: number; warn: number }
export interface Histogram { step: number; from: number; to: number; buckets: HistBucket[] }
const STEPS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400].map((s) => s * 1000)

/** 按跨度自动选桶宽（秒 / 分 / 时 / 天），最多 maxBuckets 个；分钟以上按本地时间对齐 */
export function buildHistogram(points: Pick<LogMeta, 't' | 'level' | 'cont'>[], maxBuckets = 60): Histogram | undefined {
  let lo = Infinity, hi = -Infinity
  for (const p of points) if (!p.cont) { if (p.t < lo) lo = p.t; if (p.t > hi) hi = p.t }
  if (lo === Infinity) return undefined
  const day = STEPS[STEPS.length - 1]
  const step = STEPS.find((s) => Math.floor(hi / s) - Math.floor(lo / s) < maxBuckets) ?? Math.ceil((hi - lo) / (maxBuckets - 1) / day) * day
  const tz = step >= 3600_000 ? -new Date(lo).getTimezoneOffset() * 60_000 : 0
  const from = Math.floor((lo + tz) / step) * step - tz
  const count = Math.floor((hi - from) / step) + 1
  const buckets: HistBucket[] = Array.from({ length: count }, (_, i) => ({ t: from + i * step, total: 0, error: 0, warn: 0 }))
  for (const p of points) {
    if (p.cont) continue
    const b = buckets[Math.floor((p.t - from) / step)]
    b.total++
    if (p.level === 'error') b.error++
    else if (p.level === 'warn') b.warn++
  }
  return { step, from, to: from + count * step, buckets }
}

// ── 时间显示 ──────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
/** 本地时间：HH:mm:ss；withDate 时 MM-DD HH:mm:ss */
export function fmtLogClock(t: number, withDate = false): string {
  const d = new Date(t)
  return `${withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export const LEVEL_LABEL: Record<LogLevel, string> = { error: 'ERROR', warn: 'WARN', info: 'INFO', debug: 'DEBUG' }
export function fmtStep(step: number): string {
  return step < 60_000 ? tr('{n} 秒', { n: step / 1000 }) : step < 3600_000 ? tr('{n} 分钟', { n: step / 60_000 }) : step < 86400_000 ? tr('{n} 小时', { n: step / 3600_000 }) : tr('1 天')
}

// ── 发给 AI ───────────────────────────────────────
export const LOG_DIGEST_TAG = '【日志洞察】'   // i18n-ignore 消息前缀标识
export interface LogDigestInput {
  source: string; host: string
  from: number; to: number
  metas: Pick<LogMeta, 't' | 'level' | 'cont'>[]   // 范围内的行
  patterns: LogPattern[]                            // 范围内的 Top 模式（已排序）
  redact?: (s: string) => string                    // 示例行脱敏（按「发给 AI 前脱敏」）
  maxPatterns?: number
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** 「这段时间发生了什么」：范围内的级别统计 + 时间分布 + Top 模式（指纹 + 一条脱敏示例），作为一条用户消息发给 AI */
export function buildLogDigest(i: LogDigestInput): string {
  const lines = i.metas.filter((m) => !m.cont)
  const c = { error: 0, warn: 0, info: 0, other: 0 }
  for (const m of lines) {
    if (m.level === 'error') c.error++
    else if (m.level === 'warn') c.warn++
    else if (m.level === 'info') c.info++
    else c.other++
  }
  const wd = !sameDay(i.from, i.to)
  const tm = (t: number) => fmtLogClock(t, wd)
  const red = i.redact ?? ((s: string) => s)
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'")
  const hist = buildHistogram(lines, 30)
  const busy = hist ? hist.buckets.filter((b) => b.error || b.warn).sort((a, b) => b.error - a.error || b.warn - a.warn).slice(0, 8).sort((a, b) => a.t - b.t) : []
  const pats = i.patterns.slice(0, i.maxPatterns ?? 15)
  const out = [
    `${LOG_DIGEST_TAG}「${i.host}」上的日志 ${i.source}，${tm(i.from)} ~ ${tm(i.to)} 这段时间的归并统计如下（数字、IP、ID 等已换成占位符）。`,   // i18n-ignore 发给 AI 的话
    '请据此概括这段时间发生了什么：主要事件、错误 / 警告从何时开始、峰值时段、可能原因，以及下一步建议排查的方向。需要更多原文时告诉我要看哪类日志。',   // i18n-ignore 发给 AI 的话
    '',
    `- 共 ${lines.length} 行：ERROR ${c.error}，WARN ${c.warn}，INFO ${c.info}，其他 ${c.other}`,   // i18n-ignore 发给 AI 的话
    `- 不同模式 ${i.patterns.length} 种，下面列出前 ${pats.length} 种`,   // i18n-ignore 发给 AI 的话
  ]
  if (hist) {
    out.push(`- 时间分布（每 ${fmtStep(hist.step)}一格）：${hist.buckets.map((b) => b.total).join(' ')}`)   // i18n-ignore 发给 AI 的话
    if (busy.length) out.push(`- 错误 / 警告集中的时段：${busy.map((b) => `${tm(b.t)}（ERROR ${b.error}，WARN ${b.warn}）`).join('；')}`)   // i18n-ignore 发给 AI 的话
  }
  out.push('', '| 次数 | 级别 | 首次 | 最近 | 模式 |', '| --- | --- | --- | --- | --- |')   // i18n-ignore 发给 AI 的话
  for (const p of pats) out.push(`| ${p.count} | ${p.level ? LEVEL_LABEL[p.level] : '—'} | ${tm(p.first)} | ${tm(p.last)} | \`${cell(red(p.fp))}\` |`)
  const ex = pats.filter((p) => p.level === 'error' || p.level === 'warn').slice(0, 5)
  if (ex.length) {
    out.push('', '错误 / 警告示例（每种一条）：', '```')   // i18n-ignore 发给 AI 的话
    for (const p of ex) out.push(red(p.sample).slice(0, 300))
    out.push('```')
  }
  return out.join('\n')
}

/** 「问 AI」某个模式：放进输入框（不自动发），带次数、时间与最多 3 条示例 */
export function patternQuote(source: string, host: string, p: LogPattern, samples: string[]): string {
  const fence = '```'
  return [
    `「${host}」上的日志 ${source} 里，这类日志出现了 ${p.count} 次（${p.level ? LEVEL_LABEL[p.level] : '级别未知'}，首次 ${fmtLogClock(p.first, true)}，最近 ${fmtLogClock(p.last, true)}）：`,   // i18n-ignore 发给 AI 的话
    `模式：\`${p.fp.replace(/`/g, "'")}\``,   // i18n-ignore 发给 AI 的话
    fence, ...samples.slice(0, 3).map((s) => s.slice(0, 500)), fence,
    '这是什么问题？可能的原因和处理办法？',   // i18n-ignore 发给 AI 的话
  ].join('\n')
}
