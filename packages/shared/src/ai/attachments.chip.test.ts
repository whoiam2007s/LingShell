import { describe, it, expect } from 'vitest'
import { CHIP_PREVIEW_CHARS, chipPreview } from './attachments.js'

describe('chip 气泡预览（长内容折叠）', () => {
  it('短文本原样返回，不标截断', () => {
    const r = chipPreview('nginx: 12 个 worker')
    expect(r).toEqual({ preview: 'nginx: 12 个 worker', truncated: false, chars: 'nginx: 12 个 worker'.length })
  })

  it('刚好到上限也算不截断', () => {
    const t = 'x'.repeat(CHIP_PREVIEW_CHARS)
    expect(chipPreview(t).truncated).toBe(false)
  })

  it('超长只给前 400 字，但报出总字数（发送时仍是全文）', () => {
    const r = chipPreview('y'.repeat(5000))
    expect(r.preview).toHaveLength(CHIP_PREVIEW_CHARS)
    expect(r.truncated).toBe(true)
    expect(r.chars).toBe(5000)
  })

  it('空值不炸', () => {
    expect(chipPreview('').truncated).toBe(false)
    expect(chipPreview(undefined as unknown as string).chars).toBe(0)
  })
})
