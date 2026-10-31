import { describe, expect, it } from 'vitest'
import { bufferFileName, bufferText, readTermBuffer, registerBufferReader, type Buf } from './termBuffer.js'

// 假缓冲：每行 [文本（含行尾空格）, 是否软换行续行]
const buf = (rows: [string, boolean?][]): Buf => ({
  length: rows.length,
  getLine: (y) => rows[y] && { isWrapped: !!rows[y][1], translateToString: (trim?: boolean) => (trim ? rows[y][0].trimEnd() : rows[y][0]) },
})

describe('bufferText', () => {
  it('软换行接回上一行（保留行尾空格），硬换行分行，末尾空行去掉', () => {
    expect(bufferText(buf([['$ echo hello   '], ['abc de', false], ['f gh  '], ['ij', true], [''], ['   ']]))).toBe('$ echo hello\nabc de\nf gh  ij\n')
  })
  it('空缓冲导出空串', () => {
    expect(bufferText(buf([['  '], ['']]))).toBe('')
  })
})

describe('登记表与文件名', () => {
  it('按终端 id 取，注销只删自己登记的', () => {
    const off1 = registerBufferReader('t1', () => 'a')
    registerBufferReader('t1', () => 'b')
    off1()
    expect(readTermBuffer('t1')).toBe('b')
    expect(readTermBuffer('nope')).toBeUndefined()
  })
  it('文件名去掉非法字符并带时间', () => {
    expect(bufferFileName('root@1.2.3.4:22 / "x"', new Date(2026, 9, 14, 9, 5, 7))).toBe('root@1.2.3.4_22 _ _x_-20261014-090507.txt')
    expect(bufferFileName('???', new Date(2026, 0, 1))).toBe('_-20260101-000000.txt')
  })
})
