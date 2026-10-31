// 趋势预测（纯逻辑见 shared/ops/trend.ts）：trend:get(主机[]) → 每台的磁盘写满 / 证书过期预测。
// 数据：主机体检档案（profiles，长期）+ 仪表盘采样环形缓冲（短期，只有 60 点），两者都用、分开标注依据。
import { hostTrend, type DashPoint, type HostProfile, type HostTrend } from '@lingshell/shared'
import type { ProfileStore } from './hostCheck.js'

export interface TrendDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  store: Pick<ProfileStore, 'list' | 'get'>
  samples(): Promise<Record<string, DashPoint[]>>   // 各主机仪表盘采样点（一次取全）
  now?: () => number
}

/** 一台主机的趋势：只读体检档案（快照不采磁盘） */
export async function trendOf(store: TrendDeps['store'], hostKey: string, points: DashPoint[], now: number): Promise<HostTrend> {
  const metas = (await store.list(hostKey)).filter((m) => m.type === 'check')
  const ps = (await Promise.all(metas.map((m) => store.get(hostKey, m.id)))).filter((p): p is HostProfile => !!p)
  return hostTrend(ps, points, now)
}

export function registerTrend(d: TrendDeps) {
  d.handle('trend:get', async (_e, keys) => {
    const list = Array.isArray(keys) ? [...new Set(keys.filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 200) : []
    const samples = await d.samples().catch(() => ({} as Record<string, DashPoint[]>))
    const now = (d.now ?? Date.now)()
    const out: Record<string, HostTrend> = {}
    for (const k of list) out[k] = await trendOf(d.store, k, samples[k] ?? [], now)
    return out
  })
}
