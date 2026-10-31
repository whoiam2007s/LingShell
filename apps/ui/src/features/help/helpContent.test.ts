import { describe, it, expect } from 'vitest'
import { HELP_SECTIONS, filterHelp, blockText, type HelpSection } from './helpContent.js'

describe('HELP_SECTIONS', () => {
  it('id 唯一、标题和内容非空', () => {
    const ids = HELP_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of HELP_SECTIONS) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/)
      expect(s.title.trim()).not.toBe('')
      expect(s.icon).toBeTruthy()
      expect(s.blocks.length).toBeGreaterThan(0)
      for (const b of s.blocks) {
        expect(blockText(b).trim()).not.toBe('')
        for (const x of [...(b.steps ?? []), ...(b.tips ?? [])]) expect(x.trim()).not.toBe('')
      }
    }
  })
  it('含快速开始、快捷键、常见问题', () => {
    expect(HELP_SECTIONS[0].id).toBe('quickstart')
    expect(HELP_SECTIONS.some((s) => s.id === 'shortcuts')).toBe(true)
    expect(HELP_SECTIONS.some((s) => s.id === 'faq')).toBe(true)
  })
})

describe('filterHelp', () => {
  const icon = HELP_SECTIONS[0].icon
  const secs: HelpSection[] = [
    { id: 'a', title: '终端', icon, blocks: [{ p: '广播输入 Broadcast' }, { steps: ['按 Ctrl+F 搜索'] }] },
    { id: 'b', title: '主机与连接', icon, blocks: [{ h: '跳板机', tips: ['支持 SOCKS5'] }] },
    { id: 'c', title: '快捷键', icon, blocks: [{ keys: [['F1', '使用帮助']] }] },
  ]
  it('空查询返回全部', () => {
    expect(filterHelp(secs, '  ')).toBe(secs)
  })
  it('按标题 / 正文 / 步骤 / 提示 / 快捷键匹配，不区分大小写', () => {
    expect(filterHelp(secs, '终端').map((s) => s.id)).toEqual(['a'])
    expect(filterHelp(secs, 'broadcast').map((s) => s.id)).toEqual(['a'])
    expect(filterHelp(secs, 'ctrl+f').map((s) => s.id)).toEqual(['a'])
    expect(filterHelp(secs, 'socks5').map((s) => s.id)).toEqual(['b'])
    expect(filterHelp(secs, 'f1').map((s) => s.id)).toEqual(['c'])
  })
  it('多词须同一章节都命中', () => {
    expect(filterHelp(secs, '跳板机 socks5').map((s) => s.id)).toEqual(['b'])
    expect(filterHelp(secs, '跳板机 广播')).toEqual([])
  })
  it('无匹配返回空', () => {
    expect(filterHelp(secs, '不存在的词')).toEqual([])
  })
})
