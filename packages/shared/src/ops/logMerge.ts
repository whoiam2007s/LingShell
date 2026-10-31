// ── 多主机日志：实时合流（按时间归并）+ 历史检索（含 .gz 轮转，只读）──────────────
// 主进程 desktop/main/ops/logMulti.ts 用；时间戳解析复用洞察的 parseLogTime。
import { parseLogTime, isContinuation, isLogTz } from './logInsight.js'
import { ereLiteral, shq } from '../files/explorer.js'
import { tr } from '../i18n/i18n.js'
import type { LogSource } from './logTail.js'
import type { CompareTarget } from '../files/index.js'

export interface MergedLine { h: number; text: string }   // h：第几台主机（与发起时的目标顺序一致）
export interface MultiLogHostState { ended?: { error?: string } }
/** 多主机实时合流的一次轮询：items 已按时间归并；hosts[i].ended = 这台的通道已结束 */
export interface MultiLogPoll { items: MergedLine[]; dropped: number; hosts: MultiLogHostState[]; ended?: boolean }
export interface MultiLogTarget { label: string; target: CompareTarget }

export const MERGE_WINDOW_MS = 1500        // 新行先在缓冲里等这么久，晚到的别家更早的行能插到前面
export const MERGE_START_WAIT_MS = 5000    // 起步：等各台都开始出数据（或结束）再放行，最多等这么久（临时连接首连较慢）
export const MERGE_MAX_BUFFER = 20_000     // 缓冲超过这么多行就不再等窗口，直接放
export const MULTI_LOG_MAX_HOSTS = 12

interface Pending { key: number; seq: number; at: number; h: number; text: string }

/**
 * 按时间归并多路日志。每行的时间：解析得出就用；解析不出（续行 / 无时间戳）沿用这一路上一行的时间（续行跟着上一行走），
 * 这一路还没出现过时间就用到达时间。缓冲按（时间, 到达序）排序，队首到达满 window 才放出。
 */
export class LogMerger {
  private buf: Pending[] = []
  private seq = 0
  private last: (number | undefined)[]
  private started: boolean[]
  private t0: number
  constructor(private sources: number, now = Date.now(), private win = MERGE_WINDOW_MS, private startWait = MERGE_START_WAIT_MS) {
    this.last = Array(sources).fill(undefined)
    this.started = Array(sources).fill(false)
    this.t0 = now
  }
  push(h: number, lines: string[], now = Date.now()) {
    this.started[h] = true
    for (const text of lines) {
      const t = isContinuation(text) ? undefined : parseLogTime(text, now)?.t
      if (t !== undefined) this.last[h] = t
      this.buf.push({ key: t ?? this.last[h] ?? now, seq: this.seq++, at: now, h, text })
    }
  }
  /** 这一路结束了（出错 / 远端命令退出）：不再等它起步 */
  end(h: number) { this.started[h] = true }
  get size() { return this.buf.length }
  private ready(now: number) { return this.started.every(Boolean) || now - this.t0 >= this.startWait }
  /** 取出可以放行的行（all = 全部放出，如通道都结束了） */
  drain(now = Date.now(), all = false): MergedLine[] {
    if (!this.buf.length || (!all && !this.ready(now))) return []
    this.buf.sort((a, b) => a.key - b.key || a.seq - b.seq)
    let n = 0
    if (all) n = this.buf.length
    else {
      while (n < this.buf.length && this.buf[n].at + this.win <= now) n++
      n = Math.max(n, this.buf.length - MERGE_MAX_BUFFER)
    }
    return this.buf.splice(0, n).map(({ h, text }) => ({ h, text }))
  }
}

// ── 历史检索 ──────────────────────────────────────────────
export interface LogSearchQuery {
  src: LogSource
  from?: number            // 毫秒时间戳（含）
  to?: number              // 毫秒时间戳（不含）
  pattern?: string         // 关键字或正则（空 = 不按内容筛）
  regex?: boolean
  caseSensitive?: boolean
  perHost?: number         // 每台最多返回几行（取时间段内最新的）
}
export const LOG_SEARCH_PER_HOST = 500
export const LOG_SEARCH_PER_HOST_MAX = 5000
export const LOG_SEARCH_RAW_MAX = 20_000   // 远端最多回传这么多行原始匹配（取最新的）
export const LOG_SEARCH_TIMEOUT_MS = 60_000
const MARK = '@@AISH@@'

