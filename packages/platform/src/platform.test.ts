import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAppPaths, logSessionDir, pruneLogDirs, makeStartedAtLabel, Logger } from './index.js'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'lingshell-plat-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('resolveAppPaths', () => {
  it('creates config/logs/sessions under root', () => {
    const p = resolveAppPaths(tmp)
    expect(existsSync(p.config)).toBe(true)
    expect(existsSync(p.logs)).toBe(true)
    expect(existsSync(p.sessions)).toBe(true)
    expect(existsSync(p.recordings)).toBe(true)
  })
})

describe('makeStartedAtLabel', () => {
  it('formats timestamp as YYYY-MM-DD_HH-mm-ss', () => {
    const label = makeStartedAtLabel(new Date(Date.UTC(2026, 5, 29, 7, 8, 9)))
    // 用本地时间格式化；只校验形状
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
  })
})

describe('Logger', () => {
  it('writes main and web logs to separate files', async () => {
    const p = resolveAppPaths(tmp)
    const dir = logSessionDir(p.logs, '2026-06-29_10-00-00')
    const logger = new Logger(dir, { mirrorConsole: false })
    logger.write({ level: 'info', source: 'main', message: 'hello main', time: '2026-06-29T10:00:00Z' })
    logger.write({ level: 'error', source: 'web', scope: 'chat', message: 'oops', data: { code: 1 }, time: '2026-06-29T10:00:01Z' })
    await logger.close()

    const mainLog = readFileSync(join(dir, 'main.log'), 'utf8')
    const webLog = readFileSync(join(dir, 'web.log'), 'utf8')
    expect(mainLog).toContain('hello main')
    expect(mainLog).toContain('[main]')
    expect(webLog).toContain('oops')
    expect(webLog).toContain('[chat]')
    expect(webLog).toContain('{"code":1}')
  })

  it('respects minLevel filter', async () => {
    const p = resolveAppPaths(tmp)
    const dir = logSessionDir(p.logs, '2026-06-29_11-00-00')
    const logger = new Logger(dir, { minLevel: 'warn', mirrorConsole: false })
    logger.write({ level: 'debug', source: 'main', message: 'should be filtered' })
    logger.write({ level: 'warn', source: 'main', message: 'should appear' })
    await logger.close()
    const mainLog = readFileSync(join(dir, 'main.log'), 'utf8')
    expect(mainLog).not.toContain('should be filtered')
    expect(mainLog).toContain('should appear')
  })

  it('日志文件写入失败不崩进程，降级为仅控制台', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const logger = new Logger(join(tmp, 'missing-dir'), { mirrorConsole: false })   // 目录不存在 → 打开失败触发 'error'
      logger.write({ level: 'info', source: 'main', message: 'first' })
      await new Promise((r) => setTimeout(r, 50))
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('降级为仅控制台'))
      logger.write({ level: 'info', source: 'main', message: 'after-fail' })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('after-fail'))
      await logger.close()
    } finally { errSpy.mockRestore(); logSpy.mockRestore() }
  })
})

describe('pruneLogDirs', () => {
  it('按时间只留最近 N 个运行目录；格式不对的目录不碰', () => {
    for (const d of ['2026-01-01_00-00-00', '2026-03-01_00-00-00', '2026-02-01_00-00-00', '2026-04-01_00-00-00', 'keep-me']) mkdirSync(join(tmp, d))
    expect(pruneLogDirs(tmp, 2)).toEqual(['2026-01-01_00-00-00', '2026-02-01_00-00-00'])
    expect(readdirSync(tmp).sort()).toEqual(['2026-03-01_00-00-00', '2026-04-01_00-00-00', 'keep-me'])
    expect(pruneLogDirs(tmp, 2)).toEqual([])
  })
})

describe('resolveAppPaths 默认根目录（临时 home，不碰真实目录）', () => {
  it('在 home 下建 .lingshell 及子目录', () => {
    const p = resolveAppPaths(undefined, tmp)
    expect(p.root).toBe(join(tmp, '.lingshell'))
    expect(existsSync(p.config)).toBe(true)
    expect(existsSync(p.logs)).toBe(true)
  })
  it('指定了数据目录：用它，不碰 home 下的目录', () => {
    const p = resolveAppPaths(join(tmp, 'custom'), tmp)
    expect(p.root).toBe(join(tmp, 'custom'))
    expect(existsSync(join(tmp, '.lingshell'))).toBe(false)
  })
})
