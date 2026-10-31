import { describe, it, expect } from 'vitest'
import { routeOf, keyEnvOf, withRoute, friendlyError, maxTokensOf, deepseekBaseOf, usesPiAi } from './providers.js'

describe('模型配置 → dsh 路由 / key 变量', () => {
  it('每套配置一条路由、一个 key 变量；deepseek 与 OpenAI 兼容的前缀不同；缺省配置 id = default', () => {
    expect(routeOf('deepseek', 'a1')).toBe('lingshell-ds-a1')
    expect(routeOf('moonshot', 'a1')).toBe('lingshell-p-a1')
    expect(routeOf('qwen')).toBe('lingshell-p-default')
    // DeepSeek 选 OpenAI 兼容 → 走 pi-ai 路由；其它提供商填 anthropic 也无效
    expect(routeOf('deepseek', 'a1', 'openai')).toBe('lingshell-p-a1')
    expect(routeOf('deepseek', 'a1', 'anthropic')).toBe('lingshell-ds-a1')
    expect(routeOf('qwen', 'a1', 'anthropic')).toBe('lingshell-p-a1')
    expect(usesPiAi('deepseek')).toBe(false)
    expect(usesPiAi('deepseek', 'openai')).toBe(true)
    expect(keyEnvOf('mp_x9')).toBe('LINGSHELL_MP_MP_X9_KEY')
    expect(keyEnvOf()).toBe('LINGSHELL_MP_DEFAULT_KEY')
  })
})

describe('withRoute', () => {
  it('声明 openai-completions 路由：自己的 key 变量、去尾斜杠的 baseURL、按模型的窗口', () => {
    const r = withRoute({}, { profileId: 'q', provider: 'qwen', model: 'qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' })
    expect(r['lingshell-p-q']).toMatchObject({
      api: 'openai-completions', apiKeyEnv: 'LINGSHELL_MP_Q_KEY',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ id: 'qwen-max', name: 'qwen-max', contextWindow: 32_768, maxTokens: 8192 }],
    })
  })
  it('输出上限：默认 32768，小窗口封顶到窗口 1/4', () => {
    expect(maxTokensOf(1_000_000)).toBe(32_768)
    expect(maxTokensOf(32_768)).toBe(8192)
  })
  it('DeepSeek 官方地址换成 Messages 根，自定义地址原样', () => {
    expect(deepseekBaseOf({ provider: 'deepseek', baseUrl: '' })).toBe('https://api.deepseek.com/anthropic')
    expect(deepseekBaseOf({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/' })).toBe('https://api.deepseek.com/anthropic')
    expect(deepseekBaseOf({ provider: 'deepseek', baseUrl: 'http://gw.local/anthropic' })).toBe('http://gw.local/anthropic')
  })
  it('DeepSeek 走 OpenAI 兼容：官方地址修回 https://api.deepseek.com（含 /anthropic），带 deepseek 思考格式与 reasoning_content 回放', () => {
    const r = withRoute({}, { profileId: 'd', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'openai' })
    expect(r['lingshell-p-d']).toMatchObject({
      api: 'openai-completions', baseURL: 'https://api.deepseek.com', reasoning: 'high',
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, supportsStore: false },
      models: [{ id: 'deepseek-v4-pro', reasoningEfforts: { high: 'high', max: 'max' } }],
    })
    // 其它提供商不带 DeepSeek 专属项
    const q = withRoute({}, { profileId: 'q', provider: 'qwen', model: 'qwen-max', baseUrl: '' })['lingshell-p-q']
    expect(q.compat).not.toHaveProperty('thinkingFormat')
    expect(q).not.toHaveProperty('reasoning')
    expect(q.models[0]).not.toHaveProperty('reasoningEfforts')
  })
  it('换模型保留旧模型；同模型改窗口就地更新；不改入参', () => {
    const a = withRoute({}, { profileId: 'o', provider: 'ollama', model: 'qwen3:8b', baseUrl: '' })
    const b = withRoute(a, { profileId: 'o', provider: 'ollama', model: 'llama3.1', baseUrl: '' })
    const c = withRoute(b, { profileId: 'o', provider: 'ollama', model: 'qwen3:8b', baseUrl: '', contextWindow: 8192 })
    expect(a['lingshell-p-o'].models).toHaveLength(1)
    expect(a['lingshell-p-o'].baseURL).toBe('http://127.0.0.1:11434/v1')   // 空 baseUrl 回落默认
    expect(c['lingshell-p-o'].models.map((m) => [m.id, m.contextWindow])).toEqual([['llama3.1', 32_768], ['qwen3:8b', 8192]])
  })
  it('同一提供商的两套配置各占一条路由（地址 / key 不串）', () => {
    const r = withRoute(withRoute({}, { profileId: 'a', provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://a' }), { profileId: 'b', provider: 'qwen', model: 'qwen-plus', baseUrl: 'https://b' })
    expect(Object.entries(r).map(([k, v]) => [k, v.baseURL, v.apiKeyEnv])).toEqual([['lingshell-p-a', 'https://a', 'LINGSHELL_MP_A_KEY'], ['lingshell-p-b', 'https://b', 'LINGSHELL_MP_B_KEY']])
  })
})

it('friendlyError：模型不支持工具时补提示，其余原样', () => {
  expect(friendlyError('registry.ollama.ai/library/gemma:2b does not support tools')).toContain('不支持工具调用')
  expect(friendlyError('boom')).toBe('boom')
})
