// 执行记录汇总：「今天放行了哪些危险操作」这类复盘，直接把一堆审计记录丢给 AI 太浪费，
// 这里先按主机 / 决定类型统计，再把危险项的明细列出来。
import type { AuditEntry } from '../protocol/types.js'

/** 值得人回头看一眼的决定：拦截、删文件、杀进程、库脚本这类 */
const RISKY_PREFIX = ['deny:', 'rollback', 'turn_undo']
const RISKY_EXACT = new Set([
  'process_kill', 'db_kill', 'db_script', 'db_key_del', 'file_delete', 'file_rename',
  'key_deploy', 'mcp_call', 'write_allowed', 'upload_allowed', 'download_allowed',
  'exec_allowed:edited',
])

export function isRisky(e: AuditEntry): boolean {
  const d = e.decision
  // 按规则自动放行的也算「值得复盘」：没经过人逐条确认的那一类
  return RISKY_EXACT.has(d) || RISKY_PREFIX.some((p) => d.startsWith(p)) || !!e.rule || (e.exitCode !== undefined && e.exitCode !== 0)
}

/** 今天的记录（按本地时区算自然日） */
export function isToday(e: AuditEntry, now = Date.now()): boolean {
  const d = new Date(e.at)
  const n = new Date(now)
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

export interface AuditDigestOpts {
  /** hostKey → 人看得懂的主机名 */
  hostLabel?: (k: string) => string
  /** 只统计这些（已经筛过的）记录；不传=全部 */
  rows: AuditEntry[]
  /** 汇总口径说明，如「今天」「本会话」 */
  scopeNote?: string
}

const line = (e: AuditEntry, hostLabel: (k: string) => string): string => {
  const when = new Date(e.at).toLocaleTimeString()
  const who = hostLabel(e.hostKey) + (e.terminalTitle ? ` · ${e.terminalTitle}` : '')
  const bits = [`${when}`, who, e.decision]
  if (e.rule) bits.push(`规则：${e.rule}`)   // i18n-ignore 发给 AI 的话
  if (e.exitCode !== undefined) bits.push(`退出码 ${e.exitCode}`)   // i18n-ignore 发给 AI 的话
  if (e.command) bits.push(`命令：${e.command.replace(/\s+/g, ' ').slice(0, 200)}`)   // i18n-ignore 发给 AI 的话
  if (e.filePath) bits.push(`文件：${e.filePath}`)   // i18n-ignore 发给 AI 的话
  return `- ${bits.join(' | ')}`
}

export function auditDigest({ rows, hostLabel = (k) => k, scopeNote }: AuditDigestOpts): string {
  if (!rows.length) return `【执行记录】${scopeNote ?? ''}没有任何记录。`   // i18n-ignore 发给 AI 的话
  const byHost = new Map<string, number>()
  const byDecision = new Map<string, number>()
  for (const e of rows) {
    const h = hostLabel(e.hostKey)
    byHost.set(h, (byHost.get(h) ?? 0) + 1)
    byDecision.set(e.decision, (byDecision.get(e.decision) ?? 0) + 1)
  }
  const risky = rows.filter(isRisky).slice(0, 60)
  const tail = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} × ${v}`).join('、')   // i18n-ignore 发给 AI 的话
  const out = [
    `【执行记录】范围：${scopeNote ?? '全部'}，共 ${rows.length} 条。`,   // i18n-ignore 发给 AI 的话
    `按主机：${tail(byHost)}`,   // i18n-ignore 发给 AI 的话
    `按类型：${tail(byDecision)}`,   // i18n-ignore 发给 AI 的话
    `其中有风险 / 需要复盘的有 ${rows.filter(isRisky).length} 条${risky.length < rows.filter(isRisky).length ? `（明细只列最近 ${risky.length} 条）` : ''}：`,   // i18n-ignore 发给 AI 的话
    ...(risky.length ? risky.map((e) => line(e, hostLabel)) : ['- 无']),   // i18n-ignore 发给 AI 的话
    '说明：这是执行记录（谁批准了什么、退出码多少），不是命令输出；需要细节可以让我再看某一条。',   // i18n-ignore 发给 AI 的话
  ]
  return out.join('\n')
}
