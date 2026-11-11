import { describe, it, expect } from 'vitest'
import { auditTable, historyTable, tableToCsv, tableToMarkdown, exportTable, formatExt } from './exportTable.js'
import type { AuditEntry, CommandHistoryEntry } from '../protocol/types.js'

const ctx = { hostLabel: (k: string) => (k === 'local' ? '本机' : 'web-1'), timeLabel: (iso: string) => iso.slice(11, 19) }

const hist: CommandHistoryEntry[] = [
  { command: 'ls -la', terminalId: 't1', terminalTitle: '本地', hostKey: 'local', at: '2026-01-02T03:04:05.000Z', source: 'user' },
  { command: 'df -h', terminalId: 't2', terminalTitle: 'web', hostKey: 'h1', at: '2026-01-02T04:05:06.000Z', source: 'ai' },
]

const audit: AuditEntry[] = [
  { at: '2026-01-02T03:04:05.000Z', sessionId: 's1', terminalId: 't1', hostKey: 'local', command: 'echo "a,b"', decision: 'exec_allowed', exitCode: 0, rollback: 'rm -f x' },
  { at: '2026-01-02T03:10:00.000Z', sessionId: 's1', terminalId: 't1', hostKey: 'local', command: 'rm -rf /tmp/x', decision: 'deny:user:危险', exitCode: 1 },
]

describe('导出表', () => {
  it('命令历史：列顺序 + 时间格式化 + 来源', () => {
    const t = historyTable(hist, ctx)
    expect(t.header.length).toBe(5)
    expect(t.rows[0][0]).toBe('03:04:05')
    expect(t.rows[0][1]).toBe('本机')
    expect(t.rows[1][1]).toBe('web-1')
    expect(t.rows[1][3]).toBe('AI')
    expect(t.rows[0][4]).toBe('ls -la')
  })

  it('执行记录：退出码 / 回滚 / 备份路径', () => {
    const t = auditTable(audit, ctx)
    expect(t.rows[0][5]).toBe('0')
    expect(t.rows[0][6]).toBe('rm -f x')
    expect(t.rows[0][7]).toBe('')
    expect(t.rows[1][5]).toBe('1')
  })

  it('CSV 带 UTF-8 BOM、逗号与引号被转义', () => {
    const csv = tableToCsv(auditTable(audit, ctx))
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"echo ""a,b"""')
    expect(csv.split('\r\n').length).toBeGreaterThan(2)
  })

  it('Markdown 表格的竖线与换行被转义', () => {
    const md = tableToMarkdown('# 标题', { header: ['a'], rows: [['x|y\nz']] })
    expect(md).toContain('# 标题')
    expect(md).toContain('| x\\|y ⏎ z |')
    expect(md).toContain('| --- |')
  })

  it('空结果也给出表头（不让调用方拿到空文件）', () => {
    const md = tableToMarkdown('# 空', historyTable([], ctx))
    expect(md).toContain('| --- |')
    const csv = tableToCsv(historyTable([], ctx))
    expect(csv.trim().split('\r\n').length).toBe(1)
  })

  it('exportTable 按格式分派；扩展名', () => {
    const t = historyTable(hist, ctx)
    expect(exportTable('csv', 'x', t).charCodeAt(0)).toBe(0xfeff)
    expect(exportTable('markdown', 'x', t).startsWith('x')).toBe(true)
    expect(formatExt('csv')).toBe('csv')
    expect(formatExt('markdown')).toBe('md')
  })
})
