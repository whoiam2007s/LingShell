import { describe, it, expect } from 'vitest'
import {
  BG_DEDUPE_MS, BgTaskRegistry, NoticeLimiter, clipCommand, noticeOverflowText, noticeText, shouldNotify, type BgTask,
} from './bgWatch.js'

const task = (over: Partial<BgTask> = {}): BgTask => ({
  jobId: 'a'.repeat(16), sessionId: 'sess_1', terminalId: 'term_1', command: 'pnpm build', startedAt: 1000, ...over,
})

describe('后台任务表', () => {
  it('按会话 / 按终端分组', () => {
    const r = new BgTaskRegistry()
    r.add(task({ jobId: 'a'.repeat(16) }))
    r.add(task({ jobId: 'b'.repeat(16) }))
    r.add(task({ jobId: 'c'.repeat(16), sessionId: 'sess_2', terminalId: 'term_2' }))
    expect(r.of('sess_1').map((t) => t.jobId)).toEqual(['a'.repeat(16), 'b'.repeat(16)])
    expect([...r.byTerminal().keys()]).toEqual(['term_1', 'term_2'])
    expect(r.byTerminal().get('term_1')!.length).toBe(2)
    expect(r.size).toBe(3)
    r.remove('a'.repeat(16))
    expect(r.size).toBe(2)
  })

  it('markChecked 只作用于还在表里的任务', () => {
    const r = new BgTaskRegistry()
    r.add(task())
    r.markChecked('a'.repeat(16), 5000, 3)
    expect(r.get('a'.repeat(16))!.checkedAt).toBe(5000)
    expect(r.get('a'.repeat(16))!.checkedTurn).toBe(3)
    r.markChecked('z'.repeat(16), 5000)   // 不存在的 id：不炸、不新增
    expect(r.size).toBe(1)
  })

  // 终端关了 / 连接断了之后查询会一直失败：不放弃的话定时器永远停不下来，
  // 每 5 秒对一个已经不存在的终端发一次命令（自评审发现的泄漏）
  it('连续查不到就累计 misses，查到了清零', () => {
    const r = new BgTaskRegistry()
    r.add(task())
    expect(r.miss('a'.repeat(16))).toBe(1)
    expect(r.miss('a'.repeat(16))).toBe(2)
    r.seen('a'.repeat(16))
    expect(r.miss('a'.repeat(16))).toBe(1)   // 中间查到过一次，重新计数
    expect(r.miss('z'.repeat(16))).toBe(0)   // 不存在的 id 不炸
  })
})

describe('该不该通知', () => {
  it('没被查过 → 通知', () => {
    expect(shouldNotify(task(), Date.now())).toBe(true)
  })
  it('刚查过（10 秒内）→ 不通知，避免同一条结果重复进上下文', () => {
    const t = task({ checkedAt: 1_000_000 })
    expect(shouldNotify(t, 1_000_000 + BG_DEDUPE_MS - 1)).toBe(false)
    expect(shouldNotify(t, 1_000_000 + BG_DEDUPE_MS + 1)).toBe(true)
  })
})

describe('通知文案', () => {
  it('全部成功', () => {
    const s = noticeText([{ task: task(), end: 'finished', exitCode: 0 }])
    expect(s).toContain('全部成功')
    expect(s).toContain('退出码 0')
    expect(s).toContain('pnpm build')
  })
  it('有失败时分别计数', () => {
    const s = noticeText([
      { task: task({ jobId: 'b'.repeat(16) }), end: 'finished', exitCode: 0 },
      { task: task({ jobId: 'c'.repeat(16) }), end: 'finished', exitCode: 2 },
    ])
    expect(s).toContain('1 个成功、1 个失败')
    expect(s).toContain('退出码 2')
  })
  it('取消 / 未知状态各有说法', () => {
    const s = noticeText([
      { task: task({ jobId: 'd'.repeat(16) }), end: 'cancelled' },
      { task: task({ jobId: 'e'.repeat(16) }), end: 'unknown' },
    ])
    expect(s).toContain('已被取消')
    expect(s).toContain('状态未知')
    expect(s).toContain('2 个失败')
  })
  it('长命令截断、换行压成一行', () => {
    const long = `echo ${'x'.repeat(200)}`
    expect(clipCommand(long).endsWith('…')).toBe(true)
    expect(clipCommand('a\n\n b   c')).toBe('a b c')
  })
  it('超限汇总文案带任务数', () => {
    expect(noticeOverflowText(7)).toContain('7 个任务结束')
  })
})

describe('推送限流', () => {
  it('窗口内前 5 条正常推，第 6 条起改成汇总', () => {
    const l = new NoticeLimiter()
    for (let i = 0; i < 5; i++) expect(l.hit('sess_1', 1_000 + i)).toBe(false)
    expect(l.hit('sess_1', 1_006)).toBe(true)
  })
  it('不同会话互不影响', () => {
    const l = new NoticeLimiter()
    for (let i = 0; i < 5; i++) l.hit('sess_1', 1_000)
    expect(l.hit('sess_2', 1_000)).toBe(false)
  })
  it('窗口过期后重新计数', () => {
    const l = new NoticeLimiter(60_000)
    for (let i = 0; i < 5; i++) l.hit('sess_1', 1_000)
    expect(l.hit('sess_1', 1_000 + 60_001)).toBe(false)
  })
})
