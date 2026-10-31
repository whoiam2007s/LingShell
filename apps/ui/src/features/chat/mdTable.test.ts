import { describe, expect, it } from 'vitest'
import { rowsToMarkdown, rowsToTsv, tableRows, type HNode } from './mdTable.js'

const el = (tagName: string, children: HNode[] = []): HNode => ({ type: 'element', tagName, children })
const t = (value: string): HNode => ({ type: 'text', value })
// | 检查项 | 结论 |  ← 表头；单元格里有 <strong>、<br>、管道符
const table = el('table', [
  el('thead', [el('tr', [el('th', [t('检查项')]), el('th', [t('结论')])])]),
  el('tbody', [
    el('tr', [el('td', [t('内存')]), el('td', [el('strong', [t('最大瓶颈')]), el('br'), t('  需腾内存 ')])]),
    el('tr', [el('td', [t('a|b')]), el('td', [t('ok\tyes')])]),
  ]),
])

describe('对话表格复制', () => {
  it('取单元格文字：嵌套标签展开、<br> 和多余空白压成一个空格', () => {
    expect(tableRows(table)).toEqual([['检查项', '结论'], ['内存', '最大瓶颈 需腾内存'], ['a|b', 'ok yes']])
  })
  it('Markdown：管道符转义，带分隔行', () => {
    expect(rowsToMarkdown(tableRows(table))).toBe('| 检查项 | 结论 |\n| --- | --- |\n| 内存 | 最大瓶颈 需腾内存 |\n| a\\|b | ok yes |')
  })
  it('制表符分隔（粘进 Excel 按列拆开）', () => {
    expect(rowsToTsv([['a', 'b\tc'], ['1', '2']])).toBe('a\tb c\n1\t2')
  })
})
