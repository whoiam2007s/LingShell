// 传输队列：上传 / 下载任务排队，按并发上限执行；状态 排队中 → 进行中 → 完成 / 失败 / 已取消。
// 失败或取消的可按原参数重跑（run 闭包本身就是"同参数任务"）。逐个文件直传的任务（resumable）可暂停，重跑时由 run 从半截文件接着传；
// 其余（加密打包上传等）重试从头来。已结束的任务存历史（HistoryStore），重启后只读展示。
// 纯逻辑、不依赖 electron，便于测试；具体怎么传由 TransferService 提供 run。
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TransferMove, TransferProgressEvent, TransferReveal, TransferState } from '@lingshell/shared'
import { tr } from '@lingshell/shared'

type Ev = TransferProgressEvent
// run 里能改的进度字段
export type TransferPatch = Partial<Pick<Ev, 'stage' | 'stagePercent' | 'overallPercent' | 'fileDone' | 'fileTotal' | 'cancellable' | 'bytesDone' | 'bytesTotal' | 'reveal' | 'files' | 'target' | 'skipped'>>
export interface TaskCtx {
  signal: AbortSignal
  progress(p: TransferPatch): void
  paused(): boolean          // 这次中止是「暂停」（保留半截文件以便续传）还是「取消」
}
export interface TaskSpec<T> {
  kind: Ev['kind']
  files: string[]
  target?: string
  reveal?: TransferReveal
  resumable?: boolean                 // 可暂停 / 断点续传（run 自己负责从半截文件接着传）
  cleanup?: () => Promise<void>       // 放弃已暂停 / 失败的任务时删掉半截文件
  run(ctx: TaskCtx): Promise<T>
}
// 历史记录存取（已结束的任务，重启后还能看到）
export interface HistoryStore { load(): Ev[]; save(list: Ev[]): void }
/** 存成一个 JSON 文件；读坏了当没有 */
export function fileHistory(path: string): HistoryStore {
  return {
    load: () => { try { const v = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(v) ? v.filter((e) => e && typeof e.taskId === 'string' && Array.isArray(e.files)) : [] } catch { return [] } },
    save: (list) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(list)) },
  }
}

interface Job {
  ev: Ev
  run: (ctx: TaskCtx) => Promise<unknown>
  cleanup?: () => Promise<void>
  pausing?: boolean
  ac: AbortController
  waiter?: { resolve(v: unknown): void; reject(e: unknown): void }   // 首次入队调用方；重试没有调用方
  lastEmit: number
  speedAt: number   // 上次采样速度的时间与字节
  speedBytes: number
  sampled?: boolean  // 已建立速度基线（第一次采样只记基线，不把续传前的量算成瞬时速度）
}

const FINISHED: TransferState[] = ['done', 'error', 'cancelled']
export const isFinished = (s: TransferState): boolean => FINISHED.includes(s)
const KEEP_FINISHED = 200   // 已结束的最多留这么多条（面板可手动清除）
const EMIT_MS = 150         // 只有字节数变化时的事件节流
const SPEED_MS = 500        // 速度采样间隔

// 平滑速度：新样本占 30%，避免数字乱跳；没有旧值直接用样本
export function nextSpeed(prev: number | undefined, dBytes: number, dtMs: number): number {
  const inst = dtMs > 0 ? (dBytes * 1000) / dtMs : 0
  return prev === undefined ? inst : prev * 0.7 + inst * 0.3
}
// 剩余秒数；速度为 0 或总量未知时算不出
export function etaOf(done: number | undefined, total: number | undefined, speed: number | undefined): number | undefined {
  if (!total || done === undefined || !speed || speed <= 0) return undefined
  return Math.max(0, Math.round((total - done) / speed))
}
export const isQueueMove = (v: unknown): v is TransferMove => v === 'top' || v === 'up' || v === 'down'
export const clampConcurrency = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 2)

export class TransferQueue {
  private jobs = new Map<string, Job>()
  constructor(private emit: (ev: Ev) => void, private concurrency: () => number = () => 2, private now: () => number = Date.now, private history?: HistoryStore) {
    // 上次运行留下的：只读展示（没有 run，不能重试）；当时还没结束的算中断
    for (const ev of history?.load() ?? []) {
      const e: Ev = { ...ev, restored: true, paused: false, resumable: false, cancellable: false, speed: undefined, etaSec: undefined, queuePos: undefined }
      if (!isFinished(e.state)) { e.state = 'error'; e.stage = 'error'; e.error = tr('应用退出时中断') }
      this.jobs.set(e.taskId, { ev: e, run: () => Promise.reject(new Error(tr('历史记录，不能重试'))), ac: new AbortController(), lastEmit: 0, speedAt: 0, speedBytes: 0 })
    }
  }
  private persist(): void {
    if (!this.history) return
    try { this.history.save([...this.jobs.values()].filter((j) => isFinished(j.ev.state)).map((j) => ({ ...j.ev })).slice(-KEEP_FINISHED)) } catch { /* 写不了历史不影响传输 */ }
  }

