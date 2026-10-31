import { describe, it, expect, vi } from 'vitest'
import { BaseTerminal } from './Terminal.js'
import type { ExitHandler } from './Terminal.js'

class FakeTerminal extends BaseTerminal {
  public written: string[] = []
  public killed = false
  protected writeRaw(data: string): void { this.written.push(data) }
  protected killRaw(): void { this.killed = true }
  resize(_cols: number, _rows: number): void {}
  feed(chunk: string): void { this.onRawData(chunk) }
  exit(info: { code?: number; reason?: string }): void { this.onRawExit(info) }
}

describe('BaseTerminal', () => {
  it('onData 在非捕获期实时分发；捕获期不分发但仍存 scrollback', () => {
    const t = new FakeTerminal('t1')
    const got: string[] = []
    t.onData((c) => got.push(c))
    t.feed('hello\r\n')
    expect(got).toEqual(['hello\r\n'])
    expect(t.readSnapshot()).toContain('hello')
  })
  it('write noHistory：直接写底层，不记命令历史（自动应答的密码）', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((c) => cmds.push(c))
    t.write('PW_123\r', { noHistory: true })
    expect(t.written).toEqual(['PW_123\r'])
    expect(cmds).toEqual([])
    expect(t.busy).toBe(false)
  })
  it('write 透传到底层 writeRaw', () => {
    const t = new FakeTerminal('t1')
    t.write('ls\r')
    expect(t.written).toContain('ls\r')
  })
  it('execCapture：写哨兵命令，feed 标记间输出 → 解析 output+exitCode', async () => {
    const t = new FakeTerminal('t1')
    const p = t.execCapture('echo hi')
    const wrapped = t.written.find((w) => w.includes('__CW_START_'))!
    const id = wrapped.match(/__CW_START_([0-9a-f]{16})__/)![1]
    t.feed(`__CW_START_${id}__\r\n`)
    t.feed('hi\r\n')
    t.feed(`__CW_END_${id}__0__\r\n`)
    const r = await p
    expect(r.output.trim()).toBe('hi')
    expect(r.exitCode).toBe(0)
  })
  it('execCapture 拒绝危险 shell 控制命令(exit)', async () => {
    const t = new FakeTerminal('t1')
    await expect(t.execCapture('exit')).rejects.toThrow('forbidden_command')
  })
  it('execCapture 拒绝全屏程序(vim)', async () => {
    const t = new FakeTerminal('t1')
    await expect(t.execCapture('vim file')).rejects.toThrow('fullscreen_program')
  })
  it('onExit 回调被 onRawExit 触发', () => {
    const t = new FakeTerminal('t1')
    const fn: ExitHandler = vi.fn()
    t.onExit(fn)
    t.exit({ code: 0 })
    expect(fn).toHaveBeenCalledWith({ code: 0 })
  })
  it('readSnapshot 过滤哨兵标记行', () => {
    const t = new FakeTerminal('t1')
    t.feed('real line\r\n')
    t.feed('__CW_START_abcdef0123456789__\r\n')
    t.feed('__CW_END_abcdef0123456789__0__\r\n')
    const snap = t.readSnapshot()
    expect(snap).toContain('real line')
    expect(snap).not.toContain('__CW_START_')
  })
  it('readSnapshot：shell integration 标记（OSC 133/633）跨 chunk 切开也剥干净', () => {
    const t = new FakeTerminal('t1')
    t.feed('out\r\n\x1b]133;D;0\x07\x1b]633;P;Cwd=/r')
    t.feed('oot\x07\x1b]133;A\x07$ ls\r\n')
    expect(t.readSnapshot()).toBe('out\n$ ls')
  })
  it('kill 调 killRaw', () => {
    const t = new FakeTerminal('t1')
    t.kill()
    expect(t.killed).toBe(true)
  })
  it('execCapture 触发 onCommand source=ai', async () => {
    const t = new FakeTerminal('t1')
    const cmds: { command: string; source: string }[] = []
    t.onCommand((command, source) => cmds.push({ command, source }))
    const p = t.execCapture('echo hi')
    const wrapped = t.written.find((w) => w.includes('__CW_START_'))!
    const id = wrapped.match(/__CW_START_([0-9a-f]{16})__/)![1]
    t.feed(`__CW_START_${id}__\r\n`); t.feed('hi\r\n'); t.feed(`__CW_END_${id}__0__\r\n`)
    await p
    expect(cmds).toContainEqual({ command: 'echo hi', source: 'ai' })
  })
  it('execCapture wire：发进 shell 的是 wire（密钥明文），回显 / 命令历史是占位符原文', async () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = [], ui: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.onData((c) => ui.push(c))
    const p = t.execCapture('echo {{secret:demo}}', 5000, undefined, { wire: `echo 'S3cr3t-xyz-123'` })
    const wrapped = t.written.find((w) => w.includes('__CW_START_'))!
    expect(wrapped).toContain('S3cr3t-xyz-123')
    expect(wrapped.startsWith(' ')).toBe(true)   // 行首空格：HISTCONTROL=ignorespace 时不进 bash 历史
    const id = wrapped.match(/__CW_START_([0-9a-f]{16})__/)![1]
    t.feed(`__CW_START_${id}__\r\n`); t.feed('S3cr3t-xyz-123\r\n'); t.feed(`__CW_END_${id}__0__\r\n`)
    expect((await p).output).toBe('S3cr3t-xyz-123')
    expect(cmds).toEqual(['echo {{secret:demo}}'])
    expect(ui[0]).toContain('echo {{secret:demo}}')
    expect(ui[0]).not.toContain('S3cr3t')
  })

  it('write 逐键累积，遇 \\r 且行非空 emit source=user', () => {
    const t = new FakeTerminal('t1')
    const cmds: { command: string; source: string }[] = []
    t.onCommand((command, source) => cmds.push({ command, source }))
    for (const ch of 'ls -al') t.write(ch)
    t.write('\r')
    expect(cmds).toEqual([{ command: 'ls -al', source: 'user' }])
  })

  it('write 空行（直接回车）不记', () => {
    const t = new FakeTerminal('t1')
    const cmds: unknown[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('\r')
    t.write('   \r')   // 纯空白也算空
    expect(cmds).toEqual([])
  })

  it('write 多行粘贴：每个 \\r 切一条', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('a\rb\r')
    expect(cmds).toEqual(['a', 'b'])
  })

  it('write 普通命令 ls\\r 正常 emit', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('ls\r')
    expect(cmds).toEqual(['ls'])
  })

  it('write 方向键 CSI 序列不污染缓冲', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('\x1b[A\x1b[B')   // ↑↓ 光标键
    t.write('whoami\r')
    expect(cmds).toEqual(['whoami'])
  })

  it('write CSI 序列跨多次 write 也能跳过', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('\x1b[')   // ESC[ 一次
    t.write('A')       // 终止字节另一次
    t.write('id\r')
    expect(cmds).toEqual(['id'])
  })

  it('execCapture 超时返回已捕获的部分输出', async () => {
    vi.useFakeTimers()
    try {
      const t = new FakeTerminal('t1')
      const p = t.execCapture('sleep 99', 1000)
      const id = t.written.find((w) => w.includes('__CW_START_'))!.match(/__CW_START_([0-9a-f]{16})__/)![1]
      t.feed(`__CW_START_${id}__\r\nhalf\r\n`)
      vi.advanceTimersByTime(1000)
      const r = await p
      expect(r).toMatchObject({ exitCode: -1, truncated: true })
      expect(r.output.trim()).toBe('half')
    } finally { vi.useRealTimers() }
  })

  it('捕获中终端退出/kill → 立即 reject terminal_disconnected，不再写 \\x03', async () => {
    for (const end of [(t: FakeTerminal) => t.exit({ code: 1 }), (t: FakeTerminal) => t.kill()]) {
      const t = new FakeTerminal('t1')
      const p = t.execCapture('sleep 99')
      end(t)
      await expect(p).rejects.toThrow('terminal_disconnected')
      expect(t.busy).toBe(false)
      expect(t.written).not.toContain('\x03')
    }
  })

  it('结束标记所在 chunk 之后的提示符转发给 UI', async () => {
    const t = new FakeTerminal('t1')
    const got: string[] = []
    t.onData((c) => got.push(c))
    const p = t.execCapture('echo hi')
    const id = t.written.find((w) => w.includes('__CW_START_'))!.match(/__CW_START_([0-9a-f]{16})__/)![1]
    t.feed(`__CW_START_${id}__\r\nhi\r\n__CW_END_${id}__0__\r\n$ `)
    await p
    expect(got[got.length - 1]).toBe('$ ')
  })

  it('execCapture 逐段检查：&& / ; / | 后的 exit、sudo 全屏程序也拦', async () => {
    const t = new FakeTerminal('t1')
    await expect(t.execCapture('cd /tmp && exit')).rejects.toThrow('forbidden_command')
    await expect(t.execCapture('true; logout')).rejects.toThrow('forbidden_command')
    await expect(t.execCapture('sudo vim x')).rejects.toThrow('fullscreen_program')
    await expect(t.execCapture('ls | less')).rejects.toThrow('fullscreen_program')
  })

  it('write Ctrl-C/Ctrl-U 清空输入行，Ctrl-W 删前一个词', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('abc\x03')
    expect(t.busy).toBe(false)
    t.write('xyz\x15ls\r')
    t.write('git status\x17log\r')
    expect(cmds).toEqual(['ls', 'git log'])
  })

  it('write SS3 光标键(\\x1bOA)不污染缓冲', () => {
    const t = new FakeTerminal('t1')
    const cmds: string[] = []
    t.onCommand((command) => cmds.push(command))
    t.write('\x1bOA')   // SS3 上光标键
    t.write('pwd\r')
    expect(cmds).toEqual(['pwd'])
  })
})

describe('terminalEnv', () => {
  it('剔除引擎 API Key，其余照传', async () => {
    const { terminalEnv } = await import('./LocalTerminal.js')
    process.env.LINGSHELL_DEEPSEEK_KEY = 'sk-secret'
    try {
      const env = terminalEnv()
      expect(env.LINGSHELL_DEEPSEEK_KEY).toBeUndefined()
      expect(env.PATH ?? env.Path).toBeDefined()
    } finally { delete process.env.LINGSHELL_DEEPSEEK_KEY }
  })
})
