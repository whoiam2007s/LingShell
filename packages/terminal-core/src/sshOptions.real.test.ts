import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import { createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { connectSsh, setHostKeyPolicy } from './sshConnect.js'
import { SshTerminal } from './SshTerminal.js'
import { PortForwardManager } from './PortForwardManager.js'

// 本机回环的假 sshd：验证 agent 转发请求、远程端口转发（tcpip-forward + 服务器主动回连）、压缩协商。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

type Conn = import('ssh2').Connection
function fakeSshd(o: { agent?: 'accept' | 'reject'; forward?: 'accept' | 'reject' } = {}) {
  const st = { agentReqs: 0, shells: 0, forwards: [] as { bindAddr: string; bindPort: number }[], conns: [] as Conn[], terms: [] as string[] }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    st.conns.push(c)
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward') return reject?.()
      st.forwards.push(info as { bindAddr: string; bindPort: number })
      if (o.forward === 'reject') reject?.(); else accept?.()
    })
    c.on('session', (accept) => {
      const session = accept()
      // pty-req 里的 $TERM：ssh2 运行时带 term 字段（@types/ssh2 没声明）
      session.on('pty', (ok, _rej, info) => { st.terms.push((info as unknown as { term: string }).term); ok?.() })
      session.on('auth-agent', (ok, rej) => { st.agentReqs++; if (o.agent === 'reject') rej?.(); else ok?.() })
      session.on('shell', (ok) => { st.shells++; ok() })
    })
  })
  return new Promise<typeof st & { port: number; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r(Object.assign(st, { port: (s.address() as AddressInfo).port, close: () => s.close() }))))
}

// agent 路径只需存在于配置里（假服务器不开 auth-agent 通道，不会真去连）
const AGENT = process.platform === 'win32' ? '\\\\.\\pipe\\lingshell-test-no-agent' : '/tmp/lingshell-test-no-agent.sock'
const base = (port: number) => ({ host: '127.0.0.1', port, username: 'u', password: 'p' })

it('agent 转发：开了且有 agent → 交互通道上请求 auth-agent；没开不请求', async () => {
  trustAll()
  const srv = await fakeSshd()
  const t = await SshTerminal.connect('a1', { ...base(srv.port), agent: AGENT, agentForward: true })
  expect(srv.agentReqs).toBe(1)
  expect(t.notice).toBeUndefined()
  t.kill()
  const t2 = await SshTerminal.connect('a2', { ...base(srv.port), agent: AGENT })
  expect(srv.agentReqs).toBe(1)
  t2.kill()
  // 开了但没检测到 agent：不请求，给提示
  const t3 = await SshTerminal.connect('a3', { ...base(srv.port), agentForward: true })
  expect(srv.agentReqs).toBe(1)
  expect(t3.notice).toMatch(/未检测到 ssh-agent/)
  t3.kill(); srv.close()
}, 20000)

it('终端类型：pty-req 默认 xterm-256color；主机设了用主机的；非法值回退默认', async () => {
  trustAll()
  const srv = await fakeSshd()
  for (const [i, termType] of [undefined, 'vt100', 'bad term;rm'].entries()) {
    const t = await SshTerminal.connect(`tt${i}`, { ...base(srv.port), termType })
    t.kill()
  }
  expect(srv.terms).toEqual(['xterm-256color', 'vt100', 'xterm-256color'])
  srv.close()
}, 20000)

it('agent 转发：服务器拒绝 → 不带转发重开 shell，照常登录并提示', async () => {
  trustAll()
  const srv = await fakeSshd({ agent: 'reject' })
  const t = await SshTerminal.connect('a4', { ...base(srv.port), agent: AGENT, agentForward: true })
  expect(srv.agentReqs).toBe(1)
  expect(srv.shells).toBe(1)
  expect(t.notice).toMatch(/AllowAgentForwarding/)
  t.kill(); srv.close()
}, 20000)

