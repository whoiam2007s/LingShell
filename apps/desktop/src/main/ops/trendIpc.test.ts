import { it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DashPoint, HostProfile, HostTrend } from '@lingshell/shared'
import { ProfileStore } from './hostCheck.js'
import { registerTrend } from './trendIpc.js'

const dir = mkdtempSync(join(tmpdir(), 'lingshell-trend-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 17, 12)

it('trend:get：读体检档案（快照不算）+ 仪表盘采样，各主机分开算；没有数据的主机给空结果', async () => {
  const store = new ProfileStore(dir)
  const p = (daysAgo: number, pct: number, type: HostProfile['type'] = 'check'): HostProfile => ({
    version: 1, type, hostKey: 'h1', at: new Date(NOW - daysAgo * DAY).toISOString(),
    disks: [{ mount: '/data', fs: '/dev/sdb', sizeKb: 1, usedPct: pct }],
    ...(daysAgo === 0 ? { certs: [{ path: '/etc/nginx/ssl/a.pem', notAfter: new Date(NOW + 23 * DAY + 60_000).toISOString() }] } : {}),
  })
  for (const [d, v] of [[6, 70], [4, 74], [2, 78], [0, 82]] as const) await store.save(p(d, v), new Map())
  await store.save(p(1, 99, 'snapshot'), new Map())
  const pts: DashPoint[] = Array.from({ length: 20 }, (_, i) => ({ at: NOW - (19 - i) * 60_000, disk: 95 + i * 0.02, diskMount: '/' }))
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  registerTrend({ handle: (ch, fn) => { hs.set(ch, fn) }, store, samples: async () => ({ h1: pts }), now: () => NOW })
  const r = await hs.get('trend:get')!({}, ['h1', 'h2', 'h1', 3]) as Record<string, HostTrend>
  expect(Object.keys(r)).toEqual(['h1', 'h2'])
  expect(r.h1.profiles).toBe(4)
  expect(r.h1.disks).toHaveLength(1)
  expect(r.h1.disks[0]).toMatchObject({ mount: '/data', basis: 'profiles' })
  expect(Math.round(r.h1.disks[0].days)).toBe(9)
  expect(r.h1.certs).toEqual([{ path: '/etc/nginx/ssl/a.pem', notAfter: expect.any(String), days: 23 }])
  expect(r.h1.samples).toMatchObject({ mount: '/', basis: 'samples' })
  expect(r.h2).toEqual({ disks: [], certs: [], profiles: 0 })
})
