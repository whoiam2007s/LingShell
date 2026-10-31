import * as pty from 'node-pty'
import os from 'node:os'
import { shellKind, wslDistro } from '@lingshell/shared'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { BaseTerminal } from './Terminal.js'
import { OSC_MARK, OscSentinelParser } from './sentinel.js'
import { PROMPT_NEWLINE_ENV } from './promptNewline.js'
import { requireGitBash } from './gitBash.js'

// 选默认 shell。win32 必须 Git Bash（探测见 gitBash.ts）：哨兵是 bash 语法，退回 powershell 只会让每次 exec 超时，不如直接报错。
function defaultShell(): string {
  if (os.platform() !== 'win32') return process.env.SHELL || 'bash'
  return requireGitBash()
}

// 非默认 shell 的启动命令（见 shared/terminal/localShell.ts）。WSL 不指定目录时进 Linux 家目录（否则落在 /mnt/c/... 的 Windows 目录）
export function localShellSpawn(shell: string | undefined, hasCwd: boolean): { file: string; args: string[] } {
  const k = shellKind(shell)
  if (k === 'bash') return { file: defaultShell(), args: [] }
  if (k === 'powershell') return { file: 'powershell.exe', args: ['-NoLogo'] }
  if (k === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  return { file: 'wsl.exe', args: ['-d', wslDistro(shell)!, ...(hasCwd ? [] : ['--cd', '~'])] }
}

// 主进程 env 里有引擎用的 API Key（LINGSHELL_*_KEY），不能漏进终端：一条 `env` 就会进 AI 对话记录
export function terminalEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^LINGSHELL_.*KEY$/.test(k)))
}

// Windows 本地 Git Bash 的 AI 执行函数（经环境变量 BASH_FUNC_AI%% 导入，不往终端里打任何设置命令）。终端里只敲 ` AI`，
// 函数从 $LINGSHELL_EXEC 临时文件读：第一行 id，然后「给人看的命令（保险箱占位符原文）\0 真正执行的命令」。
//   1. 光标回到上一行（提示符那行）提示符之后，擦掉 ` AI`，用青色写上给人看的命令（同 SSH 终端的 AI 命令回显）。
//      提示符宽度由函数自己算：${PS1@P} 展开取最后一行，去掉 \[ \] 包着的不显示部分（\001…\002）。不由主进程量：
//      AI 连续执行时上一条刚结束、新提示符还没显示，量到的是 0，会把提示符盖掉。提示符 + ` AI` 折行了就不回去擦，另起一行写
//   2. 不可见的开始标记 → 在当前 shell 里 eval → 隐藏的结束标记（为什么这样做见 sentinel.ts 的 OscSentinelParser）
//   3. return 命令自己的退出码：提示符钩子按 $? 给这条命令标成败（绿 / 红点），不能被打标记的 printf 盖成 0
export const EXEC_FN = `() { local __i __d __c __r __p; { IFS= read -r __i; IFS= read -r -d '' __d; IFS= read -r -d '' __c; } < "$LINGSHELL_EXEC"; `
  + `__p="\${PS1@P}"; __p="\${__p##*$'\\n'}"; while [[ $__p == *$'\\001'*$'\\002'* ]]; do __p="\${__p%%$'\\001'*}\${__p#*$'\\002'}"; done; `
  + `if (( \${#__p} + 3 < \${COLUMNS:-80} )); then printf '\\033[1A\\r'; (( \${#__p} > 0 )) && printf '\\033[%dC' "\${#__p}"; printf '\\033[K'; fi; `
  + `printf '\\033[36m%s\\033[0m\\n' "$__d"; `
  + `printf '\\033]${OSC_MARK};S;%s\\007' "$__i"; PAGER=cat GIT_PAGER=cat eval "$__c"; __r=$?; printf '\\033[8m__CW_END_%s_%d__\\033[28m\\n' "$__i" $__r; return $__r; }`

export class LocalTerminal extends BaseTerminal {
  private proc: pty.IPty

