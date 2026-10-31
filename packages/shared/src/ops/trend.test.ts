import { describe, it, expect } from 'vitest'
import { linearFit, denoise, forecastFull, forecastFromProfiles, forecastFromSamples, certForecasts, certForecastText, hostTrend, trendLevel, fullShort, basisText, diskForecastText, PROFILE_FORECAST, SAMPLE_FORECAST } from './trend.js'
import type { HostProfile } from './hostProfile.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 17)
const prof = (daysAgo: number, disks: [string, number][], extra: Partial<HostProfile> = {}): HostProfile =>
  ({ version: 1, type: 'check', hostKey: 'h', at: new Date(NOW - daysAgo * DAY).toISOString(), disks: disks.map(([mount, usedPct]) => ({ mount, fs: '/dev/x', sizeKb: 1, usedPct })), ...extra })

describe('linearFit', () => {
  it('完美直线：斜率 / 截距 / r2=1；点不足或时间相同返回 undefined', () => {
    const f = linearFit([{ at: 0, v: 10 }, { at: 1, v: 12 }, { at: 2, v: 14 }])!
    expect(f.slope).toBeCloseTo(2)
    expect(f.intercept).toBeCloseTo(10)
    expect(f.r2).toBeCloseTo(1)
    expect(linearFit([{ at: 0, v: 1 }])).toBeUndefined()
    expect(linearFit([{ at: 5, v: 1 }, { at: 5, v: 2 }])).toBeUndefined()
  })
  it('epoch 毫秒级时间不丢精度', () => {
    const f = linearFit([0, 1, 2, 3].map((i) => ({ at: NOW + i * DAY, v: 50 + i })))!
    expect(f.slope * DAY).toBeCloseTo(1, 6)
  })
})

describe('denoise', () => {
  it('从最后一次明显下降（清理）之后算起；同一时刻取后者；去孤立尖刺', () => {
    expect(denoise([{ at: 1, v: 80 }, { at: 2, v: 90 }, { at: 3, v: 40 }, { at: 4, v: 42 }]).map((p) => p.v)).toEqual([40, 42])
    expect(denoise([{ at: 1, v: 50 }, { at: 1, v: 51 }, { at: 2, v: 52 }]).map((p) => p.v)).toEqual([51, 52])
    expect(denoise([{ at: 1, v: 50 }, { at: 2, v: 70 }, { at: 3, v: 51 }, { at: 4, v: 52 }]).map((p) => p.v)).toEqual([50, 51, 52])
  })
})

describe('forecastFull', () => {
  const o = { ...PROFILE_FORECAST, now: NOW }
  it('每天 +2%、当前 82% → 约 9 天写满', () => {
    const f = forecastFull([6, 4, 2, 0].map((d, i) => ({ at: NOW - d * DAY, v: 70 + i * 4 })), o)!
    expect(f.perDay).toBeCloseTo(2)
    expect(f.days).toBeCloseTo(9)
    expect(f.points).toBe(4)
  })
  it('数据不足判定：点数不够 / 跨度太短 / 不涨 / 太乱 / 超过上限都不给', () => {
    expect(forecastFull([{ at: NOW - DAY, v: 50 }, { at: NOW, v: 60 }], o)).toBeUndefined()                       // 2 点
    expect(forecastFull([0, 1, 2].map((i) => ({ at: NOW - i * 3_600_000, v: 50 + i })), o)).toBeUndefined()     // 2 小时
    expect(forecastFull([0, 1, 2, 3].map((i) => ({ at: NOW - i * DAY, v: 60 })), o)).toBeUndefined()            // 不涨
    expect(forecastFull([0, 1, 2, 3].map((i) => ({ at: NOW - i * DAY, v: 60 + i })), o)).toBeUndefined()        // 在降
    expect(forecastFull([[3, 50], [2, 54], [1, 50], [0, 54.2]].map(([d, v]) => ({ at: NOW - d * DAY, v })), o)).toBeUndefined()   // 来回跳
    expect(forecastFull([0, 1, 2, 3].map((i) => ({ at: NOW - (3 - i) * DAY, v: 10 + i * 0.1 })), o)).toBeUndefined()  // 900 天
  })
  it('清理过磁盘：只按清理后的那段算', () => {
    const pts = [[10, 90], [8, 95], [6, 40], [4, 44], [2, 48], [0, 52]].map(([d, v]) => ({ at: NOW - d * DAY, v }))
    expect(forecastFull(pts, o)!.days).toBeCloseTo(24)
  })
})

