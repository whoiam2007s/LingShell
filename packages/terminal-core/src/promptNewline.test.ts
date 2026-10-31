import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { PROMPT_NEWLINE_SETUP, PROMPT_NEWLINE_ENV } from './promptNewline.js'
import { makeSentinel, SentinelParser } from './sentinel.js'
import { parseOsc133, tmuxCreateCommand, TMUX_OK } from '@lingshell/shared'

const bash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p))
  : 'bash'

// 真跑 bash：模拟「出提示符前执行 PROMPT_COMMAND」。清掉外层可能带进来的 PROMPT_COMMAND/PS0
const env = (extra: Record<string, string> = {}) => ({ ...process.env, COLUMNS: '10', PROMPT_COMMAND: '', PS0: '', TMUX: '', ...extra })
const run = (script: string, extra?: Record<string, string>) => spawnSync(bash!, ['-c', script], { encoding: 'utf8', env: env(extra) }).stdout
// 交互 bash（stdin 非 tty：不回显、提示符走 stderr；首行 exec 2>&1 让 PS1/PS0 与 PROMPT_COMMAND 的输出按真实顺序进同一流）
const interactive = (lines: string[]) => spawnSync(bash!, ['--norc', '--noprofile', '-i'], {
  input: ['exec 2>&1', ...lines, ''].join('\n'), encoding: 'utf8', env: env({ PROMPT_COMMAND: PROMPT_NEWLINE_ENV }),
}).stdout

const osc = (s: string) => `\x1b]${s}\x07`
// eslint-disable-next-line no-control-regex -- 匹配 OSC 标记（ESC ... BEL）
const marks = (s: string) => [...s.matchAll(/\x1b\]133;([^\x07]*)\x07/g)]
  .map((m) => m[1])
  // bash 5.3 在空行上会重绘提示符，在 BEL 前插入 ESC[K，载荷成了 "B\x1b[K"。
  // 生产解析器 parseOsc133 认不出这种载荷、直接忽略，测试也按同样口径过滤。
  .filter((v) => parseOsc133(v) !== null)
// eslint-disable-next-line no-control-regex
const noCwd = (s: string) => s.replace(/\x1b\]633;P;Cwd=[^\x07]*\x07/g, '')

