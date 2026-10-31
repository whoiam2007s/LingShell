// 自然语言看门狗：调度 + 存储（纯逻辑见 shared/ops/watchdog.ts）。
// 只在应用运行时检查（不常驻）：主进程里一个定时器，按各看门狗的间隔在每台目标主机上跑只读检查脚本，
// 经独立 exec channel（本机走子进程），从不进交互终端；同一看门狗同一主机同时只跑一个。
// 连续触发够次数 → 通知（可点击）+ 可选自动开 AI 排查会话（到恢复前不重复开）；恢复正常也通知。
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from '@lingshell/config'
import {
  checkWatchdogInput, parseCheckOutput, pushHistory, resolveWatchdogTargets, stepWatchdog, buildWatchdogPrompt, parseWatchdogGen,
  type BatchExecResult, type HostSummary, type TermOs, type Watchdog, type WatchdogInput, type WatchdogState,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { isReadOnlyScript } from './watchdogScript.js'

// watchdogs.json（配置）+ watchdog-state.json（各主机状态与触发历史，重启后仍能看到）。原子写
export class WatchdogStore {
  private file: string
  private stateFile: string
  constructor(dir: string) {
    this.file = join(dir, 'watchdogs.json')
    this.stateFile = join(dir, 'watchdog-state.json')
    this.pauseFile = join(dir, 'watchdog-pause.json')
  }
  private pauseFile: string
  list(): Watchdog[] { return readJson<Watchdog[]>(this.file) ?? [] }
  save(input: WatchdogInput): Watchdog {
    const err = checkWatchdogInput(input)
    if (err) throw new Error(err)
    if (!isReadOnlyScript(input.script)) throw new Error(tr('脚本含写操作或无法确认只读（不允许 sudo、写文件重定向、awk/sed/eval、修改类命令等），拒绝保存'))
    const all = this.list()
    const i = input.id ? all.findIndex((w) => w.id === input.id) : -1
    const w: Watchdog = {
      id: i >= 0 ? all[i].id : `wd_${randomUUID().slice(0, 8)}`,
      name: input.name.trim(), condition: input.condition.trim(), script: input.script.trim(),
      ...(input.explain?.trim() ? { explain: input.explain.trim() } : {}),
      targets: [...input.targets], ...(input.groups?.length ? { groups: [...input.groups] } : {}),
      intervalMin: input.intervalMin, threshold: Math.floor(input.threshold), autoSession: input.autoSession, enabled: input.enabled,
      createdAt: i >= 0 ? all[i].createdAt : new Date().toISOString(),
    }
    if (i >= 0) all[i] = w; else all.push(w)
    writeJson(this.file, all)
    return w
  }
  delete(id: string): void { writeJson(this.file, this.list().filter((w) => w.id !== id)) }
  loadStates(): Record<string, WatchdogState> { return readJson<Record<string, WatchdogState>>(this.stateFile) ?? {} }
  saveStates(s: Record<string, WatchdogState>): void { writeJson(this.stateFile, s) }
  // 全局暂停（watchdog-pause.json）：重启后仍保持
  loadPaused(): boolean { return readJson<{ paused?: boolean }>(this.pauseFile)?.paused === true }
  savePaused(paused: boolean): void { writeJson(this.pauseFile, { paused }) }
}

export interface WatchdogDeps {
  list(): Watchdog[]
  hosts(): Pick<HostSummary, 'id' | 'group' | 'label'>[]
  /** 在主机上跑脚本（不抛：失败折成 conn_error / timeout） */
  run(hostKey: string, script: string): Promise<BatchExecResult>
  loadStates(): Record<string, WatchdogState>
  saveStates(s: Record<string, WatchdogState>): void
  emit(state: WatchdogState): void
  /** 系统通知；sessionId = 点击后打开的会话 */
  notify(title: string, body: string, sessionId?: string): void
  /** 开排查会话并发出首条消息，返回会话 id */
  openSession(w: Watchdog, host: { key: string; label: string }, value: string): Promise<string>
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
  unitMs?: number      // 间隔单位，默认 1 分钟（自测可经环境变量缩短，见 ipc.ts）
  // 全局暂停：初值 / 落盘 / 变化通知（设置页、托盘、悬浮球都能切）
  loadPaused?(): boolean
  savePaused?(paused: boolean): void
  onPaused?(paused: boolean): void
}

/** IPC：增删改查 + 立即检查 + 生成脚本（复用「自然语言写命令」的一次性模型调用） */
export function registerWatchdogs(d: {
  handle(channel: string, fn: (...args: any[]) => unknown): void   // eslint-disable-line @typescript-eslint/no-explicit-any
  store: WatchdogStore
  scheduler: WatchdogScheduler
  complete(system: string, user: string, signal: AbortSignal): Promise<string>
}): void {
  d.handle('watchdogs:list', () => d.store.list())
  d.handle('watchdogs:states', () => d.scheduler.list())
  d.handle('watchdogs:save', (_e, input: WatchdogInput) => { const w = d.store.save(input); d.scheduler.reset(w); return w })
  d.handle('watchdogs:delete', (_e, id: string) => { d.store.delete(String(id)); d.scheduler.forget(String(id)) })
  d.handle('watchdogs:checkNow', (_e, id: string) => d.scheduler.checkNow(String(id)))
  d.handle('watchdogs:generate', async (_e, condition: string, os?: TermOs) => {
    const c = String(condition ?? '').trim().slice(0, 500)
    if (!c) throw new Error(tr('请先写条件'))
    const p = buildWatchdogPrompt({ condition: c, os: (['linux', 'macos', 'windows'] as const).find((x) => x === os) ?? 'linux' })
    const r = parseWatchdogGen(await d.complete(p.system, p.user, AbortSignal.timeout(60_000)))
    if ('error' in r) throw new Error(r.error)
    return { ...r, readonly: isReadOnlyScript(r.script) }
  })
  d.handle('watchdogs:checkScript', (_e, script: string) => isReadOnlyScript(String(script ?? '')))
  d.handle('watchdogs:paused', () => d.scheduler.paused)
  d.handle('watchdogs:setPaused', (_e, p: unknown) => { d.scheduler.setPaused(p === true); return d.scheduler.paused })
}

export class WatchdogScheduler {
  private timer?: ReturnType<typeof setInterval>
  private states: Record<string, WatchdogState>
  private running = new Set<string>()          // `${id}|${hostKey}`
  private lastRun = new Map<string, number>()  // 同上 → 上次开跑时间（内存：重启后先跑一轮）
  private _paused: boolean
  constructor(private d: WatchdogDeps) { this.states = d.loadStates(); this._paused = d.loadPaused?.() === true }

  /** 全局暂停：到点不检查（「立即检查」照常） */
  get paused(): boolean { return this._paused }
  setPaused(paused: boolean): void {
    if (paused === this._paused) return
    this._paused = paused
    this.d.savePaused?.(paused)
    this.d.onPaused?.(paused)
    this.d.log?.('info', paused ? 'watchdog paused' : 'watchdog resumed')
  }
  /** 当前报警中的（看门狗 × 主机）数，托盘 / 悬浮球用 */
  firingCount(): number {
    const ids = new Set(this.d.list().map((w) => w.id))
    return Object.values(this.states).filter((s) => ids.has(s.id)).reduce((n, s) => n + Object.values(s.hosts).filter((h) => h.status === 'firing').length, 0)
  }

  private get unit(): number { return this.d.unitMs ?? 60_000 }
  start(): void { this.timer ??= setInterval(() => this.tick(), Math.max(500, Math.min(15_000, this.unit / 4))) }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  list(): WatchdogState[] { return this.d.list().map((w) => this.stateOf(w.id)) }
  private stateOf(id: string): WatchdogState { return this.states[id] ??= { id, hosts: {}, history: [] } }

  /** 删看门狗时清状态 */
  forget(id: string): void { delete this.states[id]; this.d.saveStates(this.states) }
  /** 改了配置：下个 tick 立即按新配置检查；已不在目标里的主机状态清掉 */
  reset(w: Watchdog): void {
    for (const k of [...this.lastRun.keys()]) if (k.startsWith(`${w.id}|`)) this.lastRun.delete(k)
    const st = this.states[w.id]
    if (!st) return
    const keep = new Set(resolveWatchdogTargets(w, this.d.hosts()))
    for (const hk of Object.keys(st.hosts)) if (!keep.has(hk)) delete st.hosts[hk]
    this.d.saveStates(this.states)
  }

  tick(now = Date.now()): void {
    if (this._paused) return
    for (const w of this.d.list()) {
      if (!w.enabled) continue
      for (const hk of resolveWatchdogTargets(w, this.d.hosts())) {
        const k = `${w.id}|${hk}`
        if (this.running.has(k) || now - (this.lastRun.get(k) ?? -Infinity) < w.intervalMin * this.unit) continue
        void this.check(w, hk, now)
      }
    }
  }

  /** 立即检查一个看门狗的全部主机（「立即检查」按钮），等全部结束 */
  async checkNow(id: string): Promise<WatchdogState> {
    const w = this.d.list().find((x) => x.id === id)
    if (!w) throw new Error(tr('看门狗不存在'))
    await Promise.all(resolveWatchdogTargets(w, this.d.hosts()).map((hk) => this.check(w, hk, Date.now())))
    return this.stateOf(id)
  }

  private async check(w: Watchdog, hostKey: string, now: number): Promise<void> {
    const k = `${w.id}|${hostKey}`
    if (this.running.has(k)) return
    this.running.add(k)
    this.lastRun.set(k, now)
    try {
      const outcome = parseCheckOutput(await this.d.run(hostKey, w.script))
      if (!this.d.list().some((x) => x.id === w.id)) return   // 检查期间被删了
      const at = new Date().toISOString()
      const st = this.stateOf(w.id)
      const { next, event } = stepWatchdog(st.hosts[hostKey], outcome, w.threshold, at)
      st.hosts[hostKey] = next
      const label = hostKey === 'local' ? tr('local|本机') : this.d.hosts().find((h) => h.id === hostKey)?.label ?? hostKey
      if (event === 'fire') {
        // 同一轮报警只开一次会话：sessionId 记在主机状态上，恢复正常才清（见 stepWatchdog）
        if (w.autoSession && !next.sessionId) {
          try { next.sessionId = await this.d.openSession(w, { key: hostKey, label }, outcome.value) }
          catch (e) { this.d.log?.('warn', 'watchdog openSession failed', { id: w.id, err: String(e) }) }
        }
        st.history = pushHistory(st.history, { at, hostKey, kind: 'fire', value: outcome.value, ...(next.sessionId ? { sessionId: next.sessionId } : {}) })
        this.d.notify(tr('看门狗「{name}」触发', { name: w.name }), next.sessionId
          ? tr('{host}：{value}，已开 AI 排查会话', { host: label, value: outcome.value || tr('（无输出）') })
          : tr('{host}：{value}', { host: label, value: outcome.value || tr('（无输出）') }), next.sessionId)
      } else if (event === 'recover') {
        st.history = pushHistory(st.history, { at, hostKey, kind: 'recover', value: outcome.value })
        this.d.notify(tr('看门狗「{name}」已恢复', { name: w.name }), tr('{host}：{value}', { host: label, value: outcome.value || tr('正常') }))
      }
      this.d.saveStates(this.states)
      this.d.emit({ ...st })
      if (event) this.d.log?.('info', `watchdog ${event}`, { id: w.id, hostKey })
    } finally { this.running.delete(k) }
  }
}
