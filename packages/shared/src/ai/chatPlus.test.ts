import { describe, it, expect } from 'vitest'
import {
  searchTokens, scoreText, searchChats, searchContextText, tailBytes, shellBlockText, bangCommand, atQueryAt,
  sanitizeAskOptions, normalizeAskAnswer, askResultText, terminalRefText, hostRefText, sessionRefText, type ChatSearchDoc,
} from './chatPlus.js'

describe('searchTokens', () => {
  it('中文切二元组，英文 / 命令 / 路径整段', () => {
    expect(searchTokens('磁盘满了')).toEqual(['磁盘', '盘满', '满了'])
    expect(searchTokens('nginx 502')).toEqual(['nginx', '502'])
    expect(searchTokens('重启nginx')).toEqual(['重启', 'nginx'])
    expect(searchTokens('/var/log/syslog')).toEqual(['/var/log/syslog'])
    expect(searchTokens('「端口」')).toEqual(['端口'])
    expect(searchTokens('  ')).toEqual([])
  })
  it('去重、不区分大小写', () => {
    expect(searchTokens('Nginx nginx')).toEqual(['nginx'])
  })
})

describe('scoreText', () => {
  it('词少时要求全中，词多时覆盖 ≥ 60%', () => {
    expect(scoreText('nginx 502 bad gateway', 'nginx 502').score).toBeGreaterThan(0)
    expect(scoreText('nginx is fine', 'nginx 502').score).toBe(0)
    // 「磁盘空间满了」：磁盘 / 盘空 / 空间 / 间满 / 满了，文本里中 4 个
    expect(scoreText('今天磁盘空间快满了', '磁盘空间满了').score).toBeGreaterThan(0)
    expect(scoreText('内存不够', '磁盘空间满了').score).toBe(0)
  })
  it('整句命中加分，片段位置落在整句处', () => {
    const a = scoreText('先 nginx -t 再 reload', 'nginx -t')
    const b = scoreText('nginx 的配置 -t 检查', 'nginx -t')
    expect(a.score).toBeGreaterThan(b.score)
    expect(a.at).toBe(2)
  })
})

