// AI 后台任务（start_background / check_background）的旁路通道：包装命令（mkdir / nohup / 轮询循环）不进用户看得见的交互终端。
// SSH 终端 = 同一连接上开独立 exec channel（不回显、不进命令历史 / 会话日志 / 录像）；本地 Git Bash 终端 = 起一个 bash 子进程。
// 任务的工作目录同终端当前目录（取 shell integration 报的目录；SSH 先 cd，本地设子进程 cwd）。WSL / PowerShell 等其它本地 shell 没有旁路（返回 undefined，工具层退回终端里静默执行）
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { TerminalInfo } from '@lingshell/shared'
import { requireGitBash, terminalEnv, type ExecFullOpts, type ExecFullResult } from '@lingshell/terminal-core'

/** TerminalManager 里用到的部分（测试注入假对象） */
export interface SideExecTerminals {
  list(): TerminalInfo[]
  // shell integration 报的当前目录（不往终端里打 pwd 探测，那会在终端里多出一行提示符）
  knownCwd(id: string): string | undefined
  execFull(id: string, command: string, o: Omit<ExecFullOpts, 'encoding'>): Promise<ExecFullResult>
}
// 本地子进程用的 shell（Windows = Git Bash，其它系统 = /bin/sh）与环境变量（去掉引擎的 API Key，同本地终端）
export const LOCAL_SHELL = { file: () => (process.platform === 'win32' ? requireGitBash() : '/bin/sh'), env: terminalEnv }
export type SideExecResult = { output: string; exitCode: number }

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const MAX_OUT = 256 * 1024

/** 本地起 shell -c 跑一条命令：stdout / stderr 合并，超时或中止时杀掉（后台任务已 nohup 出去，不受影响） */
export function runLocal(file: string, command: string, o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<SideExecResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error('aborted'))
    const p = spawn(file, ['-c', command], { cwd: o.cwd || homedir(), env: o.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', done = false
    const take = (d: Buffer) => { if (out.length < MAX_OUT) out += d.toString('utf8') }
    p.stdout.on('data', take); p.stderr.on('data', take)
    const finish = (r?: SideExecResult, err?: Error) => {
      if (done) return
      done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err); else resolve(r!)
    }
    const onAbort = () => { p.kill(); finish(undefined, new Error('aborted')) }
    const timer = setTimeout(() => { p.kill(); finish({ output: out, exitCode: -1 }) }, o.timeoutMs)
    o.signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', (e) => finish(undefined, e))   // 起不来（bash 不存在）：交给工具层退回
    p.on('close', (code) => finish({ output: out, exitCode: code ?? -1 }))
  })
}

export function createSideExec(d: SideExecTerminals, local = LOCAL_SHELL) {
  return async (id: string, command: string, o: { timeoutMs: number; signal?: AbortSignal; cwd?: boolean }): Promise<SideExecResult | undefined> => {
    const t = d.list().find((x) => x.id === id)
    if (!t) return undefined
    const cwd = o.cwd ? d.knownCwd(id) ?? '' : ''   // 不知道（非 bash / 还没出过提示符）就在家目录跑
    if (t.type === 'ssh') {
      // cd 失败（目录已删）就留在家目录，不影响启动
      const r = await d.execFull(id, cwd ? `cd ${shQuote(cwd)} 2>/dev/null; ${command}` : command, { timeoutMs: o.timeoutMs, signal: o.signal, maxBytes: MAX_OUT })
      if (r.stopped === 'aborted') throw new Error('aborted')
      return { output: r.output, exitCode: r.code ?? -1 }
    }
    if (t.shell) return undefined   // WSL / PowerShell / cmd：不在本机 Git Bash 里，没有旁路
    return runLocal(local.file(), command, { cwd: cwd || undefined, env: local.env(), timeoutMs: o.timeoutMs, signal: o.signal })
  }
}
