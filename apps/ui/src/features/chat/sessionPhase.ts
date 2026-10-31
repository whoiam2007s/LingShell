// 会话启动失败 → 界面状态与日志级别。没配 API Key 是正常的首次启动状态：
// 界面显示配置引导（见 ChatPanel 的 no-key 分支），不记 ERROR；其余失败照常记。
import { providerMeta, type AppSettings } from '@lingshell/shared'
import type { SessionPhase } from './useConversation.js'

/** 默认配置需要 Key 但还没配：首次启动的正常状态（显示配置引导，不发起建会话） */
export const needsApiKeySetup = (s: Pick<AppSettings, 'provider' | 'hasApiKey'>): boolean =>
  providerMeta(s.provider).needsApiKey && !s.hasApiKey

export const isNoKeyError = (e: unknown): boolean =>
  String((e as { message?: string })?.message ?? e).includes('api_key_not_configured')

export const errToPhase = (e: unknown): SessionPhase => {
  const raw = String((e as { message?: string })?.message ?? e)
  if (raw.includes('api_key')) return { phase: 'no-key' }
  return { phase: 'error', message: raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, '') }
}

type LeveledLog = { info: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void }

/** 建会话失败：没配 Key 用 info（正常状态），真正的失败才记 ERROR */
export function logSessionFailure(log: LeveledLog, e: unknown): void {
  if (isNoKeyError(e)) log.info('createSession skipped: api_key_not_configured')   // i18n-ignore 日志
  else log.error('createSession failed', { e: String(e) })
}