describe('forecastFromProfiles / Samples / certs / hostTrend', () => {
  it('档案：按挂载点外推、优先近 7 天、只用体检（快照不算），按天数排序', () => {
    const ps = [prof(20, [['/data', 10]]), prof(6, [['/data', 70], ['/', 30]]), prof(4, [['/data', 74], ['/', 30]]), prof(2, [['/data', 78], ['/', 30]]), prof(0, [['/data', 82], ['/', 30]]),
      prof(1, [['/data', 99]], { type: 'snapshot' })]
    const f = forecastFromProfiles(ps, NOW)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ mount: '/data', basis: 'profiles', points: 4 })
    expect(f[0].days).toBeCloseTo(9)
    expect(diskForecastText(f[0])).toBe('/data 按体检档案的增长，约 9 天后写满')
  })
  it('近 7 天点不够时用全部档案；最新体检里没有的挂载点不再预测', () => {
    const f = forecastFromProfiles([prof(30, [['/', 40]]), prof(20, [['/', 50]]), prof(1, [['/', 69]])], NOW)
    expect(f[0].points).toBe(3)
    const g = forecastFromProfiles([prof(6, [['/old', 10], ['/', 30]]), prof(4, [['/old', 50], ['/', 40]]), prof(2, [['/old', 60], ['/', 50]]), prof(0, [['/', 62]])], NOW)
    expect(g.map((x) => x.mount)).toEqual(['/'])
  })
  it('采样：只看与最新点同一挂载点的，点数 / 跨度不足不给', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ at: NOW - (19 - i) * 60_000, disk: 90 + i * 0.01, diskMount: '/' }))
    const f = forecastFromSamples(pts, NOW)!
    expect(f).toMatchObject({ mount: '/', basis: 'samples' })
    expect(f.days).toBeGreaterThan(0)
    expect(basisText(f)).toMatch(/^依据最近 19 分钟采样（短期/)
    expect(forecastFromSamples(pts.slice(-5), NOW)).toBeUndefined()
    expect(forecastFromSamples([...pts.slice(0, 15), ...pts.slice(15).map((p) => ({ ...p, diskMount: '/data' }))], NOW)).toBeUndefined()
    expect(forecastFromSamples([], NOW)).toBeUndefined()
    expect(SAMPLE_FORECAST.minPoints).toBe(10)
  })
  it('证书：直接按到期日算（含已过期），无到期日 / 到期日解析不了的跳过', () => {
    const c = certForecasts([{ path: '/a', notAfter: new Date(NOW + 23 * DAY + 1000).toISOString() }, { path: '/b', error: 'x' }, { path: '/c', notAfter: new Date(NOW - 2 * DAY).toISOString() }, { path: '/d', notAfter: 'not-a-date' }], NOW)
    expect(c.map((x) => [x.path, x.days])).toEqual([['/c', -2], ['/a', 23]])
    expect(certForecastText({ path: '/c', notAfter: '', days: -2 })).toBe('证书已过期 2 天：/c')
    expect(certForecastText({ path: '/t', notAfter: '', days: 0 })).toBe('证书今天到期：/t')
  })
  it('hostTrend：证书取最近一份体检；档案数只算体检', () => {
    const t = hostTrend([prof(5, [], { certs: [{ path: '/old', notAfter: new Date(NOW).toISOString() }] }), prof(1, [], { certs: [{ path: '/new', notAfter: new Date(NOW + 5 * DAY).toISOString() }] }), prof(0, [], { type: 'snapshot' })], [], NOW)
    expect(t.certs.map((c) => c.path)).toEqual(['/new'])
    expect(t.profiles).toBe(2)
    expect(t.samples).toBeUndefined()
  })
  it('颜色档 / 文案', () => {
    expect([trendLevel(2.5), trendLevel(13), trendLevel(30)]).toEqual(['danger', 'warn', 'normal'])
    expect(fullShort({ days: 9.2 })).toBe('约 9 天满')
    expect(fullShort({ days: 0.3 })).toBe('不到 1 天满')
  })
})
