import { describe, expect, it } from 'vitest'
import { INPUT_MAX, capInput, insertCapped, tooLong } from './composer.js'

describe('insertCapped', () => {
  it('额度够时原样插入，光标落在插入内容之后', () => {
    const r = insertCapped('你好', '世界')
    expect(r.value).toBe('你好世界')
    expect(r.caret).toBe(4)
    expect(r.cut).toBe(0)
  })

  it('超长时只插入剩余额度，并报出截掉多少字', () => {
    const cur = 'x'.repeat(INPUT_MAX - 10)
    const r = insertCapped(cur, 'y'.repeat(100))
    expect(r.value.length).toBe(INPUT_MAX)
    expect(r.kept).toBe(10)
    expect(r.cut).toBe(90)
    expect(r.value.endsWith('y'.repeat(10))).toBe(true)
  })

  it('在选区中间插入：先删选区再算额度', () => {
    const cur = 'abcdef'
    const r = insertCapped(cur, 'XY', 1, 4)   // 替换 bcd
    expect(r.value).toBe('aXYef')
    expect(r.caret).toBe(3)
  })

  it('已经满了：一个都不插，全部算截掉', () => {
    const cur = 'x'.repeat(INPUT_MAX)
    const r = insertCapped(cur, 'abc')
    expect(r.value).toBe(cur)
    expect(r.kept).toBe(0)
    expect(r.cut).toBe(3)
  })

  it('6MB 粘贴只留 5000 字（不卡的关键）', () => {
    const r = insertCapped('', 'a'.repeat(6 * 1024 * 1024))
    expect(r.value.length).toBe(INPUT_MAX)
    expect(r.cut).toBeGreaterThan(6_000_000)
  })

  it('越界的光标位置被夹回文本范围', () => {
    expect(insertCapped('ab', 'c', 99, 99).value).toBe('abc')
    expect(insertCapped('ab', 'c', -5, 1).value).toBe('cb')
  })
})

describe('capInput / tooLong', () => {
  it('capInput 按上限裁剪并报截断', () => {
    const r = capInput('z'.repeat(INPUT_MAX + 20))
    expect(r.value.length).toBe(INPUT_MAX)
    expect(r.cut).toBe(20)
  })

  it('tooLong 按字符数判断', () => {
    expect(tooLong('a'.repeat(INPUT_MAX))).toBe(false)
    expect(tooLong('a'.repeat(INPUT_MAX + 1))).toBe(true)
  })
})
