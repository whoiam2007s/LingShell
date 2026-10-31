// 主机状态小面板：采集命令（固定只读，不拼任何用户输入）+ 纯解析 + 展示用格式化。
// 采集走 SSH 独立 exec channel（见 SshTerminal.execRead），不碰交互 shell：不进历史/会话日志/录像/自动应答，也不撞 AI 哨兵。
import type { TermOs, TerminalType } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

export interface HostStats {
  at: number               // 采样时间（ms）
  cpuPct?: number          // 0–100
  memUsed?: number         // bytes
  memTotal?: number
  diskPct?: number         // 根分区已用 %（0–100）
  diskUsed?: number        // bytes
  diskTotal?: number
  load?: [number, number, number]
  uptimeSec?: number
  cores?: number
  // 网络 / 磁盘 IO 速率（bytes/s，两次采样差值）；取不到就没有，UI 隐藏
  netRx?: number           // 物理网卡合计（不含 lo；虚拟网卡如 docker0/veth 不重复计，容器里只有虚拟网卡时算全部）
  netTx?: number
  nets?: IfaceRate[]       // 各网卡（不含 lo，按流量降序）
  diskRead?: number        // 整盘合计（不含分区、loop、dm 等，免得重复计）
  diskWrite?: number
}
export interface IfaceRate { name: string; rx: number; tx: number; virtual?: boolean }

// 采集节奏：单次超时 5s；失败按 间隔×2^n 退避，最长 5 分钟
export const HOST_STATS_TIMEOUT_MS = 5000
export const HOST_STATS_MAX_BACKOFF_MS = 300_000
export const HOST_STATS_MIN_INTERVAL_SEC = 5
export const HOST_STATS_PROD_FACTOR = 3   // 生产主机（开了「生产主机也采集」时）间隔 ×3
export function hostStatsDelay(intervalSec: number, prod: boolean, failures: number): number {
  const base = Math.max(HOST_STATS_MIN_INTERVAL_SEC, intervalSec) * 1000 * (prod ? HOST_STATS_PROD_FACTOR : 1)
  return failures > 0 ? Math.min(HOST_STATS_MAX_BACKOFF_MS, base * 2 ** failures) : base
}

// 能不能采：本地终端用 Node os 模块（任何系统都行）；SSH 只支持 Linux / macOS
export const statsSupported = (type: TerminalType, os?: TermOs): boolean => type === 'local' || os === 'linux' || os === 'macos'

// 远端命令：整体交给 sh -c，登录 shell 是 csh/fish 也一样；stderr 在 sh 内丢弃。
// 分段打 @@名 标记，按段解析——登录脚本往 stdout 打的横幅不会串进数据
// 网络 / 磁盘 IO 与 CPU 同一个 sleep 窗口前后各采一次；实际间隔用 /proc/uptime 算（sleep 0.5 不支持时是 1s）。
// /sys 下的虚拟网卡 / 块设备清单用来排除重复计数（veth、loop、dm 等）
const LINUX_SCRIPT = [
  'export LC_ALL=C',
  'echo @@t1; cat /proc/uptime',
  'echo @@stat1; grep "^cpu " /proc/stat',
  'echo @@net1; cat /proc/net/dev',
  'echo @@io1; cat /proc/diskstats',
  'sleep 0.5 || sleep 1',
  'echo @@t2; cat /proc/uptime',
  'echo @@stat2; grep "^cpu " /proc/stat',
  'echo @@net2; cat /proc/net/dev',
  'echo @@io2; cat /proc/diskstats',
  'echo @@vnet; ls /sys/devices/virtual/net',
  'echo @@blk; ls /sys/block',
  'echo @@vblk; ls /sys/devices/virtual/block',
  'echo @@mem; cat /proc/meminfo',
  'echo @@df; df -Pk /',
  'echo @@load; cat /proc/loadavg',
  'echo @@up; cat /proc/uptime',
  'echo @@cores; nproc || grep -c ^processor /proc/cpuinfo',
].join('; ')
const MAC_SCRIPT = [
  'export LC_ALL=C',
  // top 第一个采样不准，取 2 个（间隔 1s）的最后一行
  'echo @@cpu; top -l 2 -s 1 -n 0 | grep "CPU usage" | tail -1',
  'echo @@memsize; sysctl -n hw.memsize',
  'echo @@vm; vm_stat',
  // APFS：根是只读系统卷，用户数据在 Data 卷，优先看它
  'echo @@df; df -Pk /System/Volumes/Data || df -Pk /',
  'echo @@load; sysctl -n vm.loadavg',
  'echo @@boot; sysctl -n kern.boottime',
  'echo @@now; date +%s',
  'echo @@cores; sysctl -n hw.ncpu',
].join('; ')
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export function hostStatsCommand(os: 'linux' | 'macos'): string {
  return `sh -c ${shQuote(`{ ${os === 'linux' ? LINUX_SCRIPT : MAC_SCRIPT}; } 2>/dev/null`)}`
}

