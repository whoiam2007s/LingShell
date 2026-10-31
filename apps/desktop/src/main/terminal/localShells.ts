import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseWslList, tr, tk, type LocalShellOption } from '@lingshell/shared'
import { gitBash } from '@lingshell/terminal-core'

// 新建本地终端可选的 shell（见 shared/terminal/localShell.ts）。只有 Windows 有得选；其它系统只有默认 shell
export interface LocalShellsDeps {
  handle(ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void
  platform?: string
  wslList?: () => Promise<Uint8Array>   // 测试注入
  hasBash?: () => boolean               // 测试注入；缺省用 terminal-core/gitBash.ts 的探测
}

// `wsl -l -q`：没装 WSL / 没有发行版时报错或空输出 → []。输出是 UTF-16LE，按 Buffer 取再解码
const wslListRaw = () => new Promise<Uint8Array>((res) => {
  const wsl = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe`
  if (!existsSync(wsl)) { res(new Uint8Array()); return }
  execFile(wsl, ['-l', '-q'], { timeout: 5000, windowsHide: true, encoding: 'buffer' }, (err, out) => res(err ? new Uint8Array() : out))
})

export const BASH_MISSING = tk('未检测到 Git Bash：请安装 Git for Windows，或在 设置 → 通用 →「Git Bash 路径」里指定')   // 显示处 tr()

export async function listLocalShells(platform: string = process.platform, wslList = wslListRaw, hasBash = () => !!gitBash().path): Promise<LocalShellOption[]> {
  if (platform !== 'win32') return [{ id: 'bash', label: tr('默认 shell'), ai: true }]
  const bash: LocalShellOption = { id: 'bash', label: 'Git Bash', ai: true, ...(hasBash() ? {} : { unavailable: tr(BASH_MISSING) }) }
  const distros = parseWslList(await wslList())
  return [
    bash,
    { id: 'powershell', label: 'PowerShell', ai: false },
    { id: 'cmd', label: 'cmd', ai: false },
    // WSL：建好后静默试一次命令捕获，bash / zsh 等能跑通就允许 AI（fish 等不行就仅手动）
    ...distros.map((d) => ({ id: `wsl:${d}`, label: `WSL · ${d}`, ai: true })),
  ]
}

export function registerLocalShells(d: LocalShellsDeps): void {
  d.handle('terminal:localShells', () => listLocalShells(d.platform, d.wslList, d.hasBash))
}
