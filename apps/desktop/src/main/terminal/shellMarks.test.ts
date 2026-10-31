// 命令成败标记端到端：真 bash（注入的 PROMPT_COMMAND）输出 → 切成小块喂 xterm（headless，与 UI 同一解析器）→
// onShellMarks + ShellMarkTracker + readBufferRange。验证 OSC 跨 chunk、退出码、cwd、输出区间。UI 胶水见 TerminalPane.tsx
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import xtermHeadless from '@xterm/headless'
import type { IMarker } from '@xterm/headless'
import { ShellMarkTracker, onShellMarks, readBufferRange, type ShellCommand } from '@lingshell/shared'
import { PROMPT_NEWLINE_ENV } from '@lingshell/terminal-core'

const { Terminal } = xtermHeadless
const bash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p))
  : 'bash'

type Pos = { m: IMarker; col: number }

describe.skipIf(!bash)('shell integration 标记 → 命令（真 bash + xterm 解析器）', () => {
  it('切成 3 字节一块喂入：每条命令的退出码、cwd、输出都对；空行不算命令', async () => {
    // 交互 bash（stdin 非 tty 不回显命令）；exec 2>&1 让提示符/PS0 与输出同流
    const out = spawnSync(bash!, ['--norc', '--noprofile', '-i'], {
      input: ['exec 2>&1', "PS1='$ '", 'echo hello', '', 'cd / && ls /nope-xyz', 'printf "a\\nb"; (exit 4)', ''].join('\n'),
      encoding: 'utf8', env: { ...process.env, COLUMNS: '80', PROMPT_COMMAND: PROMPT_NEWLINE_ENV, PS0: '' },
    }).stdout
    const t = new Terminal({ cols: 80, rows: 30, allowProposedApi: true, convertEol: true })
    const cmds: ShellCommand<Pos>[] = []
    const tr = new ShellMarkTracker<Pos>({ onCommand: (c) => cmds.push(c), onDrop: (p) => p.m.dispose() })
    onShellMarks(t, (m) => tr.feed(m, () => ({ m: t.registerMarker(0)!, col: t.buffer.active.cursorX })))
    for (let i = 0; i < out.length; i += 3) t.write(out.slice(i, i + 3))   // 每次 write 是独立 chunk，解析器状态跨块保留
    await new Promise<void>((r) => t.write('', r))

    const text = (c: ShellCommand<Pos>) => readBufferRange(t.buffer.normal, { line: c.output.m.line, col: c.output.col }, { line: c.end.m.line, col: c.end.col }).trim()
    // 第一条是 PS1='$ '（exec 2>&1 那条的 PS0 还在 stderr 原位，没有 C）
    expect(cmds.map((c) => c.exitCode)).toEqual([0, 0, 2, 4])
    expect(text(cmds[1])).toBe('hello')
    expect(text(cmds[2])).toMatch(/nope-xyz/)
    expect(cmds[3].cwd).toBe('/')   // cd / 之后那条命令执行时的目录
    expect(text(cmds[3])).toBe('a\nb')
    expect(cmds.every((c) => c.durationMs >= 0 && c.prompt && c.input)).toBe(true)
    t.dispose()
  })
})
