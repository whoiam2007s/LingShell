import { describe, it, expect } from 'vitest'
import { routeOf, keyEnvOf, withRoute, friendlyError, maxTokensOf, deepseekBaseOf, usesPiAi, RETRY_POLICY } from './providers.js'

describe('模型配置 → dsh 路由 / key 变量', () => {
  it('每套配置一条路由、一个 key 变量；deepseek 与 OpenAI 兼容的前缀不同；缺省配置 id = default', () => {
    expect(routeOf('deepseek', 'a1')).toBe('lingshell-ds-a1')
    expect(routeOf('moonshot', 'a1')).toBe('lingshell-p-a1')
    expect(routeOf('qwen')).toBe('lingshell-p-default')
    // DeepSeek 选 OpenAI 兼容 → 走 pi-ai 路由；其它提供商选 Anthropic Messages → 走 Messages 路由
    expect(routeOf('deepseek', 'a1', 'openai')).toBe('lingshell-p-a1')
    expect(routeOf('deepseek', 'a1', 'anthropic')).toBe('lingshell-ds-a1')
    expect(routeOf('qwen', 'a1', 'anthropic')).toBe('lingshell-ds-a1')   // 协议一律可选：选了 anthropic 就走 Messages 路由
    expect(usesPiAi('qwen', 'anthropic')).toBe(false)
    expect(usesPiAi('deepseek')).toBe(false)
    expect(usesPiAi('deepseek', 'openai')).toBe(true)
    // 第三种协议：单独一条路由，同样走 pi-ai
    expect(routeOf('openai', 'a1', 'openai-responses')).toBe('lingshell-r-a1')
    expect(routeOf('deepseek', 'a1', 'openai-responses')).toBe('lingshell-r-a1')
    expect(usesPiAi('openai', 'openai-responses')).toBe(true)
    expect(usesPiAi('openai')).toBe(true)
    expect(usesPiAi('anthropic', 'openai-responses')).toBe(true)   // 三种协议一律放开：显式选了 Responses 就按 Responses 走
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
      api: 'openai-completions', baseURL: 'https://api.deepseek.com', reasoning: 'medium',
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true, supportsStore: false },
      models: [{ id: 'deepseek-v4-pro', reasoningEfforts: { off: null, low: 'low', medium: 'high', high: 'max' } }],
    })
    // 其它提供商不带 DeepSeek 专属项
    const q = withRoute({}, { profileId: 'q', provider: 'qwen', model: 'qwen-max', baseUrl: '' })['lingshell-p-q']
    expect(q.compat).not.toHaveProperty('thinkingFormat')
    // 没选过思考深度就不发这个参数（以前各厂商都不发，这里必须保持）
    expect(q).not.toHaveProperty('reasoning')
    // 但档位要声明出来，界面才能让用户选（低/中/高）
    expect(q.models[0]).toHaveProperty('reasoningEfforts', { low: 'low', medium: 'medium', high: 'high' })
  })
  it('不支持思考深度的厂商不声明档位；选了档位就按厂商派发', () => {
    // ollama：本地端点不认识 reasoningEffort，不声明
    const o = withRoute({}, { profileId: 'o2', provider: 'ollama', model: 'qwen3:8b', baseUrl: '' })['lingshell-p-o2']
    expect(o.models[0]).not.toHaveProperty('reasoningEfforts')
    // qwen 选了「高」→ 档位名 high
    const hi = withRoute({}, { profileId: 'q2', provider: 'qwen', model: 'qwen-max', baseUrl: '', thinking: 'high' })['lingshell-p-q2']
    expect(hi.reasoning).toBe('high')
    // DeepSeek 选「低」→ 传档位名 low（pi-ai 再按 reasoningEfforts 翻成官方 low）
    const low = withRoute({}, { profileId: 'd2', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'openai', thinking: 'low' })['lingshell-p-d2']
    expect(low.reasoning).toBe('low')
    // DeepSeek 选「中」→ 档位名 medium（线上值是 high，见 reasoningEfforts）
    const mid = withRoute({}, { profileId: 'd4', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'openai', thinking: 'medium' })['lingshell-p-d4']
    expect(mid.reasoning).toBe('medium')
    // DeepSeek 选「高」→ 档位名 high（线上值 max，见 reasoningEfforts）
    const max = withRoute({}, { profileId: 'd3', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'openai', thinking: 'high' })['lingshell-p-d3']
    expect(max.reasoning).toBe('high')
    // DeepSeek 选「关」→ 档位名 off；pi-ai 的 thinkingFormat:deepseek 会据此发 thinking:{type:'disabled'}
    const offRoute = withRoute({}, { profileId: 'd5', provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: '', protocol: 'openai', thinking: 'off' })['lingshell-p-d5']
    expect(offRoute.reasoning).toBe('off')
    expect(offRoute.models[0]).toMatchObject({ reasoningEfforts: { off: null } })
    // 还没核对过官方文档的厂商（火山方舟）：不声明档位、也不发参数，界面整块置灰
    const volc = withRoute({}, { profileId: 'v1', provider: 'volc', model: 'doubao-seed', baseUrl: '', thinking: 'high' })['lingshell-p-v1']
    expect(volc).not.toHaveProperty('reasoning')
    expect(volc.models[0]).not.toHaveProperty('reasoningEfforts')
  })
  it('Responses 协议：独立路由 + 本协议白名单内的 compat，声明推理档位并把档位名传下去', () => {
    const r = withRoute({}, { profileId: 'gpt', provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', thinking: 'high' })
    const route = r['lingshell-r-gpt']
    expect(route).toMatchObject({
      api: 'openai-responses', baseURL: 'https://api.openai.com/v1', reasoning: 'high',
      compat: { supportsDeveloperRole: false, supportsMaxOutputTokens: true, supportsStrictMode: false },
      models: [{ id: 'gpt-5', name: 'gpt-5', reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }],
    })
    // completions 那套字段不能混进 Responses 路由（pi-ai 的 compat 按协议白名单校验）
    expect(route.compat).not.toHaveProperty('supportsStore')
    expect(route.compat).not.toHaveProperty('maxTokensField')
    // 没选档位时默认 medium：pi-ai 只有拿到 reasoningEffort 才会发 { reasoning: { effort, summary: "auto" } }
    const def = withRoute({}, { profileId: 'g2', provider: 'openai', model: 'gpt-5', baseUrl: '', protocol: 'openai-responses' })['lingshell-r-g2']
    expect(def.reasoning).toBe('medium')
    // 非推理模型（gpt-4o）不声明、不发，否则可能被端点 400
    const g4 = withRoute({}, { profileId: 'g4', provider: 'openai', model: 'gpt-4o', baseUrl: '', protocol: 'openai-responses' })['lingshell-r-g4']
    expect(g4).not.toHaveProperty('reasoning')
    expect(g4.models[0]).not.toHaveProperty('reasoningEfforts')
    // 没有档位表的自定义端点（openai-compatible）：宁可不发也不瞎发
    const gw = withRoute({}, { profileId: 'gw', provider: 'openai-compatible', model: 'gpt-5', baseUrl: 'https://gw', protocol: 'openai-responses' })['lingshell-r-gw']
    expect(gw).not.toHaveProperty('reasoning')
    expect(gw.models[0]).not.toHaveProperty('reasoningEfforts')
    // 同一套配置切回 Chat Completions 走另一条路由，互不覆盖
    const back = withRoute(r, { profileId: 'gpt', provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', protocol: 'openai' })
    expect(Object.keys(back).sort()).toEqual(['lingshell-p-gpt', 'lingshell-r-gpt'])
    expect(back['lingshell-p-gpt'].api).toBe('openai-completions')
  })
  it('重试策略显式带上：5 次、指数退避 0.5s 起 / 10s 封顶、网络与服务类失败码', () => {
    const r = withRoute({}, { profileId: 'q', provider: 'qwen', model: 'qwen-max', baseUrl: '' })['lingshell-p-q']
    expect(r.retryPolicy).toMatchObject({
      mode: 'normal', maxRetries: 5,
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 },
    })
    expect(r.retryPolicy.retryableCodes).toEqual(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED'])
    // 与总表常量同源（改曲线只需改 RETRY_POLICY）
    expect(r.retryPolicy.maxRetries).toBe(RETRY_POLICY.maxRetries)
    // Responses 协议同样带策略
    const g = withRoute({}, { profileId: 'g', provider: 'openai', model: 'gpt-5', baseUrl: '', protocol: 'openai-responses' })['lingshell-r-g']
    expect(g.retryPolicy.maxRetries).toBe(5)
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
