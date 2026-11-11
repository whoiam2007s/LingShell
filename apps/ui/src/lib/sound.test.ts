import { describe, it, expect } from 'vitest'
import { cueOf } from './sound.js'

describe('事件 → 提示音', () => {
  it('回合完成响 done', () => {
    expect(cueOf({ turnEnded: true })).toBe('done')
  })

  it('等你确认 / 交互响 wait', () => {
    expect(cueOf({ awaiting: true })).toBe('wait')
  })

  it('两件事同时发生：以「等你处理」优先（更需要你动手）', () => {
    expect(cueOf({ turnEnded: true, awaiting: true })).toBe('wait')
  })

  it('什么都不是就不响', () => {
    expect(cueOf({})).toBeNull()
    expect(cueOf({ turnEnded: false, awaiting: false })).toBeNull()
  })
})
