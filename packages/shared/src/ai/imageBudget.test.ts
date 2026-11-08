import { describe, it, expect } from 'vitest'
import { IMAGE_MAX_TOTAL_BYTES, base64Bytes, fitImageBudget } from './attachments.js'

describe('图片总量预算', () => {
  it('base64 长度换算成字节数（含尾部 = / == 的补齐）', () => {
    // 'AAAA' → 3 字节；'AAA=' → 2 字节；'AA==' → 1 字节
    expect(base64Bytes('AAAA')).toBe(3)
    expect(base64Bytes('AAA=')).toBe(2)
    expect(base64Bytes('AA==')).toBe(1)
    expect(base64Bytes('')).toBe(0)
  })

  it('都在预算内时全放行', () => {
    expect(fitImageBudget([1024, 2048, 4096])).toBe(3)
  })

  it('超出后从尾部截断，返回「放得下」的张数', () => {
    const each = Math.ceil(IMAGE_MAX_TOTAL_BYTES / 2)      // 每张占一半预算
    expect(fitImageBudget([each, each, each])).toBe(2)
    expect(fitImageBudget([each * 3])).toBe(0)             // 第一张就超了
  })

  it('刚好等于上限时算放得下（不因浮点/取整误杀）', () => {
    expect(fitImageBudget([IMAGE_MAX_TOTAL_BYTES])).toBe(1)
  })

  it('空列表返回 0（调用方按 0 张处理，不报错）', () => {
    expect(fitImageBudget([])).toBe(0)
  })
})
