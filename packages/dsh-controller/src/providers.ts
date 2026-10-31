// 模型配置（profile）→ dsh 路由 / key 环境变量 / dsh-llm-pi-ai 路由配置。纯函数，便于测试。
//
// 每套模型配置一条自己的路由、一个自己的 key 环境变量：同一家提供商可以配多套（不同 key / 地址），互不串用；
// 会话切换模型 = 下一回合的请求改走另一条路由（见 DshController 的 agent/request 覆盖）。
// 按「接口协议」分两类（protocolOf：只有 DeepSeek 可选，缺省 anthropic；其它固定 openai）：
// anthropic —— 官方适配器 dsh-llm-deepseek 的 DeepSeekAdapter（Messages 协议；插件本身只能注册唯一的 deepseek-official 路由，
//   多套 DeepSeek 配置要各自的地址 / key，所以由我们按配置各注册一个适配器实例）；
// openai —— OpenAI 兼容端点（含选了「OpenAI 兼容」的 DeepSeek），交给 dsh-llm-pi-ai 的手工声明路由（openai-completions 协议）。
// 路由名加 lingshell- 前缀，避开 pi-ai 内置 catalog 的同名路由（如 moonshotai），否则会继承其端点与模型表。
import { contextWindowOf, endpointBaseOf, protocolOf, providerMeta, tr, type ModelProtocol } from '@lingshell/shared'

// 没带配置 id 时（旧调用 / 冒烟脚本）当作默认配置
const pid = (profileId?: string) => profileId || 'default'

// 两种协议的路由前缀不同：同一套配置切协议 = 换一条路由（会话下一回合改走它，历史照常带上）
export const routeOf = (provider: string, profileId?: string, protocol?: ModelProtocol): string =>
  protocolOf(provider, protocol) === 'anthropic' ? `lingshell-ds-${pid(profileId)}` : `lingshell-p-${pid(profileId)}`

// 适配器只认环境变量名，不收明文 key。每套配置一个变量、路由只引用自己那个，key 不会串到别的端点
export const keyEnvOf = (profileId?: string): string => `LINGSHELL_MP_${pid(profileId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`

export const usesPiAi = (provider: string, protocol?: ModelProtocol): boolean => protocolOf(provider, protocol) === 'openai'

// 无需 key 的本地端点（ollama）也得给个占位：pi-ai 的 OpenAI 兼容实现没有 key 会直接拒绝发请求
export const NO_KEY_PLACEHOLDER = 'no-key'

// pi-ai 认不出私有端点的 URL 时按 OpenAI 本家处理（发 store、developer 角色、max_completion_tokens、
// strict 工具 schema），多数兼容网关至少拒其一。这里统一取最保守、各家都认的写法。
const COMPAT = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', supportsStrictMode: false } as const
// DeepSeek 走 OpenAI 兼容时（同 pi-ai catalog 里 deepseek 的写法）：思考开关用 thinking 字段，
// 回放助手消息带 reasoning_content（思考模式下多轮工具调用不带会被拒）
const DEEPSEEK_COMPAT = { ...COMPAT, thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true } as const
// 声明成推理模型，上面两项才生效；路由默认推理强度 high（与官方 Messages 适配器的默认一致：开思考）
const DEEPSEEK_EFFORTS = { high: 'high', max: 'max' } as const

// input：模型接受的输入模态。pi-ai 对手工声明的模型默认只认文本，带图片的请求会被拒；「支持图片」开了才声明 image
export interface PiModel { id: string; name: string; contextWindow: number; maxTokens: number; input: ('text' | 'image')[]; reasoningEfforts?: typeof DEEPSEEK_EFFORTS }

// 单次输出上限：pi-ai 默认 32768。dsh 0.2 的压缩把它从窗口里预留出来，小窗口模型（如 32K 的本地模型）
// 预留整个默认值就没有消息预算、压缩直接报配置错误，所以封顶到窗口的 1/4
export const maxTokensOf = (contextWindow: number): number => Math.max(1, Math.min(32768, Math.floor(contextWindow / 4)))
export interface PiRoute {
  displayName: string
  apiKeyEnv: string
  api: 'openai-completions'
  baseURL: string
  compat: typeof COMPAT | typeof DEEPSEEK_COMPAT
  reasoning?: 'high'
  models: PiModel[]
}

