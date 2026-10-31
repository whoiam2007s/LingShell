// 一键回滚（AI 执行变更命令时给出的 rollback，见 dsh-controller/terminalTools.ts）。
// 回滚经同一主机的终端执行，照常过命令规则 / 信任档 / 危险命令确认；执行结果记一条 decision=rollback、undoOf=原记录 at 的执行记录。
import type { AuditEntry } from '../protocol/index.js'

export const ROLLBACK_DECISION = 'rollback'

/** 回滚前的检查结果（给确认框展示） */
export interface RollbackCheck {
  command: string
  note?: string
  terminalId: string        // 将在哪个终端执行（原终端已关则取同主机另一个打开的终端）
  terminalTitle: string
  hostKey: string
  // allow = 本会话已有授权；confirm = 需要你在确认框里确认（首次 / 提权 / 生产 / 总是询问规则）；deny = 被拒（只读会话 / 禁止规则）
  verdict: 'allow' | 'confirm' | 'deny'
  reason?: string           // deny 的原因 / confirm 的提示
  dangerous: boolean        // 命中危险命令：须额外勾选确认
  prod: boolean
  rule?: string
}

export interface RollbackResult { exitCode: number; output: string; truncated?: boolean }

/** 一条记录的回滚状态：none = 没回滚过；done = 已回滚（最近一次退出码 0）；failed = 最近一次回滚失败 */
export function rollbackStatus(entries: AuditEntry[], e: Pick<AuditEntry, 'sessionId' | 'at'>): 'none' | 'done' | 'failed' {
  let last: AuditEntry | undefined
  for (const x of entries) {
    if (x.decision === ROLLBACK_DECISION && x.undoOf === e.at && x.sessionId === e.sessionId && (!last || x.at > last.at)) last = x
  }
  return !last ? 'none' : last.exitCode === 0 ? 'done' : 'failed'
}

/** 能「一键回滚」：带回滚命令的执行记录 */
export function canRollback(e: AuditEntry): boolean {
  return !!e.rollback && e.decision.startsWith('exec_allowed')
}
