import { describe, it, expect } from 'vitest'
import { DEFAULT_HIGHLIGHT_RULES, LogInsight } from '@lingshell/shared'
import { appendLines, withHost, syncInsight, insightFilter, bufferPaused, compileColorRules, compileFilter, countMatches, logQuote, pickRange, segments, visibleLines, QUOTE_MAX_CHARS, type LogLine } from './logView.js'

const L = (...t: string[]): LogLine[] => t.map((text, n) => ({ n, text }))

describe('环形缓冲', () => {
  it('追加并截到最多 max 行，序号连续', () => {
    let b = appendLines([], ['a', 'b', 'c'], 4, 0)
    expect(b).toEqual({ lines: [{ n: 0, text: 'a' }, { n: 1, text: 'b' }, { n: 2, text: 'c' }], next: 3 })
    b = appendLines(b.lines, ['d', 'e'], 4, b.next)
    expect(b.lines.map((l) => l.n)).toEqual([1, 2, 3, 4])
    expect(b.next).toBe(5)
  })
  it('一次来的比 max 还多：只留最后 max 行，序号对得上', () => {
    const b = appendLines([], ['1', '2', '3', '4', '5'], 2, 10)
    expect(b).toEqual({ lines: [{ n: 13, text: '4' }, { n: 14, text: '5' }], next: 15 })
  })
  it('调小上限：空追加也截断', () => {
    expect(appendLines(L('a', 'b', 'c'), [], 1, 3).lines).toEqual([{ n: 2, text: 'c' }])
  })
  it('暂停缓冲计数，超上限丢最早的并累计', () => {
    let p = bufferPaused({ lines: [], dropped: 0 }, ['a', 'b'], 3)
    p = bufferPaused(p, ['c', 'd', 'e'], 3)
    expect(p).toEqual({ lines: ['c', 'd', 'e'], dropped: 2 })
  })
})

describe('过滤', () => {
  const lines = L('GET /a 200', 'ERROR db down', 'get /b 500', 'warn: slow')
  it('关键字默认不区分大小写，特殊字符按字面', () => {
    const { re } = compileFilter({ query: 'get', regex: false, caseSensitive: false })
    expect(visibleLines(lines, re, true).map((l) => l.n)).toEqual([0, 2])
    expect(visibleLines(lines, re, false)).toHaveLength(4)   // 显示全部（高亮匹配）
    expect(countMatches(lines, re)).toBe(2)
    const dot = compileFilter({ query: '/a.', regex: false, caseSensitive: false }).re
    expect(visibleLines(L('/a.x', '/abx'), dot, true).map((l) => l.text)).toEqual(['/a.x'])
  })
  it('区分大小写、正则', () => {
    expect(visibleLines(lines, compileFilter({ query: 'get', regex: false, caseSensitive: true }).re, true).map((l) => l.n)).toEqual([2])
    expect(visibleLines(lines, compileFilter({ query: ' [45]\\d\\d$', regex: true, caseSensitive: false }).re, true).map((l) => l.n)).toEqual([2])
  })
  it('空查询无过滤；非法正则 / 匹配空串报错', () => {
    expect(compileFilter({ query: '', regex: true, caseSensitive: false })).toEqual({})
    expect(compileFilter({ query: '(', regex: true, caseSensitive: false }).error).toMatch(/正则有误/)
    expect(compileFilter({ query: 'a*', regex: true, caseSensitive: false }).error).toBe('正则会匹配空字符串')
  })
  it('g 标志的 lastIndex 不串行（连续 test 结果稳定）', () => {
    const { re } = compileFilter({ query: 'x', regex: false, caseSensitive: false })
    expect(visibleLines(L('x', 'x', 'x'), re, true)).toHaveLength(3)
  })
})

