import { useEffect, useState } from 'react'
import type { ProbeResult } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 延迟探测：面板开着时每 60 秒测一轮（主进程只做 TCP 连接计时，不认证）；结果按模块缓存，重开面板先显示上次的。
// 缓存带一份主机指纹（id + 地址端口 + 跳板 / ProxyCommand）：主机改过地址后不会沿用旧的延迟 / 不可达状态。
export const PROBE_INTERVAL_MS = 60_000
let last: { at: number; sig: string; results: Record<string, ProbeResult> } = { at: 0, sig: '', results: {} }

type ProbeHost = { id: string; host: string; port: number; jumpHostId?: string; proxyCommand?: string }
const sigOf = (hosts: ProbeHost[]) => hosts.map((h) => `${h.id}|${h.host}|${h.port}|${h.jumpHostId ? 'j' : ''}|${h.proxyCommand ? 'p' : ''}`).join(',')

export function useHostProbe(hosts: ProbeHost[], enabled: boolean): Record<string, ProbeResult> {
  const [results, setResults] = useState(last.results)
  const ids = hosts.map((h) => h.id)
  const key = ids.join(',')
  const sig = sigOf(hosts)
  useEffect(() => {
    if (!enabled || !ids.length) return
    let alive = true
    const run = () => client.hostPanel.probe(ids).then((r) => {
      last = { at: Date.now(), sig, results: r }
      if (alive) setResults(r)
    }).catch(() => {})
    // 上次结果还新鲜（同一批主机、地址没变）就等到期再测，免得反复开关面板时一直连
    const wait = last.sig === sig && ids.every((id) => last.results[id]) ? Math.max(0, last.at + PROBE_INTERVAL_MS - Date.now()) : 0
    let timer = setTimeout(function tick() { void run(); timer = setTimeout(tick, PROBE_INTERVAL_MS) }, wait)
    return () => { alive = false; clearTimeout(timer) }
  }, [key, sig, enabled])
  return enabled ? results : {}
}
