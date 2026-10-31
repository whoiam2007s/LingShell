import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

// 最小 SOCKS5 服务端（RFC 1928）：仅无认证、仅 CONNECT，ATYP 支持 IPv4/域名/IPv6。出站由调用方提供（经 SSH forwardOut）。
export type ForwardOut = (host: string, port: number, cb: (err: Error | undefined, stream?: Duplex) => void) => void

// 应答码
export const REP = { OK: 0, FAIL: 1, NOT_ALLOWED: 2, HOST_UNREACHABLE: 4, REFUSED: 5, CMD_UNSUPPORTED: 7, ATYP_UNSUPPORTED: 8 } as const

// 握手：VER NMETHODS METHODS...；数据不够返回 null，版本不对抛错
export function parseGreeting(b: Buffer): { len: number; methods: number[] } | null {
  if (b.length < 2) return null
  if (b[0] !== 5) throw new Error('bad_version')
  const len = 2 + b[1]
  return b.length < len ? null : { len, methods: [...b.subarray(2, len)] }
}

// 请求：VER CMD RSV ATYP DST.ADDR DST.PORT；host=null 表示 ATYP 不支持
export function parseRequest(b: Buffer): { len: number; cmd: number; host: string | null; port: number } | null {
  if (b.length < 5) return null
  if (b[0] !== 5) throw new Error('bad_version')
  const atyp = b[3]
  let off: number, host: string | null
  if (atyp === 1) { off = 8; if (b.length < off) return null; host = [...b.subarray(4, 8)].join('.') }
  else if (atyp === 3) { off = 5 + b[4]; if (b.length < off) return null; host = b.subarray(5, off).toString('utf8') }
  else if (atyp === 4) {
    off = 20; if (b.length < off) return null
    host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(4 + i * 2).toString(16)).join(':')
  } else return { len: b.length, cmd: b[1], host: null, port: 0 }   // 不认识的 ATYP 无法确定长度，整段吞掉
  if (b.length < off + 2) return null
  return { len: off + 2, cmd: b[1], host, port: b.readUInt16BE(off) }
}

// 应答：BND.ADDR 填 0.0.0.0:0（客户端用不到）
export const reply = (rep: number) => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0])

// ssh2 forwardOut 失败映射：拒绝连接 → 0x05；被服务端策略禁止 → 0x02；其它通道打开失败 → 0x04；连接层故障 → 0x01
export function errToRep(err: Error & { reason?: number }): number {
  if (/refused/i.test(err.message)) return REP.REFUSED
  if (err.reason === 1) return REP.NOT_ALLOWED
  if (err.reason !== undefined || /channel open failure/i.test(err.message)) return REP.HOST_UNREACHABLE
  return REP.FAIL
}

// 接管一条本地连接：握手 → 解析请求 → forwardOut → 互相 pipe。任何异常只断这一条连接
export function serveSocks5(sock: Socket, forwardOut: ForwardOut): void {
  let buf = Buffer.alloc(0)
  let stage: 'greet' | 'req' | 'done' = 'greet'
  sock.on('error', () => sock.destroy())
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    if (buf.length > 600) { sock.destroy(); return }   // 合法握手+请求最多 ~520 字节
    try {
      if (stage === 'greet') {
        const g = parseGreeting(buf); if (!g) return
        buf = buf.subarray(g.len)
        if (!g.methods.includes(0)) { stage = 'done'; sock.end(Buffer.from([5, 0xff])); return }
        sock.write(Buffer.from([5, 0])); stage = 'req'
      }
      if (stage !== 'req') return
      const r = parseRequest(buf); if (!r) return
      stage = 'done'
      sock.removeListener('data', onData); sock.pause()
      const rest = buf.subarray(r.len)
      if (r.cmd !== 1) { sock.end(reply(REP.CMD_UNSUPPORTED)); return }
      if (r.host === null) { sock.end(reply(REP.ATYP_UNSUPPORTED)); return }
      forwardOut(r.host, r.port, (err, stream) => {
        if (err || !stream) { if (!sock.destroyed) sock.end(reply(err ? errToRep(err) : REP.FAIL)); return }
        if (sock.destroyed) { stream.destroy(); return }   // 客户端已提前关闭
        stream.on('error', () => sock.destroy())
        sock.on('close', () => stream.destroy())
        sock.write(reply(REP.OK))
        if (rest.length) stream.write(rest)
        sock.pipe(stream).pipe(sock)
      })
    } catch { sock.destroy() }
  }
  sock.on('data', onData)
}
