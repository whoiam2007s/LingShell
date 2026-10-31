import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import { connect, createServer, type AddressInfo } from 'node:net'
import { PortForwardManager, setHostKeyPolicy, SshTerminal } from '@lingshell/terminal-core'
import { portsListCommand, type PortForwardInfo, type PortList, type TerminalInfo } from '@lingshell/shared'
import { registerPorts } from './portsIpc.js'

// 本机回环的假 sshd：exec 回固定的 ss 输出（监听端口 = 本机 echo 服务的端口），direct-tcpip 转到本机目标。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function echoServer() {
  const s = createServer((c) => c.pipe(c))
  return new Promise<{ port: number; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
}

function fakeSshd(listenPort: number) {
  const execs: string[] = [], tcpip: { destIP: string; destPort: number }[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('tcpip', (accept, reject, info) => {
      tcpip.push({ destIP: info.destIP, destPort: info.destPort })
      const sock = connect(info.destPort, info.destIP)
      sock.once('connect', () => { const ch = accept(); sock.pipe(ch).pipe(sock) })
      sock.once('error', () => reject())
    })
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { ok() })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const ch = ok()
        ch.write(`@@tool:ss\nLISTEN 0 128 0.0.0.0:${listenPort} 0.0.0.0:* users:(("echo",pid=42,fd=3))\nLISTEN 0 128 [::]:22 [::]:*\n`)
        ch.exit(0); ch.end()
      })
    })
  })
  return new Promise<{ port: number; execs: string[]; tcpip: typeof tcpip; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, execs, tcpip, close: () => s.close() })))
}

// 连本机端口发一句，拿回显；连不上 reject
const roundTrip = (port: number, text: string) => new Promise<string>((resolve, reject) => {
  const s = connect(port, '127.0.0.1')
  let got = ''
  s.on('connect', () => s.write(text))
  s.on('data', (d) => { got += d.toString(); if (got.length >= text.length) { s.destroy(); resolve(got) } })
  s.on('error', reject)
  setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, 3000)
})

it('列监听端口；转发到本机（本机同号被占自动 +1）后连得通，停止 / 关终端后断开', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const echo = await echoServer()   // 「远端」服务；它也正占着本机同号端口 → 转发得 +1
  const srv = await fakeSshd(echo.port)
  const t = await SshTerminal.connect('p1', { host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  const fm = new PortForwardManager()
  try {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const ports = registerPorts({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => (id === 'p1' ? ({ id, type: 'ssh', os: 'linux', title: 'u@127.0.0.1' } as TerminalInfo) : undefined),
      exec: () => (cmd, ms) => t.execRead(cmd, ms),
      sshOpts: () => t.connectOpts,
      hostKey: () => 'h1',
      forwards: fm,
    })
    const call = <T>(ch: string, ...a: unknown[]) => hs.get(ch)!({}, ...a) as Promise<T>
    const list = await call<PortList>('ports:list', 'p1')
    expect(srv.execs).toEqual([portsListCommand()])
    expect(list.rows).toEqual([
      { proto: 'tcp6', addr: '::', port: 22 },
      { proto: 'tcp', addr: '0.0.0.0', port: echo.port, process: 'echo', pid: 42 },
    ])

    const f = await call<PortForwardInfo>('ports:forward', 'p1', '0.0.0.0', echo.port)
    expect(f).toMatchObject({ kind: 'local', remoteHost: '127.0.0.1', remotePort: echo.port, hostId: 'h1', hostLabel: 'u@127.0.0.1（临时）' })
    expect(f.localPort).toBeGreaterThan(echo.port)
    expect(await roundTrip(f.localPort, 'hello')).toBe('hello')
    expect(srv.tcpip.at(-1)).toEqual({ destIP: '127.0.0.1', destPort: echo.port })
    // 同一行再点：返回已有的那条，不重复开
    expect((await call<PortForwardInfo>('ports:forward', 'p1', '0.0.0.0', echo.port)).id).toBe(f.id)
    expect((await call<PortForwardInfo[]>('ports:forwards', 'p1')).map((x) => x.id)).toEqual([f.id])

    await call('ports:stop', 'p1', f.id)
    await expect(roundTrip(f.localPort, 'x')).rejects.toThrow()
    expect(await call<PortForwardInfo[]>('ports:forwards', 'p1')).toEqual([])

    // 终端关闭：它的临时转发全停
    const g = await call<PortForwardInfo>('ports:forward', 'p1', '0.0.0.0', echo.port)
    expect(await roundTrip(g.localPort, 'again')).toBe('again')
    ports.stopTerminal('p1')
    expect(fm.list()).toEqual([])
    await expect(roundTrip(g.localPort, 'x')).rejects.toThrow()

    // 参数校验：非法地址 / 端口；不支持的终端
    await expect(call('ports:forward', 'p1', 'evil.com; rm', 80)).rejects.toThrow('非法的监听地址')
    await expect(call('ports:forward', 'p1', '0.0.0.0', 70000)).rejects.toThrow('非法的端口')
    await expect(call('ports:list', 'nope')).rejects.toThrow('terminal_not_found')
  } finally { fm.stopAll(); t.kill(); srv.close(); echo.close() }
}, 30000)
