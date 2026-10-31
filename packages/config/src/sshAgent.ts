import { existsSync, readdirSync } from 'node:fs'
import { tr, tk, type SshAgentInfo } from '@lingshell/shared'

// 系统 ssh-agent 自动检测（每次连接时现查，agent 后启动也能用）。
// Windows：OpenSSH agent 服务管道 → Pageant 0.75+ 的 OpenSSH 兼容管道（pageant.<用户>.<hash>）→ 管道形式的 SSH_AUTH_SOCK。
//   不用 ssh2 的 'pageant'（要 spawn ssh2/util/pagent.exe，打包后在 asar 内跑不起来，且没法探测 Pageant 是否在跑）。
//   Git Bash/cygwin 的 unix socket 式 SSH_AUTH_SOCK 不认（ssh2 走 cygwin 握手，不可靠）。
// macOS/Linux：SSH_AUTH_SOCK 指向的 socket 存在即可。

/** 探测注入点（测试用假实现） */
export interface AgentProbe {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists(path: string): boolean
  listPipes(): string[]          // Windows 命名管道名列表（\\.\pipe\ 下）
}

const PIPE = '\\\\.\\pipe\\'
const OPENSSH_PIPE = PIPE + 'openssh-ssh-agent'
const isPipe = (p: string) => /^[/\\][/\\]\.[/\\]pipe[/\\].+/.test(p)

export function nodeAgentProbe(): AgentProbe {
  return {
    platform: process.platform, env: process.env,
    exists: (p) => { try { return existsSync(p) } catch { return false } },
    listPipes: () => { try { return readdirSync(PIPE) } catch { return [] } },
  }
}

export function detectSshAgent(probe: AgentProbe = nodeAgentProbe()): SshAgentInfo | undefined {
  const sock = probe.env.SSH_AUTH_SOCK?.trim()
  if (probe.platform !== 'win32') return sock && probe.exists(sock) ? { kind: 'sock', path: sock, label: tr('ssh-agent（{path}）', { path: sock }) } : undefined
  if (probe.exists(OPENSSH_PIPE)) return { kind: 'openssh', path: OPENSSH_PIPE, label: 'Windows OpenSSH agent' }
  const pageant = probe.listPipes().find((n) => n.toLowerCase().startsWith('pageant.'))
  if (pageant) return { kind: 'pageant', path: PIPE + pageant, label: 'Pageant' }
  if (sock && isPipe(sock) && probe.exists(sock)) return { kind: 'sock', path: sock, label: tr('ssh-agent（{path}）', { path: sock }) }
  return undefined
}

// 显示处（requireSshAgent 抛错时）再 tr()
export const AGENT_UNAVAILABLE = tk('ssh_agent_unavailable: 未检测到 ssh-agent/Pageant（Windows 请启动「OpenSSH Authentication Agent」服务或 Pageant 0.75+；macOS/Linux 需设置 SSH_AUTH_SOCK），并用 ssh-add 加载密钥')

/** 取 agent 路径，没有则抛 ssh_agent_unavailable */
export function requireSshAgent(detect: () => SshAgentInfo | undefined = detectSshAgent): string {
  const a = detect()
  if (!a) throw new Error(tr(AGENT_UNAVAILABLE))
  return a.path
}