/** JS 正则里有、grep -E（POSIX ERE）没有的写法：GNU grep 会把 \d 当成字母 d，结果静默为空；(?: (?= 直接报错。返回第一个不支持的写法 */
export function ereUnsupported(p: string): string | undefined {
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') {
      const c = p[i + 1]
      if (c && 'dDsSwWbB'.includes(c)) return c === 'b' || c === 'B' ? undefined : `\\${c}`   // \b \B GNU grep 支持
      i++   // 跳过被转义的字符（\\d 是字面量 \ 加 d）
      continue
    }
    if (p[i] === '(' && p[i + 1] === '?') return `(?${p[i + 2] ?? ''}`
    if ((p[i] === '*' || p[i] === '+' || p[i] === '?' || p[i] === '}') && p[i + 1] === '?') return tr('{q}?（非贪婪）', { q: p[i] })
  }
  return undefined
}

/** 校验渲染层传来的检索条件（当不可信） */
export function parseLogSearch(v: unknown, src: LogSource): LogSearchQuery {
  const o = (v ?? {}) as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined)
  const pattern = typeof o.pattern === 'string' ? o.pattern : ''
  if (pattern.length > 1000 || /[\0\r\n]/.test(pattern)) throw new Error(tr('关键字不合法'))
  if (pattern && o.regex) {
    try { new RegExp(pattern) } catch { throw new Error(tr('正则有误')) }
    const bad = ereUnsupported(pattern)
    if (bad) throw new Error(tr('远端用 grep -E 检索，不支持 {what}：请改写（如 \\d 写成 [0-9]，\\w 写成 [A-Za-z0-9_]）', { what: bad }))
  }
  const from = num(o.from), to = num(o.to)
  if (from && to && from >= to) throw new Error(tr('开始时间要早于结束时间'))
  const per = num(o.perHost)
  return {
    src, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(pattern ? { pattern } : {}), regex: !!o.regex, caseSensitive: !!o.caseSensitive,
    perHost: Math.min(LOG_SEARCH_PER_HOST_MAX, Math.max(1, Math.round(per ?? LOG_SEARCH_PER_HOST))),
  }
}

/**
 * 远端检索命令（只读）。文件：当前文件 + 同名轮转（x.1、x.2.gz、x-20261018、x-20261018.gz…），按修改时间从旧到新；
 * 修改时间早于开始时间的轮转文件整个跳过（里面不可能有更晚的行）；.gz 用 zcat -f，没有 zcat 的跳过并说明；
 * journal：journalctl -o short-iso --since/--until @秒。内容筛选用 grep -E（关键字按字面量转义、正则原样），最后只回传最新 RAW_MAX 行。
 * 说明信息（找到哪些文件、跳过了哪些）走 stderr 的 @@AISH@@ 行，不受 grep 影响。时间段在本机按行时间再精确筛。
 */
export function logSearchCommand(q: LogSearchQuery): string {
  // 关键字用 -E + 字面量转义（不用 -F：Git Bash 的 GNU grep 3.0 在 -i -F 下会 abort，stdout 为空）
  const grep = q.pattern ? `grep -a${q.caseSensitive ? '' : ' -i'} -E -e ${shq(q.regex ? q.pattern : ereLiteral(q.pattern))}` : 'cat'
  const tail = `tail -n ${LOG_SEARCH_RAW_MAX}`
  if (q.src.kind === 'k8s') throw new Error(tr('Pod 日志不支持历史检索'))
  if (q.src.kind === 'journal') {
    const args = ['--no-pager', '-o', 'short-iso', ...(q.src.unit ? ['-u', shq(q.src.unit)] : []),
      ...(q.from ? ['--since', `@${Math.floor(q.from / 1000)}`] : []), ...(q.to ? ['--until', `@${Math.ceil(q.to / 1000)}`] : [])]
    return `${TZ_LINE}; command -v journalctl >/dev/null 2>&1 || { echo '${MARK} nojournal' >&2; exit 0; }; journalctl ${args.join(' ')} 2>&1 | ${grep} | ${tail}`
  }
  const from = q.from ? Math.floor(q.from / 1000) : 0
  // 读不了的文件（Permission denied）打标记，不让 cat 的报错混进结果行
  const rd = (cmd: string) => `{ ${cmd} -- "$f" 2>/dev/null || echo "${MARK} denied $f" >&2; }`
  const loop = `p=${shq(q.src.path)}; from=${from}; ls -1tr -- "$p" "$p".* "$p"-* 2>/dev/null | while IFS= read -r f; do `
    + `[ -f "$f" ] || continue; `
    + `if [ "$from" -gt 0 ]; then m=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0); if [ "$m" -gt 0 ] && [ "$m" -lt "$from" ]; then echo "${MARK} old $f" >&2; continue; fi; fi; `
    + `[ -r "$f" ] || { echo "${MARK} denied $f" >&2; continue; }; `
    + `case "$f" in `
    + `*.gz) if command -v zcat >/dev/null 2>&1; then echo "${MARK} file $f" >&2; ${rd('zcat -f')}; else echo "${MARK} nozcat $f" >&2; fi ;; `
    + `*.bz2|*.xz|*.zst|*.lz4) echo "${MARK} unsupported $f" >&2 ;; `
    + `*) echo "${MARK} file $f" >&2; ${rd('cat')} ;; esac; done`
  return `${TZ_LINE}; { ${loop}; } | ${grep} | ${tail}`
}
// 远端主机的时区偏移（+0000 / +0800）：没写时区的日志行按它解析，不按桌面的本机时区
const TZ_LINE = `echo "${MARK} tz $(date +%z 2>/dev/null)" >&2`

