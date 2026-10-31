import { describe, it, expect } from 'vitest'
import { AuthRegistry, type AuthStore } from './AuthRegistry.js'

function memStore(): AuthStore & { saved: () => string } {
  let state = { records: [] as never[], trust: {} as Record<string, never> }
  return { load: () => state, save: (s) => { state = s as typeof state }, saved: () => JSON.stringify(state) }
}

describe('AuthRegistry 限时提权', () => {
  it('期内有效、到期自动收回；按会话 + 主机隔离；不落盘', () => {
    let now = 1_000_000
    const store = memStore()
    const reg = new AuthRegistry({ store, now: () => now })
    const until = reg.grantSudo('s1', 'h1', 15)
    expect(until).toBe(now + 15 * 60_000)
    expect(reg.sudoUntil('s1', 'h1')).toBe(until)
    expect(reg.sudoUntil('s1', 'h2')).toBeUndefined()
    expect(reg.sudoUntil('s2', 'h1')).toBeUndefined()
    expect(reg.listSudo('s1')).toEqual([{ hostKey: 'h1', until }])
    expect(store.saved()).not.toContain('h1')
    now += 15 * 60_000 - 1
    expect(reg.sudoUntil('s1', 'h1')).toBe(until)
    now += 1
    expect(reg.sudoUntil('s1', 'h1')).toBeUndefined()
    expect(reg.listSudo('s1')).toEqual([])
  })
  it('立即收回 / 删会话一并清掉；时长夹在 1 分钟 ~ 1 天', () => {
    const reg = new AuthRegistry({ store: memStore(), now: () => 0 })
    reg.grantSudo('s1', 'h1', 5)
    expect(reg.revokeSudo('s1', 'h1')).toBe(true)
    expect(reg.sudoUntil('s1', 'h1')).toBeUndefined()
    reg.grantSudo('s1', 'h1', 60)
    reg.revokeSession('s1')
    expect(reg.listSudo('s1')).toEqual([])
    expect(reg.grantSudo('s1', 'h1', 0)).toBe(60_000)
    expect(reg.grantSudo('s1', 'h1', 99_999)).toBe(24 * 60 * 60_000)
  })
})
