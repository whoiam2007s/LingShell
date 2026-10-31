import { randomUUID } from 'node:crypto'
import {
  LogMerger, LOG_SEARCH_TIMEOUT_MS, MULTI_LOG_MAX_HOSTS, createDecoder, logTailCommand, logSearchCommand, parseLogSearch, parseLogSearchOutput, parseLogSource,
  type CompareTarget, type LogSearchHostResult, type LogSource, type MergedLine, type MultiLogPoll, type MultiLogTarget,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { ExecStreamHandlers } from '@lingshell/terminal-core'
import { MAX_LINE_CHARS, MAX_PENDING_LINES, IDLE_MS } from './logTail.js'
import type { Runner } from './batchExec.js'

// 多主机日志（只读，不进终端 / 命令历史 / 执行记录）：
//  - 实时合流：每台一条 tail -F / journalctl -f 独立通道（在线终端复用其连接，否则临时连接，停止时断开），
//    新行进 LogMerger 按时间归并，界面轮询取走（同单台 logTail.ts）。界面久不来取 / 停止 → 关全部通道
//  - 历史检索：每台跑一次 logSearchCommand（当前文件 + 轮转 + .gz / journalctl），本机再按时间段精确筛
/** 打开一台的流式通道；连接失败 reject。返回关闭函数（含断开临时连接） */
export type OpenTargetStream = (t: CompareTarget, command: string, h: ExecStreamHandlers) => Promise<() => void>
export const MAX_MULTI_TAILS = 4
const SEARCH_MAX_BYTES = 16 * 1024 * 1024

interface Host { stop?: () => void; rest: string; ended?: { error?: string } }
interface Multi { hosts: Host[]; merger: LogMerger; out: MergedLine[]; dropped: number; lastPoll: number; stopped: boolean }

export class MultiTails {
  private m = new Map<string, Multi>()
  private timer?: NodeJS.Timeout
  constructor(private open: OpenTargetStream, private encoding: (t: CompareTarget) => string | undefined = () => undefined, private now: () => number = Date.now) {}

  start(targets: MultiLogTarget[], src: LogSource): string {
    if ([...this.m.values()].filter((x) => !x.stopped).length >= MAX_MULTI_TAILS) throw new Error(tr('最多同时开 {n} 个多主机日志', { n: MAX_MULTI_TAILS }))
    const id = randomUUID()
    const x: Multi = { hosts: targets.map(() => ({ rest: '' })), merger: new LogMerger(targets.length, this.now()), out: [], dropped: 0, lastPoll: this.now(), stopped: false }
    this.m.set(id, x)
    const cmd = logTailCommand(src)
    targets.forEach((t, i) => {
      const h = x.hosts[i], decode = createDecoder(this.encoding(t.target))
      const end = (error?: string) => {
        if (h.ended) return
        if (h.rest) { this.add(x, i, [h.rest]); h.rest = '' }
        h.ended = error ? { error } : {}
        x.merger.end(i)
      }
      this.open(t.target, cmd, {
        data: (d) => this.push(x, i, decode(d)),
        end: (e) => end(e ?? (x.stopped ? undefined : tr('已停止：远端命令已退出或连接已断开'))),
      }).then((stop) => { if (x.stopped) stop(); else h.stop = stop }, (e) => end(e instanceof Error ? e.message : String(e)))
    })
    return id
  }

  private push(x: Multi, i: number, s: string) {
    const h = x.hosts[i]
    const parts = (h.rest + s).split('\n')
    h.rest = parts.pop() ?? ''
    if (h.rest.length > MAX_LINE_CHARS) { parts.push(h.rest); h.rest = '' }
    this.add(x, i, parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)))
  }
  private add(x: Multi, i: number, ls: string[]) {
    x.merger.push(i, ls.map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)), this.now())
    this.flush(x, false)
  }
  private flush(x: Multi, all: boolean) {
    for (const it of x.merger.drain(this.now(), all)) x.out.push(it)
    const over = x.out.length - MAX_PENDING_LINES
    if (over > 0) { x.out.splice(0, over); x.dropped += over }
  }

  /** 取走已归并的新行；全部结束且取完 → ended 并移除 */
  poll(id: string): MultiLogPoll {
    const x = this.m.get(id)
    if (!x) return { items: [], dropped: 0, hosts: [], ended: true }
    x.lastPoll = this.now()
    const allEnded = x.hosts.every((h) => h.ended)
    this.flush(x, allEnded)
    const r: MultiLogPoll = { items: x.out, dropped: x.dropped, hosts: x.hosts.map((h) => (h.ended ? { ended: h.ended } : {})) }
    x.out = []; x.dropped = 0
    if (allEnded && !x.merger.size) { r.ended = true; this.m.delete(id) }
    return r
  }

  stop(id: string) {
    const x = this.m.get(id)
    if (!x) return
    this.m.delete(id)
    x.stopped = true
    for (const h of x.hosts) { try { h.stop?.() } catch { /* 已关 */ } }
  }
  sweep() { const now = this.now(); for (const [id, x] of this.m) if (now - x.lastPoll > IDLE_MS) this.stop(id) }
  get size() { return this.m.size }
  startSweep(ms = 10_000) { this.timer = setInterval(() => this.sweep(), ms); this.timer.unref?.() }
  dispose() { clearInterval(this.timer); for (const id of [...this.m.keys()]) this.stop(id) }
}

