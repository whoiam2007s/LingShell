import { randomUUID } from 'node:crypto'
import { createDecoder, logSupported, logTailCommand, parseLogSource, type LogPoll, type LogSource, type TerminalInfo } from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import type { ExecStreamHandlers } from '@lingshell/terminal-core'

// 日志实时查看（tail -F / journalctl -f）：每个日志标签一条独立 exec channel，不碰交互 shell、不记执行记录（只读）。
// 输出在主进程按行缓冲，界面轮询取走（同 dirSync 的进度轮询：不新增事件类型）。
// 清理：界面 stop / 终端断开（channel 随连接关闭）/ 界面久不来取（窗口重载、崩溃）→ 关通道，远端 tail 随之退出
export type OpenStream = (terminalId: string, command: string, h: ExecStreamHandlers) => () => void

export const MAX_PENDING_LINES = 50_000   // 界面暂停也在取，这里只防界面卡住时撑内存
export const MAX_LINE_CHARS = 16_000      // 没有换行的超长输出按此切开
export const IDLE_MS = 30_000             // 这么久没轮询视为界面已不要了
export const MAX_PER_TERMINAL = 4         // 同一终端同时查看的日志数（服务器 MaxSessions 默认 10，还要留给 shell / sftp）

interface Tail { terminalId: string; stop: () => void; rest: string; lines: string[]; dropped: number; ended?: { error?: string }; lastPoll: number }

export class LogTails {
  private m = new Map<string, Tail>()
  private timer?: NodeJS.Timeout
  constructor(private open: OpenStream, private now: () => number = Date.now) {}

  start(terminalId: string, src: LogSource, encoding?: string): string {
    if ([...this.m.values()].filter((t) => t.terminalId === terminalId && !t.ended).length >= MAX_PER_TERMINAL) throw new Error(tr('同一终端最多同时查看 {n} 个日志', { n: MAX_PER_TERMINAL }))
    const id = randomUUID()
    const t: Tail = { terminalId, stop: () => {}, rest: '', lines: [], dropped: 0, lastPoll: this.now() }
    const decode = createDecoder(encoding)
    t.stop = this.open(terminalId, logTailCommand(src), {
      data: (d) => this.push(t, decode(d)),
      end: (error) => {
        if (t.rest) { this.add(t, [t.rest]); t.rest = '' }
        t.ended = error ? { error } : {}
      },
    })
    this.m.set(id, t)   // open 同步抛（终端已断）就不登记
    return id
  }

  private push(t: Tail, s: string) {
    const parts = (t.rest + s).split('\n')
    t.rest = parts.pop() ?? ''
    if (t.rest.length > MAX_LINE_CHARS) { parts.push(t.rest); t.rest = '' }
    this.add(t, parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)))
  }
  private add(t: Tail, ls: string[]) {
    for (const l of ls) t.lines.push(l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) : l)
    const over = t.lines.length - MAX_PENDING_LINES
    if (over > 0) { t.lines.splice(0, over); t.dropped += over }
  }

  /** 取走新行；已结束且取完 → 带上 ended 并移除 */
  poll(id: string): LogPoll {
    const t = this.m.get(id)
    if (!t) return { lines: [], dropped: 0, ended: {} }
    t.lastPoll = this.now()
    const r: LogPoll = { lines: t.lines, dropped: t.dropped }
    t.lines = []; t.dropped = 0
    if (t.ended) { r.ended = t.ended; this.m.delete(id) }
    return r
  }

  stop(id: string) {
    const t = this.m.get(id)
    if (!t) return
    this.m.delete(id)
    t.stop()
  }

  /** 关掉久未轮询的（界面重载 / 崩溃留下的） */
  sweep() {
    const now = this.now()
    for (const [id, t] of this.m) if (now - t.lastPoll > IDLE_MS) this.stop(id)
  }
  get size() { return this.m.size }
  startSweep(ms = 10_000) { this.timer = setInterval(() => this.sweep(), ms); this.timer.unref?.() }
  dispose() { clearInterval(this.timer); for (const id of [...this.m.keys()]) this.stop(id) }
}

export interface LogTailIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  open: OpenStream
}

// msg 是 tk() 标过的完整报错，抛出时再翻译
const str = (v: unknown, msg: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr(msg)); return v }

export function registerLogTail(d: LogTailIpcDeps): LogTails {
  const tails = new LogTails(d.open)
  tails.startSweep()
  d.handle('logs:start', (_e, tid, src) => {
    const t = d.terminal(str(tid, tk('非法的终端')))
    if (!t || !logSupported(t.type, t.os)) throw new Error(tr('日志查看只支持 Linux / macOS 的 SSH 终端'))
    if (t.status === 'disconnected') throw new Error(tr('终端已断开'))
    return tails.start(t.id, parseLogSource(src), t.encoding)
  })
  d.handle('logs:poll', (_e, id) => tails.poll(str(id, tk('非法的日志'))))
  d.handle('logs:stop', (_e, id) => tails.stop(str(id, tk('非法的日志'))))
  return tails
}
