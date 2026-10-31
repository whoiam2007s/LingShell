import { afterEach, describe, expect, it } from 'vitest'
import { EN } from './locales/en/index.js'
import { dateLocale, getLocale, placeholdersOf, resolveLocale, setLocale, tk, tr, trParts } from './i18n.js'

afterEach(() => setLocale('zh-CN'))

describe('i18n', () => {
  it('默认中文：原样返回键，占位符照填', () => {
    expect(getLocale()).toBe('zh-CN')
    expect(tr('跟随系统')).toBe('跟随系统')
    expect(tr('删除 {n} 个', { n: 3 })).toBe('删除 3 个')
    expect(tr('{a} 和 {b}', { a: 1 })).toBe('1 和 {b}')   // 没给的占位符原样留着，便于发现
  })
  it('英文：有译文用译文，没有退回中文', () => {
    setLocale('en')
    expect(tr('跟随系统')).toBe('Follow system')
    expect(tr('这句没有译文')).toBe('这句没有译文')
    expect(dateLocale()).toBe('en-US')
  })
  it('tk 只做标记', () => { expect(tk('只读')).toBe('只读') })
  it('语境前缀：中文去掉前缀，英文按整键查', () => {
    expect(tr('size|中')).toBe('中')
    setLocale('en')
    expect(tr('size|中')).toBe('Medium')
    expect(tr('nope|没有')).toBe('没有')
    expect(tr('a|b 不是前缀的竖线')).toBe('b 不是前缀的竖线')
  })
  it('resolveLocale：显式设置优先，auto 看系统语言', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolveLocale('auto', 'zh-TW')).toBe('zh-CN')
    expect(resolveLocale('auto', 'en-GB')).toBe('en')
    expect(resolveLocale(undefined, undefined)).toBe('en')
  })
  it('trParts：占位符换成组件', () => {
    expect(trParts('点 {btn} 保存', { btn: 'B' })).toEqual(['点 ', 'B', ' 保存'])
    expect(trParts('{x}', { x: 1 })).toEqual([1])
  })
  it('英文词典：译文非空、不含中文、占位符与原文一致', () => {
    for (const [zh, en] of Object.entries(EN)) {
      expect(en.trim(), zh).not.toBe('')
      expect(/[一-鿿]/.test(en), `${zh} → ${en}`).toBe(false)
      expect(placeholdersOf(en), `${zh} → ${en}`).toEqual(placeholdersOf(zh))
    }
  })
})
