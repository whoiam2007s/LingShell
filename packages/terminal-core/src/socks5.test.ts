import { describe, it, expect, afterEach } from 'vitest'
import { createServer, connect as netConnect, type AddressInfo, type Server, type Socket } from 'node:net'
import { parseGreeting, parseRequest, serveSocks5, errToRep, reply, type ForwardOut } from './socks5.js'

const B = (...a: number[]) => Buffer.from(a)
const req = (atyp: number, addr: number[], port: number, cmd = 1) => B(5, cmd, 0, atyp, ...addr, port >> 8, port & 255)

describe('解析', () => {
  it('握手：分片不够返回 null，够了给出方法', () => {
    expect(parseGreeting(B(5))).toBeNull()
    expect(parseGreeting(B(5, 2, 0))).toBeNull()
    expect(parseGreeting(B(5, 2, 0, 2))).toEqual({ len: 4, methods: [0, 2] })
    expect(() => parseGreeting(B(4, 1, 0))).toThrow()
  })

  it('请求：IPv4 / 域名 / IPv6，逐字节喂到完整前都是 null', () => {
    const cases: [Buffer, string, number][] = [
      [req(1, [10, 0, 0, 8], 8080), '10.0.0.8', 8080],
      [req(3, [8, ...Buffer.from('intranet')], 80), 'intranet', 80],
      [req(4, [0x20, 0x01, 0x0d, 0xb8, ...Array(11).fill(0), 1], 443), '2001:db8:0:0:0:0:0:1', 443],
    ]
    for (const [b, host, port] of cases) {
      for (let i = 0; i < b.length; i++) expect(parseRequest(b.subarray(0, i))).toBeNull()
      expect(parseRequest(b)).toEqual({ len: b.length, cmd: 1, host, port })
    }
    expect(parseRequest(B(5, 1, 0, 9, 1, 2))?.host).toBeNull()   // 未知 ATYP
  })

  it('forwardOut 错误映射', () => {
    expect(errToRep(new Error('(SSH) Channel open failure: Connection refused'))).toBe(5)
    expect(errToRep(Object.assign(new Error('(SSH) Channel open failure: connect failed: Name or service not known'), { reason: 2 }))).toBe(4)
    expect(errToRep(Object.assign(new Error('(SSH) Channel open failure: administratively prohibited'), { reason: 1 }))).toBe(2)
    expect(errToRep(new Error('Not connected'))).toBe(1)
  })
})

describe('serveSocks5 端到端', () => {
  const servers: Server[] = []
  afterEach(() => { for (const s of servers.splice(0)) s.close() })
  const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)) })
  // 假出站：真的用 node:net 连到目标（回显服务器）
  const realOut: ForwardOut = (host, port, cb) => {
    const s = netConnect(port, host, () => cb(undefined, s))
    s.once('error', (e) => cb(e))
  }
  const proxy = (out: ForwardOut) => listen(createServer((sock) => serveSocks5(sock, out)))
  // 客户端：按分片逐个写（间隔几毫秒，确保服务端分多次收到），收集全部回包直到对端关闭或收满 want 字节
  const talk = (port: number, chunks: Buffer[], want = Infinity) => new Promise<Buffer>((resolve) => {
    const got: Buffer[] = []
    const c: Socket = netConnect(port, '127.0.0.1', async () => {
      c.setNoDelay(true)
      for (const ch of chunks) { c.write(ch); await new Promise((r) => setTimeout(r, 5)) }
    })
    const done = () => { resolve(Buffer.concat(got)); c.destroy() }
    c.on('data', (d) => { got.push(d); if (Buffer.concat(got).length >= want) done() })
    c.on('close', done)
    c.on('error', done)
  })

  it('握手+请求被拆成碎片 → CONNECT 成功，数据经回显服务器原样返回', async () => {
    const echo = await listen(createServer((s) => s.pipe(s)))
    const port = await proxy(realOut)
    const r = req(1, [127, 0, 0, 1], echo)
    const out = await talk(port, [B(5), B(1, 0), r.subarray(0, 3), r.subarray(3, 7), r.subarray(7), Buffer.from('ping')], 2 + 10 + 4)
    expect(out.subarray(0, 2)).toEqual(B(5, 0))
    expect(out.subarray(2, 12)).toEqual(reply(0))
    expect(out.subarray(12).toString()).toBe('ping')
  })

  it('域名目标原样交给 forwardOut', async () => {
    const seen: [string, number][] = []
    const echo = await listen(createServer((s) => s.pipe(s)))
    const port = await proxy((h, p, cb) => { seen.push([h, p]); realOut('127.0.0.1', echo, cb) })
    const out = await talk(port, [Buffer.concat([B(5, 1, 0), req(3, [9, ...Buffer.from('intranet1')], 80), Buffer.from('x')])], 13)
    expect(seen).toEqual([['intranet1', 80]])
    expect(out.subarray(12).toString()).toBe('x')
  })

  it('不支持的认证方法 → 05 FF 并关闭', async () => {
    const port = await proxy(realOut)
    expect(await talk(port, [B(5, 1, 2)])).toEqual(B(5, 0xff))
  })

  it('不支持的命令（BIND）→ 0x07 并关闭，不调 forwardOut', async () => {
    let called = false
    const port = await proxy(() => { called = true })
    const out = await talk(port, [B(5, 1, 0), req(1, [1, 2, 3, 4], 80, 2)])
    expect(out).toEqual(Buffer.concat([B(5, 0), reply(7)]))
    expect(called).toBe(false)
  })

  it('forwardOut 失败 → 按原因回 0x05 / 0x04 后关闭', async () => {
    const refused = await proxy((_h, _p, cb) => cb(new Error('(SSH) Channel open failure: Connection refused')))
    expect((await talk(refused, [B(5, 1, 0), req(1, [10, 0, 0, 1], 80)])).subarray(2)).toEqual(reply(5))
    const unreach = await proxy((_h, _p, cb) => cb(Object.assign(new Error('(SSH) Channel open failure: no route'), { reason: 2 })))
    expect((await talk(unreach, [B(5, 1, 0), req(3, [2, 0x61, 0x62], 80)])).subarray(2)).toEqual(reply(4))
  })

  it('客户端在 forwardOut 回来前关闭 → 出站流被销毁，不崩', async () => {
    let destroyed = false
    let later!: () => void
    const port = await proxy((_h, _p, cb) => {
      later = () => {
        const s = netConnect(1, '127.0.0.1'); s.on('error', () => {})
        s.on('close', () => { destroyed = true })
        cb(undefined, s)
      }
    })
    await talk(port, [Buffer.concat([B(5, 1, 0), req(1, [10, 0, 0, 1], 80)])], 2)   // 收到 05 00 即断开
    await new Promise((r) => setTimeout(r, 20))
    later()
    await new Promise((r) => setTimeout(r, 20))
    expect(destroyed).toBe(true)
  })
})
