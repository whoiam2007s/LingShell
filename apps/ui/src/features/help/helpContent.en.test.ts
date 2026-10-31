import { describe, it, expect, afterEach } from 'vitest'
import { setLocale } from '@lingshell/shared'
import { HELP_SECTIONS, helpSections, blockText, type HelpBlock } from './helpContent.js'
import { HELP_SECTIONS_EN, HELP_SETTINGS_TITLES_EN } from './helpContent.en.js'
import { buildHelpIndex, searchHelp, helpSnippet } from './helpSearch.js'
import { linkify } from './helpLinks.js'

const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/
const shape = (b: HelpBlock) => ({ h: !!b.h, p: !!b.p, steps: b.steps?.length ?? -1, tips: b.tips?.length ?? -1, keys: b.keys?.length ?? -1 })

describe('英文帮助与中文结构一致', () => {
  it('章节顺序、id、图标、settings 相同', () => {
    expect(HELP_SECTIONS_EN.map((s) => s.id)).toEqual(HELP_SECTIONS.map((s) => s.id))
    HELP_SECTIONS.forEach((z, i) => {
      const e = HELP_SECTIONS_EN[i]
      expect(e.icon, z.id).toBe(z.icon)
      expect(e.settings, z.id).toBe(z.settings)
    })
  })
  it('每章块数、块字段、步骤 / 提示 / 快捷键行数相同', () => {
    HELP_SECTIONS.forEach((z, i) => {
      const e = HELP_SECTIONS_EN[i]
      expect(e.blocks.map(shape), z.id).toEqual(z.blocks.map(shape))
    })
  })
  it('英文里没有中文 / 全角字符，内容非空', () => {
    for (const s of HELP_SECTIONS_EN) {
      expect(s.title, s.id).not.toMatch(CJK)
      expect(s.title.trim()).not.toBe('')
      for (const b of s.blocks) {
        const text = blockText(b)
        expect(text, s.id).not.toMatch(CJK)
        expect(text.trim()).not.toBe('')
        for (const x of [...(b.steps ?? []), ...(b.tips ?? []), ...(b.keys ?? []).flat()]) expect(x.trim()).not.toBe('')
      }
    }
  })
  it('反引号奇偶与中文一致（代码样式不会错位）', () => {
    const odd = (x?: string) => (x?.match(/`/g) ?? []).length % 2
    const texts = (b: HelpBlock) => [b.h, b.p, ...(b.steps ?? []), ...(b.tips ?? [])]
    HELP_SECTIONS.forEach((z, i) => z.blocks.forEach((zb, j) => {
      const eb = texts(HELP_SECTIONS_EN[i].blocks[j])
      texts(zb).forEach((x, k) => expect(odd(eb[k]), `${z.id}: ${eb[k]}`).toBe(odd(x)))
    }))
  })
})

describe('helpSections 按界面语言取', () => {
  afterEach(() => setLocale('zh-CN'))
  it('中文 / 英文', () => {
    expect(helpSections()).toBe(HELP_SECTIONS)
    setLocale('en')
    expect(helpSections()).toBe(HELP_SECTIONS_EN)
  })
})

describe('英文帮助的链接与搜索', () => {
  it('"Settings → 页名" 和 "功能名" 变链接，拼回去不丢字', () => {
    expect(linkify('Open "Settings → AI & security → App lock" first', HELP_SETTINGS_TITLES_EN)).toEqual([
      'Open "', { text: 'Settings → AI & security', action: { kind: 'settings', tab: 'ai' } }, ' → App lock" first',
    ])
    expect(linkify('Settings → Terminal recordings', HELP_SETTINGS_TITLES_EN)[0]).toEqual({ text: 'Settings → Terminal recordings', action: { kind: 'settings', tab: 'recordings' } })
    expect(linkify('Click "Containers (Docker)" or "Unknown"', HELP_SETTINGS_TITLES_EN)[1]).toEqual({ text: '"Containers (Docker)"', action: { kind: 'palette', cmd: { type: 'termDrawer', drawer: 'docker' } } })
    expect(linkify('a "b" c', { ...HELP_SETTINGS_TITLES_EN, about: ['About', 'b'] })[1]).toEqual({ text: '"b"', action: { kind: 'settings', tab: 'about' } })
    for (const s of HELP_SECTIONS_EN) for (const b of s.blocks) {
      const text = blockText(b)
      expect(linkify(text, HELP_SETTINGS_TITLES_EN).map((p) => typeof p === 'string' ? p : p.text).join('')).toBe(text)
    }
  })
  it('英文帮助里的入口大多能点', () => {
    const linked = HELP_SECTIONS_EN.filter((s) => s.blocks.some((b) => linkify(blockText(b), HELP_SETTINGS_TITLES_EN).some((p) => typeof p !== 'string')))
    expect(linked.length).toBeGreaterThan(HELP_SECTIONS_EN.length / 2)
  })
  it('英文搜索：不区分大小写、多词 AND，片段不切半个单词', () => {
    const idx = buildHelpIndex(HELP_SECTIONS_EN)
    const r = searchHelp(idx, 'PORT forwarding')
    expect(r.length).toBeGreaterThan(0)
    for (const h of r) for (const t of ['port', 'forwarding']) expect(`${h.doc.sectionTitle} ${h.doc.h ?? ''} ${h.doc.body}`.toLowerCase()).toContain(t)
    expect(r.some((h) => /port forwarding/i.test(`${h.doc.h ?? ''} ${h.doc.body}`))).toBe(true)
    expect(searchHelp(idx, 'jump host').length).toBeGreaterThan(0)
    for (const h of r) {
      const s = h.snippet.replace(/^…/, '').replace(/…$/, '')
      const body = h.doc.body
      const at = body.indexOf(s)
      expect(at, h.snippet).toBeGreaterThanOrEqual(0)
      if (at > 0) expect(/\w\w/.test(body.slice(at - 1, at + 1)), h.snippet).toBe(false)
      const end = at + s.length
      if (end < body.length) expect(/\w\w/.test(body.slice(end - 1, end + 1)), h.snippet).toBe(false)
    }
  })
  it('英文片段：窗口更长、截在词边界', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const s = helpSnippet(words, ['word40'])
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
    expect(s).toContain('word40')
    expect(s).toMatch(/^…word\d+ /)
    expect(s).toMatch(/ word\d+…$/)
    expect(s.length).toBeGreaterThan(100)
  })
})
