// 执行记录（auditStore）的公共写法：补会话 / 终端名 / 主机、补时间、运行日志不记命令原文。
// 以前各领域 register.ts 各抄一遍（13 处），改一处容易漏。依赖注入是为了能单测，services.ts 负责接真的存储。
import { tr, type AuditEntry, type TerminalInfo } from '@lingshell/shared'

/** 调用方给的内容：sessionId / terminalId / hostKey 可由 helper 补 */
export type AuditInput = Omit<AuditEntry, 'at' | 'sessionId' | 'terminalId' | 'hostKey'> &
  Partial<Pick<AuditEntry, 'sessionId' | 'terminalId' | 'hostKey'>>

export interface AuditLogOptions {
  /** 运行日志里的动作名，缺省用 decision（有的地方固定写 'cmd' / 'restore'） */
  logLabel?: string
  /** 运行日志里带上命令原文（缺省不带：可能含口令）；文件类操作没有敏感内容，可打开 */
  logCommand?: boolean
  /** 运行日志里额外带的字段（如批量执行的 status） */
  logExtra?: Record<string, unknown>
}

export interface AuditDeps {
  add(entry: AuditEntry): void
  activeSessionId(): string
  terminalTitle(id: string): string | undefined
  hostKeyOf(id: string): string | undefined
  hostLabel(hostKey: string): string | undefined
  logAudit(label: string, data: Record<string, unknown>): void
  now?(): string
}

export interface LiveTerminalOptions {
  /** 只算 running 的（缺省：除 disconnected 外都算） */
  running?: boolean
  /** 只算 SSH 终端 */
  ssh?: boolean
  /** 把巡检用的后台终端也算上（默认不算：它们不在 UI 标签页里） */
  includeHidden?: boolean
  terminals(): TerminalInfo[]
  hostKeys(): Iterable<[string, string]>
  isHidden(id: string): boolean
}

export function createAuditHelpers(d: AuditDeps) {
  const auditRaw = (e: AuditInput, o: AuditLogOptions = {}): AuditEntry => {
    const entry: AuditEntry = { sessionId: d.activeSessionId(), terminalId: '', hostKey: 'local', ...e, at: (d.now?.() ?? new Date().toISOString()) }
    // 运行日志不带 at，默认也不带命令原文（可能含口令）；执行记录里都保留
    const { at: _at, command, ...brief } = entry
    d.logAudit(o.logLabel ?? entry.decision, { ...brief, ...(o.logCommand && command !== undefined ? { command } : {}), ...o.logExtra })
    d.add(entry)
    return entry
  }

  /** 终端相关：终端名和主机按终端补（终端之后可能已关，所以记的时候取） */
  const auditTerminal = (terminalId: string, e: AuditInput, o?: AuditLogOptions) =>
    auditRaw({ terminalId, terminalTitle: d.terminalTitle(terminalId), hostKey: d.hostKeyOf(terminalId) ?? 'local', ...e }, o)

  /** 按主机记（没有终端：数据库、部署公钥）：终端名位置放主机名，本机显示「本机」 */
  const auditHost = (hostKey: string, e: AuditInput, o?: AuditLogOptions) =>
    auditRaw({ hostKey, terminalTitle: hostKey === 'local' ? tr('本机') : d.hostLabel(hostKey), ...e }, o)

  return { auditRaw, auditTerminal, auditHost }
}

/** 某台主机上开着的终端 id（同一台主机可能有多个；按 termHostKey 的插入顺序取第一个） */
export function findLiveTerminal(hostKey: string, o: LiveTerminalOptions): string | undefined {
  const list = o.terminals()
  for (const [id, k] of o.hostKeys()) {
    if (k !== hostKey) continue
    if (!o.includeHidden && o.isHidden(id)) continue
    const t = list.find((x) => x.id === id)
    if (!t) continue
    if (o.ssh && t.type !== 'ssh') continue
    if (o.running ? t.status !== 'running' : t.status === 'disconnected') continue
    return id
  }
  return undefined
}
