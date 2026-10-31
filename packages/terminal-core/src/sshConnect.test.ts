import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer, connect as netConnect, type AddressInfo } from 'node:net'

// 公钥 blob：uint32 长度 + 类型名 + uint32 长度 + 数据
const str = (s: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, s.length]), s])
const blob = (type: string, data: string) => Buffer.concat([str(Buffer.from(type)), str(Buffer.from(data))])
// 每台假服务器的主机公钥（默认 ed25519，数据=主机名）；测试可改它模拟换钥/中间人
const serverKeys = new Map<string, Buffer>()
const keyOf = (host: string) => serverKeys.get(host) ?? blob('ssh-ed25519', host)
const verified: string[] = []   // 指纹校验顺序（主机名）

// 假 ssh2：先做主机指纹校验（hostVerifier 返回 false → 握手失败），再：host 以 bad 开头 → 认证失败；forwardOut 到 nofwd → 拒绝；否则给一个回显流（PassThrough）
const clients: FakeClient[] = []
class FakeClient extends EventEmitter {
  cfg: Record<string, unknown> = {}
  ended = false
  fwd: unknown[][] = []
  constructor() { super(); clients.push(this) }
  connect(cfg: Record<string, unknown>) {
    this.cfg = cfg
    setImmediate(() => {
      const host = String(cfg.host)
      verified.push(host)
      const hv = cfg.hostVerifier as ((k: Buffer) => boolean) | undefined
      if (hv && !hv(keyOf(host))) return this.emit('error', new Error('Host denied (verification failed)'))
      if (host.startsWith('bad')) this.emit('error', new Error('All configured authentication methods failed'))
      else this.emit('ready')
    })
  }
  forwardOut(...a: unknown[]) {
    this.fwd.push(a.slice(0, 4))
    const cb = a[4] as (e?: Error, s?: unknown) => void
    if (a[2] === 'nofwd') cb(new Error('(SSH) Channel open failure: Connection refused'))
    else cb(undefined, new PassThrough())
  }
  end() { if (!this.ended) { this.ended = true; this.emit('close') } }
}

let mod: typeof import('./sshConnect.js')
let connectSsh: typeof import('./sshConnect.js').connectSsh
let PFM: typeof import('./PortForwardManager.js').PortForwardManager
// 默认策略：所有假服务器的当前钥匙都已知（老用例不涉及指纹）
const trustAll = () => mod.setHostKeyPolicy({
  lookup: (hp) => ({ keyType: 'ssh-ed25519', fingerprint: mod.sshFingerprint(keyOf(hp.replace(/:\d+$/, ''))) }),
  remember: () => {},
})
beforeAll(async () => {
  vi.resetModules()
  vi.doMock('ssh2', () => ({ Client: FakeClient }))
  mod = await import('./sshConnect.js')
  connectSsh = mod.connectSsh
  PFM = (await import('./PortForwardManager.js')).PortForwardManager
  trustAll()
})
afterAll(() => { vi.doUnmock('ssh2'); vi.resetModules() })

const o = (host: string, extra: object = {}) => ({ host, port: 22, username: 'u', label: host, ...extra })

