import { describe, expect, it } from 'vitest'
import { registerNotify } from './notifyIpc.js'

describe('system:notify', () => {
  const setup = () => {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const sent: [string, string][] = []
    registerNotify({ handle: (ch, fn) => hs.set(ch, fn), notify: (t, b) => sent.push([t, b]) })
    return { call: (...a: unknown[]) => hs.get('system:notify')!(null, ...a), sent }
  }
  it('校验参数并截断长度', () => {
    const { call, sent } = setup()
    call('t'.repeat(100), 'b'.repeat(500))
    expect(sent).toEqual([['t'.repeat(80), 'b'.repeat(300)]])
  })
  it('非法参数拒绝', () => {
    const { call, sent } = setup()
    expect(() => call('', 'x')).toThrow()
    expect(() => call('t', 1)).toThrow()
    expect(sent).toEqual([])
  })
})
