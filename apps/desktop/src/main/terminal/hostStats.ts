import os from 'node:os'
import { statfs, readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { HOST_STATS_TIMEOUT_MS, cpuPercent, hostStatsCommand, hostStatsDelay, ioRates, parseDiskstats, parseHostStats, parseNetDev, parseNetstatE, statsSupported, type CpuTimes, type HostStats, type IoSample, type IoTopology, type TermOs, type TerminalType } from '@lingshell/shared'

// 主机状态采集调度（见 shared/terminal/hostStats.ts）：
// - 只采 UI 告知的可见终端；采集开关默认关；生产主机默认不采（开了则间隔 ×3）；锁定时暂停
// - 同主机（hostKey）多个可见终端只采一次、结果发给每个；每主机最多一个在途；失败按指数退避
export interface StatsTarget { id: string; hostKey: string; type: TerminalType; os?: TermOs; running: boolean; prod: boolean }
export interface StatsUpdate { stats?: HostStats; error?: string; unsupported?: boolean }
export interface HostStatsDeps {
  settings(): { enabled: boolean; intervalSec: number; prod: boolean }
  targets(): StatsTarget[]
  collect(t: StatsTarget): Promise<HostStats>
  emit(terminalId: string, u: StatsUpdate): void
  paused(): boolean                 // 应用锁定中
  now?: () => number
}

interface HostState { nextAt: number; failures: number; busy: boolean }

export class HostStatsScheduler {
  private watched = new Set<string>()
  private hosts = new Map<string, HostState>()
  private shown = new Map<string, 'data' | 'unsupported'>()   // 已给 UI 发过什么：变为不可采时发一次清空
  private timer?: NodeJS.Timeout
  constructor(private d: HostStatsDeps) {}
  private now() { return (this.d.now ?? Date.now)() }

  start(tickMs = 1000) { this.timer = setInterval(() => { void this.tick() }, tickMs); this.timer.unref?.() }
  stop() { clearInterval(this.timer) }

  // 整份替换可见终端列表；新出现的立即采一次（切标签不用等一个间隔）
  watch(ids: string[]) { this.watched = new Set(ids); void this.tick() }

  // 一轮：返回本轮发起的采集（测试 await 用）
  tick(): Promise<void> {
    if (this.d.paused()) return Promise.resolve()
    const cfg = this.d.settings()
    const all = this.d.targets()
    const alive = new Set(all.map((t) => t.id))
    for (const id of this.shown.keys()) if (!alive.has(id)) this.shown.delete(id)   // 终端已关
    const groups = new Map<string, StatsTarget[]>()
    for (const t of all) {
      const eligible = cfg.enabled && t.running && (!t.prod || cfg.prod)
      if (!eligible) { this.clear(t.id); continue }
      if (!this.watched.has(t.id)) continue   // 看不见：不采，但留着最后一次数据（hover 摘要用）
      if (!statsSupported(t.type, t.os)) {
        if (this.shown.get(t.id) !== 'unsupported') { this.shown.set(t.id, 'unsupported'); this.d.emit(t.id, { unsupported: true }) }
        continue
      }
      if (this.shown.get(t.id) === 'unsupported') this.clear(t.id)   // 重连后系统识别出来了
      const g = groups.get(t.hostKey) ?? []
      g.push(t); groups.set(t.hostKey, g)
    }
    for (const k of this.hosts.keys()) if (!all.some((t) => t.hostKey === k)) this.hosts.delete(k)   // 该主机终端全关了
    const now = this.now()
    const jobs: Promise<void>[] = []
    for (const [key, ts] of groups) {
      const h = this.hosts.get(key) ?? { nextAt: 0, failures: 0, busy: false }
      this.hosts.set(key, h)
      if (h.busy || now < h.nextAt) continue
      jobs.push(this.run(h, ts, cfg.intervalSec))
    }
    return Promise.all(jobs).then(() => {})
  }

  private clear(id: string) {
    if (!this.shown.has(id)) return
    this.shown.delete(id)
    this.d.emit(id, {})
  }

  private async run(h: HostState, ts: StatsTarget[], intervalSec: number) {
    h.busy = true
    // 兜底超时：collect 内部自己有 5s 超时，这里防它万一不返回把该主机永久卡在 busy
    let guard: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, rej) => { guard = setTimeout(() => rej(new Error('exec_timeout')), HOST_STATS_TIMEOUT_MS * 2) })
    try {
      const stats = await Promise.race([this.d.collect(ts[0]), timeout])
      h.failures = 0
      for (const t of ts) { this.shown.set(t.id, 'data'); this.d.emit(t.id, { stats }) }
    } catch (e) {
      h.failures++
      const error = e instanceof Error ? e.message : String(e)
      for (const t of ts) { this.shown.set(t.id, 'data'); this.d.emit(t.id, { error }) }
    } finally {
      clearTimeout(guard)
      h.busy = false
      h.nextAt = this.now() + hostStatsDelay(intervalSec, ts[0].prod, h.failures)
    }
  }
}

