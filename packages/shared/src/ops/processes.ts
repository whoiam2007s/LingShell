// 进程管理器：ps 命令构造 + 纯解析 / 排序 / 过滤 / 树形。只支持 SSH 终端（非 Windows），走独立 exec channel（execRead），不碰交互 shell。
// 不同系统的 ps 参数不一样：远端按 GNU procps → macOS/BSD → busybox → 裸 ps 依次试，第一个成功的输出带表头，解析按表头认列。
import type { TermOs, TerminalType } from '../protocol/index.js'

export type ProcSignal = 'TERM' | 'KILL' | 'HUP'
export type ProcSortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'rss' | 'elapsed' | 'stat' | 'command'

export interface ProcRow {
  pid: number
  ppid?: number
  user: string
  cpu?: number       // %CPU（busybox 没有）
  mem?: number       // %MEM（busybox 没有）
  rss?: number       // KB
  etime: string      // 运行时长原文（[[dd-]hh:]mm:ss）
  elapsed?: number   // 运行时长秒数（排序用；认不出为 undefined）
  stat: string
  command: string    // 完整命令行（args）
}
export interface ProcList {
  rows: ProcRow[]
  hasCpu: boolean    // 是否有 %CPU / %MEM 列（busybox 降级时没有）
  truncated: boolean // 只取了前 PROC_MAX 行
  local?: 'windows' | 'unix'   // 本机视图（本地终端）：windows 时没有 HUP，结束 = taskkill
}

import { tk, tr } from '../i18n/i18n.js'

export const PROC_MAX = 500
export const PROC_TIMEOUT_MS = 15_000
export const PROC_SIGNALS: ProcSignal[] = ['TERM', 'HUP', 'KILL']
export const PROC_SIGNAL_LABEL: Record<ProcSignal, string> = { TERM: tk('结束（TERM）'), HUP: tk('重载（HUP）'), KILL: tk('强制结束（KILL）') }
export const processSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows'
export const isProcSignal = (s: unknown): s is ProcSignal => s === 'TERM' || s === 'KILL' || s === 'HUP'
// pid 0 / 1（init）不许发信号：杀 init 等于让整台机器出事
export const isKillablePid = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p > 1 && p < 2 ** 31

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const RC = '@@rc:'
const wrap = (script: string) => `sh -c ${shQuote(`export LC_ALL=C; ${script}`)}`

// 按顺序试：GNU procps（按 CPU 倒序）→ macOS/BSD（-r 按 CPU）→ busybox（-o 列）→ 只有 pid/user/args → 裸 ps。
// 失败（不认参数）时 stdout 为空、退出码非 0，换下一个；最后截前 PROC_MAX+1 行（含表头）、每行最多 1000 字符
const PS_TRIES = [
  '-eo pid,ppid,user:32,pcpu,pmem,rss,etime,stat,args --sort=-pcpu',
  '-axr -o pid,ppid,user,pcpu,pmem,rss,etime,stat,args',
  '-o pid,ppid,user,rss,etime,stat,args',
  '-o pid,ppid,user,args',
  '',
]
export const processListCommand = () => wrap(
  `for a in ${PS_TRIES.map((t) => `"${t}"`).join(' ')}; do o=$(ps $a 2>/dev/null) && [ -n "$o" ] && break; o=; done; ` +
  // 多取一行（+表头）：恰好 PROC_MAX 个进程时不能误标「+」
  `[ -n "$o" ] || exit 1; printf '%s\\n' "$o" | head -n ${PROC_MAX + 2} | cut -c 1-1000`,
)
export const processSignalCommand = (pid: number, sig: ProcSignal) => {
  if (!isKillablePid(pid) || !isProcSignal(sig)) throw new Error(tr('非法的进程或信号'))
  return wrap(`kill -${sig} ${pid} 2>&1; echo "${RC}$?"`)
}

// 表头 → 字段（GNU / macOS / busybox 的叫法都收）
const HEAD: Record<string, keyof ProcRow> = {
  PID: 'pid', PPID: 'ppid', USER: 'user', UID: 'user', '%CPU': 'cpu', '%MEM': 'mem', RSS: 'rss', ELAPSED: 'etime', ETIME: 'etime',
  STAT: 'stat', S: 'stat', COMMAND: 'command', ARGS: 'command', CMD: 'command',
}

