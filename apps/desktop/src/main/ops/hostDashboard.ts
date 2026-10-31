// 主机仪表盘 / 多主机墙（纯逻辑见 shared/ops/hostDashboard.ts）：
// - 每台已保存主机一个最近 60 点的环形缓冲；「主机状态标签」对已连接终端的采样（CPU / 内存 / 负载）也灌进来（ingest），关着仪表盘也攒
// - 仪表盘开着时按间隔采样：有在线终端的复用它的连接（独立 exec channel，不碰交互 shell），
//   未连接的只采用户开了「采样」的——临时连接，开着期间复用同一条，关仪表盘 / 关采样 / 出错即断
// - 只跑固定只读命令（dashboardCommand），不在主机上写任何东西
import {
  DASH_DEFAULT_INTERVAL, DASH_INTERVALS, DASH_TIMEOUT_MS, Ring, dashboardCommand, hostStatsDelay, parseDashSample, pointFromStats,
  type DashPoint, type DashSnapshot, type HostStats, type HostSummary,
} from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'

type Exec = (command: string, o: ExecFullOpts) => Promise<ExecFullResult>
export interface DashConn { exec: Exec; close(): void }
export interface DashboardDeps {
  hosts(): Pick<HostSummary, 'id'>[]
  liveTerminal(hostId: string): string | undefined
  execOnTerminal(terminalId: string, command: string, o: ExecFullOpts): Promise<ExecFullResult>
  connect(hostId: string): Promise<DashConn>
  lastCheck(hostId: string): Promise<{ at: string; issues: number } | undefined>
  paused(): boolean
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
  now?: () => number
  timeoutMs?: number   // 单次采样超时（缺省 DASH_TIMEOUT_MS；超时的用已收到的部分）
}

interface HostState { nextAt: number; failures: number; busy: boolean; error?: string; lastOkAt?: number }
const CONNECT_TIMEOUT_MS = 60_000   // 首连可能要等用户确认指纹 / 输入口令
const CHECK_TTL_MS = 20_000
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ERR_TEXT: Record<string, string> = { stats_parse_failed: tk('输出无法解析（仅支持 Linux 主机）'), terminal_disconnected: tk('终端已断开') }

export class DashboardSampler {
  private rings = new Map<string, Ring<DashPoint>>()
  private st = new Map<string, HostState>()
  private conns = new Map<string, Promise<DashConn>>()
  private checks = new Map<string, { t: number; v?: { at: string; issues: number } }>()
  private sampling = new Set<string>()
  private open = false
  private intervalSec = DASH_DEFAULT_INTERVAL
  private timer?: NodeJS.Timeout
  constructor(private d: DashboardDeps) {}
  private now() { return (this.d.now ?? Date.now)() }
  private ring(id: string) { let r = this.rings.get(id); if (!r) this.rings.set(id, r = new Ring<DashPoint>()); return r }
  private state(id: string) { let s = this.st.get(id); if (!s) this.st.set(id, s = { nextAt: 0, failures: 0, busy: false }); return s }

  start(tickMs = 1000) { this.timer = setInterval(() => { void this.tick() }, tickMs); this.timer.unref?.() }
  stop() { clearInterval(this.timer); this.setOpen(false) }

  /** 主机状态标签的样本（已连接终端）：同一时刻多个终端报同一份只记一次 */
  ingest(hostId: string | undefined, s: HostStats) {
    if (!hostId || !this.d.hosts().some((h) => h.id === hostId)) return
    const r = this.ring(hostId)
    if (r.last()?.at === s.at) return
    r.push(pointFromStats(s))
    const h = this.state(hostId)
    h.lastOkAt = s.at; h.error = undefined
  }

  setOpen(open: boolean) {
    this.open = open
    if (open) { void this.tick(); return }
    for (const id of [...this.conns.keys()]) this.dropConn(id)   // 关仪表盘：未连接主机的临时连接全断
    // 关掉后不再采样的主机：把上一次的失败清掉，别让卡片永久显示「采样失败」
    for (const [id, h] of this.st) if (!this.sampling.has(id) && !this.d.liveTerminal(id)) { h.error = undefined; h.failures = 0; h.busy = false }
  }
  setSampling(ids: string[], on: boolean) {
    for (const id of ids) {
      if (on) { this.sampling.add(id); const h = this.state(id); h.nextAt = 0; h.failures = 0; h.error = undefined }
      else { this.sampling.delete(id); this.dropConn(id); const h = this.st.get(id); if (h) { h.error = undefined; h.failures = 0; h.busy = false } }
    }
    void this.tick()
  }
  setInterval(sec: number) {
    if (!(DASH_INTERVALS as readonly number[]).includes(sec)) throw new Error(tr('采样间隔只能是 15 / 30 / 60 秒'))
    this.intervalSec = sec
    for (const h of this.st.values()) h.nextAt = Math.min(h.nextAt, this.now() + sec * 1000)
  }