describe('着色分段', () => {
  const colors = compileColorRules(DEFAULT_HIGHLIGHT_RULES)
  it('复用终端高亮规则：ERROR 红、WARN 黄', () => {
    expect(segments('2024 ERROR boom', colors)).toEqual([{ text: '2024 ' }, { text: 'ERROR', color: 'red' }, { text: ' boom' }])
    expect(segments('Warning: x', colors)[0]).toEqual({ text: 'Warning', color: 'yellow' })
    expect(segments('plain', colors)).toEqual([{ text: 'plain' }])
  })
  it('过滤命中与关键字着色叠加', () => {
    const re = compileFilter({ query: 'or b', regex: false, caseSensitive: false }).re
    expect(segments('error boom', colors, re)).toEqual([
      { text: 'err', color: 'red' }, { text: 'or', color: 'red', mark: true }, { text: ' b', mark: true }, { text: 'oom' },
    ])
  })
  it('停用 / 非法 / 匹配空串的规则忽略', () => {
    const rs = compileColorRules([
      { id: 'a', pattern: 'x', isRegex: false, caseSensitive: true, color: 'red', enabled: false },
      { id: 'b', pattern: '(', isRegex: true, caseSensitive: true, color: 'red', enabled: true },
      { id: 'c', pattern: 'y?', isRegex: true, caseSensitive: true, color: 'red', enabled: true },
      { id: 'd', pattern: 'INFO', isRegex: false, caseSensitive: true, color: 'blue', bold: true, enabled: true },
    ])
    expect(rs).toHaveLength(1)
    expect(segments('INFO x', rs)[0]).toEqual({ text: 'INFO', color: 'blue', bold: true })
  })
})

describe('选中与问 AI', () => {
  it('Shift 连选取可见行区间（被过滤掉的不选）', () => {
    const vis = L('a', 'b', 'c', 'd').filter((l) => l.n !== 2)
    expect([...pickRange(vis, 3, 0)].sort()).toEqual([0, 1, 3])
  })
  it('引用带主机和来源，超长截前面', () => {
    expect(logQuote('/var/log/syslog', 'root@web1', 'l1\nl2\n')).toBe('「root@web1」上的日志 /var/log/syslog：\n```\nl1\nl2\n```\n')
    const q = logQuote('p', 'h', 'x'.repeat(QUOTE_MAX_CHARS + 5))
    expect(q).toContain('前面省略 5 字')
  })
})

describe('洞察同步', () => {
  it('增量：只处理新行；缓冲截断时扣减；清空时清空；可重复调用', () => {
    const x = new LogInsight()
    let b = appendLines([], ['2026-10-15 10:00:01 ERROR a 1', '2026-10-15 10:00:02 INFO b 2'], 3, 0)
    syncInsight(x, b.lines)
    syncInsight(x, b.lines)
    expect(x.size).toBe(2)
    b = appendLines(b.lines, ['2026-10-15 10:00:03 ERROR a 3', '2026-10-15 10:00:04 INFO c 4'], 3, b.next)
    syncInsight(x, b.lines)
    expect(x.size).toBe(3)
    expect(x.top().map((p) => [p.fp, p.count])).toEqual([['ERROR a <n>', 1], ['INFO c <n>', 1], ['INFO b <n>', 1]])   // 同级同次数：最近的在前
    // 一次来的比上限还多：整段替换
    b = appendLines(b.lines, ['x 1', 'x 2', 'x 3', 'x 4', 'x 5'], 3, b.next)
    syncInsight(x, b.lines)
    expect(x.size).toBe(3)
    expect(x.top().map((p) => [p.fp, p.count])).toEqual([['x <n>', 3]])
    syncInsight(x, [])
    expect(x.size).toBe(0)
  })
  it('按模式 / 时间段筛原始视图', () => {
    const x = new LogInsight()
    const lines = L('2026-10-15 10:00:01 ERROR a 1', '2026-10-15 10:00:02 INFO b 2', '2026-10-15 10:00:03 ERROR a 3')
    syncInsight(x, lines)
    expect(insightFilter(lines, x)).toBe(lines)
    expect(insightFilter(lines, x, 'ERROR a <n>').map((l) => l.n)).toEqual([0, 2])
    const from = new Date(2026, 9, 15, 10, 0, 2).getTime()
    expect(insightFilter(lines, x, undefined, { from, to: from + 1000 }).map((l) => l.n)).toEqual([1])
    expect(insightFilter(lines, x, 'ERROR a <n>', { from, to: from + 2000 }).map((l) => l.n)).toEqual([2])
  })
})

describe('多主机行', () => {
  it('appendLines 带主机下标；withHost 加前缀', () => {
    const r = appendLines([], [{ text: 'a', h: 1 }, 'b'], 10, 0)
    expect(r.lines).toEqual([{ n: 0, text: 'a', h: 1 }, { n: 1, text: 'b' }])
    expect(withHost(r.lines[0], ['web1', 'web2'])).toBe('[web2] a')
    expect(withHost(r.lines[1], ['web1'])).toBe('b')
    expect(withHost(r.lines[0])).toBe('a')
  })
})
