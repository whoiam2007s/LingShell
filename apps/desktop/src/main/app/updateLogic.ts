import type { UpdateStatus } from '@lingshell/shared'

// 更新源判定（纯函数，便于测试）。来源优先级：
//  1. 运行时环境变量 LINGSHELL_UPDATE_URL（临时换源/本地测试用）→ override=true，需 setFeedURL
//  2. 打包时生成的 resources/app-update.yml（构建时设了 LINGSHELL_UPDATE_URL 才会有）→ electron-updater 自己读
// 开发模式（未打包）一律禁用；都没有 → 禁用，不联网
export type UpdateSource = { enabled: false } | { enabled: true; url: string; override: boolean }

const isHttpUrl = (s: string | undefined): s is string => !!s && /^https?:\/\/\S+$/i.test(s)

export function resolveUpdateSource(o: { isPackaged: boolean; envUrl?: string; appUpdateYml?: string }): UpdateSource {
  if (!o.isPackaged) return { enabled: false }
  const env = o.envUrl?.trim()
  if (isHttpUrl(env)) return { enabled: true, url: env, override: true }
  const yml = o.appUpdateYml?.match(/^\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
  if (isHttpUrl(yml)) return { enabled: true, url: yml, override: false }
  return { enabled: false }
}

// electron-updater 事件 → 状态。progress 事件不带版本号，沿用上一状态的；未知事件返回 undefined
export function nextUpdateStatus(prev: UpdateStatus, event: string, arg?: unknown): UpdateStatus | undefined {
  const a = (arg ?? {}) as { version?: unknown; percent?: unknown; message?: unknown }
  const version = typeof a.version === 'string' ? a.version : prev.version
  switch (event) {
    case 'checking-for-update': return { state: 'checking' }
    case 'update-not-available': return { state: 'none' }
    case 'update-available': return { state: 'available', version }
    case 'download-progress':
      return { state: 'downloading', version, percent: typeof a.percent === 'number' ? Math.round(a.percent) : prev.percent }
    case 'update-downloaded': return { state: 'downloaded', version }
    case 'error': return { state: 'error', version, error: arg instanceof Error ? arg.message : typeof a.message === 'string' ? a.message : String(arg) }
    default: return undefined
  }
}
