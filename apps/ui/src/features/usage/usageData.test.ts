import { describe, it, expect } from 'vitest'
import { fillDays, sortRows, shares } from './usageData.js'

const t = (n: number) => ({ requests: 1, input: n, cacheRead: 0, output: 0, unpriced: 1 })

describe('用量统计弹窗逻辑', () => {
  it('7 天补零：每天一项，有记录的保留原值', () => {
    const now = new Date(2026, 9, 14, 15)
    const r = fillDays({ range: '7d', days: [{ day: '2026-10-10', ...t(5) }] }, now)
    expect(r.map((d) => d.day)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])
    expect(r[2].input).toBe(5)
    expect(r[0].requests).toBe(0)
  })
  it('「全部」从第一条记录那天起；没记录只有今天', () => {
    const now = new Date(2026, 9, 14, 15)
    expect(fillDays({ range: 'all', days: [{ day: '2026-10-12', ...t(1) }] }, now)).toHaveLength(3)
    expect(fillDays({ range: 'all', days: [] }, now).map((d) => d.day)).toEqual(['2026-10-14'])
  })
  it('排序稳定、支持数字和文字、不改原数组', () => {
    const rows = [{ k: 'b', v: 2 }, { k: 'a', v: 2 }, { k: 'c', v: 1 }]
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.k)).toEqual(['b', 'a', 'c'])
    expect(sortRows(rows, (r) => r.k, 'asc').map((r) => r.k)).toEqual(['a', 'b', 'c'])
    expect(rows[0].k).toBe('b')
  })
  it('占比：尾部并入「其它」，0 值丢掉，总量 0 返回空', () => {
    const r = shares([{ label: 'a', value: 5 }, { label: 'b', value: 3 }, { label: 'c', value: 1 }, { label: 'd', value: 1 }, { label: 'z', value: 0 }], 3)
    expect(r.map((x) => [x.label, x.value])).toEqual([['a', 5], ['b', 3], ['其它', 2]])
    expect(r[0].ratio).toBeCloseTo(0.5)
    expect(shares([{ label: 'a', value: 0 }])).toEqual([])
  })
})
