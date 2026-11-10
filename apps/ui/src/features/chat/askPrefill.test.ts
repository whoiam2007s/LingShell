import { describe, expect, it } from 'vitest'
import { prefillAsk } from './askPrefill.js'

// 面板「问 AI」预填规则：空 → 填；还是上次自动填的 → 换；用户改过 → 不覆盖
describe('prefillAsk', () => {
  it('空输入框：用问题预填', () => {
    expect(prefillAsk('', '这条告警怎么查', '')).toBe('这条告警怎么查')
    expect(prefillAsk('   \n', '第一句', '')).toBe('第一句')
  })

  it('连着点两个面板：换成新的那句，不叠加旧问题', () => {
    const a = prefillAsk('', '第一句', '')
    expect(a).toBe('第一句')
    expect(prefillAsk(a, '第二句', '第一句')).toBe('第二句')
  })

  it('用户自己改过：不覆盖', () => {
    expect(prefillAsk('我自己写的', '面板问题', '面板问题')).toBe('我自己写的')
    expect(prefillAsk('第一句 + 我补的半句', '第二句', '第一句')).toBe('第一句 + 我补的半句')
  })

  it('首尾空白不算改动（自己没打字，只是格式化）', () => {
    expect(prefillAsk('  第一句  ', '第二句', '第一句')).toBe('第二句')
  })
})
