import { resolveAppPaths, logSessionDir, pruneLogDirs, makeStartedAtLabel, Logger, type AppPaths } from '@lingshell/platform'

// 应用级单例上下文：数据目录 + 本次启动的日志器。
// 在 app ready 时初始化一次，main 与 ipc 共用。
let _paths: AppPaths | undefined
let _logger: Logger | undefined
let _logDir: string | undefined

export function initAppContext(): { paths: AppPaths; logger: Logger; logDir: string } {
  if (_paths && _logger && _logDir) return { paths: _paths, logger: _logger, logDir: _logDir }
  // LINGSHELL_DATA_DIR：把整个数据根目录挪到别处。给"拿真应用试新引擎又不想动线上数据"用的，
  // 不设就是 ~/.lingshell。
  const paths = resolveAppPaths(process.env.LINGSHELL_DATA_DIR || undefined)
  const label = makeStartedAtLabel(new Date())                     // 启动时间标签
  const logDir = logSessionDir(paths.logs, label)                  // ~/.lingshell/logs/<时间>/
  const pruned = pruneLogDirs(paths.logs, 20)                      // 只留最近 20 次运行的日志
  const logger = new Logger(logDir, { mirrorConsole: true })
  logger.write({ level: 'info', source: 'main', scope: 'boot', message: `灵壳 LingShell 启动，数据目录 ${paths.root}，日志 ${logDir}`, time: new Date().toISOString() })   // i18n-ignore 日志
  if (pruned.length) logger.write({ level: 'info', source: 'main', scope: 'boot', message: `清理旧日志 ${pruned.length} 个目录（保留最近 20 次）`, time: new Date().toISOString() })   // i18n-ignore 日志
  _paths = paths; _logger = logger; _logDir = logDir
  return { paths, logger, logDir }
}

export function getLogger(): Logger {
  if (!_logger) return initAppContext().logger
  return _logger
}

// 便捷日志方法（自动带时间戳）
export function log(level: 'debug' | 'info' | 'warn' | 'error', source: 'main' | 'web', scope: string, message: string, data?: unknown): void {
  getLogger().write({ level, source, scope, message, data, time: new Date().toISOString() })
}
