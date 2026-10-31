import { osFromUname } from '../protocol/types.js'
import type { TermOs } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

// 断线不中断的长任务：主机开「断线后保持会话」后，交互 shell 跑在远端 tmux 会话 lingshell-<8hex> 里。
// 断线 / 重连 / 应用重启都 attach 回同一会话，任务不中断。这里只放纯函数（命令拼装 + 输出解析），
// 连接/状态在 terminal-core（SshTerminal / TerminalManager）。所有命令都走独立 exec channel（execRead），不往用户在用的 shell 里打字。
//
// 名字定长 8 位 hex：tmux -t 是前缀匹配，定长保证不会误中别的会话（也就不用 =name 精确语法，它要 tmux ≥2.1）。
// 名字会拼进远端命令行：用前一律过 isTmuxSessionName（布局文件可被手改）。

export const TMUX_PREFIX = 'lingshell-'
const NAME_RE = /^lingshell-[0-9a-f]{8}$/
export const isTmuxSessionName = (s: unknown): s is string => typeof s === 'string' && NAME_RE.test(s)

// 各功能的最低 tmux 版本：整体（1.8，低于此不用 tmux）/ mouse 选项（2.1，此前叫 mode-mouse 且默认关）/ allow-passthrough（3.3，此前默认就放行）
export const TMUX_MIN = 1.8
const MOUSE_SINCE = 2.1
const PASSTHROUGH_SINCE = 3.3
export const TMUX_OK = '@@ok'   // 建会话成功的回执（exec 只拿 stdout，不看退出码）

/** 不能用 tmux 时给用户的一次性提示；能用 → undefined */
export function tmuxFallback(p: TmuxProbe, legacyEncoding: boolean): string | undefined {
  if (!p.installed) return tr('服务器未安装 tmux，已用普通会话')
  if (p.version < TMUX_MIN) return tr('服务器 tmux 版本过低（需 ≥ {min}），已用普通会话', { min: TMUX_MIN })
  if (legacyEncoding) return tr('非 UTF-8 编码的主机不支持保持会话（tmux），已用普通会话')
  return undefined
}

// 包一层 sh -c：用户登录 shell 可能是 csh/fish，`2>&1`、if/fi 写法不通用。单引号转义各 shell 通用
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sh =(script: string) => `sh -c ${shq(script)}`

/** 连接时的探测：tmux 是否在 / 版本 / 目标会话是否已存在 / 系统（顺带 uname，免得再开一次 channel） */
export function tmuxProbeCommand(name: string): string {
  if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session')
  return sh(`if command -v tmux >/dev/null 2>&1; then tmux -V 2>&1; tmux has-session -t ${name} 2>/dev/null && echo @@exists; else echo @@notmux; fi; uname -s`)
}

export interface TmuxProbe { installed: boolean; version: number; exists: boolean; os: TermOs }

/** 版本串：'tmux 3.2a' → 3.2；'tmux next-3.4' → 3.4；'tmux master' / 'tmux openbsd-7.3' 等认不出数字的 → 当作很新 */
export function parseTmuxVersion(line: string): number {
  const m = /^tmux\s+(?:next-)?(\d+)\.(\d+)/.exec(line.trim())
  return m ? Number(m[1]) + Number(m[2]) / 10 : 99
}

export function parseTmuxProbe(out: string): TmuxProbe {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const v = lines.find((l) => l.startsWith('tmux '))
  const installed = !lines.includes('@@notmux') && !!v
  const rest = lines.filter((l) => l !== v && !l.startsWith('@@'))
  return { installed, version: installed ? parseTmuxVersion(v!) : 0, exists: installed && lines.includes('@@exists'), os: osFromUname(rest.at(-1) ?? '') }
}

/**
 * 会话不存在时先后台建好（-d），再把提示符设置（setup，见 promptNewline.ts）当按键打进去并 clear：
 * 设置不走哨兵 execCapture —— 那样设置命令和标记会留在 tmux 屏幕上，attach 后用户看得到。
 * 只改本会话的选项（不带 -g，不动用户自己的其它 tmux 会话）：
 *   status off  不占一行（xterm 行数 = 实际可用行数）
 *   mouse off   鼠标还给 xterm：拖选复制 / 右键粘贴照旧（tmux 开 mouse 会把滚轮变 copy-mode）
 *   allow-passthrough on（≥3.3 才有这个选项，此前默认放行）：OSC 133/633 命令标记包成 DCS 透传才到得了 xterm
 */
// 一条 tmux 调用里用 \; 串多条 tmux 命令（任一条失败即中止、退出码非 0）；不包 sh -c：setup 自带单引号，
// 两层单引号转义在 fish 下会坏（fish 单引号里 \' 是转义），一层 shq 各 shell 都对
export function tmuxCreateCommand(name: string, version: number, setup: string): string {
  if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session')
  const cmds = [`new-session -d -s ${name}`, `set-option -t ${name} status off`]
  if (version >= MOUSE_SINCE) cmds.push(`set-option -t ${name} mouse off`)
  if (version >= PASSTHROUGH_SINCE) cmds.push(`set-option -w -t ${name} allow-passthrough on`)
  cmds.push(`send-keys -t ${name} -l ${shq(` ${setup}; clear`)}`, `send-keys -t ${name} Enter`)
  return `tmux ${cmds.join(' \\; ')} && echo ${TMUX_OK}`
}

/**
 * 交互通道上跑的命令（exec + pty 代替 shell）。-d：踢掉残留的旧客户端（断线时服务器还没察觉的那个），
 * 否则窗口尺寸会被旧客户端限制。-u：按 UTF-8 输出（exec 会话常没有 LANG，tmux 会把中文画成 _）
 */
export function tmuxAttachCommand(name: string): string {
  if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session')
  return `tmux -u attach-session -d -t ${name}`
}

export const tmuxKillCommand = (name: string) => { if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session'); return `tmux kill-session -t ${name}` }
// 当前目录：问 tmux 而不是往 shell 里打 pwd（会话里可能正跑着任务，打字会喂给它）
export const tmuxPwdCommand = (name: string) => { if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session'); return `tmux display-message -p -t ${name} '#{pane_current_path}'` }
export const tmuxPanesCommand = (name: string) => { if (!isTmuxSessionName(name)) throw new Error('bad_tmux_session'); return `tmux list-panes -s -t ${name} -F '#{pane_current_command}'` }

// 前台是这些 = 空闲（登录 shell 可能带 - 前缀）
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'busybox'])
/** list-panes 输出 → 各窗格里正在跑的非 shell 命令（去重）。空 = 可以直接关 */
export function parseTmuxJobs(out: string): string[] {
  const cmds = out.split(/\r?\n/).map((l) => l.trim()).filter((c) => c && !SHELLS.has(c.replace(/^-/, '')))
  return [...new Set(cmds)]
}

// 服务器上保留的会话：只认我们起的 lingshell- 前缀。没 tmux / 没 server 时输出为空
export const TMUX_LIST_COMMAND = sh(`tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}|#{pane_current_command}' 2>/dev/null; true`)
export interface TmuxSessionInfo { name: string; createdAt: number; attached: boolean; command: string }
export function parseTmuxSessions(out: string): TmuxSessionInfo[] {
  return out.split(/\r?\n/).flatMap((l) => {
    const [name, created, attached, ...cmd] = l.trim().split('|')
    if (!isTmuxSessionName(name)) return []
    return [{ name, createdAt: Number(created) * 1000 || 0, attached: Number(attached) > 0, command: cmd.join('|') }]
  })
}
