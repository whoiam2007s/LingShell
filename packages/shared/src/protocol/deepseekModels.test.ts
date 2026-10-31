import { describe, it, expect } from 'vitest'
import { canonicalModel } from './deepseekModels.js'

describe('canonicalModel', () => {
  it('官方地址上的 DeepSeek 旧 id 换成 deepseek-flash', () => {
    for (const m of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(canonicalModel('deepseek', m)).toBe('deepseek-flash')
      expect(canonicalModel('deepseek', m, 'https://api.deepseek.com/anthropic')).toBe('deepseek-flash')
    }
  })
  it('现行 id、自建网关、其它提供商原样', () => {
    expect(canonicalModel('deepseek', 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(canonicalModel('deepseek', 'deepseek-chat', 'http://gw.local/v1')).toBe('deepseek-chat')
    expect(canonicalModel('deepseek', 'deepseek-chat', 'not a url')).toBe('deepseek-chat')
    expect(canonicalModel('openai-compatible', 'deepseek-chat', 'https://api.deepseek.com')).toBe('deepseek-chat')
  })
})