describe.skipIf(!bash)('提示符另起一行（PROMPT_COMMAND）', () => {
  it('打 COLUMNS 个空格再回车：行中间会折到新行，行首则被提示符盖掉；前后是 D/A 标记', () => {
    expect(noCwd(run(`${PROMPT_NEWLINE_SETUP}; printf line4; eval "$PROMPT_COMMAND"`)))
      .toBe(`line4${osc('133;D;0')}${' '.repeat(10)}\r${osc('133;A')}`)
  })

  it('本地终端的环境变量版本（PROMPT_COMMAND 经 env 传入）同样生效', () => {
    const out = spawnSync(bash!, ['-c', 'printf line4; (exit 3); eval "$PROMPT_COMMAND"; echo " rc=$?"'], { encoding: 'utf8', env: env({ PROMPT_COMMAND: PROMPT_NEWLINE_ENV }) }).stdout
    expect(noCwd(out)).toBe(`line4${osc('133;D;3')}${' '.repeat(10)}\r${osc('133;A')} rc=3\n`)   // 退出码原样交还
  })

  it('cwd 经 633;P;Cwd 上报', () => {
    expect(run(`cd /; ${PROMPT_NEWLINE_SETUP}; eval "$PROMPT_COMMAND"`)).toContain(osc('633;P;Cwd=/'))
  })

  it('重复执行不叠加；用户原有 PROMPT_COMMAND / PS1 / PS0 保留，标记只追加一次', () => {
    const out = run(`PROMPT_COMMAND='echo mine'; PS1='$ '; PS0='p0'; ${PROMPT_NEWLINE_SETUP}; ${PROMPT_NEWLINE_SETUP}; `
      + `eval "$PROMPT_COMMAND" >/dev/null; eval "$PROMPT_COMMAND" >/dev/null; printf '%s|' "$PROMPT_COMMAND" "$PS1" "$PS0"`)
    expect(out).toBe(String.raw`__lingshell_nl;echo mine|$ \[\033]133;B\007\]|p0\033]133;C\007|`)
  })

  it('在 tmux 里（$TMUX 非空）：每个标记包成 DCS 透传，内层 ESC 双写；PS1/PS0 同样', () => {
    const dcs = (s: string) => `\x1bPtmux;\x1b\x1b]${s}\x07\x1b\\`
    const out = run(`PS1='$ '; ${PROMPT_NEWLINE_SETUP}; cd /; printf line4; eval "$PROMPT_COMMAND"; printf '|%s|%s' "$PS1" "$PS0"`, { TMUX: '/tmp/tmux-0/default,1,0' })
    expect(out).toBe(`line4${dcs('133;D;0')}${dcs('633;P;Cwd=/')}${' '.repeat(10)}\r${dcs('133;A')}`
      + String.raw`|$ \[\033Ptmux;\033\033]133;B\007\033\134\]|\033Ptmux;\033\033]133;C\007\033\134`)
  })

  it('保持会话建会话命令经真 shell 解析：设置原样成为 send-keys -l 的一个参数', () => {
    // tmux 换成逐个打印参数的函数；脚本经 stdin 喂给 bash，不经 Windows 命令行转义
    const script = `tmux() { for a in "$@"; do printf '[%s]\\n' "$a"; done; }\n${tmuxCreateCommand('lingshell-0123abcd', 3.4, PROMPT_NEWLINE_SETUP)}\n`
    const out = spawnSync(bash!, ['-s'], { input: script, encoding: 'utf8', env: env() }).stdout
    const args = [...out.matchAll(/^\[([\s\S]*?)\]$/gm)].map((m) => m[1])
    expect(args).toContain(` ${PROMPT_NEWLINE_SETUP}; clear`)
    expect(args.filter((a) => a === ';')).toHaveLength(5)   // \; 交给 tmux 当命令分隔
    expect(out.trim().endsWith(TMUX_OK)).toBe(true)
  })

  it('用户 PROMPT_COMMAND 看到的 $? 仍是用户命令的退出码', () => {
    const out = run(`PROMPT_COMMAND='echo "mine=$?"'; ${PROMPT_NEWLINE_SETUP}; (exit 7); eval "$PROMPT_COMMAND"`)
    expect(out).toContain(osc('133;D;7'))
    expect(out.endsWith('mine=7\n')).toBe(true)
  })

  it('经 execCapture 的哨兵包装（eval 单引号）后同样生效：函数和变量留在当前 shell', () => {
    const s = makeSentinel(PROMPT_NEWLINE_SETUP)
    const out = run(`${s.wrapped}; printf x; eval "$PROMPT_COMMAND"`)
    expect(noCwd(out).endsWith(`x${osc('133;D;0')}${' '.repeat(10)}\r${osc('133;A')}`)).toBe(true)
  })

  it('交互 bash：每条命令 C…D;<退出码>；空行/纯注释行没有 C（UI 忽略孤立的 D）', () => {
    expect(marks(interactive(['true', 'false', '', '# c', '(exit 3)']))).toEqual([
      'D;0', 'A', 'D;0', 'A', 'B',        // 启动提示符、exec 2>&1（其 PS0 还在 stderr 原位，未进 stdout）
      'C', 'D;0', 'A', 'B',               // true
      'C', 'D;1', 'A', 'B',               // false
      'D;1', 'A', 'B', 'D;1', 'A', 'B',   // 空行、注释：无 C
      'C', 'D;3', 'A', 'B',               // (exit 3)
    ])
  })

  it('AI 哨兵命令的 C/D 落在哨兵标记外侧：捕获期 C 不转发给 UI，结束后的 D 成孤立标记，不算用户命令', () => {
    const s = makeSentinel('echo hi; false')
    const out = interactive([s.wrapped])
    const c = out.lastIndexOf(osc('133;C')), start = out.indexOf(`${s.startMarker}\n`), end = out.indexOf(s.endMarker)
    expect(c).toBeGreaterThan(-1)
    expect(c).toBeLessThan(start)                                    // PS0 在命令执行前，早于开始标记 → 被捕获吞掉
    expect(out.indexOf(osc('133;D;0'), end)).toBeGreaterThan(end)   // D 在结束标记之后（尾巴里转发给 UI；整行末条是 printf，故为 0）
    const p = new SentinelParser(s)
    p.feed(out)
    expect(p.result()).toEqual({ output: 'hi', exitCode: 1 })        // 标记不影响哨兵解析
  })
})

describe.skipIf(!bash)('HISTCONTROL 含 ignorespace（密钥保险箱：哨兵包装行不进历史）', () => {
  it('没设 / 只有 ignoredups 时补上，已有 ignorespace / ignoreboth 不动，重复执行不叠加', () => {
    const hc = (v: string) => run(`HISTCONTROL='${v}'; ${PROMPT_NEWLINE_SETUP}; ${PROMPT_NEWLINE_SETUP}; printf %s "$HISTCONTROL"`)
    expect(hc('')).toBe('ignorespace')
    expect(hc('ignoredups')).toBe('ignorespace:ignoredups')
    expect(hc('ignoreboth')).toBe('ignoreboth')
    expect(hc('erasedups:ignorespace')).toBe('erasedups:ignorespace')
  })
})
