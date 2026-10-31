// 磁盘空间分析（只读，命令与解析见 shared/ops/diskUsage.ts）：SSH 终端走独立 exec channel（不进交互 shell / 命令历史），
// 本地终端起 Git Bash 子进程跑同样的 du / find。不写执行记录（只读统计，同主机体检）
import {
  DISK_BIG_TIMEOUT_SEC, DISK_EXEC_MARGIN_MS, DISK_LEVEL_TIMEOUT_SEC, diskBigCommand, diskCommonCommand, diskDeletedCommand, diskLevelCommand, diskLinuxOnly, diskSupported,
  parseDiskBig, parseDiskCommon, parseDiskDeleted, parseDiskLevel, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'

const MAX_BYTES = 1024 * 1024
export type DiskExec = (command: string, o: ExecFullOpts) => Promise<ExecFullResult>

export interface DiskUsageDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  /** SSH 终端的独立 exec channel */
  sshExec(terminalId: string): DiskExec
  /** 本机：Git Bash 子进程；没有 Git Bash（Windows）返回 undefined */
  localExec(): DiskExec | undefined
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

/** 渲染层传来的 scope / 路径一律当不可信 */
export function diskTarget(d: Pick<DiskUsageDeps, 'terminal' | 'sshExec' | 'localExec'>, scope: unknown): { exec: DiskExec; linux: boolean } {
  if (scope === 'local') {
    const exec = d.localExec()
    if (!exec) throw new Error(tr('本机磁盘分析需要 Git Bash（Git for Windows），没有检测到'))
    return { exec, linux: process.platform === 'linux' }
  }
  const id = (scope as { terminalId?: unknown } | null)?.terminalId
  const t = typeof id === 'string' ? d.terminal(id) : undefined
  if (!t) throw new Error('terminal_not_found')
  if (t.type !== 'ssh') return diskTarget(d, 'local')
  if (!diskSupported(t.type, t.os)) throw new Error(tr('磁盘空间分析不支持 Windows 的 SSH 主机'))
  return { exec: d.sshExec(t.id), linux: diskLinuxOnly(t.type, t.os) }
}

const dirOf = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\r\n\0]/.test(v)) throw new Error(tr('非法的目录'))
  return v.trim()
}

export async function runDisk(exec: DiskExec, command: string, timeoutSec: number): Promise<string> {
  const r = await exec(command, { timeoutMs: timeoutSec * 1000 + DISK_EXEC_MARGIN_MS, maxBytes: MAX_BYTES })
  return r.output
}

export function registerDiskUsage(d: DiskUsageDeps): void {
  d.handle('disk:level', async (_e, scope, dir) => {
    const p = dirOf(dir)
    const r = parseDiskLevel(await runDisk(diskTarget(d, scope).exec, diskLevelCommand(p), DISK_LEVEL_TIMEOUT_SEC), p)
    d.log?.('info', 'disk level', { entries: r.entries.length, truncated: r.truncated })
    return r
  })
  d.handle('disk:big', async (_e, scope, dir) => {
    const p = dirOf(dir)
    return parseDiskBig(await runDisk(diskTarget(d, scope).exec, diskBigCommand(p), DISK_BIG_TIMEOUT_SEC), p)
  })
  d.handle('disk:common', async (_e, scope) => {
    const t = diskTarget(d, scope)
    if (!t.linux) throw new Error(tr('「常见占用」只支持 Linux 主机'))
    return parseDiskCommon(await runDisk(t.exec, diskCommonCommand(), 30))
  })
  d.handle('disk:deleted', async (_e, scope) => {
    const t = diskTarget(d, scope)
    if (!t.linux) throw new Error(tr('「已删除仍被占用」只支持 Linux 主机（要读 /proc 或 lsof）'))
    return parseDiskDeleted(await runDisk(t.exec, diskDeletedCommand(), 20))
  })
}

