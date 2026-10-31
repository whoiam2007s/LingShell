import { describe, expect, it } from 'vitest'
import { errToPhase, isNoKeyError, logSessionFailure, needsApiKeySetup } from './sessionPhase.js'

const noKey = new Error("Error invoking remote method 'agent:createSession': Error: api_key_not_configured")

const capture = () => {
  const calls: [string, string][] = []
  return {
    calls,
    log: {
      info: (m: string) => calls.push(['info', m]),
      error: (m: string) => calls.push(['error', m]),
    },
  }
}

describe('会话启动失败', () => {
  it('没配 API Key 是正常首次启动：不发起建会话、不记 ERROR，界面显示配置引导', () => {
    expect(needsApiKeySetup({ provider: 'deepseek', hasApiKey: false })).toBe(true)
    expect(needsApiKeySetup({ provider: 'deepseek', hasApiKey: true })).toBe(false)
    expect(needsApiKeySetup({ provider: 'ollama', hasApiKey: false })).toBe(false)   // 本地模型不需要 Key
    const { calls, log } = capture()
    logSessionFailure(log, noKey)
    expect(calls).toEqual([['info', 'createSession skipped: api_key_not_configured']])
    expect(errToPhase(noKey)).toEqual({ phase: 'no-key' })
    expect(isNoKeyError(noKey)).toBe(true)
  })
  it('真正的失败仍记 ERROR 并显示错误', () => {
    const { calls, log } = capture()
    logSessionFailure(log, new Error('boom'))
    expect(calls).toEqual([['error', 'createSession failed']])
    expect(errToPhase(new Error('boom'))).toEqual({ phase: 'error', message: 'boom' })
    expect(isNoKeyError(new Error('boom'))).toBe(false)
  })
})
