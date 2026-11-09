import { describe, it, expect } from 'vitest'
import {
  THINKING_LEVELS, thinkingLevelsOf, thinkingLevelsOfModel, thinkingSupportedModel,
  thinkingWireOf, thinkingWireOfModel, type ThinkingLevel,
} from './types.js'

describe('思考档位：厂商 + 模型', () => {
  it('未知模型回退厂商级（行为与老版本一致，不因为表没写全就坏）', () => {
    expect(thinkingLevelsOfModel('deepseek', 'deepseek-v9-future')).toEqual(thinkingLevelsOf('deepseek'))
    expect(thinkingLevelsOfModel('openai', undefined)).toEqual(thinkingLevelsOf('openai'))
    expect(thinkingWireOfModel('deepseek', undefined, 'high')).toBe('max')
  })

  it('DeepSeek：deepseek-chat 是非推理模型 → 一档都不给（界面置灰）', () => {
    expect(thinkingLevelsOfModel('deepseek', 'deepseek-chat')).toEqual([])
    expect(thinkingSupportedModel('deepseek', 'deepseek-chat')).toBe(false)
    expect(thinkingWireOfModel('deepseek', 'deepseek-chat', 'medium')).toBeUndefined()
    // reasoner 没有模型级规则 → 沿用厂商级
    expect(thinkingLevelsOfModel('deepseek', 'deepseek-reasoner')).toEqual(thinkingLevelsOf('deepseek'))
  })

  it('OpenAI：gpt-4o / gpt-4.1 / chatgpt-4o 置灰；o 系列与 gpt-5 保留三档', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'chatgpt-4o-latest']) {
      expect(thinkingLevelsOfModel('openai', m), m).toEqual([])
    }
    for (const m of ['o3', 'o4-mini', 'gpt-5']) {
      expect(thinkingSupportedModel('openai', m), m).toBe(true)
      expect(thinkingWireOfModel('openai', m, 'high')).toBe('high')
    }
  })

  it('Gemini：1.5 / 2.0 置灰，2.5 保留', () => {
    expect(thinkingLevelsOfModel('gemini', 'gemini-1.5-pro')).toEqual([])
    expect(thinkingLevelsOfModel('gemini', 'gemini-2.0-flash')).toEqual([])
    expect(thinkingSupportedModel('gemini', 'gemini-2.5-pro')).toBe(true)
  })

  it('Qwen 不写模型级规则（分不干净）→ 仍按厂商级放行，不会误置灰', () => {
    expect(thinkingLevelsOfModel('qwen', 'qwen-max')).toEqual(thinkingLevelsOf('qwen'))
    expect(thinkingSupportedModel('qwen', 'qwen3-235b-a22b')).toBe(true)
  })

  it('按模型查表也走老接口（thinkingWireOf 第三参），老调用点行为不变', () => {
    const lv: ThinkingLevel = 'low'
    expect(thinkingWireOf('deepseek', lv)).toBe('low')
    expect(thinkingWireOf('deepseek', lv, 'deepseek-chat')).toBeUndefined()
    expect(thinkingWireOf('deepseek', undefined, 'deepseek-chat')).toBeUndefined()
    // 四档顺序固定，界面按它渲染
    expect(THINKING_LEVELS).toEqual(['off', 'low', 'medium', 'high'])
  })
})
