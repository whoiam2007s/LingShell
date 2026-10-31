// 渲染层日志器：写浏览器控制台 + 转发给主进程写入 web.log。
// 业务代码用 log.info/warn/error，不直接用 console，保证日志落盘。

type Level = 'debug' | 'info' | 'warn' | 'error'

interface ElectronLogAPI {
  log?: (rec: { level: string; scope?: string; message: string; data?: unknown; time?: string }) => void
}

function forward(level: Level, scope: string, message: string, data?: unknown) {
  const api = (window as unknown as { electronAPI?: ElectronLogAPI }).electronAPI
  // 浏览器控制台
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[${scope}] ${message}`, data ?? '')
  // 转发主进程落盘（仅 Electron 环境有 electronAPI.log）
  api?.log?.({ level, scope, message, data, time: new Date().toISOString() })
}

export const logger = {
  scope(scope: string) {
    return {
      debug: (m: string, d?: unknown) => forward('debug', scope, m, d),
      info: (m: string, d?: unknown) => forward('info', scope, m, d),
      warn: (m: string, d?: unknown) => forward('warn', scope, m, d),
      error: (m: string, d?: unknown) => forward('error', scope, m, d),
    }
  },
}

// 全局捕获未处理错误 → 落盘
export function installGlobalErrorLogging() {
  const l = logger.scope('window')
  window.addEventListener('error', (e) => l.error(`uncaught: ${e.message}`, { filename: e.filename, lineno: e.lineno }))
  window.addEventListener('unhandledrejection', (e) => l.error('unhandledrejection', { reason: String(e.reason) }))
}
