import { describe, it, expect } from 'vitest'
import { parseLogTime, logLevel, logFingerprint, isContinuation, LogInsight, buildHistogram, buildLogDigest, patternQuote, fmtStep, LOG_DIGEST_TAG } from './logInsight.js'

const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()   // 本地 2026-10-15 12:00:00
const local = (mo: number, d: number, h: number, mi: number, s: number, msec = 0, y = 2026) => new Date(y, mo - 1, d, h, mi, s, msec).getTime()
const t = (line: string) => parseLogTime(line, NOW)?.t

describe('parseLogTime', () => {
  it('ISO8601：Z / 带偏移 / 无时区按本地 / 纳秒', () => {
    expect(t('2026-10-15T10:00:01Z INFO started')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1))
    expect(t('2026-10-15T10:00:01.250Z x')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1, 250))
    expect(t('2026-10-15T18:00:01+08:00 x')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1))
    expect(t('2026-10-15T18:00:01+0800 myhost sshd[1]: x')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1))   // journalctl -o short-iso
    expect(t('2026-10-15T05:00:01-05:00 x')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1))
    expect(t('2026-10-15T10:00:01.123456789Z x')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1, 123))
    expect(t('2026-10-15T10:00:01 x')).toBe(local(10, 15, 10, 0, 1))
  })
  it('Python logging（逗号毫秒）/ Java logback / log4j', () => {
    expect(t('2026-10-15 10:00:01,123 - app.db - ERROR - connection lost')).toBe(local(10, 15, 10, 0, 1, 123))
    expect(t('2026-10-15 10:00:01.456 [main] WARN  c.e.Foo - slow query')).toBe(local(10, 15, 10, 0, 1, 456))
    expect(t('[2026-10-15 10:00:01] local.ERROR: boom')).toBe(local(10, 15, 10, 0, 1))   // Laravel
    expect(t('ERROR 2026-10-15 10:00:01 something')).toBe(local(10, 15, 10, 0, 1))
  })
  it('nginx error.log / Go log（斜杠日期）', () => {
    expect(t('2026/10/15 10:00:01 [error] 1234#0: *5 connect() failed')).toBe(local(10, 15, 10, 0, 1))
  })
  it('nginx / apache 访问日志', () => {
    expect(t('10.0.0.1 - - [15/Oct/2026:10:00:01 +0800] "GET / HTTP/1.1" 200 612')).toBe(Date.UTC(2026, 9, 15, 2, 0, 1))
    expect(t('10.0.0.1 - - [15/Oct/2026:10:00:01 -0000] "GET / HTTP/1.1" 200 612')).toBe(Date.UTC(2026, 9, 15, 10, 0, 1))
    expect(t('10.0.0.1 - - [5/Oct/2026:10:00:01] "GET /"')).toBe(local(10, 5, 10, 0, 1))
  })
  it('syslog / journalctl short：取今年，晚于现在一天以上算去年；单数字日期两个空格', () => {
    expect(t('Oct 15 10:00:01 web1 sshd[1234]: Accepted publickey')).toBe(local(10, 15, 10, 0, 1))
    expect(t('Oct  5 09:00:00 web1 kernel: x')).toBe(local(10, 5, 9, 0, 0))
    expect(t('Dec 31 23:59:59 web1 cron[1]: x')).toBe(local(12, 31, 23, 59, 59, 0, 2025))
    expect(t('<34>Oct 15 10:00:01 web1 su: x')).toBe(local(10, 15, 10, 0, 1))
    expect(t('Oct 15 10:00:01.123456 web1 x')).toBe(local(10, 15, 10, 0, 1, 123))
  })
  it('apache error.log / Tomcat catalina / klog', () => {
    expect(t('[Thu Oct 15 10:00:01.123456 2026] [core:error] [pid 1] AH00126')).toBe(local(10, 15, 10, 0, 1, 123))
    expect(t('15-Oct-2026 10:00:01.123 SEVERE [main] org.apache.catalina')).toBe(local(10, 15, 10, 0, 1, 123))
    expect(t('E1015 10:00:01.123456    1234 reflector.go:138] failed to list')).toBe(local(10, 15, 10, 0, 1, 123))
  })
  it('取最靠前的时间戳；返回位置供指纹去掉', () => {
    const line = 'Oct 15 10:00:01 web1 app: request at 2026-10-14T00:00:00Z done'
    expect(parseLogTime(line, NOW)).toEqual({ t: local(10, 15, 10, 0, 1), start: 0, end: 15 })
  })
  it('解析不出返回 undefined', () => {
    for (const s of ['', 'hello world', 'version 1.2.3', '    at com.foo.Bar.baz(Bar.java:12)', 'Foo 15 10:00:01 x', '12:00:01 only clock']) expect(t(s)).toBeUndefined()
  })
})