  async snapshot(): Promise<DashSnapshot> {
    const hosts: DashSnapshot['hosts'] = {}
    for (const { id } of this.d.hosts()) {
      const h = this.st.get(id)
      hosts[id] = {
        points: this.rings.get(id)?.toArray() ?? [],
        connected: !!this.d.liveTerminal(id),
        sampling: this.sampling.has(id),
        ...(h?.error ? { error: h.error } : {}),
        ...(h?.lastOkAt !== undefined ? { lastOkAt: h.lastOkAt } : {}),
        ...await this.lastCheck(id).then((v) => (v ? { lastCheck: v } : {})),
      }
    }
    return { intervalSec: this.intervalSec, hosts }
  }
  private async lastCheck(id: string) {
    const c = this.checks.get(id)
    if (c && this.now() - c.t < CHECK_TTL_MS) return c.v
    const v = await this.d.lastCheck(id).catch(() => undefined)
    this.checks.set(id, { t: this.now(), v })
    return v
  }

  /** 一轮：返回本轮发起的采样（测试 await 用） */
  tick(): Promise<void> {
    if (!this.open || this.d.paused()) return Promise.resolve()
    const ids = new Set(this.d.hosts().map((h) => h.id))
    for (const id of [...this.sampling]) if (!ids.has(id)) { this.sampling.delete(id); this.dropConn(id) }   // 主机已删
    const now = this.now()
    const jobs: Promise<void>[] = []
    for (const id of ids) {
      const tid = this.d.liveTerminal(id)
      if (tid) this.dropConn(id)   // 连上终端了：改走终端的连接
      if (!tid && !this.sampling.has(id)) continue
      const h = this.state(id)
      if (h.busy || now < h.nextAt) continue
      jobs.push(this.run(id, h, tid))
    }
    return Promise.all(jobs).then(() => {})
  }

  private exec(id: string, tid: string | undefined): Promise<ExecFullResult> {
    const o = { timeoutMs: this.d.timeoutMs ?? DASH_TIMEOUT_MS, maxBytes: 256 * 1024 }
    if (tid) return this.d.execOnTerminal(tid, dashboardCommand(), o)
    let c = this.conns.get(id)
    if (!c) {
      let timer: NodeJS.Timeout | undefined
      const opening = this.d.connect(id)
      c = Promise.race([opening, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(tr('连接超时'))), CONNECT_TIMEOUT_MS) })])
        .finally(() => clearTimeout(timer))
      c.catch(() => { opening.then((x) => x.close(), () => {}) })   // 超时后才连上：直接断
      this.conns.set(id, c)
    }
    return c.then((x) => x.exec(dashboardCommand(), o))
  }
  private dropConn(id: string) {
    const c = this.conns.get(id)
    if (!c) return
    this.conns.delete(id)
    c.then((x) => x.close(), () => {})
  }

  private async run(id: string, h: HostState, tid: string | undefined) {
    h.busy = true
    try {
      const r = await this.exec(id, tid)
      const p = parseDashSample(r.output, this.now())   // 超时被截断的照样用已收到的
      this.ring(id).push(p)
      h.failures = 0; h.error = undefined; h.lastOkAt = p.at
    } catch (e) {
      // 采样已经在途时被关掉（关仪表盘 / 关采样）：这次失败不算在卡片上
      const stillOn = this.open && (!!tid || this.sampling.has(id))
      h.failures++
      h.error = stillOn ? (ERR_TEXT[msg(e)] ? tr(ERR_TEXT[msg(e)]) : msg(e)) : undefined
      if (!tid) this.dropConn(id)   // 临时连接出错：断掉，下次重连
      if (stillOn) this.d.log?.('warn', 'dashboard 采样失败', { hostId: id, err: h.error })   // i18n-ignore 日志
    } finally {
      h.busy = false
      h.nextAt = this.now() + hostStatsDelay(this.intervalSec, false, h.failures)
    }
  }
}

export function registerHostDashboard(d: DashboardDeps & { handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void }) {
  const s = new DashboardSampler(d)
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  d.handle('dashboard:open', () => { s.setOpen(true); return s.snapshot() })
  d.handle('dashboard:close', () => { s.setOpen(false) })
  d.handle('dashboard:snapshot', () => s.snapshot())
  d.handle('dashboard:setSampling', (_e, list, on) => { s.setSampling(ids(list), on === true) })
  d.handle('dashboard:setInterval', (_e, sec) => { s.setInterval(Number(sec)) })
  s.start()
  return s
}