describe('connectSsh', () => {
  it('无跳板：单连接，错误码不变', async () => {
    clients.length = 0
    const c = await connectSsh(o('t'))
    expect(clients).toHaveLength(1)
    expect(clients[0].cfg.sock).toBeUndefined()
    c.close()
    await expect(connectSsh(o('bad'))).rejects.toThrow(/^ssh_auth_failed$/)
  })

  it('经两级跳板：逐跳 forwardOut + sock 串起；close 断全部', async () => {
    clients.length = 0
    const c = await connectSsh(o('t', { port: 2222, jump: o('j1', { jump: o('j2') }) }))
    const [j2, j1, t] = clients
    expect(j2.cfg.host).toBe('j2')
    expect(j2.fwd[0]).toEqual(['127.0.0.1', 0, 'j1', 22])
    expect(j1.cfg.sock).toBeInstanceOf(PassThrough)
    expect(j1.fwd[0]).toEqual(['127.0.0.1', 0, 't', 2222])
    expect(t.cfg.sock).toBeInstanceOf(PassThrough)
    c.close()
    expect(clients.every((x) => x.ended)).toBe(true)
  })

  it('错误标明哪一跳失败，且已建立的跳板被断开', async () => {
    clients.length = 0
    await expect(connectSsh(o('t', { jump: o('bad-j') }))).rejects.toThrow('跳板机「bad-j」: ssh_auth_failed')
    await expect(connectSsh(o('t', { jump: o('j1', { jump: o('bad-j2') }) }))).rejects.toThrow('跳板机「bad-j2」: ssh_auth_failed')
    clients.length = 0
    await expect(connectSsh(o('bad-t', { jump: o('j') }))).rejects.toThrow('目标主机「bad-t」: ssh_auth_failed')
    expect(clients[0].ended).toBe(true)
    clients.length = 0
    await expect(connectSsh(o('nofwd', { jump: o('j') }))).rejects.toThrow(/跳板机「j」无法转发到 nofwd:22/)
    expect(clients[0].ended).toBe(true)
  })

  it('agent 认证：每跳各自传 agent，不开 agentForward；认证失败带 agent 提示', async () => {
    clients.length = 0
    const A = '\\\\.\\pipe\\openssh-ssh-agent'
    const c = await connectSsh(o('t', { agent: A, jump: o('j', { password: 'pw' }) }))
    const [j, t] = clients
    expect(j.cfg).toMatchObject({ password: 'pw', agent: undefined })
    expect(t.cfg).toMatchObject({ agent: A })
    expect(clients.every((x) => !x.cfg.agentForward)).toBe(true)
    c.close()
    await expect(connectSsh(o('bad', { agent: A }))).rejects.toThrow(/^ssh_auth_failed: ssh-agent 中没有被服务器接受的密钥/)
    await expect(connectSsh(o('t', { jump: o('bad-j', { agent: A }) }))).rejects.toThrow(/^跳板机「bad-j」: ssh_auth_failed: ssh-agent/)
  })
})

describe('连接高级选项透传', () => {
  it('心跳：主机配了用主机的（0 = 关），否则用调用方默认；超时；压缩与指纹算法合并；各跳各用各的', async () => {
    clients.length = 0
    const c = await connectSsh(o('t', { keepaliveSec: 0, readyTimeoutMs: 45000, compress: true, jump: o('j') }), { keepaliveInterval: 15000, keepaliveCountMax: 3 })
    const [j, t] = clients
    expect(j.cfg).toMatchObject({ keepaliveInterval: 15000, keepaliveCountMax: 3, readyTimeout: 20000 })
    expect(j.cfg.algorithms).toEqual({ serverHostKey: { remove: ['ssh-ed25519'], prepend: ['ssh-ed25519'], append: [] } })
    expect(t.cfg).toMatchObject({ keepaliveInterval: 0, keepaliveCountMax: 3, readyTimeout: 45000 })
    expect(t.cfg.algorithms).toMatchObject({ compress: ['zlib@openssh.com', 'zlib', 'none'], serverHostKey: { prepend: ['ssh-ed25519'] } })
    expect(t.cfg.agentForward).toBeUndefined()
    c.close()
    clients.length = 0
    ;(await connectSsh(o('t', { keepaliveSec: 30 }))).close()
    expect(clients[0].cfg.keepaliveInterval).toBe(30000)
  })
})

describe('mapSshError', () => {
  it('agent 通信失败 → ssh_agent_failed', () => {
    const e = Object.assign(new Error('Failed to connect to agent'), { level: 'agent' })
    expect(mod.mapSshError(e).message).toMatch(/^ssh_agent_failed: .*Failed to connect to agent/)
    expect(mod.mapSshError(new Error('All configured authentication methods failed')).message).toBe('ssh_auth_failed')
  })
})

