import { describe, it, expect } from 'vitest'
import { ShellMarkTracker, adjacentLine, commandQuote, failedCommandQuote, fmtDuration, parseOsc133, parseOsc633, readBufferRange, type ShellCommand, type ShellMark } from './shellMarks.js'

// 位置用自增数字代替 marker；时间手动推进
function setup() {
  let t = 0, n = 0
  const cmds: ShellCommand<number>[] = [], dropped: number[] = []
  const tr = new ShellMarkTracker<number>({ onCommand: (c) => cmds.push(c), onDrop: (p) => dropped.push(p), now: () => t })
  const feed = (...ms: (string | ShellMark)[]) => ms.forEach((m) => tr.feed(typeof m === 'string' ? (parseOsc133(m) ?? parseOsc633(m))! : m, () => ++n))
  return { tr, cmds, dropped, feed, tick: (ms: number) => { t += ms } }
}

describe('parseOsc133 / parseOsc633', () => {
  it('A/B/C/D 与退出码', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'A' })
    expect(parseOsc133('C')).toEqual({ kind: 'C' })
    expect(parseOsc133('D;0')).toEqual({ kind: 'D', exitCode: 0 })
    expect(parseOsc133('D;127')).toEqual({ kind: 'D', exitCode: 127 })
    expect(parseOsc133('D')).toEqual({ kind: 'D' })
    expect(parseOsc133('D;x')).toEqual({ kind: 'D' })
    expect(parseOsc133('Z')).toBeNull()
  })
  it('cwd：只认 P;Cwd=', () => {
    expect(parseOsc633('P;Cwd=/var/log')).toEqual({ kind: 'cwd', cwd: '/var/log' })
    expect(parseOsc633('P;Cwd=/a;b')).toEqual({ kind: 'cwd', cwd: '/a;b' })
    expect(parseOsc633('E;ls')).toBeNull()
  })
})

describe('ShellMarkTracker', () => {
  it('A→B→C→D 凑成一条命令：位置、退出码、耗时、执行时的 cwd', () => {
    const { cmds, feed, tick } = setup()
    feed('P;Cwd=/home', 'A', 'B', 'C')
    tick(1234)
    feed('D;2', 'P;Cwd=/tmp')
    expect(cmds).toEqual([{ prompt: 1, input: 2, output: 3, end: 4, exitCode: 2, durationMs: 1234, cwd: '/home' }])
  })

  it('孤立的 D（空行 / 注释 / 启动时第一个提示符）不产出命令', () => {
    const { cmds, feed } = setup()
    feed('D;0', 'A', 'B', 'D;0', 'A', 'B', 'D;1')
    expect(cmds).toEqual([])
  })

  it('AI 哨兵命令：捕获期 C 被吞，UI 只收到结束后的 D→A→B，不算用户命令；之后的用户命令照常', () => {
    const { cmds, feed } = setup()
    feed('A', 'B')            // 用户提示符
    // AI exec：哨兵行的 C 和输出在捕获期被吞，尾巴里的 D;0 A B 转发给 UI
    feed('D;0', 'A', 'B')
    expect(cmds).toEqual([])
    feed('C', 'D;1')
    expect(cmds.map((c) => c.exitCode)).toEqual([1])
  })

  it('reset（AI 锁定）丢掉进行中的用户命令：AI 命令的 D 不会记到它头上', () => {
    const { tr, cmds, dropped, feed } = setup()
    feed('A', 'B', 'C')       // 用户命令跑着（位置 1,2,3）
    tr.reset()
    feed('D;0', 'A', 'B')     // AI 命令结束的尾巴
    expect(cmds).toEqual([])
    expect(dropped).toEqual([1, 2, 3])
  })

  it('C 前没见过提示符（标记丢了）：不标', () => {
    const { cmds, feed } = setup()
    feed('C', 'D;0')
    expect(cmds).toEqual([])
  })

  it('D 丢了又来新命令：旧的作废并交还位置，新的照常', () => {
    const { cmds, dropped, feed } = setup()
    feed('A', 'B', 'C')       // 1,2,3
    feed('A', 'B', 'C', 'D;0')
    expect(dropped).toEqual([1, 2, 3])
    expect(cmds).toHaveLength(1)
    expect(cmds[0].output).toBe(6)
  })

  it('A 重复（Ctrl+C 掉的输入行）：旧提示符交还', () => {
    const { dropped, feed } = setup()
    feed('A', 'B', 'A')
    expect(dropped).toEqual([1, 2])
  })

  it('没有 B（PS1 被框架改写）：只有 prompt，照样成命令', () => {
    const { cmds, feed } = setup()
    feed('A', 'C', 'D;0')
    expect(cmds[0]).toMatchObject({ prompt: 1, input: undefined, output: 2, end: 3 })
  })

  it('promptState：无标记 unknown → A/B 后 idle（带 B 位置）→ C 后 busy → reset 回 unknown', () => {
    const { tr, feed } = setup()
    expect(tr.promptState()).toEqual({ kind: 'unknown' })
    feed('A', 'B')
    expect(tr.promptState()).toEqual({ kind: 'idle', input: 2 })
    feed('C')
    expect(tr.promptState()).toEqual({ kind: 'busy' })
    feed('D;0', 'A')
    expect(tr.promptState()).toEqual({ kind: 'idle', input: undefined })
    tr.reset()
    expect(tr.promptState()).toEqual({ kind: 'unknown' })
  })
})

