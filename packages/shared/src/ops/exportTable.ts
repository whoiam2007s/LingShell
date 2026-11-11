// 导出：命令历史 / 执行记录 → Markdown 或 CSV。
// CSV 带 UTF-8 BOM（Excel 打开不乱码），字段含逗号 / 引号 / 换行时加引号；
// Markdown 表格里的 | 和换行要转义，否则贴进工单的表格会散开。
// 注意：函数名带 table 前缀，避免和 terminal/outputTable.ts 的 toCsv / toMarkdown 撞名。
import type { AuditEntry, CommandHistoryEntry } from '../protocol/types.js'
import { tr } from '../i18n/i18n.js'
import { auditDecisionLabel } from '../ai/report.js'

export type ExportFormat = 'markdown' | 'csv'
export interface ExportTable { header: string[]; rows: string[][] }
export interface ExportCtx {
  /** hostKey → 人看得懂的主机名 */
  hostLabel: (hostKey: string) => string
  /** 时间戳格式化（如本地时区）；缺省原样输出 ISO */
  timeLabel?: (iso: string) => string
}

/** 文件扩展名（保存框默认文件名用） */
export const formatExt = (f: ExportFormat): string => (f === 'csv' ? 'csv' : 'md')

const at = (iso: string, ctx: ExportCtx) => (ctx.timeLabel ? ctx.timeLabel(iso) : iso)

export function historyTable(entries: CommandHistoryEntry[], ctx: ExportCtx): ExportTable {
  return {
    header: [tr('时间'), tr('主机'), tr('终端'), tr('来源'), tr('命令')],
    rows: entries.map((e) => [
      at(e.at, ctx),
      ctx.hostLabel(e.hostKey),
      e.terminalTitle,
      e.source === 'ai' ? 'AI' : tr('用户'),
      e.command,
    ]),
  }
}

export function auditTable(entries: AuditEntry[], ctx: ExportCtx): ExportTable {
  return {
    header: [tr('时间'), tr('主机'), tr('终端'), tr('命令'), tr('决定'), tr('退出码'), tr('回滚'), tr('备份路径')],
    rows: entries.map((e) => [
      at(e.at, ctx),
      ctx.hostLabel(e.hostKey),
      e.terminalTitle ?? '',
      e.command ?? e.filePath ?? '',
      auditDecisionLabel(e.decision),
      e.exitCode === undefined ? '' : String(e.exitCode),
      e.rollback ?? '',
      e.backupPath ?? '',
    ]),
  }
}

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ')

export function tableToCsv(t: ExportTable): string {
  const lines = [t.header, ...t.rows].map((r) => r.map(csvCell).join(','))
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

export function tableToMarkdown(title: string, t: ExportTable): string {
  const head = `| ${t.header.map(mdCell).join(' | ')} |`
  const sep = `| ${t.header.map(() => '---').join(' | ')} |`
  const body = t.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)
  return [title, '', head, sep, ...body].join('\n') + '\n'
}

/** 导出成可直接保存的文本：CSV 带 BOM，Markdown 带标题；空结果也给表头（是否提示「空态」由调用方决定） */
export function exportTable(format: ExportFormat, title: string, t: ExportTable): string {
  return format === 'csv' ? tableToCsv(t) : tableToMarkdown(title, t)
}