describe('主机指纹校验', () => {
  type Info = import('@lingshell/shared').HostKeyInfo
  const mem = (prompt?: (i: Info) => Promise<boolean>) => {
    const db = new Map<string, { keyType: string; fingerprint: string }>()
    const prompts: Info[] = [], mismatches: Info[] = []
    mod.setHostKeyPolicy({
      lookup: (hp) => db.get(hp),
      remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) },
      prompt: prompt && ((i) => { prompts.push(i); return prompt(i) }),
      onMismatch: (i) => { mismatches.push(i) },
    })
    return { db, prompts, mismatches }
  }
  const fp = (host: string) => mod.sshFingerprint(keyOf(host))
  beforeEach(() => { clients.length = 0; verified.length = 0 })
  afterEach(() => { serverKeys.clear(); trustAll() })

  it('指纹格式与 ssh-keygen -lf 一致', () => {
    const k = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIPuPPNR4cf2RJdo1h5OY6qMJ6JOXz9Qm3mcaC4ceTGlV', 'base64')
    expect(mod.sshFingerprint(k)).toBe('SHA256:UiG9tQ7lJVMbwewNM1yjoID5j9DG3/na8u+4OskMpDo')
    expect(mod.keyTypeOf(k)).toBe('ssh-ed25519')
    expect(mod.hostPortOf(' Web.Example.COM ', 2222)).toBe('web.example.com:2222')
  })

  it('已知且一致 → 直接连上，不问；优先协商记录的钥匙类型', async () => {
    const p = mem(async () => true)
    p.db.set('t:22', { keyType: 'ssh-ed25519', fingerprint: fp('t') })
    ;(await connectSsh(o('t'))).close()
    expect(p.prompts).toHaveLength(0)
    expect(clients).toHaveLength(1)
    expect(clients[0].cfg.algorithms).toEqual({ serverHostKey: { remove: ['ssh-ed25519'], prepend: ['ssh-ed25519'], append: [] } })
  })

  it('不符 → host_key_mismatch，不问、不改记录，通知告警', async () => {
    const p = mem(async () => true)
    p.db.set('t:22', { keyType: 'ssh-ed25519', fingerprint: fp('t') })
    serverKeys.set('t', blob('ssh-ed25519', 'evil'))
    await expect(connectSsh(o('t'))).rejects.toThrow(/^host_key_mismatch: t:22 .*已记录 SHA256:.*本次 ssh-ed25519 SHA256:/)
    expect(p.prompts).toHaveLength(0)
    expect(p.db.get('t:22')?.fingerprint).toBe(mod.sshFingerprint(blob('ssh-ed25519', 't')))
    expect(p.mismatches).toEqual([{ hostPort: 't:22', label: 't', role: '目标主机', keyType: 'ssh-ed25519', fingerprint: fp('t'), expected: mod.sshFingerprint(blob('ssh-ed25519', 't')) }])
    expect(clients[0].ended).toBe(true)
  })

  it('未知 + 用户信任 → 记住并重连；之后不再问', async () => {
    const p = mem(async () => true)
    ;(await connectSsh(o('t'))).close()
    expect(p.prompts.map((i) => [i.hostPort, i.role, i.keyType, i.fingerprint])).toEqual([['t:22', '目标主机', 'ssh-ed25519', fp('t')]])
    expect(p.db.get('t:22')).toEqual({ keyType: 'ssh-ed25519', fingerprint: fp('t') })
    expect(clients).toHaveLength(2)   // 首次握手被拒，确认后重连
    ;(await connectSsh(o('t'))).close()
    expect(p.prompts).toHaveLength(1)
  })

  it('未知 + 用户拒绝 → host_key_rejected，不记录', async () => {
    const p = mem(async () => false)
    await expect(connectSsh(o('t'))).rejects.toThrow(/^host_key_rejected: t:22/)
    expect(p.db.size).toBe(0)
    expect(clients).toHaveLength(1)
  })

  it('无确认者 / noHostKeyPrompt（无人值守）→ host_key_unknown，绝不弹', async () => {
    mem()
    await expect(connectSsh(o('t'))).rejects.toThrow(/^host_key_unknown: .*先手动连接一次以确认指纹/)
    const p = mem(async () => true)
    await expect(connectSsh(o('t', { noHostKeyPrompt: true, jump: o('j') }))).rejects.toThrow(/^跳板机「j」: host_key_unknown/)
    expect(p.prompts).toHaveLength(0)
    mod.setHostKeyPolicy(undefined)
    await expect(connectSsh(o('t'))).rejects.toThrow(/host_key_unknown/)   // 未注入策略：失败即关闭
  })

  it('跳板链逐跳校验：先跳板后目标；跳板不符则不再碰目标', async () => {
    const p = mem(async () => true)
    ;(await connectSsh(o('t', { jump: o('j1', { jump: o('j2') }) }))).close()
    expect(p.prompts.map((i) => `${i.role}:${i.hostPort}`)).toEqual(['跳板机:j2:22', '跳板机:j1:22', '目标主机:t:22'])
    verified.length = 0
    serverKeys.set('j1', blob('ssh-ed25519', 'evil'))
    await expect(connectSsh(o('t', { jump: o('j1', { jump: o('j2') }) }))).rejects.toThrow(/^跳板机「j1」: host_key_mismatch/)
    expect(verified).toEqual(['j2', 'j1'])
    expect(p.mismatches[0].role).toBe('跳板机')
  })

  it('同一主机并发首连只问一次', async () => {
    let release!: (v: boolean) => void
    const p = mem(() => new Promise((r) => { release = r }))
    const both = Promise.all([connectSsh(o('t')), connectSsh(o('t'))])
    await new Promise((r) => setTimeout(r, 20))
    release(true)
    for (const c of await both) c.close()
    expect(p.prompts).toHaveLength(1)
  })
})