// ── 采集实现 ──
const sumCpus = (): CpuTimes => {
  let idle = 0, total = 0
  for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq }
  return { idle, total }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 本机网络 / 磁盘 IO 快照：Linux 直接读 /proc；Windows 只有网络（`netstat -e` 合计字节，没有分网卡）；其它系统不采
interface IoSnap extends IoSample { t: number }
const run = (file: string, args: string[]) => new Promise<string>((res) => {
  execFile(file, args, { timeout: 2000, windowsHide: true, encoding: 'latin1' }, (err, out) => res(err ? '' : out))
})
const readOr = (p: string) => readFile(p, 'utf8').catch(() => '')
const WIN_NET = '*'   // netstat -e 的合计：不当网卡展示
export async function localIoSnap(platform = process.platform): Promise<IoSnap> {
  if (platform === 'win32') {
    const n = parseNetstatE(await run('netstat', ['-e']))
    return { t: performance.now() / 1000, ...(n ? { net: { [WIN_NET]: n } } : {}) }
  }
  if (platform !== 'linux') return { t: performance.now() / 1000 }
  const [net, disk] = await Promise.all([readOr('/proc/net/dev'), readOr('/proc/diskstats')])
  return { t: performance.now() / 1000, net: parseNetDev(net), disk: parseDiskstats(disk) }
}
async function localTopology(): Promise<IoTopology> {
  if (process.platform !== 'linux') return {}
  const ls = (p: string) => readdir(p).catch(() => [] as string[])
  const [vnet, blk, vblk] = await Promise.all([ls('/sys/devices/virtual/net'), ls('/sys/block'), ls('/sys/devices/virtual/block')])
  return { vnet, blk, vblk }
}
export function localIoRates(a: IoSnap, b: IoSnap, topo: IoTopology = {}): Partial<HostStats> {
  const r = ioRates(a, b, b.t - a.t, topo)
  if (r.nets?.every((n) => n.name === WIN_NET)) delete r.nets
  return r
}

// 本机：Node os 模块（不起子进程，Windows 也能采）；磁盘取系统盘根
export async function localStats(): Promise<HostStats> {
  const [a, ioA] = [sumCpus(), await localIoSnap()]
  await sleep(500)
  const [b, ioB] = [sumCpus(), await localIoSnap()]
  const s: HostStats = {
    ...localIoRates(ioA, ioB, await localTopology()),
    at: Date.now(), cpuPct: cpuPercent(a, b),
    memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem(),
    uptimeSec: Math.floor(os.uptime()), cores: os.cpus().length,
  }
  if (process.platform !== 'win32') s.load = os.loadavg() as [number, number, number]   // Windows 恒为 0，不显示
  try {
    const f = await statfs(process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/')
    const total = f.blocks * f.bsize, used = (f.blocks - f.bfree) * f.bsize, avail = f.bavail * f.bsize
    if (total > 0) Object.assign(s, { diskTotal: total, diskUsed: used, diskPct: Math.round((used / (used + avail)) * 1000) / 10 })
  } catch { /* 取不到磁盘就不显示 */ }
  return s
}

// SSH：固定命令走独立 exec channel（execRead），解析失败当采集失败
export async function remoteStats(execRead: (cmd: string, timeoutMs: number) => Promise<string>, sys: 'linux' | 'macos'): Promise<HostStats> {
  return parseHostStats(sys, await execRead(hostStatsCommand(sys), HOST_STATS_TIMEOUT_MS), Date.now())
}