describe('辅助函数', () => {
  it('fmtDuration', () => {
    expect(fmtDuration(42)).toBe('42ms')
    expect(fmtDuration(1234)).toBe('1.2s')
    expect(fmtDuration(125_000)).toBe('2m05s')
  })

  it('adjacentLine：上一个 / 下一个，跳过已裁掉的（-1）', () => {
    const ls = [3, -1, 10, 25]
    expect(adjacentLine(ls, 10, -1)).toBe(3)
    expect(adjacentLine(ls, 10, 1)).toBe(25)
    expect(adjacentLine(ls, 3, -1)).toBeUndefined()
    expect(adjacentLine(ls, 25, 1)).toBeUndefined()
  })

  it('readBufferRange：首行从列开始、末行到列结束，软折行拼回', () => {
    const rows = [
      { s: '$ make all ', w: false },
      { s: 'gcc -c x.c ', w: false },
      { s: 'x.c:1: erro', w: false },
      { s: 'r: boom    ', w: true },
      { s: '$         ', w: false },
    ]
    const buf = { getLine: (y: number) => rows[y] && { isWrapped: rows[y].w, translateToString: (trim?: boolean, a = 0, b?: number) => { const t = rows[y].s.slice(a, b); return trim ? t.trimEnd() : t } } }
    expect(readBufferRange(buf, { line: 0, col: 2 }, { line: 1, col: 0 })).toBe('make all\n')
    expect(readBufferRange(buf, { line: 1, col: 0 }, { line: 4, col: 0 })).toBe('gcc -c x.c\nx.c:1: error: boom\n')
    expect(readBufferRange(buf, { line: 0, col: 0 }, { line: 4, col: 0 }, 2)).toBe('x.c:1: error: boom\n')   // 只留末尾
  })

  it('failedCommandQuote：命令、退出码、目录、输出；超长留末尾', () => {
    const q = failedCommandQuote({ title: 'web-01', command: 'make', exitCode: 2, cwd: '/srv', output: 'err\n\n' })
    expect(q).toBe('终端「web-01」里这条命令失败了（退出码 2，目录 /srv），帮我看看原因：\n```\n$ make\nerr\n```\n')
    const long = failedCommandQuote({ title: 't', command: 'x', exitCode: 1, output: 'a'.repeat(5000) + 'END' })
    expect(long).toContain('前面省略 1003 字')
    expect(long).toContain('END')
  })

  it('commandQuote：失败的问原因，成功 / 无退出码的请 AI 看结果', () => {
    expect(commandQuote({ title: 't', command: 'x', exitCode: 2, output: 'e' })).toBe(failedCommandQuote({ title: 't', command: 'x', exitCode: 2, output: 'e' }))
    const ok = commandQuote({ title: '本地', command: 'df -h', exitCode: 0, cwd: '/srv', output: 'Filesystem' })
    expect(ok).toContain('执行结果（退出码 0，目录 /srv）')
    expect(ok).toContain('$ df -h\nFilesystem')
    expect(commandQuote({ title: 't', command: 'y', output: '' })).toContain('退出码 未知')
  })
})
