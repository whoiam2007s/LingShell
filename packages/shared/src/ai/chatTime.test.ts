import { describe, it, expect } from 'vitest'
import { relativeTime, sessionTime, messageTime, formatDuration, elapsedMs, turnTimeView, toMs, fmtDateTime, fmtClockTenths, toolTimeTitle, charCount, fmtChars, reasoningTimeTitle } from './chatTime.js'

const NOW = new Date(2026, 9, 14, 15, 30, 0).getTime()   // 本地 2026-10-14 15:30:00
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H

describe('relativeTime（会话列表）', () => {
  it('1 分钟内「刚刚」，59 秒仍是刚刚，60 秒是 1 分钟前', () => {
    expect(relativeTime(NOW, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 59 * S, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 60 * S, NOW)).toBe('1 分钟前')
  })
  it('59 分 59 秒是 59 分钟前，满 1 小时显示 HH:mm', () => {
    expect(relativeTime(NOW - (59 * M + 59 * S), NOW)).toBe('59 分钟前')
    expect(relativeTime(NOW - H, NOW)).toBe('14:30')
  })
  it('24 小时内显示 HH:mm（可跨天），满 24 小时显示 N 天前', () => {
    expect(relativeTime(NOW - 23 * H, NOW)).toBe('16:30')   // 昨天 16:30
    expect(relativeTime(NOW - D, NOW)).toBe('1 天前')
    expect(relativeTime(NOW - 3 * D - H, NOW)).toBe('3 天前')
  })
  it('未来时间（时钟偏差）兜底为刚刚', () => {
    expect(relativeTime(NOW + 5 * M, NOW)).toBe('刚刚')
  })
})

describe('sessionTime', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  it('两者都有：显示最近活动，tooltip 带创建与最近活动', () => {
    const r = sessionTime({ createdAt: iso(NOW - 2 * D), lastActiveAt: iso(NOW - 5 * M) }, NOW)!
    expect(r.text).toBe('5 分钟前')
    expect(r.title).toBe(`创建于 ${fmtDateTime(NOW - 2 * D)} · 最近活动 ${fmtDateTime(NOW - 5 * M)}`)
  })
  it('只有创建时间；都没有 / 非法 → undefined', () => {
    expect(sessionTime({ createdAt: iso(NOW - 2 * H) }, NOW)?.text).toBe('13:30')
    expect(sessionTime({ createdAt: '', lastActiveAt: 'bad' }, NOW)).toBeUndefined()
    expect(toMs(0)).toBeUndefined()
    expect(toMs(undefined)).toBeUndefined()
  })
})

describe('messageTime（用户消息）', () => {
  it('今天 HH:mm；今年非今天 MM-DD HH:mm；往年 yyyy-MM-dd HH:mm', () => {
    expect(messageTime(new Date(2026, 9, 14, 0, 5).getTime(), NOW)).toBe('00:05')
    expect(messageTime(new Date(2026, 9, 13, 23, 59).getTime(), NOW)).toBe('10-13 23:59')
    expect(messageTime(new Date(2025, 11, 31, 8, 0).getTime(), NOW)).toBe('2025-12-31 08:00')
  })
})

describe('formatDuration', () => {
  it('< 10 秒带 1 位小数，< 1 分钟整秒', () => {
    expect(formatDuration(0)).toBe('0.0秒')
    expect(formatDuration(3_050)).toBe('3.0秒')
    expect(formatDuration(9_999)).toBe('9.9秒')
    expect(formatDuration(10_000)).toBe('10秒')
    expect(formatDuration(59_999)).toBe('59秒')
  })
  it('60 秒起 X分Y秒，59分59秒，1 小时起 X时Y分Z秒', () => {
    expect(formatDuration(60 * S)).toBe('1分0秒')
    expect(formatDuration(59 * M + 59 * S)).toBe('59分59秒')
    expect(formatDuration(H)).toBe('1时0分0秒')
    expect(formatDuration(26 * H + 3 * M + 4 * S)).toBe('26时3分4秒')
  })
  it('负数 / 非法按 0', () => {
    expect(formatDuration(-5000)).toBe('0.0秒')
    expect(formatDuration(NaN)).toBe('0.0秒')
  })
})

