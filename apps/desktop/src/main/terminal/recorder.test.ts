import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCast } from '@lingshell/shared'
import { TerminalRecorder, pruneRecordings, listRecordings, recordingPath } from './recorder.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'lingshell-rec-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('TerminalRecorder', () => {
  it('写 header + o/i/r 事件，时间为相对秒', async () => {
    let t = new Date(2026, 9, 10, 8, 30, 15).getTime()
    const rec = new TerminalRecorder(tmp, undefined, () => t)
    const file = rec.start('term_ab12', '本地 1', 'local')
    expect(file).toBe(join(tmp, '2026-10-10', '08-30-15_本地_1_term_ab12.cast'))
    rec.resize('term_ab12', 120, 40)          // 首个事件前：改 header
    t += 500; rec.output('term_ab12', '$ ')
    t += 250; rec.input('term_ab12', 'ls\r')
    t += 1000; rec.resize('term_ab12', 100, 30)
    rec.output('nope', 'x')                   // 未录制的终端忽略
    expect(rec.activeIds()).toEqual(new Set(['2026-10-10/08-30-15_本地_1_term_ab12.cast']))
    await rec.stopAll()
    expect(rec.active).toBe(false)

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 120, height: 40, title: '本地 1', timestamp: Math.floor(new Date(2026, 9, 10, 8, 30, 15).getTime() / 1000) })
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual([[0.5, 'o', '$ '], [0.75, 'i', 'ls\r'], [1.75, 'r', '100x30']])
  })

  it('无事件关闭也留合法 header；list 给出时长/标题', async () => {
    let t = new Date(2026, 9, 10, 9, 0, 0).getTime()
    const rec = new TerminalRecorder(tmp, undefined, () => t)
    rec.start('t1', 'web 01', 'ssh')
    rec.start('t2', 'empty', 'local')
    t += 3200; rec.output('t1', 'x'.repeat(10000))   // 超过 8KB，走末尾切片
    t += 100; rec.output('t1', 'end')
    await rec.stop('t2')
    const live = listRecordings(tmp, rec.activeIds())
    await rec.stopAll()
    expect(live.map((r) => [r.id.includes('empty'), r.active])).toEqual([[false, true], [true, false]])
    const list = listRecordings(tmp)
    const web = list.find((r) => r.title === 'web 01')!
    expect(web.durationSec).toBe(3.3)
    expect(web.date).toBe('2026-10-10')
    expect(list.find((r) => r.title === 'empty')!.durationSec).toBe(0)
    expect(parseCast(readFileSync(recordingPath(tmp, web.id), 'utf8')).events).toHaveLength(2)
  })

  it('recordingPath 拒绝目录穿越', () => {
    expect(() => recordingPath(tmp, '../x.cast')).toThrow()
    expect(() => recordingPath(tmp, '2026-10-10/../../x.cast')).toThrow()
    expect(recordingPath(tmp, '2026-10-10/a.cast')).toBe(join(tmp, '2026-10-10', 'a.cast'))
  })
})

describe('pruneRecordings', () => {
  it('删早于保留天数的日期目录，其它不碰', () => {
    for (const d of ['2026-09-01', '2026-09-09', '2026-09-10', '2026-10-10', 'keep-me']) {
      mkdirSync(join(tmp, d)); writeFileSync(join(tmp, d, 'a.cast'), '{}')
    }
    expect(pruneRecordings(tmp, 30, new Date(2026, 9, 10, 12))).toEqual(['2026-09-01', '2026-09-09'])
    expect(readdirSync(tmp).sort()).toEqual(['2026-09-10', '2026-10-10', 'keep-me'])
    expect(pruneRecordings(tmp, 0, new Date(2027, 0, 1))).toEqual([])
  })
})
