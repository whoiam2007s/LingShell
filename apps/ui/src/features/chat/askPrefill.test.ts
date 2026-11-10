import { describe, expect, it } from 'vitest'
import { prefillAsk } from './askPrefill.js'

// 面板「问 AI」预填规则：空 → 填；还是上次自动填的 → 换；用户写了字 → 换行补在下面
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

  it('用户自己写了字：换行补在下面', () => {
    expect(prefillAsk('帮我看看', '面板问题', '')).toBe('帮我看看\n\n面板问题')
    expect(prefillAsk('帮我看看\n', '面板问题', '面板问题')).toBe('帮我看看\n\n面板问题')
  })

  it('用户写了字 + 已自动补过一次：替换掉补的那段，不叠加', () => {
    const first = prefillAsk('帮我看看', '第一句', '')
    expect(first).toBe('帮我看看\n\n第一句')
    expect(prefillAsk(first, '第二句', '第一句')).toBe('帮我看看\n\n第二句')
  })

  it('首尾空白不算改动（自己没打字，只是格式化）', () => {
    expect(prefillAsk('  第一句  ', '第二句', '第一句')).toBe('第二句')
  })
})