/** 一台的历史检索：失败折成 error（不抛） */
export async function searchHost(open: () => Promise<Runner>, q: ReturnType<typeof parseLogSearch>): Promise<LogSearchHostResult & { error?: string }> {
  const empty = { lines: [], times: [], files: [], notes: [], rawCapped: false, capped: 0 }
  let r: Runner
  try { r = await open() } catch (e) { return { ...empty, error: (e as Error).message ?? String(e) } }
  try {
    const x = await r.exec(logSearchCommand(q), { timeoutMs: LOG_SEARCH_TIMEOUT_MS, maxBytes: SEARCH_MAX_BYTES })
    const res = parseLogSearchOutput(x.output, q)
    if (x.stopped === 'timeout') return { ...res, error: tr('检索超时（{s}s），只有部分结果', { s: LOG_SEARCH_TIMEOUT_MS / 1000 }) }
    if (x.truncated) res.notes.push(tr('输出过大已截断，请加关键字或缩小时间段'))
    if (q.src.kind === 'file' && !res.files.length && !res.notes.length) return { ...res, error: tr('没有找到这个文件（或没有权限读）') }
    return res
  } catch (e) {
    return { ...empty, error: (e as Error).message ?? String(e) }
  } finally { r.close() }
}

export interface LogMultiDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  open: OpenTargetStream
  runner(t: CompareTarget): () => Promise<Runner>
  encoding(t: CompareTarget): string | undefined
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

/** 校验目标：只要 SSH（已保存主机 / 在线终端），1–MULTI_LOG_MAX_HOSTS 台 */
export function parseTargets(v: unknown): MultiLogTarget[] {
  const ts = (Array.isArray(v) ? v : []).filter((x): x is MultiLogTarget => {
    const t = (x as MultiLogTarget)?.target
    return typeof (x as MultiLogTarget)?.label === 'string' && ((t?.kind === 'host' && typeof t.hostId === 'string') || (t?.kind === 'terminal' && typeof t.terminalId === 'string'))
  })
  if (!ts.length) throw new Error(tr('请选择主机（只支持 SSH 主机）'))
  if (ts.length > MULTI_LOG_MAX_HOSTS) throw new Error(tr('最多 {n} 台', { n: MULTI_LOG_MAX_HOSTS }))
  return ts
}
const isRemote = (t: unknown): t is CompareTarget => {
  const x = t as CompareTarget
  return (x?.kind === 'host' && typeof x.hostId === 'string') || (x?.kind === 'terminal' && typeof x.terminalId === 'string')
}

export function registerLogMulti(d: LogMultiDeps): MultiTails {
  const tails = new MultiTails(d.open, d.encoding)
  tails.startSweep()
  d.handle('logMulti:start', (_e, ts, src) => {
    const targets = parseTargets(ts), s = parseLogSource(src)
    d.log?.('info', '多主机日志开始', { hosts: targets.length, kind: s.kind })   // i18n-ignore 日志
    return tails.start(targets, s)
  })
  d.handle('logMulti:poll', (_e, id) => tails.poll(String(id)))
  d.handle('logMulti:stop', (_e, id) => tails.stop(String(id)))
  d.handle('logMulti:search', async (_e, t, q) => {
    if (!isRemote(t)) throw new Error(tr('只支持 SSH 主机'))
    const qq = parseLogSearch(q, parseLogSource((q as { src?: unknown })?.src))
    return searchHost(d.runner(t), qq)
  })
  return tails
}
