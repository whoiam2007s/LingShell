import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource = 'main' | 'web'

export interface LogRecord {
  level: LogLevel
  source: LogSource
  scope?: string          // 模块名，如 'dsh' / 'terminal'
  message: string
  data?: unknown          // 附加结构化数据
  time?: string           // 调用方可传；不传则留空（platform 不调 Date）
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * 文件日志器。每个来源（main/web）写到本次启动日志目录下的独立文件。
 * web 端日志通过 IPC 转发到主进程，由主进程的 Logger 写入 web.log。
 */
export class Logger {
  private streams = new Map<LogSource, WriteStream>()
  private minLevel: number

  constructor(private logDir: string, opts?: { minLevel?: LogLevel; mirrorConsole?: boolean }) {
    this.minLevel = LEVEL_ORDER[opts?.minLevel ?? 'debug']
    this.mirrorConsole = opts?.mirrorConsole ?? true
  }
  private mirrorConsole: boolean

  private fileFailed = false   // 落盘出错（磁盘满/目录被删）后降级为只写控制台

  private stream(source: LogSource): WriteStream {
    let s = this.streams.get(source)
    if (!s) {
      s = createWriteStream(join(this.logDir, `${source}.log`), { flags: 'a' })
      // 必须挂 error 监听：否则 WriteStream 的 'error' 无人处理会直接崩主进程
      s.on('error', (err) => {
        this.streams.delete(source)
        if (!this.fileFailed) console.error(`[logger] 日志文件写入失败，降级为仅控制台输出: ${String(err)}`)   // i18n-ignore 日志
        this.fileFailed = true
      })
      this.streams.set(source, s)
    }
    return s
  }

  /** 写一条日志记录。time 由调用方提供（ISO 字符串）。 */
  write(rec: LogRecord): void {
    if (LEVEL_ORDER[rec.level] < this.minLevel) return
    const time = rec.time ?? ''
    const scope = rec.scope ? `[${rec.scope}]` : ''
    const dataStr = rec.data !== undefined ? ' ' + safeStringify(rec.data) : ''
    const line = `${time} ${rec.level.toUpperCase().padEnd(5)} [${rec.source}]${scope} ${rec.message}${dataStr}\n`
    if (!this.fileFailed) this.stream(rec.source).write(line)
    // debug 级别只落盘、不镜像控制台（避免引擎详细输出刷屏）；其余镜像到控制台（落盘失败后强制镜像）
    if ((this.mirrorConsole || this.fileFailed) && rec.level !== 'debug') {
      const fn = rec.level === 'error' ? console.error : rec.level === 'warn' ? console.warn : console.log
      fn(line.trimEnd())
    }
  }

  /** 关闭所有日志流，等待数据真正 flush 到磁盘。 */
  async close(): Promise<void> {
    const closing = [...this.streams.values()].map(
      (s) => new Promise<void>((resolve) => s.end(() => resolve()))
    )
    this.streams.clear()
    await Promise.all(closing)
  }
}

function safeStringify(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v) }
  catch { return String(v) }
}
