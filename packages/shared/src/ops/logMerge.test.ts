import { describe, expect, it } from 'vitest'
import { LogMerger, logSearchCommand, parseLogSearch, parseLogSearchOutput, mergeSearchResults, ereUnsupported, LOG_SEARCH_RAW_MAX } from './logMerge.js'

const T0 = Date.UTC(2026, 9, 18, 2, 0, 0)
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()

describe('LogMerger', () => {
  it('两台按时间归并，晚到的更早行能插到前面', () => {
    const m = new LogMerger(2, 0, 1000, 5000)
    m.push(0, [`${iso(1)} a1`, `${iso(3)} a3`], 0)
    m.push(1, [`${iso(2)} b2`], 500)
    expect(m.drain(900)).toEqual([])            // 还没满窗口
    expect(m.drain(1000)).toEqual([{ h: 0, text: `${iso(1)} a1` }])   // 队首 a1 到期；b2 时间更早于 a3 但还没到期 → 卡住 a3 后面的也不放
    expect(m.drain(1500)).toEqual([{ h: 1, text: `${iso(2)} b2` }, { h: 0, text: `${iso(3)} a3` }])
  })
  it('续行 / 无时间的行跟着本台上一行', () => {
    const m = new LogMerger(2, 0, 0, 0)
    m.push(0, [`${iso(5)} ERROR boom`, '    at x.y(Z.java:1)', 'Caused by: q'], 0)
    m.push(1, [`${iso(4)} b4`, `${iso(6)} b6`], 0)
    expect(m.drain(0).map((x) => x.text)).toEqual([`${iso(4)} b4`, `${iso(5)} ERROR boom`, '    at x.y(Z.java:1)', 'Caused by: q', `${iso(6)} b6`])
  })
  it('起步：等各台都出数据或结束，最多等 startWait', () => {
    const m = new LogMerger(2, 0, 0, 5000)
    m.push(0, [`${iso(9)} late-host-a`], 100)
    expect(m.drain(200)).toEqual([])
    m.push(1, [`${iso(1)} b-backlog`], 3000)    // 慢的这台积压的旧行到了
    expect(m.drain(3000).map((x) => x.h)).toEqual([1, 0])
    const m2 = new LogMerger(2, 0, 0, 5000)
    m2.push(0, ['x'], 0)
    expect(m2.drain(4999)).toEqual([])
    expect(m2.drain(5000)).toHaveLength(1)
    const m3 = new LogMerger(2, 0, 0, 5000)
    m3.push(0, ['x'], 0); m3.end(1)
    expect(m3.drain(1)).toHaveLength(1)
  })
  it('drain(all) 全部放出', () => {
    const m = new LogMerger(1, 0, 10_000, 0)
    m.push(0, ['a', 'b'], 0)
    expect(m.drain(1, true)).toHaveLength(2)
    expect(m.size).toBe(0)
  })
})

describe('检索命令', () => {
  it('文件：轮转 + gz + 关键字按字面量匹配（默认不区分大小写）+ 只回传最新行', () => {
    const c = logSearchCommand({ src: { kind: 'file', path: "/var/log/my app's.log" }, pattern: 'a.b', from: T0 })
    expect(c).toContain(`p='/var/log/my app'\\''s.log'`)
    expect(c).toContain('ls -1tr -- "$p" "$p".* "$p"-*')
    expect(c).toContain(`from=${T0 / 1000}`)
    expect(c).toContain('zcat -f -- "$f"')
    expect(c).toContain(`grep -a -i -E -e 'a\\.b'`)
    expect(c).toContain(`tail -n ${LOG_SEARCH_RAW_MAX}`)
  })
  it('正则、区分大小写、无关键字', () => {
    expect(logSearchCommand({ src: { kind: 'file', path: '/a' }, pattern: 'x|y', regex: true, caseSensitive: true })).toContain(`grep -a -E -e 'x|y'`)
    expect(logSearchCommand({ src: { kind: 'file', path: '/a' } })).toContain('| cat |')
  })
  it('journal：--since/--until @秒，short-iso', () => {
    const c = logSearchCommand({ src: { kind: 'journal', unit: 'nginx' }, from: T0, to: T0 + 3600_000, pattern: 'err' })
    expect(c).toContain(`journalctl --no-pager -o short-iso -u 'nginx' --since @${T0 / 1000} --until @${T0 / 1000 + 3600}`)
    expect(c).toContain('nojournal')
  })
  it('命令带远端时区标记；文件不可读打 denied 标记', () => {
    const c = logSearchCommand({ src: { kind: 'file', path: '/var/log/app.log' } })
    expect(c).toContain('tz $(date +%z')
    expect(c).toContain('denied')
    expect(logSearchCommand({ src: { kind: 'journal' } })).toContain('tz $(date +%z')
  })
  it('grep -E 不支持的 JS 正则写法：提前拦下', () => {
    expect(ereUnsupported('timeout \\d+ms')).toBe('\\d')
    expect(ereUnsupported('(?:a|b)')).toBe('(?:')
    expect(ereUnsupported('a+?')).toContain('非贪婪')
    expect(ereUnsupported('a\\\\d')).toBeUndefined()   // \\d = 字面反斜杠 + d
    expect(ereUnsupported('\\bword\\b [0-9]+ (a|b)')).toBeUndefined()
    expect(() => parseLogSearch({ pattern: 'x\\d', regex: true }, { kind: 'file', path: '/x' })).toThrow('不支持')
    expect(() => parseLogSearch({ pattern: 'x\\d', regex: false }, { kind: 'file', path: '/x' })).not.toThrow()   // 关键字模式是 -F
  })
  it('校验条件', () => {
    const src = { kind: 'file' as const, path: '/a' }
    expect(() => parseLogSearch({ pattern: 'a\nb' }, src)).toThrow('关键字')
    expect(() => parseLogSearch({ pattern: '(', regex: true }, src)).toThrow('正则')
    expect(() => parseLogSearch({ from: 5, to: 3 }, src)).toThrow('开始时间')
    expect(parseLogSearch({ perHost: 99999 }, src).perHost).toBe(5000)
    expect(parseLogSearch({}, src)).toMatchObject({ perHost: 500, regex: false })
  })
})

