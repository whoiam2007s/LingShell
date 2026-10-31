import { it, expect, describe, afterEach } from 'vitest'
import ssh2 from 'ssh2'
import { createServer, connect as tcpConnect, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { connectSsh, setHostKeyPolicy, setSshAuthPrompter, isPasswordPrompt } from './sshConnect.js'
import { serveSocks5 } from './socks5.js'
import { connectViaProxy, ipv6Bytes } from './proxyConnect.js'
import type { SshAuthPromptInfo } from '@lingshell/shared'

// 本机回环：假 sshd（keyboard-interactive 两步：密码 + 验证码）、假 HTTP CONNECT / SOCKS5 代理（node:net）。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

const servers: { close(): void }[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close(); setSshAuthPrompter(undefined) })
const listen = (s: NetServer) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => { servers.push(s); r((s.address() as AddressInfo).port) }))

// 只接受 keyboard-interactive：先问 Password:（不回显），再问 Verification code:（回显）
function fakeSshd(o: { password?: string; otp?: string; kbdOnly?: boolean } = {}) {
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('error', () => {})
    c.on('authentication', (ctx) => {
      if (o.kbdOnly === false) return ctx.accept()
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive'])
      ctx.prompt([{ prompt: 'Password: ', echo: false }], 'login', '', (a1) => {
        if (a1[0] !== (o.password ?? 'pw')) return ctx.reject()
        ctx.prompt([{ prompt: 'Verification code: ', echo: true }], '', '请输入 Google Authenticator 动态码', (a2) => (a2[0] === (o.otp ?? '123456') ? ctx.accept() : ctx.reject()))
      })
    })
    c.on('ready', () => {})
  })
  return new Promise<number>((r) => s.listen(0, '127.0.0.1', () => { servers.push(s); r((s.address() as AddressInfo).port) }))
}

const base = (port: number) => ({ host: '127.0.0.1', port, username: 'u', password: 'pw', label: '堡垒机' })

describe('keyboard-interactive', () => {
  it('密码提示自动用已存密码答，验证码弹给用户（带主机名/说明/回显标记）', async () => {
    trustAll()
    const port = await fakeSshd()
    const seen: SshAuthPromptInfo[] = []
    setSshAuthPrompter(async (info) => { seen.push(info); return ['123456'] })
    const c = await connectSsh(base(port))
    c.close()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ label: '堡垒机', role: '目标主机', hostPort: `127.0.0.1:${port}`, instructions: '请输入 Google Authenticator 动态码', prompts: [{ prompt: 'Verification code: ', echo: true }] })
  }, 20000)

  it('验证码错 → ssh_auth_failed；用户取消 → ssh_auth_cancelled', async () => {
    trustAll()
    const port = await fakeSshd()
    setSshAuthPrompter(async () => ['000000'])
    await expect(connectSsh(base(port))).rejects.toThrow(/ssh_auth_failed/)
    setSshAuthPrompter(async () => null)
    await expect(connectSsh(base(port))).rejects.toThrow(/ssh_auth_cancelled/)
  }, 20000)

  it('没存密码：密码提示也弹框；无人值守连接不弹，直接失败并说明', async () => {
    trustAll()
    const port = await fakeSshd()
    const asked: string[][] = []
    setSshAuthPrompter(async (info) => { asked.push(info.prompts.map((p) => p.prompt)); return info.prompts[0].prompt.startsWith('Password') ? ['pw'] : ['123456'] })
    const c = await connectSsh({ ...base(port), password: undefined })
    c.close()
    expect(asked).toEqual([['Password: '], ['Verification code: ']])
    await expect(connectSsh({ ...base(port), noHostKeyPrompt: true })).rejects.toThrow(/二次验证.*无人值守/)
  }, 20000)

  it('用户输入耗时超过连接超时也不断（输入期间暂停握手超时）', async () => {
    trustAll()
    const port = await fakeSshd()
    setSshAuthPrompter(() => new Promise((r) => setTimeout(() => r(['123456']), 1500)))
    const c = await connectSsh({ ...base(port), readyTimeoutMs: 800 })
    c.close()
  }, 20000)

  it('isPasswordPrompt：只认「密码」类，验证码/改密不认', () => {
    expect(isPasswordPrompt({ prompt: 'Password: ', echo: false })).toBe(true)
    expect(isPasswordPrompt({ prompt: 'root@h\'s password:', echo: false })).toBe(true)
    expect(isPasswordPrompt({ prompt: '请输入密码：', echo: false })).toBe(true)
    expect(isPasswordPrompt({ prompt: 'Verification code: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'Passcode: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'OTP Password: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'New password: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'Password: ', echo: true })).toBe(false)
  })
})

