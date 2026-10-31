import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { makeSentinel, SentinelParser } from './sentinel.js'

describe('sentinel command capture', () => {
  it('builds a wrapped command with start/end markers', () => {
    const s = makeSentinel('ls -la')
    expect(s.wrapped).toContain('ls -la')
    expect(s.wrapped).toMatch(/__CW_START_[0-9a-f]{16}__/)
    expect(s.wrapped).toMatch(/__CW_END_[0-9a-f]{16}__/)
  })

  it('parses clean output and exit code between markers', () => {
    const s = makeSentinel('echo hi')
    const p = new SentinelParser(s)
    p.feed(`${s.startMarker}\r\n`)
    p.feed('hi\r\n')
    p.feed(`${s.endMarker}0__\r\n`)
    const r = p.result()
    expect(r).not.toBeNull()
    expect(r!.output.trim()).toBe('hi')
    expect(r!.exitCode).toBe(0)
  })

  // 保持会话时 AI 命令跑在 tmux 里：收到的是 tmux 重绘后的字节流（隐藏光标、ESC(B 复位字符集、清行尾、绝对定位、DCS/OSC…），
  // 标记是独占一行的纯文本，剥掉控制序列后照样认得；回显行被折行（长命令）也不误认开始标记
  it('tmux 重绘风格的输出：控制序列夹在标记和输出里也能正确解析', () => {
    const s = makeSentinel('echo hi; echo 中文')
    const p = new SentinelParser(s)
    const echo = s.wrapped.replace(s.startMarker, `${s.startMarker.slice(0, 9)}\r\n${s.startMarker.slice(9)}`)   // 回显被 tmux 折行
    p.feed(`\x1b[?25l\x1b[23;1H$ ${echo}\x1b(B\x1b[m\x1b[K\r\n`)
    p.feed(`\x1b[?25h${s.startMarker}\x1b[K\r\n\x1b]133;C\x1b\\hi\x1b(B\x1b[m\r\n\x1b[1m中文\x1b[0m\r\n`)
    expect(p.result()).toBeNull()
    p.feed(`\x1b[?25l${s.endMarker.slice(0, 5)}`)
    p.feed(`${s.endMarker.slice(5)}0__\x1b[K\r\n\x1b[24;1H$ \x1b[?25h`)
    expect(p.result()).toEqual({ output: 'hi\r\n中文', exitCode: 0 })
  })

  it('strips ANSI escape sequences around markers', () => {
    const s = makeSentinel('x')
    const p = new SentinelParser(s)
    p.feed(`\x1b[32m${s.startMarker}\x1b[0m\r\n`)
    p.feed('out\r\n')
    p.feed(`\x1b[1m${s.endMarker}7__\x1b[0m\r\n`)
    const r = p.result()
    expect(r!.output.trim()).toBe('out')
    expect(r!.exitCode).toBe(7)
  })

  it('handles markers split across chunks', () => {
    const s = makeSentinel('x')
    const p = new SentinelParser(s)
    const half = Math.floor(s.startMarker.length / 2)
    p.feed(s.startMarker.slice(0, half))
    p.feed(s.startMarker.slice(half) + '\r\n')
    p.feed('data\r\n')
    p.feed(`${s.endMarker}0__\r\n`)
    const r = p.result()
    expect(r!.output.trim()).toBe('data')
  })

  it('returns null before end marker arrives', () => {
    const s = makeSentinel('x')
    const p = new SentinelParser(s)
    p.feed(`${s.startMarker}\r\npartial`)
    expect(p.result()).toBeNull()
  })

  it('partial() 返回 startMarker 之后已到的输出', () => {
    const s = makeSentinel('x')
    const p = new SentinelParser(s)
    expect(p.partial()).toBe('')
    p.feed(`${s.startMarker}\r\n\x1b[1mpart\x1b[0mial`)
    expect(p.partial()).toBe('partial')
  })

  it('tail() 返回同一 chunk 里结束标记行之后的提示符（保留颜色）', () => {
    const s = makeSentinel('x')
    const p = new SentinelParser(s)
    p.feed(`${s.startMarker}\r\n`)
    const chunk = `out\r\n${s.endMarker}0__\r\n\x1b[32muser@h\x1b[0m $ `
    p.feed(chunk)
    expect(p.tail(chunk)).toBe('\x1b[32muser@h\x1b[0m $ ')
  })
})

// 真跑 bash：拼接方式错了只有真 shell 才暴露（# 注释吞结束标记、& 拼成 &; 等）
const bash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p))
  : 'bash'
describe.skipIf(!bash)('sentinel wrapped command in real bash', () => {
  const run = (cmd: string) => {
    const s = makeSentinel(cmd)
    const r = spawnSync(bash!, ['-c', s.wrapped], { encoding: 'utf8' })
    const p = new SentinelParser(s)
    p.feed(r.stdout)
    return p.result()
  }
  it.each([
    ['echo a # 注释', 'a', 0],
    [`echo "it's"`, "it's", 0],
    ['false', '', 1],
    ['sleep 0 &', '', 0],
    ['cat <<EOF\nx\nEOF', 'x', 0],
    ['echo 1\necho 2', '1\n2', 0],
    ['echo $PAGER $GIT_PAGER', 'cat cat', 0],
    ['sh -c \'echo $GIT_PAGER\'', 'cat', 0],   // 导出给子进程
  ])('%j', (cmd, out, code) => {
    expect(run(cmd)).toEqual({ output: out, exitCode: code })
  })
})
