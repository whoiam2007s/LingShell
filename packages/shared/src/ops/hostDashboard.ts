// 主机仪表盘 / 多主机墙：采样命令（固定只读）、解析、环形缓冲、异常判定与排序、汇总。调度见 desktop/main/ops/hostDashboard.ts
import { parseLinuxStats, memPct, splitSections } from '../terminal/hostStats.js'
import type { HostStats } from '../terminal/index.js'
import { tr } from '../i18n/i18n.js'

export const DASH_POINTS = 60                       // 每主机保留最近 60 个点
export const DASH_INTERVALS = [15, 30, 60] as const // 未连接主机的采样间隔（秒）
export const DASH_DEFAULT_INTERVAL = 30
export const DASH_TIMEOUT_MS = 10_000
// 异常阈值：CPU / 内存 > 90%，最满的挂载点 > 85%
export const DASH_LIMITS = { cpu: 90, mem: 90, disk: 85 } as const

/** 一个采样点（取不到的项缺省） */
export interface DashPoint {
  at: number
  cpu?: number
  mem?: number
  disk?: number          // 最满的挂载点已用 %
  diskMount?: string
  load1?: number
  cores?: number
  failed?: number        // systemd 失败服务数
  ctRunning?: number     // 容器：运行中 / 总数
  ctTotal?: number
}

/** 固定容量环形缓冲：满了丢最旧的 */
export class Ring<T> {
  private buf: T[] = []
  constructor(readonly cap = DASH_POINTS) {}
  push(x: T) { this.buf.push(x); if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap) }
  toArray(): T[] { return [...this.buf] }
  last(): T | undefined { return this.buf.at(-1) }
  get size() { return this.buf.length }
}

// 一次 exec 拿全：CPU（两次 /proc/stat 差值）/ 内存 / 负载 / 核数 / 各挂载点 / 失败服务 / 容器状态。
// 段名沿用 hostStats 的 stat1/stat2/mem/load/cores（直接复用 parseLinuxStats）；df 用 dfall 段自己挑最满的。
// systemctl / docker 成功才打 @@failedok / @@dockerok，没有这些命令或没权限时不出数（而不是当成 0）。docker 放最后：卡住超时也不丢前面的
const SCRIPT = [
  'export LC_ALL=C',
  'echo @@stat1; grep "^cpu " /proc/stat',
  'sleep 0.5 || sleep 1',
  'echo @@stat2; grep "^cpu " /proc/stat',
  'echo @@mem; cat /proc/meminfo',
  'echo @@load; cat /proc/loadavg',
  'echo @@cores; nproc || grep -c ^processor /proc/cpuinfo',
  'echo @@dfall; df -Pk -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs || df -Pk',
  'echo @@failed; systemctl list-units --state=failed --no-legend --plain && echo @@failedok',
  'echo @@docker; docker ps -a --format "{{.State}}" && echo @@dockerok',
].join('; ')
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export function dashboardCommand(): string {
  return `sh -c ${shQuote(`{ ${SCRIPT}; } 2>/dev/null`)}`
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** df -Pk 全部行里最满的挂载点（伪文件系统已在命令里排除；容量为 0 的跳过） */
export function worstMount(s: string | undefined): { pct: number; mount: string } | undefined {
  let best: { pct: number; mount: string } | undefined
  for (const l of (s ?? '').split('\n')) {
    const f = l.trim().split(/\s+/)
    if (f.length < 6 || !/^\d+$/.test(f[1]) || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) continue
    const used = Number(f[2]), avail = Number(f[3])
    if (used + avail <= 0) continue
    const pct = round1((used / (used + avail)) * 100)
    if (!best || pct > best.pct) best = { pct, mount: f.slice(5).join(' ') }
  }
  return best
}

const lines = (s: string | undefined) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean)

/** 采样输出 → 一个点；CPU / 内存 / 磁盘 / 负载一项都没有 → 抛错（当采样失败） */
export function parseDashSample(out: string, at: number): DashPoint {
  const sec = splitSections(out)
  let s: HostStats | undefined
  try { s = parseLinuxStats(out, at) } catch { /* 下面看磁盘有没有 */ }
  const d = worstMount(sec.dfall)
  if (!s && !d) throw new Error('stats_parse_failed')
  const p: DashPoint = { at, ...(s ? pointFromStats(s) : {}) }
  if (d) { p.disk = d.pct; p.diskMount = d.mount }
  if ('failedok' in sec) p.failed = lines(sec.failed).length
  if ('dockerok' in sec) {
    const st = lines(sec.docker)
    p.ctTotal = st.length
    p.ctRunning = st.filter((x) => x === 'running').length
  }
  return p
}

/** 主机状态标签的样本（已连接终端在采）→ 点：只有 CPU / 内存 / 负载（磁盘是根分区，口径不同不混进来） */
export function pointFromStats(s: HostStats): DashPoint {
  const p: DashPoint = { at: s.at }
  if (s.cpuPct !== undefined) p.cpu = s.cpuPct
  const m = memPct(s)
  if (m !== undefined) p.mem = m
  if (s.load) p.load1 = s.load[0]
  if (s.cores) p.cores = s.cores
  return p
}

/** 每项取最近一次有值的（不同来源的点各缺一些项） */
export type DashLatest = Omit<DashPoint, 'at'> & { at?: number }
export function latestOf(points: DashPoint[]): DashLatest {
  const r: DashLatest = {}
  for (const p of points) {
    for (const [k, v] of Object.entries(p)) if (v !== undefined) (r as Record<string, unknown>)[k] = v
    if (p.disk !== undefined && p.diskMount === undefined) delete r.diskMount
  }
  return r
}