// 按 @@名 切段（标记前的内容丢弃）
export function splitSections(out: string): Record<string, string> {
  const r: Record<string, string> = {}
  let cur: string | undefined
  for (const line of out.split(/\r?\n/)) {
    const m = /^@@(\w+)\s*$/.exec(line)
    if (m) { cur = m[1]; r[cur] = ''; continue }
    if (cur) r[cur] += line + '\n'
  }
  return r
}

const num = (s: string | undefined) => { const n = Number(s); return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined }
const round1 = (n: number) => Math.round(n * 10) / 10
const clampPct = (n: number) => Math.min(100, Math.max(0, n))

// CPU 时间快照 → 区间使用率；delta 为 0（计数没动 / 计数回绕）→ undefined
export interface CpuTimes { idle: number; total: number }
export function cpuPercent(a: CpuTimes, b: CpuTimes): number | undefined {
  const dt = b.total - a.total, di = b.idle - a.idle
  if (!(dt > 0) || di < 0) return undefined
  return round1(clampPct((1 - di / dt) * 100))
}
// /proc/stat 的 cpu 行：user nice system idle iowait irq softirq steal（guest 已含在 user 里，不重复加）
export function parseProcStatCpu(s: string | undefined): CpuTimes | undefined {
  const line = s?.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return undefined
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return undefined
  return { idle: v[3] + (v[4] ?? 0), total: v.reduce((x, y) => x + y, 0) }
}

// df -Pk：取最后一个数据行，1024-blocks Used Available Capacity Mounted
export function parseDf(s: string | undefined): Pick<HostStats, 'diskPct' | 'diskUsed' | 'diskTotal'> {
  const rows = (s ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && /^\d+$/.test(f[1]) && /^\d+%$/.test(f[4]))
  const f = rows.at(-1)
  if (!f) return {}
  const used = Number(f[2]), avail = Number(f[3])
  // 同 df 的 Capacity：used / (used + avail)（root 保留块不算可用）；分母为 0 时回落 Capacity 列
  const pct = used + avail > 0 ? (used / (used + avail)) * 100 : Number(f[4].slice(0, -1))
  return { diskPct: round1(pct), diskUsed: used * 1024, diskTotal: Number(f[1]) * 1024 }
}

// 「1.23 0.45 0.67 …」或 macOS 的「{ 1.23 0.45 0.67 }」
export function parseLoad(s: string | undefined): HostStats['load'] {
  const v = (s ?? '').replace(/[{}]/g, ' ').trim().split(/\s+/).slice(0, 3).map(Number)
  return v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : undefined
}

// ── 网络 / 磁盘 IO ──
export type NetCounters = Record<string, { rx: number; tx: number }>
export type DiskCounters = Record<string, { read: number; write: number }>   // bytes
export interface IoSample { net?: NetCounters; disk?: DiskCounters }

// /proc/net/dev：「  eth0: rx_bytes … (8 列) tx_bytes …」；老内核大数时冒号后不带空格
export function parseNetDev(s: string | undefined): NetCounters | undefined {
  const r: NetCounters = {}
  for (const l of (s ?? '').split('\n')) {
    const m = /^\s*([^\s:|]+):\s*(.*)$/.exec(l)
    if (!m) continue
    const f = m[2].trim().split(/\s+/).map(Number)
    if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) r[m[1]] = { rx: f[0], tx: f[8] }
  }
  return Object.keys(r).length ? r : undefined
}
// /proc/diskstats：major minor name 读次数 读合并 读扇区 读耗时 写次数 写合并 写扇区 …；扇区固定 512 字节
export function parseDiskstats(s: string | undefined): DiskCounters | undefined {
  const r: DiskCounters = {}
  for (const l of (s ?? '').split('\n')) {
    const f = l.trim().split(/\s+/)
    if (f.length < 10) continue
    const rd = Number(f[5]), wr = Number(f[9])
    if (Number.isFinite(rd) && Number.isFinite(wr)) r[f[2]] = { read: rd * 512, write: wr * 512 }
  }
  return Object.keys(r).length ? r : undefined
}
// Windows `netstat -e`：第一行带两个数字的就是「字节 接收 发送」（各语言版本行名不同，按形状认）
export function parseNetstatE(s: string | undefined): { rx: number; tx: number } | undefined {
  for (const l of (s ?? '').split(/\r?\n/)) {
    const m = /\s(\d+)\s+(\d+)\s*$/.exec(l)
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) }
  }
  return undefined
}
const lines = (s: string | undefined) => (s ?? '').split(/\s+/).filter(Boolean)
// 整盘：/sys/block 里减去虚拟块设备（loop/dm/md/zram…）；拿不到 sysfs 时按常见整盘名认
const DISK_NAME = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/
export interface IoTopology { vnet?: string[]; blk?: string[]; vblk?: string[] }

