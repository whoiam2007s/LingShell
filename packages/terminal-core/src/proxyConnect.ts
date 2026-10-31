import { connect, isIP, type Socket } from 'node:net'
import { tr, tk, type ProxyOpts } from '@lingshell/shared'

// 出站代理客户端（零依赖，node:net）：经 HTTP CONNECT 或 SOCKS5（RFC 1928/1929）打通到 host:port 的隧道，
// 返回已就绪的 socket，交给 ssh2 的 sock。代理回应后紧跟的字节（如 SSH 服务器 banner）放回 socket 不丢。
// 失败错误码：proxy_unreachable / proxy_auth_failed / proxy_refused / proxy_timeout / proxy_error
export function connectViaProxy(p: ProxyOpts, host: string, port: number, timeoutMs = 20000): Promise<Socket> {
  const where = tr('代理 {host}:{port}', { host: p.host, port: p.port })
  return new Promise<Socket>((resolve, reject) => {
    const sock = connect({ host: p.host, port: p.port })
    let settled = false
    const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); reject(e) }
    const timer = setTimeout(() => fail(new Error(`proxy_timeout: ${tr('{where} 在 {sec} 秒内未打通隧道', { where, sec: Math.round(timeoutMs / 1000) })}`)), timeoutMs)
    let connected = false
    const onError = (e: NodeJS.ErrnoException) => fail(new Error(!connected
      ? `proxy_unreachable: ${tr('无法连接{where}（{error}）', { where, error: e.code ?? e.message })}` : `proxy_error: ${tr('{where} 连接中断（{error}）', { where, error: e.code ?? e.message })}`))
    sock.on('error', onError)
    sock.once('connect', () => {
      connected = true
      const r = reader(sock)
      const run = p.type === 'http' ? httpConnect(sock, r, p, host, port, where) : socks5Connect(sock, r, p, host, port, where)
      run.then(() => {
        if (settled) return
        settled = true; clearTimeout(timer)
        sock.pause()                       // 摘掉 data 监听不会自动暂停：先停住，等 ssh2 接管时再流动
        const rest = r.done()
        if (rest.length) sock.unshift(rest)
        sock.off('error', onError)         // 之后的错误归 ssh2（它在 connect() 里同步挂监听）
        resolve(sock)
      }, (e: Error) => fail(e))
    })
  })
}

// 按需取字节：take(need) 等到缓冲区够 need(buf) 个字节再切出来；连接关闭则抛错
function reader(sock: Socket) {
  let buf = Buffer.alloc(0)
  let wake: (() => void) | undefined
  let closed = false
  const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); wake?.() }
  const onClose = () => { closed = true; wake?.() }
  sock.on('data', onData); sock.on('end', onClose); sock.on('close', onClose)
  return {
    async take(need: (b: Buffer) => number | null, closedMsg: string): Promise<Buffer> {
      for (;;) {
        const n = need(buf)
        if (n !== null && buf.length >= n) { const out = buf.subarray(0, n); buf = buf.subarray(n); return out }
        if (closed) throw new Error(closedMsg)
        await new Promise<void>((r) => { wake = r })
        wake = undefined
      }
    },
    done(): Buffer { sock.off('data', onData); sock.off('end', onClose); sock.off('close', onClose); return buf },
  }
}
type Reader = ReturnType<typeof reader>

const hostPortText = (host: string, port: number) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`

async function httpConnect(sock: Socket, r: Reader, p: ProxyOpts, host: string, port: number, where: string): Promise<void> {
  const target = hostPortText(host, port)
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}\r\n` : ''
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
  const head = await r.take((b) => {
    const i = b.indexOf('\r\n\r\n')
    if (i >= 0) return i + 4
    if (b.length > 16384) throw new Error(`proxy_error: ${tr('{where} 回应头过长', { where })}`)
    return null
  }, `proxy_error: ${tr('{where} 未回应即断开（不是 HTTP 代理？）', { where })}`)
  const m = /^HTTP\/1\.[01] (\d{3})([^\r\n]*)/.exec(head.toString('latin1'))
  if (!m) throw new Error(`proxy_error: ${tr('{where} 回应不是 HTTP（不是 HTTP 代理？）', { where })}`)
  const code = Number(m[1])
  if (code === 200) return
  if (code === 407) throw new Error(`proxy_auth_failed: ${tr('{where} 要求认证或用户名/密码错误（HTTP 407）', { where })}`)
  throw new Error(`proxy_refused: ${tr('{where} 拒绝连接到 {target}（HTTP {status}）', { where, target, status: `${code}${m[2].trimEnd()}` })}`)
}