describe('searchChats', () => {
  const docs: ChatSearchDoc[] = [
    { sessionId: 's1', kind: 'user', text: '网站 502 了，帮我看看 nginx', itemId: 'u1', at: 100 },
    { sessionId: 's1', kind: 'cmd', text: 'systemctl restart nginx', itemId: 'c1', at: 200 },
    { sessionId: 's2', kind: 'ai', text: '已经 reload nginx，502 恢复', itemId: 'b1', at: 300 },
    { sessionId: 's3', kind: 'ai', text: '磁盘清理完了', at: 50 },
  ]
  it('按得分再按时间排序，带片段与上下文', () => {
    const r = searchChats(docs, 'nginx')
    expect(r.map((h) => h.itemId)).toEqual(['b1', 'c1', 'u1'])
    expect(r[0].snippet).toContain('nginx')
    expect(r[0].context).toContain('reload nginx')
  })
  it('每个会话最多 perSession 条、总数 limit', () => {
    expect(searchChats(docs, 'nginx', { perSession: 1 }).map((h) => h.sessionId)).toEqual(['s2', 's1'])
    expect(searchChats(docs, 'nginx', { limit: 1 })).toHaveLength(1)
  })
  it('长文本片段截断加省略号', () => {
    const long = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`
    const [h] = searchChats([{ sessionId: 's', kind: 'ai', text: long }], '关键词')
    expect(h.snippet.startsWith('…')).toBe(true)
    expect(h.snippet.endsWith('…')).toBe(true)
    expect(h.snippet.length).toBeLessThan(100)
    expect(h.context.length).toBeLessThanOrEqual(602)
  })
  it('空查询无结果', () => { expect(searchChats(docs, '  ')).toEqual([]) })
  it('「问 AI」上下文文字', () => {
    const t = searchContextText('nginx', searchChats(docs, 'nginx').slice(0, 2).map((h) => ({ ...h, title: `T-${h.sessionId}` })))
    expect(t).toContain('检索「nginx」')
    expect(t).toContain('1. 会话「T-s2」 · AI 回复')
    expect(t).toContain('2. 会话「T-s1」 · 执行过的命令')
  })
})

describe('终端块', () => {
  it('tailBytes：不超就原样；超了留末尾、从整行开始', () => {
    expect(tailBytes('abc')).toEqual({ text: 'abc', truncated: false })
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n')
    const r = tailBytes(lines, 4096)
    expect(r.truncated).toBe(true)
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(4096)
    expect(r.text.endsWith('line-1999')).toBe(true)
    expect(r.text.startsWith('line-')).toBe(true)
  })
  it('tailBytes 按 UTF-8 字节算（中文 3 字节）', () => {
    const r = tailBytes('中'.repeat(2000), 300)
    expect(r.text.length).toBe(100)
  })
  it('shellBlockText', () => {
    const t = shellBlockText({ terminal: '本地 1', command: 'ls', exitCode: 2, output: 'x\n', truncated: true })
    expect(t).toContain('终端「本地 1」')
    expect(t).toContain('$ ls')
    expect(t).toContain('退出码：2')
    expect(t).toContain('只保留末尾 4KB')
    expect(shellBlockText({ terminal: 't', command: 'true', exitCode: 0, output: '' })).toContain('（无输出）')
  })
  it('bangCommand', () => {
    expect(bangCommand('!ls -la')).toBe('ls -la')
    expect(bangCommand('  ! df -h ')).toBe('df -h')
    expect(bangCommand('!')).toBe('')
    expect(bangCommand('看看 !ls')).toBeNull()
  })
})

describe('@ 引用', () => {
  it('atQueryAt：行首或空白后的 @ 到光标', () => {
    expect(atQueryAt('@', 1)).toEqual({ start: 0, q: '' })
    expect(atQueryAt('看看 @web', 7)).toEqual({ start: 3, q: 'web' })
    expect(atQueryAt('看看 @web 的', 7)).toEqual({ start: 3, q: 'web' })
    expect(atQueryAt('a@b', 3)).toBeNull()             // 邮箱之类不算
    expect(atQueryAt('@web 的', 6)).toBeNull()          // 光标已离开 @ 词
    expect(atQueryAt('第一行\n@lo', 7)).toEqual({ start: 4, q: 'lo' })
  })
  it('上下文文字带名称与 id', () => {
    expect(terminalRefText('本地 1', 'term_ab12')).toBe('用户指定在终端「本地 1」（terminal_id: term_ab12）上操作。')
    expect(hostRefText('web1', 'h1', 'web')).toContain('host_id: h1，分组：web')
    expect(hostRefText('web1', 'h1')).toContain('create_terminal（type=ssh，hostId=h1）')
    expect(sessionRefText('排查 502', '最近活动 2026-10-01', '')).toContain('（这个会话还没有内容）')
  })
})

describe('ask_user', () => {
  it('sanitizeAskOptions：字符串 / 对象都认，去空去重，最多 8 个', () => {
    expect(sanitizeAskOptions(['重启', { label: 'reload', description: '不断连接' }, { label: '重启' }, { label: ' ' }, null]))
      .toEqual([{ label: '重启' }, { label: 'reload', description: '不断连接' }])
    expect(sanitizeAskOptions(Array.from({ length: 12 }, (_, i) => `o${i}`))).toHaveLength(8)
    expect(sanitizeAskOptions('x')).toEqual([])
  })
  const req = { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: false, allowOther: true }
  it('normalizeAskAnswer：只认原选项；单选留一个；其他只在允许时收；全空 = null', () => {
    expect(normalizeAskAnswer(req, { selected: ['B', 'X', 'C'] })).toEqual({ selected: ['B'] })
    expect(normalizeAskAnswer({ ...req, multiSelect: true }, { selected: ['C', 'A', 'C'] })).toEqual({ selected: ['C', 'A'] })
    expect(normalizeAskAnswer(req, { selected: [], other: ' 先备份 ' })).toEqual({ selected: [], other: '先备份' })
    expect(normalizeAskAnswer({ ...req, allowOther: false }, { selected: [], other: '先备份' })).toBeNull()
    expect(normalizeAskAnswer(req, { selected: [] })).toBeNull()
    expect(normalizeAskAnswer(req, 'A')).toBeNull()
  })
  it('askResultText', () => {
    expect(JSON.parse(askResultText({ selected: ['A'], other: 'x' }))).toEqual({ answered: true, selected: ['A'], other: 'x' })
    expect(JSON.parse(askResultText(null)).answered).toBe(false)
  })
})