it('压缩：协商到 zlib；带着开着的 channel 断开不抛未捕获异常（绕过 ssh2 的 zlib 释放缺陷）', async () => {
  trustAll()
  const srv = await fakeSshd()
  const c = await connectSsh({ ...base(srv.port), compress: true })
  const writer = (c.client as unknown as { _protocol: { _packetRW: { write: object } } })._protocol._packetRW.write
  expect(writer.constructor.name).toBe('ZlibPacketWriter')
  c.close()
  const t = await SshTerminal.connect('c1', { ...base(srv.port), compress: true, keepaliveSec: 0 })
  expect(srv.shells).toBe(1)
  t.kill()                                     // 本端断开
  const t2 = await SshTerminal.connect('c2', { ...base(srv.port), compress: true })
  const closed = new Promise((r) => t2.onExit(r))
  srv.conns.at(-1)!.end()                      // 服务器断开
  await closed
  await new Promise((r) => setTimeout(r, 100)) // 等 channel 收尾的 nextTick
  srv.close()
}, 20000)

function echoServer() {
  const got: string[] = []
  const s: NetServer = createServer((sock) => sock.on('data', (d) => { got.push(d.toString()); sock.write('pong:' + d.toString()) }))
  return new Promise<{ port: number; got: string[]; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, got, close: () => s.close() })))
}

it('远程转发 -R：服务器收到 tcpip-forward；服务器上来的连接经 SSH 回到本机目标，数据往返', async () => {
  trustAll()
  const srv = await fakeSshd()
  const echo = await echoServer()
  const m = new PortForwardManager()
  const info = await m.start({ hostId: 'h', kind: 'remote', remotePort: 18080, localHost: '127.0.0.1', localPort: echo.port }, () => base(srv.port), 'T')
  expect(info.status.state).toBe('running')
  expect(srv.forwards).toEqual([{ bindAddr: '127.0.0.1', bindPort: 18080 }])
  // 模拟服务器上有人连 127.0.0.1:18080：服务器开 forwarded-tcpip 通道给客户端（最后一条连接；首连确认指纹时还有一条被拒掉的）
  const reply = await new Promise<string>((resolve, reject) => {
    srv.conns.at(-1)!.forwardOut('127.0.0.1', 18080, '127.0.0.1', 50000, (err, ch) => {
      if (err) return reject(err)
      ch.on('data', (d: Buffer) => resolve(d.toString()))
      ch.write('ping')
    })
  })
  expect(reply).toBe('pong:ping')
  expect(echo.got).toEqual(['ping'])
  // 本机目标没起：服务器那头的这条连接被拒
  const dead = await new Promise<number>((r) => { const x = createServer(); x.listen(0, '127.0.0.1', () => { const p = (x.address() as AddressInfo).port; x.close(() => r(p)) }) })
  const info2 = await m.start({ hostId: 'h', kind: 'remote', remotePort: 18081, localHost: '127.0.0.1', localPort: dead }, () => base(srv.port), 'T')
  await expect(new Promise((resolve, reject) => srv.conns.at(-1)!.forwardOut('127.0.0.1', 18081, '127.0.0.1', 50001, (err) => err ? reject(err) : resolve(undefined)))).rejects.toThrow()
  m.stop(info.id); m.stop(info2.id)
  expect(m.list()).toEqual([])
  echo.close(); srv.close()
}, 20000)

it('远程转发 -R：服务器拒绝监听 → remote_bind_failed，说明 AllowTcpForwarding / GatewayPorts', async () => {
  trustAll()
  const srv = await fakeSshd({ forward: 'reject' })
  const m = new PortForwardManager()
  await expect(m.start({ hostId: 'h', kind: 'remote', remotePort: 80, remoteBind: '0.0.0.0', localHost: '127.0.0.1', localPort: 1 }, () => base(srv.port), 'T'))
    .rejects.toThrow(/^remote_bind_failed: 服务器拒绝在 0\.0\.0\.0:80 监听.*AllowTcpForwarding.*GatewayPorts/)
  expect(m.list()).toEqual([])
  srv.close()
}, 20000)