describe('elapsedMs / turnTimeView（按回合算耗时）', () => {
  it('有始有终取差；进行中用 now；历史里没结束的不给', () => {
    expect(elapsedMs(1000, 4000)).toBe(3000)
    expect(elapsedMs(1000, undefined, 2500)).toBe(1500)
    expect(elapsedMs(1000, undefined)).toBeUndefined()
    expect(elapsedMs(undefined, 4000, 5000)).toBeUndefined()
    expect(elapsedMs(5000, 4000)).toBe(0)   // 结束早于开始（时钟偏差）
  })
  it('开始回答：时间点 + hover 显示提问后多久；耗时进行中实时、结束后定格', () => {
    const start = new Date(2026, 9, 14, 15, 0, 0).getTime()
    const t = { startedAt: start, firstAt: start + 2_300 }
    const live = turnTimeView(t, { live: true, now: start + 75 * S, askedAt: start - 200 })
    expect(live.first?.text).toBe('开始回答 15:00:02')
    expect(live.first?.title).toContain('提问后 2.5秒 开始回答')
    expect(live.duration).toBe('1分15秒')
    expect(turnTimeView(t, { live: false, now: start + 75 * S }).duration).toBeUndefined()
    expect(turnTimeView({ ...t, endedAt: start + 12_000 }, { live: false, now: NOW }).duration).toBe('12秒')
  })
  it('没有时间信息（旧会话）什么都不显示', () => {
    expect(turnTimeView(undefined, { live: false, now: NOW })).toEqual({})
    expect(turnTimeView({}, { live: false, now: NOW })).toEqual({ first: undefined, duration: undefined })
  })
})

describe('toolTimeTitle（工具卡片耗时 hover）', () => {
  const at = NOW + 250   // 15:30:00.2
  it('有识别时刻：识别 → 完成，拆出生成参数与执行', () => {
    expect(fmtClockTenths(at)).toBe('15:30:00.2')
    expect(toolTimeTitle({ at, callAt: at + 1500, doneAt: at + 4000 }))
      .toBe('识别 15:30:00.2 → 完成 15:30:04.2（其中生成参数 1.5秒、执行 2.5秒）')
  })
  it('进行中：生成参数中 / 执行中', () => {
    expect(toolTimeTitle({ at, preparing: true })).toBe('识别 15:30:00.2 → 生成参数中…')
    expect(toolTimeTitle({ at, callAt: at + 1000 })).toBe('识别 15:30:00.2 → 执行中（生成参数 1.0秒）')
    expect(toolTimeTitle({ at, preparing: true, doneAt: at + 1500 })).toBe('识别 15:30:00.2 → 中止 15:30:01.7（参数没生成完，未执行）')
  })
  it('旧会话没有识别时刻：只写开始 → 完成，不拆；没有时间什么都不给', () => {
    expect(toolTimeTitle({ at, doneAt: at + 2000 })).toBe('开始 15:30:00.2 → 完成 15:30:02.2')
    expect(toolTimeTitle({})).toBe('')
  })
})

describe('思考过程：时长 hover 与字数', () => {
  const at = NOW + 250
  it('开始 → 结束；进行中写「思考中…」；没有开始时间不给', () => {
    expect(reasoningTimeTitle({ at, doneAt: at + 12_300 })).toBe('开始 15:30:00.2 → 结束 15:30:12.5')
    expect(reasoningTimeTitle({ at })).toBe('开始 15:30:00.2 → 思考中…')
    expect(reasoningTimeTitle({ doneAt: at })).toBe('')
  })
  it('字数按 Unicode 字符计：中英混排、emoji 各算 1；千分位', () => {
    expect(charCount('先看 nginx 日志')).toBe(11)
    expect(charCount('😀ab')).toBe(3)   // UTF-16 是 4 个码元
    expect(charCount('')).toBe(0)
    expect(fmtChars(1234)).toBe('1,234 字')
    expect(fmtChars(7)).toBe('7 字')
  })
})