// 两次采样 → 速率（bytes/s）。计数回绕 / 重置（差值为负）的项跳过；dt 不对就整体不出
export function ioRates(a: IoSample, b: IoSample, dtSec: number, topo: IoTopology = {}): Pick<HostStats, 'netRx' | 'netTx' | 'nets' | 'diskRead' | 'diskWrite'> {
  if (!(dtSec > 0)) return {}
  const out: Pick<HostStats, 'netRx' | 'netTx' | 'nets' | 'diskRead' | 'diskWrite'> = {}
  const rate = (x: number, y: number) => y >= x ? Math.round((y - x) / dtSec) : undefined
  if (a.net && b.net) {
    const vnet = new Set(topo.vnet ?? [])
    const nets: IfaceRate[] = []
    for (const [name, y] of Object.entries(b.net)) {
      const x = a.net[name]
      if (!x || name === 'lo') continue
      const rx = rate(x.rx, y.rx), tx = rate(x.tx, y.tx)
      if (rx === undefined || tx === undefined) continue
      nets.push({ name, rx, tx, ...(vnet.has(name) ? { virtual: true } : {}) })
    }
    const phys = nets.filter((n) => !n.virtual)
    const sum = phys.length ? phys : nets   // 容器里 eth0 也是虚拟网卡：没有物理网卡就全算
    if (sum.length) {
      out.netRx = sum.reduce((t, n) => t + n.rx, 0)
      out.netTx = sum.reduce((t, n) => t + n.tx, 0)
      out.nets = nets.sort((p, q) => q.rx + q.tx - (p.rx + p.tx))
    }
  }
  if (a.disk && b.disk) {
    const vblk = new Set(topo.vblk ?? [])
    const whole = topo.blk?.length ? new Set(topo.blk.filter((n) => !vblk.has(n))) : undefined
    let read = 0, write = 0, n = 0
    for (const [name, y] of Object.entries(b.disk)) {
      const x = a.disk[name]
      if (!x || !(whole ? whole.has(name) : DISK_NAME.test(name))) continue
      const r = rate(x.read, y.read), w = rate(x.write, y.write)
      if (r === undefined || w === undefined) continue
      read += r; write += w; n++
    }
    if (n) Object.assign(out, { diskRead: read, diskWrite: write })
  }
  return out
}

const firstLine = (s: string | undefined) => s?.split('\n').map((l) => l.trim()).find(Boolean)
const hasAny = (s: HostStats) => s.cpuPct !== undefined || s.memTotal !== undefined || s.diskPct !== undefined || s.load !== undefined

// Linux 整段输出 → HostStats；一项都没解析出 → 抛错（当失败处理，触发退避）
export function parseLinuxStats(out: string, at: number): HostStats {
  const sec = splitSections(out)
  const a = parseProcStatCpu(sec.stat1), b = parseProcStatCpu(sec.stat2)
  const mem: Record<string, number> = {}
  for (const l of (sec.mem ?? '').split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(l)
    if (m) mem[m[1]] = Number(m[2]) * 1024
  }
  const memTotal = mem.MemTotal
  // 老内核（< 3.14）没有 MemAvailable：回落 Free + Buffers + Cached
  const avail = mem.MemAvailable ?? (memTotal !== undefined ? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0) : undefined)
  const up = num(firstLine(sec.up)?.split(/\s+/)[0])
  const s: HostStats = {
    at,
    cpuPct: a && b ? cpuPercent(a, b) : undefined,
    ...(memTotal ? { memTotal, memUsed: Math.max(0, memTotal - (avail ?? 0)) } : {}),
    ...parseDf(sec.df),
    load: parseLoad(firstLine(sec.load)),
    uptimeSec: up !== undefined ? Math.floor(up) : undefined,
    cores: num(firstLine(sec.cores)),
  }
  if (!hasAny(s)) throw new Error('stats_parse_failed')
  const t1 = num(firstLine(sec.t1)?.split(/\s+/)[0]), t2 = num(firstLine(sec.t2)?.split(/\s+/)[0])
  if (t1 !== undefined && t2 !== undefined) {
    Object.assign(s, ioRates(
      { net: parseNetDev(sec.net1), disk: parseDiskstats(sec.io1) },
      { net: parseNetDev(sec.net2), disk: parseDiskstats(sec.io2) },
      t2 - t1, { vnet: lines(sec.vnet), blk: lines(sec.blk), vblk: lines(sec.vblk) }))
  }
  return s
}

