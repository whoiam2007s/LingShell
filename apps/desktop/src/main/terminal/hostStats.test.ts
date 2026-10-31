import { describe, it, expect } from 'vitest'
import { DEFAULT_SYSTEM_SETTINGS, type HostStats } from '@lingshell/shared'
import { HostStatsScheduler, localIoRates, localIoSnap, type StatsTarget, type StatsUpdate } from './hostStats.js'

const T = (id: string, over: Partial<StatsTarget> = {}): StatsTarget => ({ id, hostKey: `h_${id}`, type: 'ssh', os: 'linux', running: true, prod: false, ...over })
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(over: { targets?: StatsTarget[]; enabled?: boolean; prod?: boolean; fail?: boolean; hang?: boolean } = {}) {
  let now = 0
  const cfg = { enabled: over.enabled ?? true, intervalSec: 10, prod: over.prod ?? false }
  let targets = over.targets ?? [T('a')]
  let paused = false
  const calls: string[] = []
  const emits: [string, StatsUpdate][] = []
  let release: (() => void) | undefined
  const s = new HostStatsScheduler({
    settings: () => cfg,
    targets: () => targets,
    collect: (t) => {
      calls.push(t.id)
      if (over.hang) return new Promise<HostStats>((r) => { release = () => r({ at: now }) })
      return over.fail ? Promise.reject(new Error('exec_timeout')) : Promise.resolve({ at: now, cpuPct: 1 })
    },
    emit: (id, u) => emits.push([id, u]),
    paused: () => paused,
    now: () => now,
  })
  return {
    s, cfg, calls, emits,
    setNow: (n: number) => { now = n },
    setTargets: (t: StatsTarget[]) => { targets = t },
    setPaused: (p: boolean) => { paused = p },
    release: () => release?.(),
  }
}

describe('HostStatsScheduler', () => {
  it('默认关：系统设置默认值不采集', async () => {
    expect(DEFAULT_SYSTEM_SETTINGS.hostStats).toBe(false)
    expect(DEFAULT_SYSTEM_SETTINGS.hostStatsProd).toBe(false)
    const h = setup({ enabled: DEFAULT_SYSTEM_SETTINGS.hostStats })
    h.s.watch(['a']); await h.s.tick()
    expect(h.calls).toEqual([])
  })

  it('只采可见终端；同主机多个可见终端只采一次、结果发给每个', async () => {
    const h = setup({ targets: [T('a'), T('b'), T('c', { hostKey: 'h_a' })] })
    h.s.watch(['a', 'c']); await flush()
    expect(h.calls).toEqual(['a'])
    expect(h.emits.map(([id]) => id).sort()).toEqual(['a', 'c'])
  })

  it('每主机最多一个在途；间隔到了才采下一次', async () => {
    const h = setup({ hang: true })
    h.s.watch(['a'])
    h.setNow(60_000); await h.s.tick(); await h.s.tick()
    expect(h.calls).toEqual(['a'])          // 还在途，不叠加
    h.release(); await flush()
    h.setNow(65_000); await h.s.tick()
    expect(h.calls).toEqual(['a'])          // 距完成不到 10s
    h.setNow(70_000); h.s.tick(); await flush()
    expect(h.calls).toEqual(['a', 'a'])
    h.release()
  })

  it('失败：发 error（不清旧数据）并指数退避 20s → 40s', async () => {
    const h = setup({ fail: true })
    h.s.watch(['a']); await flush()
    expect(h.emits).toEqual([['a', { error: 'exec_timeout' }]])
    h.setNow(19_999); await h.s.tick()
    expect(h.calls.length).toBe(1)
    h.setNow(20_000); await h.s.tick()
    expect(h.calls.length).toBe(2)
    h.setNow(59_999); await h.s.tick()
    expect(h.calls.length).toBe(2)
    h.setNow(60_000); await h.s.tick()
    expect(h.calls.length).toBe(3)
  })

  it('生产主机：默认不采；开「生产主机也采集」后采，间隔 ×3', async () => {
    const off = setup({ targets: [T('p', { prod: true })] })
    off.s.watch(['p']); await off.s.tick()
    expect(off.calls).toEqual([])
    const on = setup({ targets: [T('p', { prod: true })], prod: true })
    on.s.watch(['p']); await flush()
    on.setNow(29_999); await on.s.tick()
    expect(on.calls.length).toBe(1)
    on.setNow(30_000); await on.s.tick()
    expect(on.calls.length).toBe(2)
  })

  it('锁定时暂停；断线 / 关掉采集 → 清空一次', async () => {
    const h = setup()
    h.setPaused(true); h.s.watch(['a']); await h.s.tick()
    expect(h.calls).toEqual([])
    h.setPaused(false); await h.s.tick()
    expect(h.calls).toEqual(['a'])
    h.setTargets([T('a', { running: false })]); await h.s.tick(); await h.s.tick()
    expect(h.emits.filter(([, u]) => !u.stats && !u.error && !u.unsupported)).toEqual([['a', {}]])
  })

  it('Windows / 未知系统的 SSH：只发一次「不支持」，不执行命令；本地终端照采', async () => {
    const h = setup({ targets: [T('w', { os: 'windows' }), T('u', { os: undefined }), T('l', { type: 'local', os: 'windows', hostKey: 'local' })] })
    h.s.watch(['w', 'u', 'l']); await flush(); await h.s.tick()
    expect(h.calls).toEqual(['l'])
    expect(h.emits.filter(([, u]) => u.unsupported)).toEqual([['w', { unsupported: true }], ['u', { unsupported: true }]])
  })
})

describe('本机网络 / 磁盘 IO', () => {
  it('Windows 的 netstat 合计只出总速率，不当网卡列出', () => {
    const r = localIoRates({ t: 1, net: { '*': { rx: 0, tx: 0 } } }, { t: 1.5, net: { '*': { rx: 1000, tx: 500 } } })
    expect(r).toEqual({ netRx: 2000, netTx: 1000 })
  })
  it('本机真实采样：Windows / Linux 能取到网络计数，其它系统只有时间戳', async () => {
    const s = await localIoSnap()
    expect(s.t).toBeGreaterThan(0)
    if (process.platform === 'win32' || process.platform === 'linux') expect(s.net).toBeDefined()
    expect((await localIoSnap('aix')).net).toBeUndefined()
  })
})
