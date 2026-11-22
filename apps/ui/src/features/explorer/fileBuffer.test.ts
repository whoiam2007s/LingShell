import { describe, it, expect } from 'vitest'
import { buildDiskText, discardedText, eolOf, isDirty, normalizeEolText } from './fileBuffer.js'

describe('换行符判定', () => {
  it('没有内容时不判（undefined）', () => {
    expect(eolOf(undefined)).toBeUndefined()
  })
  it('混用时按数量多的那种，并标出混用', () => {
    expect(eolOf('a\r\nb\r\nc\n')).toMatchObject({ eol: 'crlf', mixed: true, crlf: 2, lf: 1 })
    expect(eolOf('a\nb\nc\r\n')).toMatchObject({ eol: 'lf', mixed: true, crlf: 1, lf: 2 })
  })
  it('全 LF / 全 CRLF', () => {
    expect(eolOf('a\nb')).toMatchObject({ eol: 'lf', mixed: false })
    expect(eolOf('a\r\nb')).toMatchObject({ eol: 'crlf', mixed: false })
  })
})

describe('落盘文本', () => {
  it('原文件以换行结尾：编辑区丢了末尾换行也要补回来', () => {
    expect(buildDiskText('a\nb', { finalNewline: true, eol: 'lf' })).toBe('a\nb\n')
    expect(buildDiskText('a', { finalNewline: true, eol: 'crlf' })).toBe('a\r\n')
  })
  it('原文件不以换行结尾：不擅自加', () => {
    expect(buildDiskText('a\nb', { finalNewline: false, eol: 'lf' })).toBe('a\nb')
  })
  it('切 CRLF 时逐行替换，且不会把已有的 CRLF 变成 CRCRLF', () => {
    expect(buildDiskText('a\nb', { finalNewline: false, eol: 'crlf' })).toBe('a\r\nb')
  })
  it('空内容保持空', () => {
    expect(buildDiskText('', { finalNewline: true, eol: 'crlf' })).toBe('')
  })
})

describe('未保存改动判定', () => {
  const base = 'a\r\nb\r\n'
  it('刚打开时不算改动（编辑区是 LF、磁盘是 CRLF）', () => {
    expect(isDirty({ base, text: 'a\nb', eol: 'crlf', baseEol: 'crlf' })).toBe(false)
  })
  it('内容变了算改动', () => {
    expect(isDirty({ base, text: 'a\nc', eol: 'crlf', baseEol: 'crlf' })).toBe(true)
  })
  it('只切换行符也算改动（否则保存按钮会变灰）', () => {
    expect(isDirty({ base, text: 'a\nb', eol: 'lf', baseEol: 'crlf' })).toBe(true)
  })
  it('还没读到内容时不算改动', () => {
    expect(isDirty({ base: undefined, text: 'x', eol: 'crlf', baseEol: 'lf' })).toBe(false)
  })
  it('丢弃后必须回到「没改动」：文本与换行符一起复位', () => {
    const text = discardedText(base)   // 编辑区
    expect(isDirty({ base, text, eol: eolOf(base)!.eol, baseEol: eolOf(base)!.eol })).toBe(false)
  })
})

describe('归一化', () => {
  it('只把 CRLF 变 LF，单独的 CR 不动', () => {
    expect(normalizeEolText('a\r\nb\rc')).toBe('a\nb\rc')
  })
})
