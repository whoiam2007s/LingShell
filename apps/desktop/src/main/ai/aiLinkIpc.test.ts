import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { castEventLine, castHeaderLine } from '@lingshell/shared'
import { registerAiLink, summaryPathOf, type AiLinkDeps } from './aiLinkIpc.js'

function setup(reply: (system: string, user: string) => string | Promise<string>) {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const calls: { system: string; user: string; source: string }[] = []
  const dir = mkdtempSync(join(tmpdir(), 'ailink-'))
  const deps: AiLinkDeps = {
    handle: (ch, fn) => { hs.set(ch, fn) },
    complete: async (system, user, _s, source) => { calls.push({ system, user, source }); return reply(system, user) },
    redact: (t) => t.replaceAll('S3CRET', '[已脱敏]'),
    castPath: (id) => join(dir, id),
  }
  registerAiLink(deps)
  const call = (ch: string, ...a: unknown[]) => hs.get(ch)!(null, ...a) as Promise<unknown>
  return { call, calls, dir }
}

describe('aiLink 预测', () => {
  it('脱敏后发出，返回清洗过的一行命令', async () => {
    const { call, calls } = setup(() => '```\n$ git push\n```')
    expect(await call('aiLink:predict', { commands: ['git commit -m x', 'export T=S3CRET'], outputTail: 'token S3CRET', os: 'linux' })).toBe('git push')
    expect(calls[0].user).not.toContain('S3CRET')
    expect(calls[0].source).toBe('predict-command')
  })
  it('没有命令不调模型；模型出错 / 拿不准 → 空串', async () => {
    const { call, calls } = setup(() => { throw new Error('api_key_not_configured') })
    expect(await call('aiLink:predict', { commands: [] })).toBe('')
    expect(calls).toHaveLength(0)
    expect(await call('aiLink:predict', { commands: ['ls'] })).toBe('')
    const b = setup(() => '#')
    expect(await b.call('aiLink:predict', { commands: ['ls'] })).toBe('')
    const c = setup(() => '6. ls -la')
    expect(await c.call('aiLink:predict', { commands: ['ls'] })).toBe('ls -la')
  })
})

describe('aiLink 录像摘要', () => {
  it('切分 → 模型 → 存 .summary.json，之后可读回', async () => {
    const { call, calls, dir } = setup(() => '[{"t":0.5,"title":"列目录"},{"t":4,"title":"看磁盘"}]')
    const B = '\x1b]133;B\x07', C = '\x1b]133;C\x07'
    const cast = castHeaderLine({ version: 2, width: 80, height: 24, timestamp: 0, title: 'web-1' })
      + castEventLine(0.1, 'o', `$ ${B}`) + castEventLine(0.4, 'i', 'S3CRET-typed\r') + castEventLine(0.5, 'o', `ls\r\n${C}a S3CRET\r\n`)
      + castEventLine(4, 'o', `$ ${B}df -h\r\n${C}/dev/sda1\r\n`)
    writeFileSync(join(dir, 'r.cast'), cast)
    expect(await call('aiLink:summary', 'r.cast')).toBeNull()
    const s = await call('aiLink:summarize', 'r.cast') as { chapters: unknown[] }
    expect(s.chapters).toEqual([{ t: 0.5, title: '列目录' }, { t: 4, title: '看磁盘' }])
    expect(calls[0].user).toContain('命令：ls')
    expect(calls[0].user).toContain('命令：df -h')
    expect(calls[0].user).not.toContain('S3CRET')
    expect(existsSync(summaryPathOf(join(dir, 'r.cast')))).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'r.summary.json'), 'utf8')).chapters).toHaveLength(2)
    expect(await call('aiLink:summary', 'r.cast')).toMatchObject({ version: 1 })
  })
  it('模型没给章节 → 报错、不写文件', async () => {
    const { call, dir } = setup(() => '抱歉')
    writeFileSync(join(dir, 'x.cast'), castHeaderLine({ version: 2, width: 80, height: 24, timestamp: 0 }) + castEventLine(1, 'o', 'hello\r\n'))
    await expect(call('aiLink:summarize', 'x.cast')).rejects.toThrow('章节')
    expect(existsSync(join(dir, 'x.summary.json'))).toBe(false)
  })
})