  // 入队，返回任务结束时的结果（失败 / 取消则 reject）。taskId 同步可得：用 onId 拿
  enqueue<T>(spec: TaskSpec<T>, onId?: (id: string) => void): Promise<T> {
    const id = 'tf_' + randomBytes(4).toString('hex')
    const ev: Ev = {
      type: 'transfer:progress', taskId: id, kind: spec.kind, files: spec.files, target: spec.target, reveal: spec.reveal,
      state: 'queued', stage: 'pack', stagePercent: 0, overallPercent: 0, cancellable: true, createdAt: this.now(), resumable: spec.resumable || undefined,
    }
    const p = new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { ev, run: spec.run, cleanup: spec.cleanup, ac: new AbortController(), waiter: { resolve: resolve as (v: unknown) => void, reject }, lastEmit: 0, speedAt: 0, speedBytes: 0 })
    })
    onId?.(id)
    this.send(this.jobs.get(id)!)
    this.pump()
    return p
  }

  list(): Ev[] { return [...this.jobs.values()].map((j) => ({ ...j.ev })) }
  activeCount(): number { return [...this.jobs.values()].filter((j) => !isFinished(j.ev.state)).length }

  // 排队中的直接取消；进行中的发中止信号，由 run 收尾后落到「已取消」。
  // run 标了不可取消（如远端解压中）的只有 force（退出应用）才中止
  cancel(id: string, force = false): void {
    const j = this.jobs.get(id)
    if (!j || isFinished(j.ev.state)) return
    if (j.ev.state === 'queued') return this.finish(j, 'cancelled', new Error(tr('已取消')))
    if (j.ev.cancellable === false && !force) return
    j.ac.abort()
  }
  cancelAll(force = false): void { for (const id of [...this.jobs.keys()]) this.cancel(id, force) }

  // 暂停（只对可续传的进行中任务）：中止但保留半截文件，「继续」= retry 从断点接着传
  pause(id: string): void {
    const j = this.jobs.get(id)
    if (!j || j.ev.state !== 'running' || !j.ev.resumable) return
    j.pausing = true
    j.ac.abort()
  }
  // 放弃：删掉已暂停 / 失败任务的半截文件，并从列表移除
  async discard(id: string): Promise<void> {
    const j = this.jobs.get(id)
    if (!j || !isFinished(j.ev.state)) return
    this.jobs.delete(id)
    this.persist()
    await j.cleanup?.().catch(() => {})
  }

  // 失败 / 已取消 / 已暂停 → 原参数重新排队（可续传的从断点接着传，其余从头）
  retry(id: string): void {
    const j = this.jobs.get(id)
    if (!j || j.ev.restored || (j.ev.state !== 'error' && j.ev.state !== 'cancelled')) return
    j.ac = new AbortController()
    j.waiter = undefined
    j.pausing = false
    j.speedAt = 0; j.speedBytes = 0; j.sampled = false
    const { taskId, kind, files, target, reveal, resumable } = j.ev
    j.ev = { type: 'transfer:progress', taskId, kind, files, target, reveal, resumable, state: 'queued', stage: 'pack', stagePercent: 0, overallPercent: 0, cancellable: true, createdAt: this.now() }
    this.jobs.delete(taskId); this.jobs.set(taskId, j)   // 重排到队尾（与新 createdAt 一致）
    this.send(j)
    this.pump()
  }

  // 调整排队顺序：top = 优先传输（移到队首）、up / down 移一位。只动排队中的，进行中的不受影响
  reorder(id: string, to: TransferMove): void {
    const queued = [...this.jobs.values()].filter((j) => j.ev.state === 'queued')
    const i = queued.findIndex((j) => j.ev.taskId === id)
    if (i < 0) return
    const k = to === 'top' ? 0 : to === 'up' ? Math.max(0, i - 1) : Math.min(queued.length - 1, i + 1)
    if (k === i) return
    queued.splice(k, 0, ...queued.splice(i, 1))
    // 重建 Map：非排队的按原顺序在前（不参与调度），排队的按新顺序接在后面；pump 按 Map 顺序取
    const rest = [...this.jobs.values()].filter((j) => j.ev.state !== 'queued')
    this.jobs = new Map([...rest, ...queued].map((j) => [j.ev.taskId, j]))
    for (const j of queued) this.send(j)   // 带新的 queuePos，面板据此排序
  }

  // 已暂停的不清（还能继续）；要丢掉用「放弃」
  clearFinished(): void {
    for (const [id, j] of this.jobs) if (isFinished(j.ev.state) && !j.ev.paused) {
      this.jobs.delete(id)
      void j.cleanup?.().catch(() => {})   // 失败任务留下的半截文件 / 远端临时包：清掉，别让「清除已完成」把唯一的清理入口删了
    }
    this.persist()
  }

  private pump(): void {
    const max = clampConcurrency(this.concurrency())
    let running = [...this.jobs.values()].filter((j) => j.ev.state === 'running').length
    for (const j of this.jobs.values()) {   // Map 按插入顺序：先来先跑
      if (running >= max) break
      if (j.ev.state !== 'queued') continue
      running++
      this.start(j)
    }
  }

  private start(j: Job): void {
    j.ev.state = 'running'
    j.speedAt = this.now(); j.speedBytes = 0; j.sampled = false
    this.send(j)
    const ctx: TaskCtx = { signal: j.ac.signal, progress: (p) => this.progress(j, p), paused: () => !!j.pausing }
    j.run(ctx).then(
      (v) => this.finish(j, j.ac.signal.aborted ? 'cancelled' : 'done', undefined, v),
      (e) => this.finish(j, j.ac.signal.aborted ? 'cancelled' : 'error', e),
    )
  }

  private progress(j: Job, p: TransferPatch): void {
    if (isFinished(j.ev.state)) return
    const stageChanged = p.stage !== undefined && p.stage !== j.ev.stage
    Object.assign(j.ev, p)
    const t = this.now()
    if (j.ev.bytesDone !== undefined && t - j.speedAt >= SPEED_MS) {
      // 换阶段（打包 → 传输）字节数会回落，此时只重置采样起点。
      // 第一次采样（含续传一开始就报出已传字节）也只记基线：否则会把断点前的量当成瞬时速度
      const d = j.ev.bytesDone - j.speedBytes
      if (d < 0) { j.ev.speed = undefined; j.sampled = false }
      else if (!j.sampled) j.sampled = true
      else j.ev.speed = nextSpeed(j.ev.speed, d, t - j.speedAt)
      j.speedAt = t; j.speedBytes = j.ev.bytesDone
      j.ev.etaSec = etaOf(j.ev.bytesDone, j.ev.bytesTotal, j.ev.speed)
    }
    // 只有字节 / 文件计数 / 百分比变化时按 150ms 节流；换阶段、可取消性变化立即发
    const onlyBytes = !stageChanged && p.cancellable === undefined
    if (onlyBytes && t - j.lastEmit < EMIT_MS) return
    this.send(j)
  }

  private finish(j: Job, state: TransferState, err?: unknown, value?: unknown): void {
    if (isFinished(j.ev.state)) return
    j.ev.state = state
    j.ev.cancellable = false
    j.ev.speed = undefined; j.ev.etaSec = undefined
    j.ev.paused = state === 'cancelled' && !!j.pausing ? true : undefined
    if (state === 'done') { j.ev.stage = 'done'; j.ev.stagePercent = 100; j.ev.overallPercent = 100; j.ev.error = undefined }
    else {
      j.ev.stage = 'error'
      j.ev.error = j.ev.paused ? tr('已暂停') : state === 'cancelled' ? tr('已取消') : err instanceof Error ? err.message : String(err)
    }
    this.send(j)
    const w = j.waiter
    j.waiter = undefined
    if (w) { if (state === 'done') w.resolve(value); else w.reject(state === 'cancelled' ? new Error(j.ev.paused ? tr('已暂停') : tr('已取消')) : err) }
    this.prune()
    this.persist()
    this.pump()
  }

  private prune(): void {
    const done = [...this.jobs.values()].filter((j) => isFinished(j.ev.state))
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) {
      this.jobs.delete(j.ev.taskId)
      void j.cleanup?.().catch(() => {})
    }
  }

  private send(j: Job): void {
    j.lastEmit = this.now()
    // 排队中的带上队内位置（1 起）；只有 reorder 会改变排队项之间的相对顺序，届时会逐个重发
    j.ev.queuePos = j.ev.state === 'queued' ? [...this.jobs.values()].filter((x) => x.ev.state === 'queued').indexOf(j) + 1 : undefined
    this.emit({ ...j.ev })
  }
}