// [[dd-]hh:]mm:ss → 秒；busybox 可能输出 1d / 3h 之类简写也认
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s)
  if (m) return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])
  const u = /^(\d+)([smhd])$/.exec(s)
  return u ? Number(u[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[u[2] as 's' | 'm' | 'h' | 'd'] : undefined
}
// RSS（KB）：busybox 大数会写成 12.3m / 1g
export function parseRss(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([kmg])?$/i.exec(s)
  if (!m) return undefined
  return Math.round(Number(m[1]) * ({ k: 1, m: 1024, g: 1024 * 1024 }[(m[2] ?? 'k').toLowerCase() as 'k' | 'm' | 'g']))
}
const num = (s: string) => { const n = Number(s.replace(',', '.')); return Number.isFinite(n) ? n : undefined }

export function parsePs(text: string): ProcList {
  const lines = text.split(/\r?\n/)
  // 表头：含 PID 且最后一列是命令；前面可能有登录横幅
  // （老 busybox 表头是 PID Uid VSZ Stat Command 这种大小写混写，统一转大写认）
  const heads = (l: string) => l.trim().toUpperCase().split(/\s+/)
  const hi = lines.findIndex((l) => { const t = heads(l); return t.includes('PID') && HEAD[t[t.length - 1]] === 'command' })
  if (hi < 0) return { rows: [], hasCpu: false, truncated: false }
  const cols = heads(lines[hi]).map((h) => HEAD[h])
  const rows: ProcRow[] = []
  for (const line of lines.slice(hi + 1)) {
    const t = line.trim()
    if (!t) continue
    // 前 n-1 列按空白切，剩下整段是命令行（命令里本身有空格）
    const parts: string[] = []
    let rest = t
    for (let i = 0; i < cols.length - 1; i++) {
      const m = /^(\S+)\s*/.exec(rest)
      if (!m) break
      parts.push(m[1]); rest = rest.slice(m[0].length)
    }
    parts.push(rest)
    const r: ProcRow = { pid: NaN, user: '', etime: '', stat: '', command: '' }
    cols.forEach((c, i) => {
      const v = parts[i] ?? ''
      if (c === 'pid' || c === 'ppid') r[c] = /^\d+$/.test(v) ? Number(v) : NaN
      else if (c === 'cpu' || c === 'mem') r[c] = num(v)
      else if (c === 'rss') r.rss = parseRss(v)
      else if (c === 'etime') { r.etime = v; r.elapsed = parseEtime(v) }
      else if (c === 'user' || c === 'stat' || c === 'command') r[c] = v
    })
    if (!Number.isFinite(r.pid)) continue   // 不是进程行（截断、警告等）
    if (r.ppid !== undefined && !Number.isFinite(r.ppid)) delete r.ppid
    rows.push(r)
  }
  const truncated = rows.length > PROC_MAX
  return { rows: truncated ? rows.slice(0, PROC_MAX) : rows, hasCpu: cols.includes('cpu'), truncated }
}

// ── 排序 / 过滤 / 树形 ──
const strKey = (k: ProcSortKey) => k === 'user' || k === 'stat' || k === 'command'
export function compareProcs(key: ProcSortKey, desc: boolean): (a: ProcRow, b: ProcRow) => number {
  return (a, b) => {
    let d: number
    if (strKey(key)) d = String(a[key as 'user']).localeCompare(String(b[key as 'user']))
    else {
      const x = a[key as 'cpu'], y = b[key as 'cpu']
      // 缺值永远排最后（不随升降序翻转）
      if (x === undefined || y === undefined) return x === y ? a.pid - b.pid : x === undefined ? 1 : -1
      d = x - y
    }
    if (desc) d = -d
    return d || a.pid - b.pid
  }
}
export const sortProcs = (rows: ProcRow[], key: ProcSortKey, desc: boolean) => [...rows].sort(compareProcs(key, desc))

// 按命令 / 用户 / PID 过滤（不分大小写，空格分隔的多个词都要命中）
export function procMatches(r: ProcRow, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${r.command}\n${r.user}\n${r.pid}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}
export const filterProcs = (rows: ProcRow[], q: string) => (q.trim() ? rows.filter((r) => procMatches(r, q)) : rows)

export interface ProcTreeRow { row: ProcRow; depth: number; hasChildren: boolean }
// 按 ppid 建树，深度优先摊平；同级按 cmp 排。父进程不在列表里（被截断 / pid 0）的当根。
// 有过滤词时保留命中的进程及其祖先链（看得出是谁拉起来的）；环（异常数据）靠 seen 截断
export function buildProcTree(rows: ProcRow[], cmp: (a: ProcRow, b: ProcRow) => number, q = ''): ProcTreeRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  let keep: Set<number> | undefined
  if (q.trim()) {
    keep = new Set()
    for (const r of rows) {
      if (!procMatches(r, q)) continue
      for (let p: ProcRow | undefined = r; p && !keep.has(p.pid); p = p.ppid !== undefined ? byPid.get(p.ppid) : undefined) keep.add(p.pid)
    }
  }
  const kids = new Map<number, ProcRow[]>()
  const roots: ProcRow[] = []
  for (const r of rows) {
    if (keep && !keep.has(r.pid)) continue
    const parent = r.ppid !== undefined && r.ppid !== r.pid ? byPid.get(r.ppid) : undefined
    if (parent && (!keep || keep.has(parent.pid))) { const a = kids.get(parent.pid) ?? []; a.push(r); kids.set(parent.pid, a) }
    else roots.push(r)
  }
  const out: ProcTreeRow[] = []
  const seen = new Set<number>()
  const walk = (r: ProcRow, depth: number) => {
    if (seen.has(r.pid)) return
    seen.add(r.pid)
    const ch = (kids.get(r.pid) ?? []).sort(cmp)
    out.push({ row: r, depth, hasChildren: ch.length > 0 })
    for (const c of ch) walk(c, depth + 1)
  }
  for (const r of roots.sort(cmp)) walk(r, 0)
  // 成环的（没有根，正常 ps 不会出现）也别丢：当根补上
  for (const r of rows.filter((x) => !seen.has(x.pid) && (!keep || keep.has(x.pid))).sort(cmp)) walk(r, 0)
  return out
}

