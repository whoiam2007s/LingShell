// 批量执行（见 shared/ops/batchExec.ts）：一台一次，经独立 exec channel 跑命令（本机走子进程），从不往交互终端里敲。
// 单台任何失败都折成结果，不抛；超时 / 取消关 channel（远端进程是否随之退出取决于 sshd）。
import { spawn } from 'node:child_process'
import { setMaxListeners } from 'node:events'
import { BATCH_MAX_OUTPUT, tr, type BatchExecResult } from '@lingshell/shared'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'

export type Exec = (command: string, o: ExecFullOpts) => Promise<ExecFullResult>
/** 一台的执行通道：在线终端复用其连接（close 空操作），否则临时连接（close 断开） */
export interface Runner { exec: Exec; close(): void }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 连接超时：要比首连指纹确认的等待（2 分钟）长，否则用户还没点完「信任」，这台就已经显示「连接超时」 */
export const BATCH_CONNECT_TIMEOUT_MS = 130_000

/** 跑一台。connectTimeoutMs 内拿不到通道算连接失败（临时连接首连可能要等用户确认指纹）；
 *  onExec：命令确实发出去了才回调（记执行记录用，连接失败 / 没起就取消的不记） */
export async function runBatchHost(open: () => Promise<Runner>, command: string, timeoutMs: number, signal: AbortSignal,
  onExec?: (r: BatchExecResult) => void, connectTimeoutMs = BATCH_CONNECT_TIMEOUT_MS): Promise<BatchExecResult> {
  const t0 = Date.now()
  const done = (r: Omit<BatchExecResult, 'ms'>): BatchExecResult => ({ ...r, ms: Date.now() - t0 })
  if (signal.aborted) return done({ status: 'canceled' })
  let runner: Runner
  let timer: NodeJS.Timeout | undefined, onAbort = () => {}
  const opening = open()
  try {
    runner = await Promise.race([opening, new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(tr('连接超时（{s}s）', { s: connectTimeoutMs / 1000 }))), connectTimeoutMs)
      onAbort = () => rej(new Error('canceled'))
      signal.addEventListener('abort', onAbort)
    })])
  } catch (e) {
    opening.then((r) => r.close(), () => {})   // 超时 / 取消后才连上：直接断，不泄漏
    return done(signal.aborted ? { status: 'canceled' } : { status: 'conn_error', error: errMsg(e) })
  } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
  let r: BatchExecResult
  try {
    const x = await runner.exec(command, { timeoutMs, maxBytes: BATCH_MAX_OUTPUT, signal })
    const base = { output: x.output, ...(x.truncated ? { truncated: true } : {}) }
    r = x.stopped ? done({ status: x.stopped === 'timeout' ? 'timeout' : 'canceled', ...base })
      : done({ status: x.code === 0 ? 'ok' : 'fail', exitCode: x.code, ...base })
  } catch (e) {
    return done({ status: 'conn_error', error: errMsg(e) })   // 通道开不出来 / 终端已断：命令没发出去
  } finally { runner.close() }
  onExec?.(r)
  return r
}

/** 结束整棵进程树：只 kill 外层 sh 时孙进程（sleep / npm / ping）还拿着 stdout，close 永远不来、任务一直「运行中」 */
export function killTree(pid: number | undefined, win = process.platform === 'win32'): void {
  if (!pid) return
  if (win) {
    try { spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}) } catch { /* taskkill 不可用就算了 */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }   // detached 时 pid = 进程组号
}

/** 本机：子进程跑（Windows 优先 Git Bash，没有则 cmd），stdout/stderr 合并按到达顺序。
 *  超时 / 取消：杀整棵进程树，并且不等 close（孙进程可能还占着管道）立即返回 */
export function localRunner(shell?: string): Runner {
  return {
    close() {},
    exec: (command, o) => new Promise<ExecFullResult>((resolve, reject) => {
      const win = process.platform === 'win32'
      // POSIX 用 detached 让子进程自成一个进程组，killTree 才能一次杀掉所有后代
      const p = shell ? spawn(shell, ['-c', command], { windowsHide: true, detached: !win })
        : win ? spawn(command, { shell: true, windowsHide: true }) : spawn('/bin/sh', ['-c', command], { detached: true })
      const max = o.maxBytes ?? BATCH_MAX_OUTPUT
      const chunks: Buffer[] = []
      let size = 0, truncated = false, stopped: ExecFullResult['stopped'], settled = false
      const take = (d: Buffer) => { if (size >= max) truncated = true; else { chunks.push(d); size += d.length; if (size > max) truncated = true } }
      p.stdout.on('data', take); p.stderr.on('data', take)
      const out = () => Buffer.concat(chunks).subarray(0, max).toString('utf8')
      const finish = (r: ExecFullResult) => { if (settled) return; settled = true; end(); resolve(r) }
      const stop = (why: 'timeout' | 'aborted') => {
        if (settled) return
        stopped ??= why
        killTree(p.pid, win)
        // 不等 close：给 300ms 收尾输出后直接返回
        setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); finish({ code: null, output: out(), truncated, stopped }) }, 300).unref?.()
      }
      const timer = setTimeout(() => stop('timeout'), o.timeoutMs)
      const onAbort = () => stop('aborted')
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort)
      function end() { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort) }
      p.on('error', (e) => { if (settled) return; settled = true; end(); reject(e) })
      p.on('close', (code) => finish({ code: stopped ? null : code, output: out(), truncated, ...(stopped ? { stopped } : {}) }))
    }),
  }
}

/** runId → 中止器：cancel 一次中止该批所有在跑的；先 cancel 后到的调用直接是「已取消」。只留最近 20 批 */
export class BatchRuns {
  private runs = new Map<string, AbortController>()
  signal(runId: string): AbortSignal {
    let c = this.runs.get(runId)
    if (!c) {
      c = new AbortController()
      setMaxListeners(100, c.signal)   // 并发上限 20，每台挂 1–2 个监听
      this.runs.set(runId, c)
      for (const k of [...this.runs.keys()].slice(0, -20)) this.runs.delete(k)
    }
    return c.signal
  }
  cancel(runId: string): void { this.signal(runId); this.runs.get(runId)?.abort() }
}
