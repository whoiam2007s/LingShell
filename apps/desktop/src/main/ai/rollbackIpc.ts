// 一键回滚：执行记录 / 对话工具卡片上点「回滚」→ 确认框展示回滚命令 → 经同一主机的终端执行。
// 不绕过任何闸门：命令规则「禁止」、只读会话直接拒；需要确认的（首次 / 提权 / 生产 / 总是询问）由确认框代为确认（一次性，不落授权）；
// 危险命令须在确认框里额外勾选。执行结果记一条 decision=rollback、undoOf=原记录 at 的执行记录。
import { ROLLBACK_DECISION, canRollback, rollbackStatus, tr, tk, type AuditEntry, type RollbackCheck, type RollbackResult } from '@lingshell/shared'

type Verdict = { kind: 'allow'; rule?: string } | { kind: 'deny'; reason: string; rule?: string } | { kind: 'prompt'; reason: string; rule?: string }

export interface RollbackDeps {
  find(sessionId: string, at: string): AuditEntry | undefined
  entries(sessionId: string): AuditEntry[]
  // 用户可见、在线的终端（巡检后台终端不算）
  terminals(): { id: string; title: string; hostKey: string }[]
  decide(sessionId: string, hostKey: string, command: string): Verdict
  isProd(hostKey: string): boolean
  dangerous(command: string): boolean
  exec(terminalId: string, command: string): Promise<RollbackResult>
  audit(e: Omit<AuditEntry, 'at'>): void
}

const CONFIRM_TEXT: Record<string, string> = {
  first_access: tk('本会话还没有该主机的授权，确认即本次允许执行（一次性，不落授权）'),
  elevation: tk('本会话对该主机只有读取授权，确认即本次允许执行（一次性，不升级）'),
  dangerous_command: tk('命中危险命令模式，请仔细核对后确认'),
}

/** 回滚前检查：定位记录与终端、按会话现有授权与规则判定（不执行） */
export function checkRollback(d: RollbackDeps, sessionId: string, at: string): RollbackCheck {
  const rec = d.find(sessionId, at)
  if (!rec || !canRollback(rec)) throw new Error(tr('该记录没有回滚方案'))
  if (rollbackStatus(d.entries(sessionId), rec) === 'done') throw new Error(tr('该记录已回滚过'))
  const live = d.terminals().filter((t) => t.hostKey === rec.hostKey)
  const term = live.find((t) => t.id === rec.terminalId) ?? live[0]
  if (!term) throw new Error(tr('该主机当前没有打开的终端，请先打开它的终端再回滚'))
  const command = rec.rollback!
  const v = d.decide(sessionId, rec.hostKey, command)
  const prod = d.isProd(rec.hostKey)
  return {
    command, ...(rec.rollbackNote ? { note: rec.rollbackNote } : {}),
    terminalId: term.id, terminalTitle: term.title, hostKey: rec.hostKey,
    verdict: v.kind === 'prompt' ? 'confirm' : v.kind,
    ...(v.kind === 'deny' ? { reason: v.reason }
      : v.kind === 'prompt' ? { reason: prod && v.reason !== 'dangerous_command' ? tr('生产主机：每条写操作都要确认，点「执行回滚」即本次授权（一次性）') : (CONFIRM_TEXT[v.reason] ? tr(CONFIRM_TEXT[v.reason]) : tr('需要确认')) } : {}),
    dangerous: d.dangerous(command), prod, ...(v.rule ? { rule: v.rule } : {}),
  }
}

/** 执行回滚：重新检查（期间规则 / 授权可能变了），危险命令要 ackDanger；命令确实发出去了才落记录 */
export async function runRollback(d: RollbackDeps, sessionId: string, at: string, ackDanger: boolean): Promise<RollbackResult> {
  const c = checkRollback(d, sessionId, at)
  if (c.verdict === 'deny') throw new Error(tr('回滚被拦截：{reason}', { reason: c.reason ?? '' }))
  if (c.dangerous && !ackDanger) throw new Error(tr('回滚命令命中危险命令模式，须先勾选确认'))
  let r: RollbackResult
  try { r = await d.exec(c.terminalId, c.command) }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    throw new Error(/terminal_busy/.test(m) ? tr('终端正忙（AI 正在执行命令），稍后再试') : m)
  }
  d.audit({
    sessionId, terminalId: c.terminalId, terminalTitle: c.terminalTitle, hostKey: c.hostKey, command: c.command,
    decision: ROLLBACK_DECISION, undoOf: at, exitCode: r.exitCode, ...(r.truncated ? { truncated: true } : {}), ...(c.rule ? { rule: c.rule } : {}),
  })
  return r
}

export function registerRollback(deps: RollbackDeps & { handle(channel: string, fn: (...args: any[]) => unknown): void }): void {   // eslint-disable-line @typescript-eslint/no-explicit-any
  deps.handle('rollback:check', (_e: unknown, sid: string, at: string) => checkRollback(deps, String(sid), String(at)))
  deps.handle('rollback:run', (_e: unknown, sid: string, at: string, ackDanger: boolean) => runRollback(deps, String(sid), String(at), ackDanger === true))
}