/** 异常原因（空 = 正常） */
export function dashProblems(l: DashLatest, watchdogFiring = 0): string[] {
  const out: string[] = []
  if (l.cpu !== undefined && l.cpu > DASH_LIMITS.cpu) out.push(`CPU ${Math.round(l.cpu)}%`)
  if (l.mem !== undefined && l.mem > DASH_LIMITS.mem) out.push(tr('内存 {v}', { v: `${Math.round(l.mem)}%` }))
  if (l.disk !== undefined && l.disk > DASH_LIMITS.disk) out.push(tr('磁盘 {v}', { v: `${l.diskMount ?? ''} ${Math.round(l.disk)}%` }).replace('  ', ' '))
  if (l.failed) out.push(tr('{n} 个失败服务', { n: l.failed }))
  if (watchdogFiring) out.push(tr('看门狗报警中') + (watchdogFiring > 1 ? ` ×${watchdogFiring}` : ''))
  return out
}

export type DashOnline = 'connected' | 'reachable' | 'error' | 'idle'
export interface DashCardOrder { label: string; problems: string[]; online: DashOnline; prod?: boolean }
const ONLINE_RANK: Record<DashOnline, number> = { connected: 0, reachable: 1, error: 2, idle: 3 }
/** 排序：异常在前（原因多的更前）→ 生产在前 → 在线在前 → 名称 */
export function sortDashCards<T extends DashCardOrder>(cards: T[]): T[] {
  return [...cards].sort((a, b) =>
    (b.problems.length > 0 ? 1 : 0) - (a.problems.length > 0 ? 1 : 0)
    || b.problems.length - a.problems.length
    || (b.prod ? 1 : 0) - (a.prod ? 1 : 0)
    || ONLINE_RANK[a.online] - ONLINE_RANK[b.online]
    || a.label.localeCompare(b.label, 'zh-CN'))
}

/** 在线判定：有在线终端 = 已连接；采样成功且不旧（3 个间隔内）= 可达；最近一次失败 = 异常；否则未知 */
export function dashOnline(h: { connected: boolean; error?: string; lastOkAt?: number }, intervalSec: number, now: number): DashOnline {
  if (h.connected) return 'connected'
  if (h.error) return 'error'
  if (h.lastOkAt !== undefined && now - h.lastOkAt <= intervalSec * 3000) return 'reachable'
  return 'idle'
}

export function dashSummary(cards: (DashCardOrder & { prod?: boolean })[]) {
  return {
    total: cards.length,
    online: cards.filter((c) => c.online === 'connected' || c.online === 'reachable').length,
    abnormal: cards.filter((c) => c.problems.length).length,
    prod: cards.filter((c) => c.prod).length,
  }
}

// ── 主进程 ⇄ UI ──
export interface DashHostState {
  points: DashPoint[]
  connected: boolean
  sampling: boolean        // 用户对这台开了采样（未连接主机才需要）
  error?: string           // 最近一次采样失败的原因
  lastOkAt?: number
  lastCheck?: { at: string; issues: number }   // 最近一次主机体检
}
export interface DashSnapshot { intervalSec: number; hosts: Record<string, DashHostState> }

const pctText = (n?: number) => (n === undefined ? '—' : `${Math.round(n)}%`)
/** 「问 AI」：把这台主机当前状态整理成一条消息 */
export function dashAskText(h: { id: string; label: string; group?: string; env?: string }, l: DashLatest, extra: { problems: string[]; alerts: string[]; lastCheck?: { at: string; issues: number } }): string {
  const rows = [
    `CPU ${pctText(l.cpu)}${l.cores ? tr('（{n} 核）', { n: l.cores }) : ''}`,
    tr('内存 {v}', { v: pctText(l.mem) }),
    tr('磁盘最满 {v}', { v: `${l.diskMount ?? ''} ${pctText(l.disk)}` }).replace('  ', ' '),
    tr('负载 {v}', { v: l.load1 !== undefined ? l.load1.toFixed(2) : '—' }),
    tr('失败服务 {v}', { v: l.failed ?? '—' }),
    tr('容器 {v}', { v: l.ctTotal !== undefined ? tr('{running}/{total} 运行', { running: l.ctRunning ?? 0, total: l.ctTotal }) : '—' }),
  ]
  const sep = tr('；')
  return [
    tr('请看一下主机「{label}」（已保存主机 id：{id}{group}{env}）的当前状态，判断是否有问题并给出排查建议：', { label: h.label, id: h.id, group: h.group ? tr('，分组 {g}', { g: h.group }) : '', env: h.env === 'prod' ? tr('，生产环境') : '' }),
    `- ${rows.join(sep)}`,
    ...(extra.problems.length ? [tr('- 异常：{v}', { v: extra.problems.join(sep) })] : []),
    ...(extra.alerts.length ? [tr('- 最近告警：{v}', { v: extra.alerts.join(sep) })] : []),
    ...(extra.lastCheck ? [tr('- 最近一次主机体检（{at}）发现 {n} 个问题', { at: extra.lastCheck.at, n: extra.lastCheck.issues })] : []),
    tr('需要时可用 create_terminal（type=ssh）打开它的终端只读排查。'),
  ].join('\n')
}
