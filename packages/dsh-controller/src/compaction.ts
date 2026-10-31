// DeepSeek 各模型上下文窗口（dsh-llm-deepseek 适配器自报的 contextWindow，我们改不了）
export const DEEPSEEK_WINDOW = 1_000_000

// 一个会话目标（dsh 路由 + 模型）的窗口。压缩插件把比例乘在**适配器自报**的窗口上，
// 所以比例 = 我方 token 阈值 / adapterWindow；contextWindow 是用户眼里的真实窗口（夹阈值用）。
// pi-ai 路由的 adapterWindow 就是我们配进去的 contextWindow；deepseek 恒为 1M（用户覆盖窗口时两者不同）。
export interface CompactTarget { provider: string; model: string; contextWindow: number; adapterWindow: number }

// 自动压缩阈值 = 模型上下文窗口的 60%，且不超过 600K（不再给用户单独配置）
export const AUTO_COMPACT_RATIO = 0.6
export const AUTO_COMPACT_CAP = 600_000

// 实际生效的阈值：min(上限, 窗口 × 60%)；limit<=0 = 不自动压缩
export function effectiveLimit(limitTokens: number, contextWindow: number): number {
  return limitTokens > 0 ? Math.min(limitTokens, Math.floor(contextWindow * AUTO_COMPACT_RATIO)) : 0
}

function policy(limitTokens: number, t: Pick<CompactTarget, 'contextWindow' | 'adapterWindow'>) {
  const thresholdRatio = Math.min(0.95, Math.max(0.001, effectiveLimit(limitTokens, t.contextWindow) / t.adapterWindow))
  return { thresholdRatio, retainRatio: thresholdRatio / 5 }
}

// 自动压缩配置：默认策略按 DeepSeek 1M 窗口换算；其余目标各一条 modelPolicies（插件按 provider/model 精确匹配）。
// 保留最近 1/5 的阈值预算原样不压（retain 必须小于 threshold）。
// limit<=0 → auto=false：插件不注册步边界压力检查，也不注册模型侧溢出恢复，即完全不自动压缩
export function compactionConfig(limitTokens: number, targets: CompactTarget[] = []): {
  auto: boolean; thresholdRatio?: number; retainRatio?: number
  modelPolicies?: ({ provider: string; model: string; headroomTokens: number } & ReturnType<typeof policy>)[]
} {
  if (!(limitTokens > 0)) return { auto: false }
  const base = { auto: true, ...policy(limitTokens, { contextWindow: DEEPSEEK_WINDOW, adapterWindow: DEEPSEEK_WINDOW }) }
  // 插件遇到重复目标会加载失败：同一目标后来者覆盖
  const uniq = new Map(targets.map((t) => [`${t.provider}\n${t.model}`, t]))
  // dsh 0.2 起阈值另受「窗口 − 单次输出预留 − headroom」封顶；headroom 默认 64K，小窗口模型会被压到很低甚至配置报错，
  // 所以按窗口的 1/10 给（1K–64K），摘要输出上限默认同 headroom
  const modelPolicies = [...uniq.values()].map((t) => ({
    provider: t.provider, model: t.model, ...policy(limitTokens, t),
    headroomTokens: Math.min(65_536, Math.max(1024, Math.floor(t.adapterWindow / 10))),
  }))
  return modelPolicies.length ? { ...base, modelPolicies } : base
}
