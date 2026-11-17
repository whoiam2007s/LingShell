import { describe, it, expect } from 'vitest'
import { AUTO_COMPACT_RATIO, clampCompactRatio, compactionConfig, effectiveLimit } from './compaction.js'

describe('compactionConfig：我方 token 阈值 → 压缩插件比例', () => {
  it('按 1M 窗口换算，保留预算是阈值的 1/5（插件要求 retain < threshold）', () => {
    expect(compactionConfig(600_000)).toEqual({ auto: true, thresholdRatio: 0.6, retainRatio: 0.12 })
    const c = compactionConfig(10_000)
    expect(c.thresholdRatio).toBeCloseTo(0.01)
    expect(c.retainRatio!).toBeLessThan(c.thresholdRatio!)
  })
  it('0 / 负数 = 不自动压缩；过大按窗口 60% 封顶，过小夹到 0.001', () => {
    expect(compactionConfig(0)).toEqual({ auto: false })
    expect(compactionConfig(-1)).toEqual({ auto: false })
    expect(compactionConfig(5_000_000).thresholdRatio).toBe(0.6)
    expect(compactionConfig(1).thresholdRatio).toBe(0.001)
  })
  it('按目标窗口出 modelPolicies：阈值取窗口 60%，比例按适配器自报窗口算；重复目标后者覆盖', () => {
    const c = compactionConfig(600_000, [
      { provider: 'lingshell-ollama', model: 'm', contextWindow: 20_000, adapterWindow: 20_000 },
      { provider: 'lingshell-qwen', model: 'qwen-plus', contextWindow: 131_072, adapterWindow: 131_072 },
      { provider: 'deepseek-official', model: 'd', contextWindow: 100_000, adapterWindow: 1_000_000 },   // 用户把 deepseek 窗口覆盖成 10 万
      { provider: 'lingshell-ollama', model: 'm', contextWindow: 40_000, adapterWindow: 40_000 },
    ])
    expect(c.thresholdRatio).toBe(0.6)   // 默认策略仍按 deepseek 1M
    const by = Object.fromEntries(c.modelPolicies!.map((p) => [`${p.provider}/${p.model}`, p.thresholdRatio]))
    expect(by['lingshell-ollama/m']).toBe(0.6)
    expect(by['lingshell-qwen/qwen-plus']).toBeCloseTo(0.6)
    expect(by['deepseek-official/d']).toBeCloseTo(0.06)
    expect(c.modelPolicies).toHaveLength(3)
    // headroom 按适配器窗口 1/10，夹在 1K–64K
    const head = Object.fromEntries(c.modelPolicies!.map((p) => [`${p.provider}/${p.model}`, p.headroomTokens]))
    expect(head).toEqual({ 'lingshell-ollama/m': 4000, 'lingshell-qwen/qwen-plus': 13_107, 'deepseek-official/d': 65_536 })
    expect(compactionConfig(100_000, [{ provider: 'p', model: 'm', contextWindow: 200_000, adapterWindow: 200_000 }]).modelPolicies![0].thresholdRatio).toBe(0.5)
  })
  it('clampCompactRatio：可填 0.6 或 60，越界夹到 0.2~0.95', () => {
    expect(clampCompactRatio(60)).toBe(0.6)
    expect(clampCompactRatio(0.6)).toBe(0.6)
    expect(clampCompactRatio(undefined)).toBe(AUTO_COMPACT_RATIO)
    expect(clampCompactRatio(5)).toBe(0.2)
    expect(clampCompactRatio(99)).toBe(0.95)
  })

  it('effectiveLimit：按模型配置的比例，默认 60%', () => {
    expect(effectiveLimit(600_000, 1_000_000, 80)).toBe(600_000)   // 800K 被 600K 上限夹住
    expect(effectiveLimit(2_000_000, 128_000, 80)).toBe(102_400)   // 小窗口按比例
    expect(effectiveLimit(2_000_000, 128_000)).toBe(76_800)        // 不填 = 60%
  })

  it('effectiveLimit：min(上限, 窗口 60%)，0 不压缩', () => {
    expect(effectiveLimit(600_000, 32_768)).toBe(19_660)
    expect(effectiveLimit(600_000, 128_000)).toBe(76_800)
    expect(effectiveLimit(600_000, 1_000_000)).toBe(600_000)
    expect(effectiveLimit(0, 32_768)).toBe(0)
  })
})
