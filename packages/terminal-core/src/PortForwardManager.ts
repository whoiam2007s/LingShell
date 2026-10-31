import { connect, createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { reconnectDelay, tr, type PortForwardInfo, type PortForwardInput, type SshConnectOpts } from '@lingshell/shared'
import { connectSsh, type SshConn } from './sshConnect.js'
import { serveSocks5 } from './socks5.js'

interface Fwd {
  info: PortForwardInfo
  opts: () => SshConnectOpts       // 每次（重）连时现取，主机改过凭据也能用上
  server?: Server; conn?: SshConn; sockets: Set<Socket>
  timer?: ReturnType<typeof setTimeout>
  busy?: boolean                   // 正在监听/连 SSH
  dead?: boolean                   // 用户已停止：在途的连接结果作废
}

const defaultDelay = (n: number) => { const s = reconnectDelay(n); return s === null ? null : s * 1000 }
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// 本地端口转发（ssh -L）：127.0.0.1:localPort ← 本机连接 → 专用 SSH 连接 forwardOut → remoteHost:remotePort。
// 动态转发（ssh -D）：本地 SOCKS5 代理，每条连接按客户端请求的目标 forwardOut。
// 远程转发（ssh -R）：服务器上监听，连进来的连接回到本机连目标（不占本地端口）。
// 每条转发一条独立 SSH 连接（经 connectSsh，跳板机同样生效），与终端互不影响。仅用户手动启停，不暴露给 AI。
// SSH 意外断开：关监听 → 按共用退避表重连（重新监听同一端口 + 连 SSH）；次数用完 / 端口被占 → stopped，等用户重试或移除。
export class PortForwardManager {
  private fwds = new Map<string, Fwd>()
  // onChange：状态被动变化时回调（UI 重新 list）；delayMs：第 n 次重连前等待毫秒，null = 放弃（测试注入）
  constructor(private onChange?: (id: string) => void, private delayMs: (attempt: number) => number | null = defaultDelay) {}

  list(): PortForwardInfo[] { return [...this.fwds.values()].map((f) => ({ ...f.info })) }

  async start(input: PortForwardInput, opts: () => SshConnectOpts, hostLabel: string): Promise<PortForwardInfo> {
    // 本地转发只监听回环；动态转发默认回环，用户显式选 0.0.0.0 才对局域网开放（白名单，防注入任意地址）。远程转发的服务器监听地址同样白名单
    const bind = input.kind === 'dynamic' ? input.bindHost ?? '127.0.0.1' : input.kind === 'remote' ? input.remoteBind ?? '127.0.0.1' : '127.0.0.1'
    if (bind !== '127.0.0.1' && bind !== '0.0.0.0') throw new Error(`bad_bind_host: ${String(bind)}`)
    const id = 'fwd_' + randomBytes(3).toString('hex')
    const f: Fwd = { info: { ...input, id, hostLabel, status: { state: 'running' } }, opts, sockets: new Set() }
    await this.open(f)
    this.fwds.set(id, f)
    return { ...f.info }
  }

  // 用户停止：移出列表，取消待重连，永不自动恢复
  stop(id: string): void {
    const f = this.fwds.get(id)
    if (!f) return
    this.fwds.delete(id)
    f.dead = true
    clearTimeout(f.timer)
    this.teardown(f)
  }

  stopAll(): void { for (const id of [...this.fwds.keys()]) this.stop(id) }

  /** 删主机时用：这台主机上正在跑的转发全部停掉（否则 SSH 连接和监听会一直留着，界面上又找不到） */
  stopByHost(hostId: string): string[] {
    const ids = [...this.fwds.values()].filter((f) => f.info.hostId === hostId).map((f) => f.info.id)
    for (const id of ids) this.stop(id)
    return ids
  }

  // 立即重连：重连中跳过倒计时（次数不变）；已停止则从第 1 次重来。正在连时忽略
  retry(id: string): void {
    const f = this.fwds.get(id)
    if (!f || f.busy || f.info.status.state === 'running') return
    void this.attempt(f, f.info.status.state === 'reconnecting' ? f.info.status.attempt : 1)
  }

  private bindOf(f: Fwd) { return f.info.kind === 'dynamic' ? f.info.bindHost ?? '127.0.0.1' : '127.0.0.1' }

  // 远程转发（-R）：连 SSH → 请服务器监听（tcpip-forward）→ 服务器上每来一条连接（forwarded-tcpip），本机连 localHost:localPort 对接
  private async openRemote(f: Fwd & { info: { kind: 'remote' } }): Promise<void> {
    const input = f.info
    f.busy = true
    try {
      const conn = await connectSsh(f.opts(), { keepaliveInterval: 15000, keepaliveCountMax: 3 })
      if (f.dead) { conn.close(); throw new Error('cancelled') }
      const bind = input.remoteBind ?? '127.0.0.1'
      conn.client.on('tcp connection', (_info, accept, reject) => {
        const sock = connect(input.localPort, input.localHost)
        let ok = false
        sock.once('connect', () => {
          ok = true
          const stream = accept()
          f.sockets.add(sock)
          sock.on('close', () => f.sockets.delete(sock))
          stream.on('error', () => sock.destroy())
          sock.pipe(stream).pipe(sock)
        })
        sock.on('error', () => { if (!ok) reject(); sock.destroy() })   // 本机目标没起：拒掉服务器那头的这条连接
      })
      try {
        await new Promise<void>((resolve, reject) => conn.client.forwardIn(bind, input.remotePort, (err) => err ? reject(err) : resolve()))
      } catch (e) {
        conn.close()
        throw new Error(`remote_bind_failed: ${tr('服务器拒绝在 {addr} 监听（{error}）。可能是端口已被占用、1024 以下端口需要 root，或服务器 sshd_config 设置了 AllowTcpForwarding no / 禁止远程转发；监听 0.0.0.0 还需 GatewayPorts yes 或 clientspecified', { addr: `${bind}:${input.remotePort}`, error: errMsg(e) })}`)
      }
      if (f.dead) { conn.close(); throw new Error('cancelled') }
      f.conn = conn
      conn.client.on('close', () => { if (f.conn === conn) this.dropped(f) })
    } finally { f.busy = false }
  }

  // 先占端口（被占用时不必白连一次 SSH，且错误清楚），再连 SSH
  private async open(f: Fwd): Promise<void> {
    const input = f.info
    if (input.kind === 'remote') return this.openRemote(f as Fwd & { info: { kind: 'remote' } })
    f.busy = true
    const server = createServer((sock) => {
      const conn = f.conn
      if (!conn) { sock.destroy(); return }
      f.sockets.add(sock)
      sock.on('close', () => f.sockets.delete(sock))
      sock.on('error', () => sock.destroy())
      if (input.kind === 'dynamic') {
        serveSocks5(sock, (host, port, cb) => conn.client.forwardOut('127.0.0.1', sock.remotePort ?? 0, host, port, cb))
        return
      }
      conn.client.forwardOut('127.0.0.1', sock.remotePort ?? 0, input.remoteHost, input.remotePort, (err, stream) => {
        if (err) { sock.destroy(); return }   // 远端拒绝（目标端口没监听等）：断掉本地这条连接即可
        stream.on('error', () => sock.destroy())
        sock.pipe(stream).pipe(sock)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE'
          ? new Error(`local_port_in_use: ${tr('本地端口 {port} 已被占用', { port: input.localPort })}`)
          : new Error(`local_listen_failed: ${e.message}`)))
        server.listen(input.localPort, this.bindOf(f), () => resolve())
      })
      let conn: SshConn
      try { conn = await connectSsh(f.opts(), { keepaliveInterval: 15000, keepaliveCountMax: 3 }) }
      catch (e) { server.close(); throw e }
      if (f.dead) { server.close(); conn.close(); throw new Error('cancelled') }
      f.server = server; f.conn = conn
      conn.client.on('close', () => { if (f.conn === conn) this.dropped(f) })
    } finally { f.busy = false }
  }

  // 关监听 + 断已有连接 + 关 SSH；先清引用，自己 close 触发的 close 事件不再当成断线
  private teardown(f: Fwd): void {
    const { server, conn } = f
    f.server = undefined; f.conn = undefined
    server?.close()
    for (const s of f.sockets) s.destroy()   // server.close 不断已有连接，手动断
    f.sockets.clear()
    conn?.close()
  }

  private dropped(f: Fwd): void {
    this.teardown(f)
    this.schedule(f, 1)
  }

  private schedule(f: Fwd, n: number): void {
    const d = this.delayMs(n)
    if (d === null) this.setStatus(f, { state: 'stopped', reason: tr('重连 {n} 次均失败', { n: n - 1 }) })
    else {
      this.setStatus(f, { state: 'reconnecting', attempt: n, retryAt: Date.now() + d })
      f.timer = setTimeout(() => void this.attempt(f, n), d)
    }
  }

  private async attempt(f: Fwd, n: number): Promise<void> {
    clearTimeout(f.timer); f.timer = undefined
    this.setStatus(f, { state: 'reconnecting', attempt: n, retryAt: Date.now() })
    try { await this.open(f) }
    catch (e) {
      if (f.dead) return
      const m = /^(?:local_port_in_use|local_listen_failed|remote_bind_failed): (.*)$/.exec(errMsg(e))
      if (m) this.setStatus(f, { state: 'stopped', reason: m[1] })   // 端口被别的程序占了 / 服务器不让监听：重试也没用，停下说清楚
      else this.schedule(f, n + 1)
      return
    }
    this.setStatus(f, { state: 'running' })
  }

  private setStatus(f: Fwd, s: PortForwardInfo['status']): void {
    if (f.dead) return
    f.info.status = s
    this.onChange?.(f.info.id)
  }
}
