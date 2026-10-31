// 对话里 Markdown 表格的「复制」：从 react-markdown 给的 hast 表格节点取出单元格文字，转成 Markdown 或制表符分隔（可直接粘进 Excel）
export type HNode = { type: string; tagName?: string; value?: string; children?: HNode[] }

const textOf = (n?: HNode): string => (!n ? '' : n.type === 'text' ? n.value ?? '' : n.tagName === 'br' ? ' ' : (n.children ?? []).map(textOf).join(''))

/** 表格节点 → 行（第一行是表头），单元格文字已去掉首尾空白、内部换行压成空格 */
export function tableRows(table?: HNode): string[][] {
  const rows: string[][] = []
  const walk = (n: HNode) => {
    if (n.tagName === 'tr') rows.push((n.children ?? []).filter((c) => c.tagName === 'th' || c.tagName === 'td').map((c) => textOf(c).replace(/\s+/g, ' ').trim()))
    else (n.children ?? []).forEach(walk)
  }
  if (table) walk(table)
  return rows
}

/** Markdown 表格（| 转义、按最宽列补齐不必要，保持紧凑） */
export function rowsToMarkdown(rows: string[][]): string {
  if (!rows.length) return ''
  const w = Math.max(...rows.map((r) => r.length))
  const line = (r: string[]) => `| ${Array.from({ length: w }, (_x, i) => (r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(rows[0]), `| ${Array(w).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

/** 制表符分隔：Excel / WPS / 飞书表格粘贴后按列拆开 */
export const rowsToTsv = (rows: string[][]): string => rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
