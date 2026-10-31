// 本地终端可选 shell（Windows）：Git Bash（默认）/ PowerShell / cmd / 各 WSL 发行版。
// shell id：'bash' | 'powershell' | 'cmd' | 'wsl:<发行版名>'；TerminalInfo / 布局项里缺省 = bash。
// AI 的终端工具靠哨兵捕获（bash 语法：printf / eval / $?），PowerShell / cmd 跑不了 → 标「仅手动」，AI 工具直接拒绝；
// WSL 建终端时静默试一次哨兵（同 SSH 的提示符设置 + uname），通过（bash / zsh / sh 系）才允许 AI，fish 等不通过就仅手动。
import { osLabel } from '../protocol/types.js'
import type { TermOs } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

export type LocalShellKind = 'bash' | 'powershell' | 'cmd' | 'wsl'
// unavailable：不能用的原因（如 Windows 上没检测到 Git Bash），菜单里置灰显示
export interface LocalShellOption { id: string; label: string; ai: boolean; unavailable?: string }

// Git Bash 探测结果（设置 → 通用「Git Bash 路径」、缺失引导卡片）。required=false：非 Windows，用 $SHELL，不需要 Git Bash。
// source：settings 设置里指定 / env 环境变量 LINGSHELL_BASH / registry 注册表 / path PATH / common 常见安装位置；custom：设置里指定的路径（可能已失效）
export interface GitBashStatus { required: boolean; path?: string; source?: 'settings' | 'env' | 'registry' | 'path' | 'common'; custom?: string }

const WSL_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/   // 发行版名：字母数字开头，. _ -（作为 wsl.exe -d 的参数，严格校验，不能以 - 开头冒充选项）
export function isShellId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  return id === 'bash' || id === 'powershell' || id === 'cmd' || (id.startsWith('wsl:') && WSL_NAME.test(id.slice(4)))
}
export const shellKind = (id?: string): LocalShellKind => !id || id === 'bash' ? 'bash' : id.startsWith('wsl:') ? 'wsl' : id as LocalShellKind
export const wslDistro = (id?: string): string | undefined => id?.startsWith('wsl:') ? id.slice(4) : undefined

// 标签名前缀 / 菜单显示名
export function shellLabel(id?: string): string {
  const k = shellKind(id)
  return k === 'bash' ? 'Git Bash' : k === 'powershell' ? 'PowerShell' : k === 'cmd' ? 'cmd' : `WSL · ${wslDistro(id)}`
}

// 终端系统 / shell 的说明（标签悬浮、AI 终端清单）
export function termEnvLabel(t: { os?: TermOs; shell?: string; manualOnly?: boolean }): string {
  if (!t.shell) return osLabel(t.os)
  const base = shellKind(t.shell) === 'wsl' && t.os === 'linux' ? tr('{shell}（Linux）', { shell: shellLabel(t.shell) }) : shellLabel(t.shell)
  return t.manualOnly ? tr('{base} · 仅手动（AI 不可执行命令）', { base }) : base
}

// `wsl -l -q` 输出：默认 UTF-16LE（带 BOM），设了 WSL_UTF8=1 时是 UTF-8。docker-desktop 系内部发行版不给用户开
export function parseWslList(buf: Uint8Array): string[] {
  let zeros = 0
  for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) zeros++
  const utf16 = buf.length >= 2 && zeros * 2 >= buf.length / 2
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(buf)
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.replace(/\0/g, '').trim())
    .filter((n) => WSL_NAME.test(n) && !n.startsWith('docker-desktop'))
}

// WSL 里 pwd 的路径 → Windows 能用的路径（资源管理器定位用）：/mnt/c/x → C:\x，其余 → \\wsl.localhost\<发行版>\x
export function wslToWinPath(p: string, distro: string): string {
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(p)
  if (m) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`
}