describe('检索输出解析', () => {
  const out = [
    '@@AISH@@ file /var/log/app.log.2.gz',
    '@@AISH@@ file /var/log/app.log.1',
    '@@AISH@@ nozcat /var/log/app.log.3.gz',
    '@@AISH@@ unsupported /var/log/app.log.4.xz',
    '@@AISH@@ old /var/log/app.log.9.gz',
    `${iso(-10)} INFO too early`,
    `${iso(1)} ERROR in range`,
    '\tat a.b(C.java:3)',
    `${iso(2)} WARN in range 2`,
    `${iso(100)} INFO too late`,
    '',
  ].join('\n')
  it('拆出说明、按时间段筛、续行跟着上一行', () => {
    const r = parseLogSearchOutput(out, { src: { kind: 'file', path: '/var/log/app.log' }, from: T0, to: T0 + 60_000 })
    expect(r.files).toEqual(['/var/log/app.log.2.gz', '/var/log/app.log.1'])
    expect(r.notes).toEqual(['跳过 /var/log/app.log.3.gz（远端没有 zcat）', '跳过 /var/log/app.log.4.xz（只支持 .gz 压缩）'])
    expect(r.lines).toEqual([`${iso(1)} ERROR in range`, '\tat a.b(C.java:3)', `${iso(2)} WARN in range 2`])
    expect(r.times[1]).toBe(T0 + 1000)
    expect(r.rawCapped).toBe(false)
  })
  it('没写时区的行按远端主机时区解析（服务器 UTC、桌面 +08:00 也不丢行）', () => {
    // 2026-10-18 02:00:01 UTC，行里没有时区；远端报 +0000
    const out = ['@@AISH@@ tz +0000', '@@AISH@@ file /var/log/syslog', '2026-10-18 02:00:01 ERROR boom', ''].join('\n')
    const r = parseLogSearchOutput(out, { src: { kind: 'file', path: '/var/log/syslog' }, from: T0, to: T0 + 60_000 })
    expect(r.lines).toEqual(['2026-10-18 02:00:01 ERROR boom'])
    expect(r.times[0]).toBe(T0 + 1000)
    // 远端是 +0800：同样的字面时间是 UTC 前一天 18:00，落在时间段外
    const r8 = parseLogSearchOutput(out.replace('+0000', '+0800'), { src: { kind: 'file', path: '/x' }, from: T0, to: T0 + 60_000 })
    expect(r8.lines).toEqual([])
  })
  it('读不了的文件走说明，不混进结果', () => {
    const r = parseLogSearchOutput('@@AISH@@ denied /var/log/secure\n', { src: { kind: 'file', path: '/var/log/secure' } })
    expect(r.notes).toEqual(['跳过 /var/log/secure（没有权限读）'])
    expect(r.lines).toEqual([])
  })
  it('带关键字时续行不沿用上一条命中行的时间做筛选', () => {
    const out = [`${iso(-100)} ERROR old`, '\tat x.y(Z.java:1)', ''].join('\n')
    const r = parseLogSearchOutput(out, { src: { kind: 'file', path: '/x' }, from: T0, pattern: 'Z.java' })
    expect(r.lines).toEqual(['\tat x.y(Z.java:1)'])   // 时间不确定的续行保留，不按上一行的旧时间丢掉
    expect(r.times[0]).toBeUndefined()
  })
  it('远端截到上限且都晚于结束时间：提示时间段内的行没取到', () => {
    const lines = Array.from({ length: LOG_SEARCH_RAW_MAX }, () => `${iso(1000)} INFO late`).join('\n')
    const r = parseLogSearchOutput(lines, { src: { kind: 'file', path: '/x' }, to: T0 + 60_000 })
    expect(r.lines).toEqual([])
    expect(r.notes.join('')).toContain('都晚于结束时间')
  })
  it('每台上限：留最新的', () => {
    const r = parseLogSearchOutput(out, { src: { kind: 'file', path: '/x' }, perHost: 2 })
    expect(r.lines).toEqual([`${iso(2)} WARN in range 2`, `${iso(100)} INFO too late`])
    expect(r.capped).toBe(3)
  })
  it('合并多台：按时间，同时按主机顺序', () => {
    const a = parseLogSearchOutput(`${iso(1)} a1\n${iso(3)} a3\n`, { src: { kind: 'file', path: '/x' } })
    const b = parseLogSearchOutput(`${iso(1)} b1\n${iso(2)} b2\n  cont\n`, { src: { kind: 'file', path: '/x' } })
    expect(mergeSearchResults([a, b]).map((x) => `${x.h}:${x.text.split(' ').pop()}`)).toEqual(['0:a1', '1:b1', '1:b2', '1:cont', '0:a3'])
  })
})
