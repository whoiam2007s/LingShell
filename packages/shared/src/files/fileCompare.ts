// ── 多台主机比对配置文件（只读）──────────────────────
// 用户手动发起：读每台主机上同一路径的文件，逐台与基准比对。读取走 SFTP，不经交互终端、从不写。
import type { HostSummary, HostEnv, TerminalInfo } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

/** 比对目标：本机 / 已保存主机（有在线终端复用其连接，否则临时连接）/ 未保存主机的在线 SSH 终端 */
export type CompareTarget = { kind: 'local' } | { kind: 'host'; hostId: string } | { kind: 'terminal'; terminalId: string }

export interface CompareOpts {
  baseline: number          // 基准在 targets 里的下标
  ignoreNoise?: boolean     // 忽略空白和注释行
}

export type CompareResult =
  | { status: 'baseline' }
  | { status: 'same' }
  | { status: 'diff'; added: number; removed: number; diff: string }
  | { status: 'error'; error: string }
  | { status: 'skipped' }   // 基准读取失败，无从比对（本机读成功了）

export const COMPARE_MIN = 2
export const COMPARE_MAX = 6
export const COMPARE_MAX_BYTES = 1024 * 1024
export const COMPARE_QUICK_PATHS = ['/etc/nginx/nginx.conf', '/etc/hosts', '/etc/ssh/sshd_config', '/etc/my.cnf']

/** 选择列表的一项。live = 有在线终端（复用其连接）；否则比对时临时连接 */
export interface CompareChoice { key: string; label: string; detail?: string; env?: HostEnv; live: boolean; target: CompareTarget }

/** 候选：本机 + 每台已保存主机（有无在线终端都只列一次）+ 未保存主机的在线 SSH 终端 */
export function compareChoices(hosts: HostSummary[], terms: TerminalInfo[]): CompareChoice[] {
  const running = terms.filter((t) => t.status === 'running')
  return [
    { key: 'local', label: tr('local|本机'), live: true, target: { kind: 'local' } },
    ...hosts.map((h): CompareChoice => ({
      key: `host:${h.id}`, label: h.label, detail: `${h.username}@${h.host}:${h.port}`, env: h.env,
      live: running.some((t) => t.hostId === h.id), target: { kind: 'host', hostId: h.id },
    })),
    ...running.filter((t) => t.type === 'ssh' && !t.hostId).map((t): CompareChoice => ({
      key: `term:${t.id}`, label: t.title, detail: t.detail, live: true, target: { kind: 'terminal', terminalId: t.id },
    })),
  ]
}

/** 「忽略空白和注释行」：统一换行，每行去首尾空白、连续空白压成一个，丢掉空行和 # / ; 开头的行 */
export function normalizeConfig(text: string): string {
  return text.split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l && !l.startsWith('#') && !l.startsWith(';'))
    .join('\n')
}
