// DeepSeek 官方已下线 / 改名的模型 id → 现在的 id（2026-10，dsh 0.2.1 内置目录只有 deepseek-flash / deepseek-v4-pro）。
//  - deepseek-chat / deepseek-reasoner：2026-07-24 到期下线；
//  - deepseek-v4-flash / deepseek-v4-flash-vision-exp：V4 Flash 退役，官方把它们路由到 V4.1 Flash（deepseek-flash）。
// 已保存的旧配置读出时自动换成新 id（只对官方地址；自建网关 / 代理的模型名可能不同，原样保留）。
export const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

const isOfficialDeepseek = (baseUrl: string): boolean => {
  const u = baseUrl.trim()
  if (!u) return true
  try { return new URL(u).hostname === 'api.deepseek.com' } catch { return false }
}

/** 规整模型 id：DeepSeek 官方地址上的旧 id 换成现在的；其它原样返回 */
export function canonicalModel(provider: string, model: string, baseUrl = ''): string {
  // 旧配置 / 导入文件里 model、baseUrl 可能缺失或不是字符串：别让 .trim() 把整个设置读崩
  const m = typeof model === 'string' ? model : ''
  if (provider !== 'deepseek' || !isOfficialDeepseek(typeof baseUrl === 'string' ? baseUrl : '')) return m
  return DEEPSEEK_MODEL_ALIASES[m.trim()] ?? m
}