// ── 展示 ──
export function fmtRss(kb?: number): string {
  if (kb === undefined) return '—'
  if (kb < 1024) return `${kb} K`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)} M`
  return `${(kb / 1024 / 1024).toFixed(1)} G`
}
export const fmtPct = (n?: number) => (n === undefined ? '—' : n.toFixed(1))

// 「问 AI」引用到对话输入框的文本
// 发给 AI 的话，保持中文（同 troubleshootPrompt）
export function procQuote(title: string, r: ProcRow): string {
  const facts = [
    `PID ${r.pid}${r.ppid !== undefined ? `（父进程 ${r.ppid}）` : ''}`, `用户 ${r.user || '—'}`,   // i18n-ignore 发给 AI 的话
    r.cpu !== undefined ? `CPU ${fmtPct(r.cpu)}%` : '', r.mem !== undefined ? `内存 ${fmtPct(r.mem)}%` : '',   // i18n-ignore 发给 AI 的话
    r.rss !== undefined ? `RSS ${fmtRss(r.rss)}` : '', r.etime ? `已运行 ${r.etime}` : '', r.stat ? `状态 ${r.stat}` : '',   // i18n-ignore 发给 AI 的话
  ].filter(Boolean).join(' · ')
  const fence = '```'
  return `终端「${title}」所在主机上的进程：\n${facts}\n命令行：\n${fence}\n${r.command}\n${fence}\n`   // i18n-ignore 发给 AI 的话
}

// 执行记录：decision = process_kill，command 里带信号、pid 和命令行（截断，去控制字符）
export const PROC_DECISION = 'process_kill'
export function procAuditCommand(pid: number, sig: ProcSignal, command: string): string {
  const c = Array.from(command, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim().slice(0, 300)
  return `kill -${sig} ${pid}${c ? `  # ${c}` : ''}`
}
// 发信号的结果：拆出退出码标记
export function parseSignalResult(out: string): { rc?: number; message: string } {
  const i = out.lastIndexOf(RC)
  if (i < 0) return { message: out.trim() }
  const rc = Number.parseInt(out.slice(i + RC.length), 10)
  return { rc: Number.isFinite(rc) ? rc : undefined, message: out.slice(0, i).trim() }
}
