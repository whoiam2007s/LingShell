import { describe, expect, it } from 'vitest'
import {
  BACKUP_KEEP_PER_FILE, backupTimeOf, isBackupFileName, origKeyOf, planBackupPrune, recentBackupExists,
} from './backupPolicy.js'

const H = 3600_000
const now = new Date(2026, 10, 17, 12, 0, 0).getTime()
const name = (stamp: string, orig: string) => `${stamp}_${orig}`
const entry = (n: string, size: number, mtimeMs: number) => ({ name: n, size, mtimeMs })

describe('备份名解析', () => {
  it('origKeyOf 去掉时间戳前缀', () => {
    expect(origKeyOf('20261117-222333-144_etc_nginx_nginx.conf')).toBe('etc_nginx_nginx.conf')
    expect(origKeyOf('随便一个名字.txt')).toBe('随便一个名字.txt')
  })

  it('backupTimeOf 解析出毫秒时间', () => {
    expect(backupTimeOf('20261117-120000-000_etc_nginx_nginx.conf')).toBe(now)
    expect(backupTimeOf('20261117-120000-005_etc_nginx_nginx.conf')).toBe(now + 5)
    expect(backupTimeOf('不是备份')).toBe(0)
  })

  it('isBackupFileName 只认带时间戳前缀的', () => {
    expect(isBackupFileName('20261117-120000-005_a.txt')).toBe(true)
    expect(isBackupFileName('a.txt')).toBe(false)
  })
})

describe('planBackupPrune', () => {
  it('每个原文件只留最近 5 份', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry(name(`20261117-1${String(i).padStart(5, '0')}-000_a.txt`, 'a.txt') || `20261117-12000${i}-000_a.txt`, 10, now - i * H))
    // 用真实的 8 个不同时间
    const real = Array.from({ length: 8 }, (_, i) => entry(`2026111${i % 10}-120000-000_a.txt`, 10, now - i * H))
    expect(entries.length).toBe(8)
    const p = planBackupPrune(real, { now })
    expect(p.del.length).toBe(3)                 // 8 份留 5 份
    expect(p.del).toContain('20261115-120000-000_a.txt')   // 最旧的三份（i=7,6,5 对应的时间）
    expect(p.kept).toBe(BACKUP_KEEP_PER_FILE)
  })

  it('不同原文件各留各的，互不影响', () => {
    const entries = [
      entry('20261117-120000-000_a.txt', 10, now - 1 * H),
      entry('20261117-110000-000_a.txt', 10, now - 2 * H),
      entry('20261117-120000-000_b.txt', 10, now - 1 * H),
      entry('20261117-110000-000_b.txt', 10, now - 2 * H),
    ]
    const p = planBackupPrune(entries, { now, keepPerFile: 2 })
    expect(p.del).toEqual([])
  })

  it('超过保留天数就删（即使份数没超）', () => {
    const entries = [
      entry('20260901-120000-000_a.txt', 10, now - 77 * 24 * H),
      entry('20261117-120000-000_a.txt', 10, now - 1 * H),
    ]
    const p = planBackupPrune(entries, { now, keepDays: 30 })
    expect(p.del).toEqual(['20260901-120000-000_a.txt'])
  })

  it('总量超了就从最旧的继续删', () => {
    const entries = [
      entry('20261117-120000-000_a.txt', 60, now - 1 * H),
      entry('20261117-110000-000_b.txt', 60, now - 2 * H),
      entry('20261117-100000-000_c.txt', 60, now - 3 * H),
    ]
    const p = planBackupPrune(entries, { now, totalBytes: 100, keepPerFile: 10, keepDays: 365 })
    expect(p.del).toEqual(['20261117-100000-000_c.txt', '20261117-110000-000_b.txt'])
    expect(p.freedBytes).toBe(120)
    expect(p.kept).toBe(1)
  })

  it('protect 里的不删（被执行记录引用的备份）', () => {
    const entries = [
      entry('20260901-120000-000_a.txt', 10, now - 77 * 24 * H),
      entry('20261117-120000-000_a.txt', 10, now - 1 * H),
    ]
    const p = planBackupPrune(entries, { now, keepDays: 30, protect: ['20260901-120000-000_a.txt'] })
    expect(p.del).toEqual([])
  })

  it('空目录什么都不删', () => {
    expect(planBackupPrune([], { now })).toEqual({ del: [], freedBytes: 0, kept: 0 })
  })
})

describe('recentBackupExists', () => {
  it('同一原文件 5 分钟内有备份 → 不必再备', () => {
    const entries = [entry('20261117-115800-000_a.txt', 10, now - 2 * 60_000)]
    expect(recentBackupExists(entries, 'a.txt', now)).toBe(true)
  })

  it('超过窗口 / 别的原文件 → 需要备份', () => {
    expect(recentBackupExists([entry('20261117-110000-000_a.txt', 10, now - 60 * 60_000)], 'a.txt', now)).toBe(false)
    expect(recentBackupExists([entry('20261117-115800-000_b.txt', 10, now - 60_000)], 'a.txt', now)).toBe(false)
  })
})
