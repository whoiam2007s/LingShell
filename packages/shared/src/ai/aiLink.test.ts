import { describe, it, expect } from 'vitest'
import { PredictThrottle, buildPredictPrompt, normalizePredict, segmentCast, mergeSegments, clipMiddle, buildSummaryPrompt, parseChapters, mapChapterTime } from './aiLink.js'
import { limitIdle, type CastEvent } from '../terminal/index.js'

const B = '\x1b]133;B\x07', C = '\x1b]133;C\x07', D = '\x1b]133;D;0\x07'

describe('预测下一条命令', () => {
  it('节流：同一提示符只请求一次，每分钟最多 6 次', () => {
    const th = new PredictThrottle(6, 60_000)
    const k1 = {}
    expect(th.allow(k1, 0)).toBe(true)
    expect(th.allow(k1, 10)).toBe(false)   // 同一提示符
    for (let i = 0; i < 5; i++) expect(th.allow({}, 100 + i)).toBe(true)
    expect(th.allow({}, 200)).toBe(false)  // 第 7 次
    expect(th.allow({}, 60_001)).toBe(true) // 一分钟后窗口滑走
  })
  it('规整：最多 5 条命令；生产主机不带输出', () => {
    const r = normalizePredict({ commands: ['a', 'b', ' ', 'c', 'd', 'e', 'f'], outputTail: 'x'.repeat(3000), os: 'linux' })
    expect(r.commands).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(r.outputTail).toHaveLength(1500)
    expect(normalizePredict({ commands: ['ls'], outputTail: 'secret', prod: true }).outputTail).toBeUndefined()
    expect(normalizePredict(undefined)).toMatchObject({ commands: [], os: 'unknown' })
  })
  it('提示词带命令与输出尾部', () => {
    const p = buildPredictPrompt({ os: 'linux', commands: ['cd app', 'git pull'], outputTail: 'Already up to date.', prod: true })
    expect(p.user).toContain('1. cd app')
    expect(p.user).toContain('Already up to date.')
    expect(p.system).toContain('生产主机')
  })
})

describe('录像切分', () => {
  it('按 OSC 133 B/C 取命令行，段输出到下一条命令前', () => {
    const ev: CastEvent[] = [
      [0.1, 'o', `$ ${B}`], [0.5, 'i', 'ls\r'], [0.6, 'o', `ls\r\n${C}a.txt\r\nb.txt\r\n${D}$ ${B}`],
      [5, 'o', `cat a.txt\r\n${C}hello\r\n`], [9, 'o', '\x1b[36mdf -h\x1b[0m\r\nFilesystem\r\n'],
    ]
    const s = segmentCast(ev)
    expect(s.map((x) => [x.t, x.command, !!x.ai])).toEqual([[0.6, 'ls', false], [5, 'cat a.txt', false], [9, 'df -h', true]])
    expect(s[0].output).toBe('a.txt\nb.txt')   // 到 133;D 为止，不带下一个提示符
    expect(s[0].output).not.toContain('hello')
    expect(s[2].output).toContain('Filesystem')
  })
  it('不读键入事件（可能有密码）', () => {
    const s = segmentCast([[0, 'o', `$ ${B}sudo ls\r\n${C}[sudo] password: `], [1, 'i', 'hunter2\r'], [2, 'o', '\r\nok\r\n']])
    expect(JSON.stringify(s)).not.toContain('hunter2')
  })
  it('没有命令标记时按 60 秒切段', () => {
    const s = segmentCast([[1, 'o', 'aaa\r\n'], [30, 'o', 'bbb\r\n'], [70, 'o', 'ccc\r\n'], [200, 'o', '\r\n']])
    expect(s.map((x) => x.t)).toEqual([1, 70])
    expect(s[0].output).toContain('bbb')
  })
  it('段数超限合并相邻段', () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({ t: i, command: `c${i}`, output: `o${i}` }))
    const m = mergeSegments(segs, 4)
    expect(m).toHaveLength(4)
    expect(m[0]).toMatchObject({ t: 0, command: 'c0；c1；c2' })
  })
  it('输出摘要留头尾', () => {
    const c = clipMiddle('a'.repeat(100) + 'b'.repeat(100), 20)
    expect(c.startsWith('a'.repeat(10))).toBe(true)
    expect(c.endsWith('b'.repeat(10))).toBe(true)
    expect(c).toContain('省略 180 字')
  })
  it('摘要提示词含时间点与命令', () => {
    const p = buildSummaryPrompt([{ t: 3.25, command: 'ls', output: 'x' }, { t: 9, command: 'df', ai: true, output: '' }], 'web-1', 75)
    expect(p.user).toContain('[3.3s] 命令：ls')
    expect(p.user).toContain('[9s] AI 执行：df')
    expect(p.system).toContain('JSON')
  })
})

describe('章节解析与时间换算', () => {
  it('JSON 数组：排序、夹在时长内、去重', () => {
    const c = parseChapters('好的：\n[{"t":30,"title":"看日志"},{"t":0,"title":"登录"},{"t":999,"title":"收尾"},{"t":0,"title":"重复"},{"x":1}]', 120)
    expect(c).toEqual([{ t: 0, title: '登录' }, { t: 30, title: '看日志' }, { t: 120, title: '收尾' }])
  })
  it('退回逐行格式', () => {
    expect(parseChapters('- 0:05 登录主机\n- 1:20 重启服务\n- 95s 验证', 200)).toEqual([{ t: 5, title: '登录主机' }, { t: 80, title: '重启服务' }, { t: 95, title: '验证' }])
    expect(parseChapters('没有内容', 10)).toEqual([])
  })
  it('原始时间 → 空闲压缩后的回放时间', () => {
    const orig: CastEvent[] = [[0, 'o', 'a'], [1, 'o', 'b'], [100, 'o', 'c'], [101, 'o', 'd']]
    const lim = limitIdle(orig)
    expect(mapChapterTime(orig, lim, 100)).toBe(3)
    expect(mapChapterTime(orig, lim, 50)).toBe(3)
    expect(mapChapterTime(orig, lim, 0)).toBe(0)
    expect(mapChapterTime(orig, lim, 500)).toBe(4)
  })
})