// ── 代理 ──
// HTTP CONNECT：先连上目标、等到目标的第一包（SSH banner）再把 200 回应和它拼成一次写出，验证回应后的多余字节不丢
function fakeHttpProxy(auth?: string) {
  const seen: string[] = []
  const s = createServer((c) => {
    c.on('error', () => {})
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString('latin1')
      const i = buf.indexOf('\r\n\r\n'); if (i < 0) return
      c.off('data', onData)
      const head = buf.slice(0, i)
      seen.push(head.split('\r\n')[0])
      if (auth && !head.includes(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`)) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return }
      const m = /^CONNECT ([^:]+):(\d+) /.exec(head)!
      const up = tcpConnect(Number(m[2]), m[1])
      up.on('error', () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
      up.once('data', (first) => {
        c.write(Buffer.concat([Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'), first]))
        up.pipe(c); c.pipe(up)
      })
    }
    c.on('data', onData)
  })
  return listen(s).then((port) => ({ port, seen }))
}

// SOCKS5：无认证时直接用项目里的 serveSocks5（-D 动态转发的服务端）；要认证时用下面的最小实现（RFC 1929，仅 IPv4 请求）
const forwardOut = (host: string, port: number, cb: (err: Error | undefined, s?: Socket) => void) => {
  const up = tcpConnect(port, host)
  up.once('connect', () => cb(undefined, up)); up.once('error', (e) => cb(e))
}
function fakeSocks5(auth?: { user: string; pass: string }) {
  const s = createServer((c) => {
    c.on('error', () => {})
    if (!auth) { serveSocks5(c, forwardOut); return }
    c.once('data', (g) => {
      if (!g.subarray(2).includes(2)) { c.end(Buffer.from([5, 0xff])); return }
      c.write(Buffer.from([5, 2]))
      c.once('data', (a) => {
        const ul = a[1], user = a.subarray(2, 2 + ul).toString(), pass = a.subarray(3 + ul, 3 + ul + a[2 + ul]).toString()
        if (user !== auth.user || pass !== auth.pass) { c.end(Buffer.from([1, 1])); return }
        c.write(Buffer.from([1, 0]))
        c.once('data', (r) => {
          forwardOut([...r.subarray(4, 8)].join('.'), r.readUInt16BE(8), (err, up) => {
            if (err || !up) { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return }
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            up.pipe(c); c.pipe(up)
          })
        })
      })
    })
  })
  return listen(s)
}

describe('出站代理', () => {
  it('HTTP CONNECT（带认证）：经代理连上，回应后紧跟的 banner 不丢', async () => {
    trustAll()
    const sshPort = await fakeSshd({ kbdOnly: false })
    const px = await fakeHttpProxy('pu:ppw')
    const c = await connectSsh({ ...base(sshPort), proxy: { type: 'http', host: '127.0.0.1', port: px.port, username: 'pu', password: 'ppw' } })
    c.close()
    expect(px.seen.length).toBeGreaterThan(0)   // 首连确认指纹后会重连一次
    for (const l of px.seen) expect(l).toBe(`CONNECT 127.0.0.1:${sshPort} HTTP/1.1`)
  }, 20000)

  it('HTTP CONNECT 认证失败 → proxy_auth_failed', async () => {
    const sshPort = await fakeSshd({ kbdOnly: false })
    const px = await fakeHttpProxy('pu:ppw')
    await expect(connectSsh({ ...base(sshPort), proxy: { type: 'http', host: '127.0.0.1', port: px.port, username: 'pu', password: 'bad' } })).rejects.toThrow(/proxy_auth_failed.*407/)
  }, 20000)

  it('SOCKS5 无认证 / 用户名密码：都能连上；密码错 → proxy_auth_failed', async () => {
    trustAll()
    const sshPort = await fakeSshd({ kbdOnly: false })
    const open = await fakeSocks5()
    const c1 = await connectSsh({ ...base(sshPort), proxy: { type: 'socks5', host: '127.0.0.1', port: open } })
    c1.close()
    const locked = await fakeSocks5({ user: 'pu', pass: 'ppw' })
    const c2 = await connectSsh({ ...base(sshPort), proxy: { type: 'socks5', host: '127.0.0.1', port: locked, username: 'pu', password: 'ppw' } })
    c2.close()
    await expect(connectSsh({ ...base(sshPort), proxy: { type: 'socks5', host: '127.0.0.1', port: locked, username: 'pu', password: 'bad' } })).rejects.toThrow(/proxy_auth_failed/)
    await expect(connectSsh({ ...base(sshPort), proxy: { type: 'socks5', host: '127.0.0.1', port: locked } })).rejects.toThrow(/proxy_auth_failed/)
  }, 20000)

  it('SOCKS5 目标拒绝 → proxy_refused；代理连不上 → proxy_unreachable', async () => {
    const open = await fakeSocks5()
    const dead = await listen(createServer())
    servers.pop()!.close()   // 端口释放：拿一个确定没人监听的端口
    await expect(connectSsh({ ...base(dead), proxy: { type: 'socks5', host: '127.0.0.1', port: open } })).rejects.toThrow(/proxy_refused/)
    await expect(connectSsh({ ...base(22), proxy: { type: 'socks5', host: '127.0.0.1', port: dead } })).rejects.toThrow(/proxy_unreachable/)
  }, 20000)

  it('代理不回应 → proxy_timeout；IPv6 地址编码', async () => {
    const mute = await listen(createServer((c) => c.on('error', () => {})))
    await expect(connectViaProxy({ type: 'socks5', host: '127.0.0.1', port: mute }, 'h', 22, 300)).rejects.toThrow(/proxy_timeout/)
    expect(ipv6Bytes('::1').toString('hex')).toBe('00000000000000000000000000000001')
    expect(ipv6Bytes('fe80::1:2').toString('hex')).toBe('fe800000000000000000000000010002')
    expect(ipv6Bytes('::ffff:1.2.3.4').toString('hex')).toBe('00000000000000000000ffff01020304')
  })
})