export interface ProviderSettings { profileId?: string; provider: string; model: string; baseUrl: string; contextWindow?: number; protocol?: ModelProtocol; multimodal?: boolean }

const inputOf = (multimodal?: boolean): ('text' | 'image')[] => (multimodal ? ['text', 'image'] : ['text'])

/**
 * DeepSeek 官方适配器的模型目录（resolveAdapterOptions 解析后的 models）按「支持图片」改写本配置所用模型的输入模态：
 * 目录里没有的模型适配器按纯文本处理（LlmRuntime 会把图片换成文字占位），所以开了就补一条 / 改成 text+image；
 * 关了就去掉 image 及其专属字段（纯文本模型不许带图片限额）。返回新数组，不改入参。
 */
export function deepseekModels<M extends { id: string; inputModalities?: string[]; imagePixelBudget?: unknown; imageMaxBytes?: number }>(models: readonly M[], model: string, multimodal?: boolean): M[] {
  const cur = models.find((m) => m.id === model)
  const { imagePixelBudget: _b, imageMaxBytes: _m, ...base } = cur ?? ({ id: model } as M)
  const next = (multimodal ? { ...base, inputModalities: inputOf(true), imageMaxBytes: cur?.imageMaxBytes ?? 2 * 1024 * 1024 } : { ...base, inputModalities: inputOf(false) }) as M
  return cur ? models.map((m) => (m === cur ? next : m)) : [...models, next]
}

/**
 * 把一套配置并入 pi-ai 路由表（返回新对象，不改入参）。
 * 同一路由下用过的模型都留着：别的会话可能还在本回合里用旧模型，删掉它下一步就 UNKNOWN_MODEL。
 */
export function withRoute(routes: Record<string, PiRoute>, s: ProviderSettings): Record<string, PiRoute> {
  const route = routeOf(s.provider, s.profileId, s.protocol)
  const meta = providerMeta(s.provider)
  const ds = s.provider === 'deepseek'
  const contextWindow = contextWindowOf(s.provider, s.model, s.contextWindow)
  const model: PiModel = { id: s.model, name: s.model, contextWindow, maxTokens: maxTokensOf(contextWindow), input: inputOf(s.multimodal), ...(ds ? { reasoningEfforts: DEEPSEEK_EFFORTS } : {}) }
  const others = (routes[route]?.models ?? []).filter((m) => m.id !== s.model)
  return {
    ...routes,
    [route]: {
      displayName: meta.label,
      apiKeyEnv: keyEnvOf(s.profileId),
      api: 'openai-completions',
      // DeepSeek 官方地址在 openai 协议下修回 https://api.deepseek.com（填了 /anthropic 也修回）
      baseURL: endpointBaseOf(s),
      compat: ds ? DEEPSEEK_COMPAT : COMPAT,
      ...(ds ? { reasoning: 'high' as const } : {}),
      models: [...others, model],
    },
  }
}

// DeepSeek 官方适配器（dsh 0.2 起）走 Anthropic Messages 协议，请求发到 {base}/v1/messages。
// 官方地址（留空 / https://api.deepseek.com / …/v1）自动换成 https://api.deepseek.com/anthropic；其它自定义地址原样（视为 Messages 兼容网关）
export const deepseekBaseOf = (s: { provider: string; baseUrl: string }): string => endpointBaseOf({ ...s, protocol: 'anthropic' })

// 本地模型不支持工具调用时（Ollama 回 400 "... does not support tools"），原始报错读不懂，补一句怎么办
export function friendlyError(msg: string): string {
  if (/does not support tools/i.test(msg)) return tr('{msg}（该模型不支持工具调用，本应用离不开工具调用；请换支持 tools 的模型，如 qwen3、qwen2.5、llama3.1）', { msg })
  return msg
}