describe('logLevel', () => {
  const cases: [string, string | undefined][] = [
    ['2026-10-15 10:00:01,123 - app - ERROR - boom', 'error'],
    ['2026-10-15 10:00:01.456 [main] WARN  c.e.Foo - slow', 'warn'],
    ['2026-10-15 10:00:01 INFO server started', 'info'],
    ['2026-10-15 10:00:01 DEBUG cache hit', 'debug'],
    ['2026-10-15 10:00:01 FATAL out of memory', 'error'],
    ['ERROR:root:something bad', 'error'],
    ['WARNING:urllib3:retrying', 'warn'],
    ['15-Oct-2026 10:00:01.123 SEVERE [main] x', 'error'],
    ['2026/10/15 10:00:01 [error] 1#0: *5 connect() failed', 'error'],
    ['2026/10/15 10:00:01 [warn] 1#0: an upstream response is buffered', 'warn'],
    ['2026/10/15 10:00:01 [notice] 1#0: signal process started', 'info'],
    ['[Thu Oct 15 10:00:01 2026] [core:error] [pid 1] AH00126', 'error'],
    ['time="2026-10-15T10:00:01Z" level=warning msg="disk almost full"', 'warn'],
    ['{"time":"2026-10-15T10:00:01Z","level":"error","msg":"x"}', 'error'],
    ['E1015 10:00:01.123456 1 reflector.go:138] failed', 'error'],
    ['W1015 10:00:01.123456 1 x.go:1] slow', 'warn'],
    ['I1015 10:00:01.123456 1 x.go:1] ok', 'info'],
    ['1.2.3.4 - - [15/Oct/2026:10:00:01 +0800] "GET /api HTTP/1.1" 502 157 "-" "curl"', 'error'],
    ['1.2.3.4 - - [15/Oct/2026:10:00:01 +0800] "GET /error HTTP/1.1" 404 157', 'warn'],
    ['1.2.3.4 - - [15/Oct/2026:10:00:01 +0800] "POST /login HTTP/1.1" 200 15', 'info'],
    ['Oct 15 10:00:01 web1 sshd[1]: Failed password for root from 1.2.3.4 port 22 ssh2', 'warn'],
    ['Oct 15 10:00:01 web1 kernel: Out of memory: Killed process 1234 (java)', 'error'],
    ['java.lang.NullPointerException: null', 'error'],
    ['Oct 15 10:00:01 web1 systemd[1]: Started Session 1 of user root.', undefined],
    ['INFO request done, 0 errors, retry after error', 'info'],   // 明确级别优先于关键字
    ['ERR_CONNECTION_RESET is a code', undefined],
  ]
  for (const [line, lv] of cases) it(line.slice(0, 60), () => expect(logLevel(line)).toBe(lv))
})

describe('logFingerprint', () => {
  const fp = (s: string) => logFingerprint(s, parseLogTime(s, NOW))
  it('同模板不同变量 → 同指纹', () => {
    const pairs: [string, string][] = [
      ['2026-10-15 10:00:01 ERROR db timeout after 3000ms host=10.0.0.5:5432', '2026-10-15 10:07:44 ERROR db timeout after 120ms host=10.0.0.9:5432'],
      ['Oct 15 10:00:01 web1 sshd[1234]: Failed password for root from 1.2.3.4 port 51234 ssh2', 'Oct 16 11:22:33 web1 sshd[99]: Failed password for root from 5.6.7.8 port 2 ssh2'],
      ['req 3f2a1b4c-1111-2222-3333-444455556666 done', 'req aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee done'],
      ['segfault at 0x7ffd1234 ip 00007f3a2b1c4d5e', 'segfault at 0xdeadbeef ip 00007f00aa11bb22'],
      ['GET /api/users/1234/orders/99 took 12ms', 'GET /api/users/7/orders/12345 took 3ms'],
      ['open /var/lib/app/cache/a1b2c3d4.tmp failed', 'open /var/lib/app/cache/x9y8.tmp failed'],
      ['session ab12cd34ef started for worker-12', 'session zz99yy88xx started for worker-7'],
      ['peer [2001:db8::1]:443 closed', 'peer [fe80::abcd:1]:443 closed'],
      ['job finished in 00:01:02.5', 'job finished in 10:11:12'],
      ['10.0.0.1 - - [15/Oct/2026:10:00:01 +0800] "GET /a/1 HTTP/1.1" 200 612', '10.0.0.2 - - [15/Oct/2026:11:00:01 +0800] "GET /a/22 HTTP/1.1" 200 7'],
    ]
    for (const [a, b] of pairs) expect(fp(a), a).toBe(fp(b))
  })
  it('不同模板 → 不同指纹', () => {
    expect(fp('2026-10-15 10:00:01 ERROR db timeout')).not.toBe(fp('2026-10-15 10:00:01 WARN db timeout'))
    expect(fp('user alice logged in')).not.toBe(fp('user alice logged out'))
    expect(fp('"GET /a HTTP/1.1" 200')).not.toBe(fp('"GET /a HTTP/1.1" 500'.replace('500', '5xx')))
  })
  it('占位符：时间戳去掉，IP / 数字 / UUID / 十六进制替换', () => {
    expect(fp('2026-10-15T10:00:01Z ERROR conn from 1.2.3.4:80 id=3f2a1b4c-1111-2222-3333-444455556666 addr 0x1f code 42'))
      .toBe('ERROR conn from <ip> id=<uuid> addr <hex> code <n>')
    expect(fp('Oct 15 10:00:01 web1 app[1234]: ok')).toBe('web<n> app[<n>]: ok')
    expect(fp('read /home/u1/data/file.txt')).toBe('read /home/<*>/data/file.txt')
  })
  it('超长截断', () => {
    expect(logFingerprint('x'.repeat(1000)).length).toBeLessThanOrEqual(241)
  })
})

