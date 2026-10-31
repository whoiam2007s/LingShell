import { describe, it, expect } from 'vitest'
import { HELP_SECTIONS } from './helpContent.js'
import { buildHelpIndex, searchHelp, helpSnippet, helpSectionHits, splitHighlight } from './helpSearch.js'

const secs = [
  { id: 'term', title: '终端', blocks: [
    { p: '终端区右上角「+」打开本地终端。' },
    { h: '广播输入', steps: ['点工具栏「广播输入」或按 Ctrl+Shift+B。', '在组内任一终端键入'] },
    { h: '粘贴安全检查', p: '往任何终端粘贴含危险命令（如 `rm -rf`）时先确认。', tips: ['开关在设置里'] },
  ] },
  { id: 'hosts', title: '主机与连接', blocks: [
    { h: '端口转发与 SOCKS5', p: '本地转发、动态转发、远程转发。' },
    { h: '凭据', p: '多台主机共用账号，改一次密码都生效。' },
    { p: '这里也提到端口转发，但只在正文里。' },
  ] },
  { id: 'keys', title: '快捷键', blocks: [{ keys: [['Ctrl+K', '打开命令面板']] as [string, string][] }] },
]
const idx = buildHelpIndex(secs)
const ids = (q: string) => searchHelp(idx, q).map((h) => `${h.doc.section}:${h.doc.block}`)

describe('buildHelpIndex', () => {
  it('每章一条章节条目 + 每块一条，正文合并段落 / 步骤 / 提示 / 快捷键并去掉反引号', () => {
    expect(idx).toHaveLength(3 + 3 + 3 + 1)
    const paste = idx.find((d) => d.h === '粘贴安全检查')!
    expect(paste).toMatchObject({ section: 'term', block: 2, sectionTitle: '终端' })
    expect(paste.body).toContain('rm -rf')
    expect(paste.body).not.toContain('`')
    expect(paste.body).toContain('开关在设置里')
    expect(idx.find((d) => d.section === 'keys' && d.block === 0)!.body).toBe('Ctrl+K 打开命令面板')
  })
  it('真实帮助内容：运行时生成，所有块都进索引', () => {
    const real = buildHelpIndex(HELP_SECTIONS)
    expect(real.length).toBe(HELP_SECTIONS.reduce((n, s) => n + 1 + s.blocks.length, 0))
    expect(searchHelp(real, '端口转发')[0].doc.h).toContain('端口转发')
    expect(searchHelp(real, '粘贴').some((h) => h.doc.h === '粘贴安全检查')).toBe(true)
    expect(searchHelp(real, '凭据').length).toBeGreaterThan(0)
  })
})

describe('searchHelp', () => {
  it('空查询无结果', () => {
    expect(searchHelp(idx, '   ')).toEqual([])
  })
  it('章节标题 > 小节标题 > 正文', () => {
    expect(ids('终端')[0]).toBe('term:-1')
    const r = ids('端口转发')
    expect(r[0]).toBe('hosts:0')          // 小节标题
    expect(r).toContain('hosts:2')        // 正文命中排后面
    expect(r.indexOf('hosts:0')).toBeLessThan(r.indexOf('hosts:2'))
  })
  it('只中章节标题的块不列出（避免整章刷屏），组合词可借章节标题', () => {
    expect(ids('主机与连接')).toEqual(['hosts:-1'])
    expect(ids('终端 广播')).toContain('term:1')
  })
  it('多关键词 AND、不区分大小写', () => {
    expect(ids('socks5 动态')).toEqual(['hosts:0'])
    expect(ids('ctrl+shift+b')).toEqual(['term:1'])
    expect(ids('广播 socks5')).toEqual([])
  })
  it('limit 生效，片段含命中词', () => {
    expect(searchHelp(idx, '终端', 2)).toHaveLength(2)
    const h = searchHelp(idx, '密码')[0]
    expect(h.doc.h).toBe('凭据')
    expect(h.snippet).toContain('密码')
  })
})

describe('helpSnippet', () => {
  const t = '一二三四五六七八九十'.repeat(10)
  it('短文本原样返回', () => {
    expect(helpSnippet('abc def', ['def'])).toBe('abc def')
  })
  it('命中处前留若干字，两端省略号', () => {
    const s = helpSnippet(t + '端口转发' + t, ['端口转发'], 5, 20)
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(s.indexOf('端口转发')).toBe(6)
  })
  it('靠近末尾时窗口回退保持满长；没命中取开头', () => {
    const s = helpSnippet(t + '尾巴', ['尾巴'], 5, 20)
    expect(s).toBe('…' + (t + '尾巴').slice(-20))
    expect(helpSnippet(t, ['不存在'], 5, 20)).toBe(t.slice(0, 20) + '…')
  })
})

describe('helpSectionHits', () => {
  it('每章取最好的那一块', () => {
    const m = helpSectionHits(idx, '端口转发')
    expect(m.get('hosts')).toMatchObject({ block: 0 })
    expect(m.has('term')).toBe(false)
  })
})

describe('splitHighlight', () => {
  it('多词多处命中、重叠合并、不区分大小写', () => {
    expect(splitHighlight('SOCKS5 与 socks', ['socks'])).toEqual([
      { text: 'SOCKS', hit: true }, { text: '5 与 ', hit: false }, { text: 'socks', hit: true },
    ])
    expect(splitHighlight('端口转发', ['端口', '口转'])).toEqual([{ text: '端口转', hit: true }, { text: '发', hit: false }])
    expect(splitHighlight('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlight('', ['a'])).toEqual([])
  })
})