export interface LogSearchHostResult {
  lines: string[]
  times: (number | undefined)[]
  files: string[]            // 检索过的文件
  notes: string[]            // 跳过的文件、没有 journalctl 等说明
  rawCapped: boolean         // 远端原始匹配达到上限（更早的匹配可能没包含）
  capped: number             // 时间段内超过每台上限而丢掉的（较早的）行数
}

/** 解析一台的检索输出：拆出说明行；按行时间精确筛时间段（续行 / 无时间的行跟着上一行）；只留最新 perHost 行 */
export function parseLogSearchOutput(output: string, q: LogSearchQuery, now = Date.now()): LogSearchHostResult {
  const files: string[] = [], notes: string[] = []
  const all: { text: string; t?: number }[] = []
  const lines = output.replace(/\r?\n$/, '').split(/\r?\n/)
  // stderr 与 stdout 合并后顺序不保证：先扫一遍拿远端时区，再解析内容行
  const tzRaw = lines.find((l) => l.startsWith(`${MARK} tz `))?.slice(MARK.length + 4).trim()
  const tz = isLogTz(tzRaw) ? tzRaw : undefined
  // 有关键字时 grep 把真正的行首过滤掉了：续行没法可靠地沿用上一条命中行的时间，不拿它做时间段筛选
  const keyed = !!q.pattern
  let raw = 0, prev: number | undefined
  for (const line of lines) {
    if (line.startsWith(MARK + ' ')) {
      const [, kind, ...rest] = line.split(' ')
      const f = rest.join(' ')
      if (kind === 'file') files.push(f)
      else if (kind === 'nozcat') notes.push(tr('跳过 {file}（远端没有 zcat）', { file: f }))
      else if (kind === 'unsupported') notes.push(tr('跳过 {file}（只支持 .gz 压缩）', { file: f }))
      else if (kind === 'nojournal') notes.push(tr('远端没有 journalctl'))
      else if (kind === 'denied') notes.push(tr('跳过 {file}（没有权限读）', { file: f }))
      // old：修改时间早于开始时间，正常跳过，不提示；tz：上面已处理
      continue
    }
    if (!line && !all.length) continue
    raw++
    const own = isContinuation(line) ? undefined : parseLogTime(line, now, tz)?.t
    const t = own ?? (keyed ? undefined : prev)
    if (own !== undefined) prev = own
    if (t !== undefined && ((q.from && t < q.from) || (q.to && t >= q.to))) continue
    all.push({ text: line, t })
  }
  const per = q.perHost ?? LOG_SEARCH_PER_HOST
  const keep = all.slice(-per)
  const rawCapped = raw >= LOG_SEARCH_RAW_MAX
  // 设了结束时间、远端又只回传了最新的 N 行：时间段内的行可能全被截掉了
  if (rawCapped && q.to && !keep.length) notes.push(tr('远端只取了最新的 {n} 行，都晚于结束时间：时间段内的行没取到，请加关键字缩小范围，或在终端里直接检索', { n: LOG_SEARCH_RAW_MAX }))
  return { lines: keep.map((x) => x.text), times: keep.map((x) => x.t), files, notes, rawCapped, capped: all.length - keep.length }
}

/** 多台检索结果按时间归并（稳定：同一时间按主机顺序；没时间的行跟着本台上一行） */
export function mergeSearchResults(hosts: Pick<LogSearchHostResult, 'lines' | 'times'>[]): MergedLine[] {
  const all: { key: number; h: number; i: number; text: string }[] = []
  hosts.forEach((r, h) => {
    let prev = -Infinity
    r.lines.forEach((text, i) => { const t = r.times[i]; if (t !== undefined) prev = t; all.push({ key: t ?? prev, h, i, text }) })
  })
  all.sort((a, b) => a.key - b.key || a.h - b.h || a.i - b.i)
  return all.map(({ h, text }) => ({ h, text }))
}