// macOS 整段输出 → HostStats（网络 / 磁盘 IO 暂不采：netstat / iostat 精度与口径都不好对齐）
export function parseMacStats(out: string, at: number): HostStats {
  const sec = splitSections(out)
  const idle = /([\d.]+)%\s*idle/.exec(sec.cpu ?? '')?.[1]
  const memTotal = num(firstLine(sec.memsize))
  // vm_stat：页大小在首行；已用 ≈ 活动 App 内存(anonymous - purgeable) + wired + 压缩占用，接近「活动监视器」的已用内存
  const vm = sec.vm ?? ''
  const page = num(/page size of (\d+) bytes/.exec(vm)?.[1]) ?? 4096
  const pages = (name: string) => num(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(vm)?.[1])
  const anon = pages('Anonymous pages'), purge = pages('Pages purgeable') ?? 0
  const wired = pages('Pages wired down'), comp = pages('Pages occupied by compressor') ?? 0
  const app = anon ?? pages('Pages active')   // 老系统没有 Anonymous pages → 用 active 近似
  const memUsed = app !== undefined && wired !== undefined ? (Math.max(0, app - (anon !== undefined ? purge : 0)) + wired + comp) * page : undefined
  const boot = num(/sec = (\d+)/.exec(sec.boot ?? '')?.[1]), now = num(firstLine(sec.now))
  const s: HostStats = {
    at,
    cpuPct: idle !== undefined ? round1(clampPct(100 - Number(idle))) : undefined,
    ...(memTotal ? { memTotal, ...(memUsed !== undefined ? { memUsed: Math.min(memUsed, memTotal) } : {}) } : {}),
    ...parseDf(sec.df),
    load: parseLoad(firstLine(sec.load)),
    uptimeSec: boot !== undefined && now !== undefined && now >= boot ? now - boot : undefined,
    cores: num(firstLine(sec.cores)),
  }
  if (!hasAny(s)) throw new Error('stats_parse_failed')
  return s
}

export function parseHostStats(os: 'linux' | 'macos', out: string, at: number): HostStats {
  return os === 'linux' ? parseLinuxStats(out, at) : parseMacStats(out, at)
}

// ── 展示 ──
export const HOT_PCT = 90
export const memPct = (s: HostStats) => s.memTotal && s.memUsed !== undefined ? round1((s.memUsed / s.memTotal) * 100) : undefined
// 负载按核数折成 %（1 分钟），没核数就不画条
export const loadPct = (s: HostStats) => s.load && s.cores ? round1(clampPct((s.load[0] / s.cores) * 100)) : undefined

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—'
  const u = ['B', 'K', 'M', 'G', 'T', 'P']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}
export function fmtUptime(sec: number | undefined): string {
  if (sec === undefined) return '—'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d ? tr('{d} 天 {h} 小时', { d, h }) : h ? tr('{h} 小时 {m} 分', { h, m }) : tr('{m} 分', { m })
}
const pct = (n: number | undefined) => n === undefined ? '—' : `${Math.round(n)}%`
// 标签 hover 的一行摘要
export function statsSummary(s: HostStats): string {
  return tr('CPU {cpu} · 内存 {mem} · 磁盘 {disk} · 负载 {load}', { cpu: pct(s.cpuPct), mem: pct(memPct(s)), disk: pct(s.diskPct), load: s.load ? s.load.map((x) => x.toFixed(2)).join(' ') : '—' })
    + (s.netRx !== undefined ? tr(' · 网络 ↓{rx} ↑{tx}', { rx: fmtRate(s.netRx), tx: fmtRate(s.netTx) }) : '')
}
// 速率：1.2M/s
export const fmtRate = (n: number | undefined) => n === undefined ? '—' : `${fmtBytes(n)}/s`
// 速率类走势没有固定上限：按几条序列的共同最大值折成 0–100（全 0 时最大值按 1 算，画成底线）
export function scaleToPct(series: (number | undefined)[][]): { scaled: (number | undefined)[][]; max: number } {
  const max = Math.max(1, ...series.flat().filter((x): x is number => x !== undefined))
  return { scaled: series.map((v) => v.map((x) => x === undefined ? undefined : (x / max) * 100)), max }
}
// 迷你折线：0–100 的值映射到 w×h 的 SVG polyline points；少于 2 个点画不了 → ''
export function sparkPoints(values: (number | undefined)[], w: number, h: number): string {
  const v = values.filter((x): x is number => x !== undefined)
  if (v.length < 2) return ''
  return v.map((x, i) => `${round1((i / (v.length - 1)) * w)},${round1(h - (clampPct(x) / 100) * h)}`).join(' ')
}