describe('isContinuation', () => {
  it('堆栈 / Caused by / ... N more', () => {
    expect(isContinuation('\tat com.foo.Bar.baz(Bar.java:12)')).toBe(true)
    expect(isContinuation('  File "/app/x.py", line 3, in <module>')).toBe(true)
    expect(isContinuation('Caused by: java.io.IOException: x')).toBe(true)
    expect(isContinuation('... 12 more')).toBe(true)
    expect(isContinuation('2026-10-15 ERROR x')).toBe(false)
    expect(isContinuation('')).toBe(false)
  })
})

describe('LogInsight 增量归并', () => {
  const lines = [
    '2026-10-15 10:00:01 ERROR db timeout after 30ms',
    '2026-10-15 10:00:02 INFO request 1 ok',
    '2026-10-15 10:00:03 ERROR db timeout after 99ms',
    '\tat com.foo.Db.query(Db.java:12)',
    'no timestamp here WARN disk 91%',
    '2026-10-15 10:01:30 INFO request 2 ok',
  ]
  const mk = () => { const x = new LogInsight(); lines.forEach((l, i) => x.add(i, l, NOW)); return x }
  it('计数、级别、首次 / 最近、示例；续行不计；无时间戳沿用上一行', () => {
    const x = mk()
    const top = x.top()
    expect(top.map((p) => [p.fp, p.count, p.level])).toEqual([
      ['ERROR db timeout after <n>ms', 2, 'error'],
      ['no timestamp here WARN disk <n>%', 1, 'warn'],
      ['INFO request <n> ok', 2, 'info'],
    ])
    expect(top[0].first).toBe(local(10, 15, 10, 0, 1))
    expect(top[0].last).toBe(local(10, 15, 10, 0, 3))
    expect(top[0].sample).toBe(lines[2])
    expect(x.meta(3)).toMatchObject({ cont: true, t: local(10, 15, 10, 0, 3) })
    expect(x.meta(4)).toMatchObject({ parsed: false, t: local(10, 15, 10, 0, 3) })
    expect(x.size).toBe(6)
    expect(x.lastN).toBe(5)
  })
  it('没解析过时间的日志用接收时间', () => {
    const x = new LogInsight()
    x.add(0, 'plain line 1', 1000)
    expect(x.meta(0)?.t).toBe(1000)
  })
  it('evictBefore 扣减，计数到 0 删除模式；clear 清空', () => {
    const x = mk()
    x.evictBefore(3)
    expect(x.size).toBe(3)
    expect(x.meta(1)).toBeUndefined()
    expect(x.top().map((p) => [p.fp, p.count])).toEqual([['no timestamp here WARN disk <n>%', 1], ['INFO request <n> ok', 1]])
    x.clear()
    expect(x.size).toBe(0)
    expect(x.patterns.size).toBe(0)
  })
  it('序号不连续：之前的行视为已丢弃', () => {
    const x = mk()
    x.add(100, '2026-10-15 10:05:00 INFO request 3 ok', NOW)
    expect(x.size).toBe(1)
    expect(x.top()).toHaveLength(1)
    expect(x.meta(100)?.n).toBe(100)
  })
  it('按时间范围统计 Top 模式', () => {
    const x = mk()
    const r = x.top(10, { from: local(10, 15, 10, 0, 2), to: local(10, 15, 10, 0, 4) })
    expect(r.map((p) => [p.fp, p.count])).toEqual([['ERROR db timeout after <n>ms', 1], ['no timestamp here WARN disk <n>%', 1], ['INFO request <n> ok', 1]])
  })
  it('几万行：增量处理够快', () => {
    const x = new LogInsight()
    const t0 = performance.now()
    for (let i = 0; i < 30000; i++) x.add(i, `2026-10-15 10:${String(i % 60).padStart(2, '0')}:01 ${i % 7 ? 'INFO' : 'ERROR'} req ${i} from 10.0.${i % 255}.1 took ${i % 900}ms`, NOW)
    x.evictBefore(10000)
    expect(x.size).toBe(20000)
    expect(x.top().reduce((s, p) => s + p.count, 0)).toBe(20000)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})

describe('buildHistogram', () => {
  it('自动选桶宽：秒 / 分 / 时；错误警告分开计', () => {
    const base = local(10, 15, 10, 0, 0)
    const h1 = buildHistogram([{ t: base, level: 'error', cont: false }, { t: base + 20_000, level: 'warn', cont: false }, { t: base + 20_500, cont: false }])!
    expect(h1.step).toBe(1000)
    expect(h1.buckets).toHaveLength(21)
    expect(h1.buckets[0]).toMatchObject({ total: 1, error: 1 })
    expect(h1.buckets[20]).toMatchObject({ total: 2, warn: 1 })
    const h2 = buildHistogram([{ t: base, cont: false }, { t: base + 40 * 60_000, cont: false }])!
    expect(h2.step).toBe(60_000)
    expect(h2.buckets).toHaveLength(41)
    const h3 = buildHistogram([{ t: base, cont: false }, { t: base + 30 * 3600_000, cont: false }])!
    expect(h3.step).toBe(3600_000)
    expect(new Date(h3.from).getMinutes()).toBe(0)
    expect(h3.buckets.reduce((s, b) => s + b.total, 0)).toBe(2)
  })
  it('续行不计；空 → undefined；跨度极大时桶数受控', () => {
    expect(buildHistogram([{ t: 1, cont: true }])).toBeUndefined()
    const h = buildHistogram([{ t: 0, cont: false }, { t: 400 * 86400_000, cont: false }], 60)!
    expect(h.buckets.length).toBeLessThanOrEqual(61)
  })
  it('fmtStep', () => {
    expect(fmtStep(5000)).toBe('5 秒')
    expect(fmtStep(60_000)).toBe('1 分钟')
    expect(fmtStep(3 * 3600_000)).toBe('3 小时')
  })
})

describe('buildLogDigest / patternQuote', () => {
  const x = new LogInsight()
  ;[
    '2026-10-15 10:00:01 ERROR db timeout password=hunter2 after 30ms',
    '2026-10-15 10:00:02 INFO request 1 ok',
    '2026-10-15 10:00:03 ERROR db timeout password=hunter2 after 99ms',
    '2026-10-15 10:00:04 WARN disk 91%',
  ].forEach((l, i) => x.add(i, l, NOW))
  it('级别统计 + 时间分布 + 模式表 + 脱敏示例', () => {
    const md = buildLogDigest({ source: '/var/log/app.log', host: 'web1', from: local(10, 15, 10, 0, 0), to: local(10, 15, 10, 5, 0), metas: x.all(), patterns: x.top(), redact: (s) => s.replace(/hunter2/g, '[已脱敏]') })
    expect(md.startsWith(`${LOG_DIGEST_TAG}「web1」上的日志 /var/log/app.log，10:00:00 ~ 10:05:00`)).toBe(true)
    expect(md).toContain('共 4 行：ERROR 2，WARN 1，INFO 1，其他 0')
    expect(md).toContain('| 2 | ERROR | 10:00:01 | 10:00:03 | `ERROR db timeout password=hunter<n> after <n>ms` |')
    expect(md).toContain('时间分布（每 1 秒一格）：1 1 1 1')
    expect(md).toContain('错误 / 警告集中的时段：10:00:01（ERROR 1，WARN 0）')
    expect(md).not.toContain('hunter2')
    expect(md).toContain('[已脱敏]')
  })
  it('跨天时带日期', () => {
    const md = buildLogDigest({ source: 's', host: 'h', from: local(10, 14, 23, 0, 0), to: local(10, 15, 1, 0, 0), metas: [], patterns: [] })
    expect(md).toContain('10-14 23:00:00 ~ 10-15 01:00:00')
  })
  it('patternQuote 带次数和示例', () => {
    const q = patternQuote('/var/log/app.log', 'web1', x.top()[0], ['a', 'b', 'c', 'd'])
    expect(q).toContain('出现了 2 次（ERROR，首次 10-15 10:00:01，最近 10-15 10:00:03）')
    expect(q).toContain('```\na\nb\nc\n```')
  })
})
