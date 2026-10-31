import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LineFilter, SessionLogger, sessionLogPath, pruneSessionLogs, ALT_SCREEN_MARK } from './sessionLog.js'
import { maskSecrets } from '@lingshell/shared'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'lingshell-slog-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

const run = (...chunks: string[]) => {
  const f = new LineFilter()
  return [...chunks.flatMap((c) => f.feed(c)), ...f.end()]
}

describe('LineFilter', () => {
  it('去掉 CSI 颜色 / OSC 标题（BEL 与 ST 两种结尾）/ ESC 字符集', () => {
    expect(run('\x1b[1;32mok\x1b[0m done\r\n')).toEqual(['ok done'])
    expect(run('\x1b]0;user@host: ~\x07$ ls\r\n')).toEqual(['$ ls'])
    expect(run('\x1b]633;A\x1b\\a\x1b(Bb\n')).toEqual(['ab'])
  })

  it('\\r 覆盖只留最终状态（进度条），\\r\\n 不截断', () => {
    expect(run('10%\r50%\r100%\n')).toEqual(['100%'])
    expect(run('downloading 9%\r\x1b[Kdone\n')).toEqual(['done'])
    expect(run('abcdef\rXY\n')).toEqual(['XYcdef'])
    expect(run('line1\r\nline2\r\n')).toEqual(['line1', 'line2'])
  })

  it('退格：\\b \\b 删字、\\b + ESC[K', () => {
    expect(run('$ lss\b \bx\r\n')).toEqual(['$ lsx'])
    expect(run('$ abc\b\b\x1b[Kz\n')).toEqual(['$ az'])
  })

  it('转义序列 / CRLF 被切到两个 chunk', () => {
    expect(run('a\x1b', '[31mb\x1b]0;ti', 'tle\x07c\r', '\nd')).toEqual(['abc', 'd'])
    expect(run('x\x1b]0;t\x1b', '\\y\n')).toEqual(['xy'])
  })

  it('其它控制字符丢弃，未换行的末行 end() 交出', () => {
    const f = new LineFilter()
    expect(f.feed('a\x07b\x00c\n$ ')).toEqual(['abc'])
    expect(f.end()).toEqual(['$'])
    expect(f.end()).toEqual([])
  })
})

describe('sessionLogPath', () => {
  it('日期目录 + 清洗 Windows 非法字符 + 短 id', () => {
    const at = new Date(2026, 9, 10, 8, 5, 9)
    expect(sessionLogPath(tmp, '本地', 'term_ab12', at)).toBe(join(tmp, '2026-10-10', '本地_080509_ab12.log'))
    expect(sessionLogPath(tmp, 'web:01 <prod>/a|b?. ', 'term_ff00', at)).toBe(join(tmp, '2026-10-10', 'web_01_prod_a_b_080509_ff00.log'))
    expect(sessionLogPath(tmp, '', 'x', at)).toBe(join(tmp, '2026-10-10', '终端_080509_x.log'))
  })
})

// 喂完关闭，返回日志内容各行
const screenLog = async (cols: number, rows: number, ...chunks: (string | [number, number])[]) => {
  const lg = new SessionLogger({ dir: () => tmp, timestamps: () => false, now: () => new Date(2026, 9, 10, 9, 0, 0).getTime(), flushMs: 60_000 })
  lg.open('s', 'x', cols, rows)
  for (const c of chunks) {
    if (typeof c === 'string') lg.data('s', c)
    else { await lg.settle('s'); lg.resize('s', c[0], c[1]) }
  }
  const file = (await lg.fileOf('s'))!
  await lg.close('s')
  return readFileSync(file, 'utf8').split('\n').slice(0, -1)
}