// SOCKS5 应答码 → 说明（RFC 1928 §6）
const SOCKS_REP: Record<number, string> = {
  1: tk('代理内部错误'), 2: tk('代理规则不允许'), 3: tk('网络不可达'), 4: tk('主机不可达'), 5: tk('目标拒绝连接'), 6: tk('TTL 过期'), 7: tk('不支持的命令'), 8: tk('不支持的地址类型'),
}

async function socks5Connect(sock: Socket, r: Reader, p: ProxyOpts, host: string, port: number, where: string): Promise<void> {
  const closed = `proxy_error: ${tr('{where} 握手中断开（不是 SOCKS5 代理？）', { where })}`
  const withAuth = !!p.username
  sock.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]))
  const g = await r.take(() => 2, closed)
  if (g[0] !== 5) throw new Error(`proxy_error: ${tr('{where} 不是 SOCKS5 代理', { where })}`)
  if (g[1] === 0xff) throw new Error(`proxy_auth_failed: ${withAuth ? tr('{where} 不接受所给认证方式', { where }) : tr('{where} 不接受无认证方式（需要用户名/密码）', { where })}`)
  if (g[1] === 2) {
    if (!withAuth) throw new Error(`proxy_auth_failed: ${tr('{where} 需要用户名/密码', { where })}`)
    const u = Buffer.from(p.username!), pw = Buffer.from(p.password ?? '')
    if (u.length > 255 || pw.length > 255) throw new Error(`proxy_error: ${tr('代理用户名或密码过长（最多 255 字节）')}`)
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]))
    const a = await r.take(() => 2, closed)
    if (a[1] !== 0) throw new Error(`proxy_auth_failed: ${tr('{where} 用户名或密码错误', { where })}`)
  } else if (g[1] !== 0) throw new Error(`proxy_error: ${tr('{where} 选了不支持的认证方式 {method}', { where, method: g[1] })}`)

  // CONNECT 请求：IP 直接给，域名交给代理解析（ATYP 3）
  let addr: Buffer
  const v = isIP(host)
  if (v === 4) addr = Buffer.from([1, ...host.split('.').map(Number)])
  else if (v === 6) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
  else {
    const d = Buffer.from(host)
    if (d.length > 255) throw new Error(`proxy_error: ${tr('主机名过长')}`)
    addr = Buffer.concat([Buffer.from([3, d.length]), d])
  }
  const pb = Buffer.alloc(2); pb.writeUInt16BE(port)
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]))
  // 应答：VER REP RSV ATYP BND.ADDR BND.PORT（长度看 ATYP）
  const rep = await r.take((b) => {
    if (b.length < 5) return null
    return b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : 5
  }, closed)
  if (rep[1] !== 0) throw new Error(`proxy_refused: ${tr('{where} 无法连接到 {target}（{reason}）', { where, target: hostPortText(host, port), reason: SOCKS_REP[rep[1]] ? tr(SOCKS_REP[rep[1]]) : tr('SOCKS5 错误 {code}', { code: rep[1] }) })}`)
}

// IPv6 文本 → 16 字节（支持 :: 缩写与末尾内嵌 IPv4）
export function ipv6Bytes(ip: string): Buffer {
  let s = ip
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) { const n = v4[1].split('.').map(Number); s = s.slice(0, -v4[1].length) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16) }
  const [l, rgt] = s.split('::')
  const a = l ? l.split(':') : [], b = rgt !== undefined && rgt ? rgt.split(':') : []
  const groups = rgt === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2))
  return out
}
