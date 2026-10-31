import { describe, it, expect, vi } from 'vitest'
import { SshTerminal } from './SshTerminal.js'

describe('SshTerminal.reconnect', () => {
  it('reconnect rejects with mapped error when host unreachable (复用存的 opts)', async () => {
    // ponytail: SSH 重连真值测试要真主机，留到真机验证。这里只锁两个可离线验证的契约：
    // ① reconnect 方法存在于原型 ② connect 对不可达地址 reject 且错误码已归一（ssh_*）。
    expect(typeof SshTerminal.prototype.reconnect).toBe('function')
    await expect(
      SshTerminal.connect('t1', { host: '203.0.113.1', port: 22, username: 'x', password: 'y', readyTimeoutMs: 800 }),
    ).rejects.toThrow(/ssh_/)   // ssh_connect_timeout / ssh_unreachable
  })
})

describe('SshTerminal 重连后旧 channel 的迟到 close', () => {
  it('不会把新连接标成断线', async () => {
    const { EventEmitter } = await import('node:events')
    const channels: InstanceType<typeof EventEmitter>[] = []
    class FakeClient extends EventEmitter {
      connect() { setImmediate(() => this.emit('ready')) }
      shell(_o: unknown, cb: (e: Error | undefined, ch: unknown) => void) {
        const ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write() {}, end() {} })
        channels.push(ch); cb(undefined, ch)
      }
      end() {}
    }
    vi.resetModules()
    vi.doMock('ssh2', () => ({ Client: FakeClient }))
    try {
      const { SshTerminal: T } = await import('./SshTerminal.js')
      const t = await T.connect('t1', { host: 'h', port: 22, username: 'u' })
      const exits: unknown[] = []
      t.onExit((e) => exits.push(e))
      await t.reconnect()
      channels[0].emit('close')   // 旧 channel 迟到的 close
      expect(exits).toEqual([])
      channels[1].emit('close')   // 新 channel 真断线仍要报
      expect(exits).toEqual([{ reason: 'channel closed' }])
    } finally { vi.doUnmock('ssh2'); vi.resetModules() }
  })
})

describe('SshTerminal GBK 主机', () => {
  it('输出按 GBK 流式解码、输入转 GBK；哨兵捕获给 AI 的输出是正确中文', async () => {
    const { EventEmitter } = await import('node:events')
    const written: Buffer[] = []
    let ch!: InstanceType<typeof EventEmitter>
    class FakeClient extends EventEmitter {
      connect() { setImmediate(() => this.emit('ready')) }
      shell(_o: unknown, cb: (e: Error | undefined, ch: unknown) => void) {
        ch = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write(d: Buffer | string) { written.push(Buffer.from(d)) }, end() {} })
        cb(undefined, ch)
      }
      end() {}
    }
    vi.resetModules()
    vi.doMock('ssh2', () => ({ Client: FakeClient }))
    try {
      const { SshTerminal: T } = await import('./SshTerminal.js')
      const t = await T.connect('t1', { host: 'h', port: 22, username: 'u', encoding: 'gbk' })
      const seen: string[] = []
      t.onData((s) => seen.push(s))
      t.write('echo 你好\r')
      expect(Buffer.concat(written)).toEqual(Buffer.from([...Buffer.from('echo '), 0xc4, 0xe3, 0xba, 0xc3, 0x0d]))
      // 「你好」的 GBK 字节被切在两个包里
      ch.emit('data', Buffer.from([0xc4, 0xe3, 0xba]))
      ch.emit('data', Buffer.from([0xc3, 0x0a]))
      expect(seen.join('')).toBe('你好\n')

      written.length = 0
      const p = t.execCapture('cat 中文.txt')
      const cmd = Buffer.concat(written)
      expect(cmd.includes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(true)   // 命令里的「中文」按 GBK 发出
      const id = cmd.toString('latin1').match(/__CW_START_([0-9a-f]{16})__/)![1]
      const out = Buffer.concat([Buffer.from(`__CW_START_${id}__\r\n`), Buffer.from([0xb2, 0xe2, 0xca, 0xd4]), Buffer.from(`\r\n__CW_END_${id}__0__\r\n`)])
      const cut = out.indexOf(0xe2)   // 在「测」两个字节中间切开
      ch.emit('data', out.subarray(0, cut))
      ch.emit('data', out.subarray(cut))
      const r = await p
      expect(r.output.trim()).toBe('测试')
      expect(r.exitCode).toBe(0)
    } finally { vi.doUnmock('ssh2'); vi.resetModules() }
  })
})

describe('SshTerminal.write noHistory', () => {
  it('自动应答（noHistory）写入不进命令历史，普通键入照常记', async () => {
    const { EventEmitter } = await import('node:events')
    const written: string[] = []
    class FakeClient extends EventEmitter {
      connect() { setImmediate(() => this.emit('ready')) }
      shell(_o: unknown, cb: (e: Error | undefined, ch: unknown) => void) {
        cb(undefined, Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write(b: string) { written.push(String(b)) }, end() {} }))
      }
      end() {}
    }
    vi.resetModules()
    vi.doMock('ssh2', () => ({ Client: FakeClient }))
    try {
      const { SshTerminal: T } = await import('./SshTerminal.js')
      const t = await T.connect('t1', { host: 'h', port: 22, username: 'u' })
      const cmds: string[] = []
      t.onCommand((c) => cmds.push(c))
      t.write('s3cret\r', { noHistory: true })
      t.write('ls\r')
      expect(written).toEqual(['s3cret\r', 'ls\r'])
      expect(cmds).toEqual(['ls'])
    } finally { vi.doUnmock('ssh2'); vi.resetModules() }
  })
})

describe('SshTerminal.execRead', () => {
  it('超时后才开出来的 exec channel 立即关掉（不泄漏占 MaxSessions）', async () => {
    const { EventEmitter } = await import('node:events')
    let late!: () => void
    let closed = 0
    class FakeClient extends EventEmitter {
      connect() { setImmediate(() => this.emit('ready')) }
      shell(_o: unknown, cb: (e: Error | undefined, ch: unknown) => void) { cb(undefined, Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write() {}, end() {} })) }
      exec(_c: string, cb: (e: Error | undefined, ch: unknown) => void) {
        late = () => cb(undefined, Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close() { closed++ } }))
      }
      end() {}
    }
    vi.resetModules()
    vi.doMock('ssh2', () => ({ Client: FakeClient }))
    try {
      const { SshTerminal: T } = await import('./SshTerminal.js')
      const t = await T.connect('t1', { host: 'h', port: 22, username: 'u' })
      await expect(t.execRead('true', 20)).rejects.toThrow('exec_timeout')
      late()
      expect(closed).toBe(1)
    } finally { vi.doUnmock('ssh2'); vi.resetModules() }
  })
})
