import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import type { HostSummary } from '@lingshell/shared'
import { probeTcp, probeHosts } from './hostProbe.js'

// 本机回环：一个监听的端口 + 一个刚关掉的端口（不可达）
let servers: Server[] = []
afterEach(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); servers = [] })
const listen = () => new Promise<number>((resolve) => {
  const s = createServer((sock) => sock.destroy())
  servers.push(s)
  s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port))
})
const closedPort = async () => {
  const s = createServer()
  const port = await new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)))
  await new Promise((r) => s.close(r))
  return port
}
const host = (id: string, port: number, extra: Partial<HostSummary> = {}): HostSummary => ({ id, label: id, host: '127.0.0.1', port, username: 'u', authType: 'password', ...extra })

describe('hostProbe', () => {
  it('probeTcp：监听的端口返回耗时，关掉的端口返回 null', async () => {
    const up = await listen()
    const ms = await probeTcp('127.0.0.1', up)
    expect(ms).toBeGreaterThanOrEqual(1)
    expect(await probeTcp('127.0.0.1', await closedPort())).toBeNull()
  })
  // 「不可路由地址超时返回 null」依赖本机网络的真实路由情况，放在 hostProbe.real.test.ts
  it('probeHosts：ok / down / 经跳板不测 / 不在列表忽略', async () => {
    const up = await listen(), down = await closedPort()
    const probed: string[] = []
    const r = await probeHosts(
      [host('a', up), host('b', down), host('c', up, { jumpHostId: 'a' }), host('d', up)],
      ['a', 'b', 'c', 'x'],
      (h, p) => { probed.push(`${h}:${p}`); return probeTcp(h, p) },
    )
    expect(r.a.state).toBe('ok')
    expect(r.b).toEqual({ state: 'down' })
    expect(r.c).toEqual({ state: 'jump' })
    expect(r.d).toBeUndefined()
    expect(probed).toHaveLength(2)   // 跳板主机没去连
  })
  it('probeHosts：经代理的主机不直连测', async () => {
    const probed: string[] = []
    const r = await probeHosts([host('a', 1)], ['a'], async (h) => { probed.push(h); return 5 }, () => true)
    expect(r.a).toEqual({ state: 'proxy' })
    expect(probed).toEqual([])
  })
  it('probeHosts：ProxyCommand 的主机也不直连测（直连 SSH 端口的结果不算数）', async () => {
    const probed: string[] = []
    const r = await probeHosts([host('p', 22, { proxyCommand: 'cloudflared access ssh --hostname %h' }), host('b', 22)], ['p', 'b'], async (h) => { probed.push(h); return 5 }, () => false)
    expect(r.p).toEqual({ state: 'proxy' })
    expect(r.b).toEqual({ state: 'ok', ms: 5 })
    expect(probed).toEqual(['127.0.0.1'])
  })
})
