import { describe, it, expect } from 'vitest'
import { dismissKey, failCommandLabel, shouldOfferFix } from './failHint.js'

const base = { command: 'ls /nonexist', enabled: true, aiBusy: false, dismissed: new Set<string>() }

describe('命令失败横幅：出现条件', () => {
  it('用户命令非 0 退出码 → 出现', () => {
    expect(shouldOfferFix({ ...base, exitCode: 2 })).toBe(true)
    expect(shouldOfferFix({ ...base, exitCode: 1, command: '' })).toBe(true)
    expect(shouldOfferFix({ ...base, exitCode: 137 })).toBe(true)   // 被 kill -9 也算失败
  })
  it('成功 / 无退出码 / Ctrl+C（130）/ Ctrl+Z（148）不出现', () => {
    for (const exitCode of [0, undefined, 130, 148]) expect(shouldOfferFix({ ...base, exitCode })).toBe(false)
  })
  it('AI 执行中、关了开关、同一命令按 × 关过 → 不出现', () => {
    expect(shouldOfferFix({ ...base, exitCode: 1, aiBusy: true })).toBe(false)
    expect(shouldOfferFix({ ...base, exitCode: 1, enabled: false })).toBe(false)
    const dismissed = new Set([dismissKey('  ls /nonexist ')])
    expect(shouldOfferFix({ ...base, exitCode: 1, dismissed })).toBe(false)
    expect(shouldOfferFix({ ...base, exitCode: 1, dismissed, command: 'false' })).toBe(true)
  })
})

describe('横幅里的命令', () => {
  it('多行取首行、超长截断、空命令为空串', () => {
    expect(failCommandLabel('for i in 1 2\n do echo $i; done')).toBe('for i in 1 2')
    expect(failCommandLabel('x'.repeat(70), 60)).toBe('x'.repeat(60) + '…')
    expect(failCommandLabel('  \n')).toBe('')
  })
})