describe('SessionLogger 虚拟屏幕', () => {
  it('ConPTY 式 CUP 整行重绘：每行只记一次、位置正确', async () => {
    expect(await screenLog(20, 5,
      '\x1b[?25l\x1b[2J\x1b[H\x1b[93mPS>\x1b[m ls\r\na\r\nb\r\nPS> \x1b[?25h',
      '\x1b[?25l\x1b[1;1HPS> ls\x1b[K\x1b[2;1Ha\x1b[K\x1b[3;1Hb\x1b[K\x1b[4;1HPS> \x1b[K\x1b[?25h',   // 原样整屏重画
      '\x1b[4;5Hecho hi\r\nhi\r\nPS> ',
      '\x1b[?25l\x1b[3;1HPS> echo hi\x1b[K\x1b[4;1Hhi\x1b[K\x1b[5;1HPS> \x1b[K\x1b[?25h',   // 滚动后再重画一遍
    )).toEqual(['PS> ls', 'a', 'b', 'PS> echo hi', 'hi', 'PS>'])
  })

  it('\\r 进度条只留最终状态；颜色/OSC 去掉；软换行拼回一行', async () => {
    expect(await screenLog(10, 3, '\x1b]0;t\x07 10%\r 50%\r\x1b[32m100%\x1b[0m\r\n', '0123456789abc\r\n$ ')).toEqual(['100%', '0123456789abc', '$'])
  })

  it('备用屏（vim）不记，只留一行标记；退出后接着记', async () => {
    expect(await screenLog(20, 4, 'before\r\n$ vim f\r\n', '\x1b[?1049h\x1b[H~\r\n~\r\n"f" 1L\x1b[2;1Hx\r\n'.repeat(5), '\x1b[?1049l$ ls\r\nout\r\n$ ')).toEqual(['before', '$ vim f', ALT_SCREEN_MARK, '$ ls', 'out', '$'])
  })

  it('mask：落盘前把密钥保险箱的明文换回占位符（软换行拆开的也认得出）', async () => {
    const lg = new SessionLogger({ dir: () => tmp, timestamps: () => false, flushMs: 60_000, mask: (s) => maskSecrets(s, [{ name: 'demo', value: 'S3cr3t-xyz-123' }]) })
    lg.open('m', 'x', 10, 3)
    lg.data('m', '$ echo {{secret:demo}}\r\nS3cr3t-xyz-123\r\n$ ')
    const file = (await lg.fileOf('m'))!
    await lg.close('m')
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/S3cr3t|xyz-123/)
    expect(text).toContain('{{secret:demo}}')
  })

  it('resize：缩行把顶上的行推出屏幕也只记一次', async () => {
    expect(await screenLog(20, 6, 'l1\r\nl2\r\nl3\r\nl4\r\n$ ', [20, 2], 'x\r\nl5\r\n$ ')).toEqual(['l1', 'l2', 'l3', 'l4', '$ x', 'l5', '$'])
  })

  it('大量输出：行数对且不长时间阻塞事件循环', async () => {
    const line = 'y'.repeat(99) + '\r\n'
    const chunk = line.repeat(Math.floor(65536 / line.length))
    const total = Math.floor(10 * 1024 * 1024 / chunk.length)
    const lg = new SessionLogger({ dir: () => tmp, timestamps: () => false, flushMs: 60_000 })
    lg.open('big', 'x', 120, 30)
    let maxGap = 0, last = performance.now()
    const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n }, 1)
    const t0 = performance.now()
    for (let i = 0; i < total; i++) lg.data('big', chunk)
    const sync = performance.now() - t0
    const file = (await lg.fileOf('big'))!
    const ms = performance.now() - t0
    clearInterval(iv)
    await lg.close('big')
    const n = readFileSync(file, 'utf8').split('\n').length - 1
    console.log(`10MB: 同步入队 ${sync.toFixed(0)}ms，解析+落盘 ${ms.toFixed(0)}ms，事件循环最大间隔 ${maxGap.toFixed(0)}ms，${n} 行`)
    expect(n).toBe(total * Math.floor(65536 / line.length))
    expect(maxGap).toBeLessThan(200)
  }, 30_000)
})

describe('SessionLogger', () => {
  it('缓冲到 tick 才写；close 时写屏上剩余并落盘；可加时间戳', async () => {
    const t = new Date(2026, 9, 10, 9, 0, 1).getTime()
    let ts = false
    const lg = new SessionLogger({ dir: () => tmp, timestamps: () => ts, now: () => t, flushMs: 60_000 })
    lg.open('term_1', '本地', 80, 1)
    const file = join(tmp, '2026-10-10', '本地_090001_1.log')
    lg.data('term_1', '\x1b[32mhello\x1b[0m\r\n$ ')
    await lg.settle('term_1')
    expect(existsSync(file)).toBe(false)
    lg.tick()
    expect(await lg.fileOf('term_1')).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('hello\n')
    ts = true
    lg.data('term_1', 'ls\r\n')
    await lg.close('term_1')
    expect(readFileSync(file, 'utf8')).toBe('hello\n[09:00:01] $ ls\n')
    lg.data('term_1', 'ignored\n')   // 关了以后忽略
    expect(lg.has('term_1')).toBe(false)
  })

  it('过零点换新文件', async () => {
    let t = new Date(2026, 9, 10, 23, 59, 59).getTime()
    const lg = new SessionLogger({ dir: () => tmp, timestamps: () => false, now: () => t, flushMs: 60_000 })
    lg.open('term_2', 'web', 80, 1)
    lg.data('term_2', 'before\r\n')
    await lg.settle('term_2')
    t = new Date(2026, 9, 11, 0, 0, 1).getTime()
    lg.tick()
    lg.data('term_2', 'after\r\n')
    await lg.closeAll()
    expect(readFileSync(join(tmp, '2026-10-10', 'web_235959_2.log'), 'utf8')).toBe('before\n')
    expect(readFileSync(join(tmp, '2026-10-11', 'web_000001_2.log'), 'utf8')).toBe('after\n')
  })

  it('fileOf 在无内容时建空文件；写失败只报一次', async () => {
    const errs: string[] = []
    const lg = new SessionLogger({ dir: () => join(tmp, 'f.txt'), timestamps: () => false, onError: (m) => errs.push(m), flushMs: 60_000 })
    const ok = new SessionLogger({ dir: () => tmp, timestamps: () => false, flushMs: 60_000 })
    ok.open('a', 'x')
    expect(readFileSync((await ok.fileOf('a'))!, 'utf8')).toBe('')
    await ok.closeAll()
    writeFileSync(join(tmp, 'f.txt'), 'x')   // dir 是个文件 → mkdir 失败
    lg.open('b', 'y', 80, 1)
    lg.data('b', '1\r\n'); await lg.settle('b'); lg.tick()
    lg.data('b', '2\r\n'); await lg.settle('b'); lg.tick()
    await lg.close('b')
    expect(errs).toEqual(['会话日志写入失败'])
  })
})

describe('pruneSessionLogs', () => {
  it('删早于保留天数的日期目录', () => {
    for (const d of ['2026-09-01', '2026-09-10', '2026-10-09']) mkdirSync(join(tmp, d))
    expect(pruneSessionLogs(tmp, 30, new Date(2026, 9, 10))).toEqual(['2026-09-01'])
    expect(readdirSync(tmp).sort()).toEqual(['2026-09-10', '2026-10-09'])
  })
})
