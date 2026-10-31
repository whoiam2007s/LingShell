// 主机面板：延迟探测 + 复制主机 IPC。
// 探测 = TCP 连主机的 SSH 端口计时，连上即断，不握手不认证（不会在服务器留登录记录）；经跳板机的主机直连测不出，标「经跳板」不测。
import { connect } from 'node:net'
import { tr, type HostSummary, type ProbeResult } from '@lingshell/shared'

export const PROBE_TIMEOUT_MS = 3000
const PROBE_CONCURRENCY = 8

/** TCP 连 host:port 的耗时（ms）；连不上 / 超时 → null */
export function probeTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const sock = connect({ host, port })
    const done = (ms: number | null) => { clearTimeout(timer); sock.destroy(); resolve(ms) }
    const timer = setTimeout(() => done(null), timeoutMs)
    sock.once('connect', () => done(Math.max(1, Math.round(performance.now() - t0))))
    sock.once('error', () => done(null))
  })
}

/** 批量探测（限并发）；不在列表里的 id 忽略 */
export async function probeHosts(hosts: HostSummary[], ids: string[], probe = probeTcp, viaProxy: (h: HostSummary) => boolean = () => false): Promise<Record<string, ProbeResult>> {
  const targets = hosts.filter((h) => ids.includes(h.id))
  const out: Record<string, ProbeResult> = {}
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const h = targets[next++]
      if (h.jumpHostId) { out[h.id] = { state: 'jump' }; continue }
      if (h.proxyCommand) { out[h.id] = { state: 'proxy' }; continue }   // ProxyCommand 接入：直连 SSH 端口测不出真实情况
      if (viaProxy(h)) { out[h.id] = { state: 'proxy' }; continue }   // 经代理出站：直连测出的不代表实际
      const ms = await probe(h.host, h.port)
      out[h.id] = ms === null ? { state: 'down' } : { state: 'ok', ms }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker))
  return out
}

export interface HostProbeDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  hosts(): HostSummary[]
  duplicate(id: string): HostSummary
  hasDefaultProxy(): boolean
}

export function registerHostProbe(d: HostProbeDeps): void {
  d.handle('hostPanel:probe', (_e, ids) => {
    if (!Array.isArray(ids)) throw new Error(tr('非法的主机列表'))
    const dflt = d.hasDefaultProxy()
    return probeHosts(d.hosts(), ids.filter((x): x is string => typeof x === 'string'), probeTcp, (h) => h.proxy ? h.proxy !== 'none' : dflt)
  })
  d.handle('hostPanel:duplicate', (_e, id) => {
    if (typeof id !== 'string' || !id) throw new Error(tr('非法的主机'))
    return d.duplicate(id)
  })
}
