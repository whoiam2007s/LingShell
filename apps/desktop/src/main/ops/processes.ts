import {
  PROC_DECISION, PROC_TIMEOUT_MS, isKillablePid, taskkillArgs, isProcSignal, parsePs, parseSignalResult, procAuditCommand, processListCommand, processSignalCommand, processSupported,
  type ProcList, type ProcSignal, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { LocalViews } from './localViews.js'

// 进程管理器主进程侧（命令 / 解析见 shared/ops/processes.ts）：全部走 SSH 独立 exec channel，不碰交互 shell
export type ExecRead = (cmd: string, timeoutMs: number) => Promise<string>

export async function processList(exec: ExecRead): Promise<ProcList> {
  const r = parsePs(await exec(processListCommand(), PROC_TIMEOUT_MS))
  if (!r.rows.length) throw new Error(tr('读不到进程列表：远端 ps 命令不可用或输出无法识别'))
  return r
}

// 不抛：调用方要先记执行记录（含退出码）再决定报错
export async function processSignal(exec: ExecRead, pid: number, sig: ProcSignal): Promise<{ rc?: number; error?: string }> {
  const { rc, message } = parseSignalResult(await exec(processSignalCommand(pid, sig), PROC_TIMEOUT_MS))
  if (rc === 0) return { rc }
  const why = /not permitted/i.test(message) ? tr('没有权限（该进程属于其他用户，需要 root）')
    : /no such process/i.test(message) ? tr('进程已不存在') : message.slice(0, 500) || tr('发送信号失败')
  return { rc, error: why }
}

// ── IPC：渲染层传来的参数一律当不可信，终端类型 / pid / 信号逐个校验 ──
export interface ProcessIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): ExecRead
  // 记执行记录（hostKey / 终端名 / 会话由 ipc.ts 补）
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
  // 本机视图：本地终端看本机进程（不给就不支持本地终端）
  local?: Pick<LocalViews, 'processes' | 'signal'>
}

export function registerProcesses(d: ProcessIpcDeps): void {
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (t.type === 'local' && d.local) return t
    if (!processSupported(t.type, t.os)) throw new Error(tr('进程管理只支持本地终端和 SSH 终端（非 Windows 主机）'))
    return t
  }
  d.handle('processes:list', (_e, id) => { const t = target(id); return t.type === 'local' && d.local ? d.local.processes() : processList(d.exec(t.id)) })
  d.handle('processes:signal', async (_e, id, pid, sig, command) => {
    const t = target(id)
    if (!isKillablePid(pid)) throw new Error(tr('非法的进程号'))
    if (!isProcSignal(sig)) throw new Error(tr('非法的信号'))
    const res = t.type === 'local' && d.local ? await d.local.signal(pid, sig) : await processSignal(d.exec(t.id), pid, sig)
    const cmd = procAuditCommand(pid, sig, typeof command === 'string' ? command : '')
    // 本机 Windows 实际跑的是 taskkill
    d.audit(t.id, { command: t.type === 'local' && process.platform === 'win32' ? cmd.replace(/^kill -\w+ \d+/, `taskkill ${taskkillArgs(pid, sig === 'KILL').join(' ')}`) : cmd, decision: PROC_DECISION, exitCode: res.rc })
    if (res.error) throw new Error(res.error)
  })
}