describe('PortForwardManager', () => {
  const freePort = () => new Promise<number>((r) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)) })
  })

  it('转发连通（假远端回显）、stop 后端口释放', async () => {
    clients.length = 0
    const m = new PFM()
    const localPort = await freePort()
    const info = await m.start({ hostId: 'h', localPort, remoteHost: '127.0.0.1', remotePort: 3306 }, () => o('t'), 'T')
    expect(m.list()).toEqual([info])
    const reply = await new Promise<string>((resolve) => {
      const s = netConnect(localPort, '127.0.0.1', () => s.write('ping'))
      s.on('data', (d) => { resolve(d.toString()); s.destroy() })
    })
    expect(reply).toBe('ping')
    expect(clients[0].fwd[0].slice(2)).toEqual(['127.0.0.1', 3306])
    m.stopAll()
    expect(m.list()).toEqual([])
    expect(clients[0].ended).toBe(true)
    await expect(freePort()).resolves.toBeGreaterThan(0)
  })

  it('动态转发：SOCKS5 CONNECT 经 forwardOut 到客户端指定目标；非法 bindHost 拒绝', async () => {
    clients.length = 0
    const m = new PFM()
    const localPort = await freePort()
    const info = await m.start({ hostId: 'h', kind: 'dynamic', localPort }, () => o('t'), 'T')
    expect(info).toMatchObject({ kind: 'dynamic', localPort, hostLabel: 'T' })
    const req = Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, 8]), Buffer.from('intranet'), Buffer.from([0, 80])])
    const got = await new Promise<Buffer>((resolve) => {
      const bufs: Buffer[] = []
      const s = netConnect(localPort, '127.0.0.1', () => s.write(Buffer.concat([req, Buffer.from('hi')])))
      s.on('data', (d) => { bufs.push(d); const b = Buffer.concat(bufs); if (b.length >= 14) { resolve(b); s.destroy() } })
    })
    expect(got.subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 0]))
    expect(got.subarray(12).toString()).toBe('hi')
    expect(clients[0].fwd[0].slice(2)).toEqual(['intranet', 80])
    m.stopAll()
    await expect(m.start({ hostId: 'h', kind: 'dynamic', localPort, bindHost: '1.2.3.4' as '0.0.0.0' }, () => o('t'), 'T')).rejects.toThrow(/^bad_bind_host/)
  })

  it('本地端口被占用 → local_port_in_use，不建 SSH 连接', async () => {
    clients.length = 0
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const port = (busy.address() as AddressInfo).port
    await expect(new PFM().start({ hostId: 'h', localPort: port, remoteHost: 'x', remotePort: 1 }, () => o('t'), 'T'))
      .rejects.toThrow(/^local_port_in_use/)
    expect(clients).toHaveLength(0)
    busy.close()
  })

  describe('断线自动恢复', () => {
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
      expect(ok()).toBe(true)
    }
    const listenOn = (port: number) => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const s = createServer().once('error', reject).listen(port, '127.0.0.1', () => resolve(s))
    })
    const echo = (port: number) => new Promise<string>((resolve) => {
      const s = netConnect(port, '127.0.0.1', () => s.write('ping'))
      s.on('data', (d) => { resolve(d.toString()); s.destroy() })
    })
    let target = 't'
    const startOne = async (m: InstanceType<typeof PFM>) => {
      clients.length = 0
      target = 't'
      const localPort = await freePort()
      const info = await m.start({ hostId: 'h', localPort, remoteHost: 'x', remotePort: 1 }, () => o(target), 'T')
      return { localPort, id: info.id, st: () => m.list()[0]?.status }
    }

    it('断开 → 关监听、退避重试 → 恢复后重新监听同一端口', async () => {
      const changed: string[] = []
      const m = new PFM((id) => changed.push(id), (n) => (n <= 5 ? 10 : null))
      const { localPort, id, st } = await startOne(m)
      target = 'bad'                     // 前几次重连失败
      clients[0].end()
      expect(st()).toMatchObject({ state: 'reconnecting', attempt: 1 })
      expect(changed).toContain(id)
      ;(await listenOn(localPort)).close()   // 断线期间端口已释放
      await until(() => st()?.state === 'reconnecting' && (st() as { attempt: number }).attempt >= 2)
      target = 't'
      await until(() => st()?.state === 'running')
      expect(await echo(localPort)).toBe('ping')
      m.stopAll()
    })

    it('次数用完 → 已停止并说明原因，端口释放', async () => {
      const m = new PFM(undefined, (n) => (n <= 2 ? 5 : null))
      const { localPort, st } = await startOne(m)
      target = 'bad'
      clients[0].end()
      await until(() => st()?.state === 'stopped')
      expect(st()).toEqual({ state: 'stopped', reason: '重连 2 次均失败' })
      ;(await listenOn(localPort)).close()
      m.stopAll()
    })

    it('用户停止 → 取消待重连，不再连', async () => {
      const m = new PFM(undefined, () => 30)
      const { id } = await startOne(m)
      clients[0].end()
      m.stop(id)
      await new Promise((r) => setTimeout(r, 80))
      expect(clients).toHaveLength(1)
      expect(m.list()).toEqual([])
    })

    it('重新监听时端口被占 → 停止（不连 SSH）；释放后立即重试恢复', async () => {
      const m = new PFM(undefined, () => 30)
      const { localPort, id, st } = await startOne(m)
      clients[0].end()
      const busy = await listenOn(localPort)
      await until(() => st()?.state === 'stopped')
      expect((st() as { reason: string }).reason).toMatch(/已被占用/)
      expect(clients).toHaveLength(1)
      await new Promise<void>((r) => busy.close(() => r()))
      m.retry(id)
      await until(() => st()?.state === 'running')
      m.stopAll()
    })
  })
})