  private gitBash: boolean
  private execFile?: string   // 仅 Windows Git Bash：AI 函数读命令的临时文件
  constructor(id: string, opts?: { cwd?: string; shell?: string }) {
    super(id)
    this.gitBash = shellKind(opts?.shell) === 'bash'
    if (process.platform === 'win32' && this.gitBash) this.execFile = join(os.tmpdir(), `lingshell-exec-${id}-${randomBytes(6).toString('hex')}`).split('\\').join('/')
    const { file, args } = localShellSpawn(opts?.shell, !!opts?.cwd)
    this.proc = pty.spawn(file, args, {
      name: 'xterm-color', cols: 80, rows: 30,
      cwd: opts?.cwd ?? os.homedir(),
      // PROMPT_COMMAND：提示符总另起一行（cat 无末尾换行的文件时不粘在输出后面），见 promptNewline.ts。只给 bash（WSL 收不到 Windows 环境变量，建好后另发设置）
      env: {
        ...terminalEnv(),
        ...(this.gitBash ? { HISTCONTROL: 'ignorespace', PROMPT_COMMAND: PROMPT_NEWLINE_ENV } : {}),
        ...(this.execFile ? { LINGSHELL_EXEC: this.execFile, 'BASH_FUNC_AI%%': EXEC_FN } : {}),
      } as Record<string, string>,
    })
    this.proc.onData((d) => { this.atPrompt = promptStateAfter(this.atPrompt, d); this.onRawData(d) })
    this.proc.onExit(({ exitCode }) => this.onRawExit({ code: exitCode }))
  }

  protected writeRaw(data: string): void { this.proc.write(data) }
  protected killRaw(): void { this.dropExecFile(); this.proc.kill() }

  // Windows Git Bash：终端里只敲 ` AI`，函数把它换成青色的命令文字；命令（含保险箱明文）走临时文件，标记不可见、输出原样显示（见 sentinel.ts）。
  // silent 探测（如兜底的 pwd）不原样显示，仍按默认方式藏起来
  protected makeCapture(display: string, wire: string, silent: boolean) {
    if (!this.execFile) return super.makeCapture(display, wire, silent)
    const id = randomBytes(8).toString('hex'), shown = display.replace(/\0/g, '')
    writeFileSync(this.execFile, `${id}\n${shown}\0${wire}`, { mode: 0o600 })
    return { wrapped: ' AI', parser: new OscSentinelParser(id, shown), raw: !silent, cleanup: () => this.dropExecFile() }
  }
  private dropExecFile(): void { if (this.execFile) try { unlinkSync(this.execFile) } catch { /* 没有就算了 */ } }

  // Git Bash（MSYS readline）的毛病：每次窗口尺寸变化（SIGWINCH）后，用户敲的下一个字符约三到五成概率被吞（`clear` → `lear`）。
  // 与等多久无关（等 1s 照样吞），换新版 conpty.dll / winpty / MSYS=disable_pcon 都不行；纯 cat 不丢 → 是 readline 层。
  // 规避：缩放后补发一个 NUL 让它吞（在 readline 里 NUL 是 set-mark，不吞也不留痕）。只在 bash 停在提示符时发
  // （OSC 133 标记判断），全屏程序/在跑的命令里 NUL 可能有含义，不发。尺寸没变不重复缩放（不白触发 SIGWINCH）。
  private atPrompt = false
  private size = ''
  resize(cols: number, rows: number): void {
    const key = `${cols}x${rows}`
    if (key === this.size) return
    this.size = key
    this.proc.resize(cols, rows)
    // 半行输入时也发（吞字同样会发生，实测补 NUL 后半行完整）；AI 哨兵命令在跑时不发
    if (process.platform === 'win32' && this.gitBash && this.atPrompt && !this.capturingNow) this.proc.write('\x00')
  }
}

// OSC 133 提示符状态：A/B = 停在提示符（readline 在读输入），C/D = 命令开始/结束（C 之后到下一个 A 之间不在提示符）
export function promptStateAfter(cur: boolean, chunk: string): boolean {
  let s = cur
  // eslint-disable-next-line no-control-regex -- 匹配 OSC 133 标记（ESC ]133;X）
  for (const m of chunk.matchAll(/\x1b\]133;([ABCD])/g)) s = m[1] === 'A' || m[1] === 'B'
  return s
}
