import { describe, it, expect } from 'vitest'
import { findSuspects, trailingSpaces, indentInfo, eolInfo, cleanText, findAll, replaceAll, lineCol, lineStart, indentLines, outdentLines, newlineKeepIndent, toggleComment, moveLines, duplicateLines, deleteLines, checkSyntax } from './editorOps.js'

describe('可疑字符 / 空白', () => {
  it('BOM、零宽、不换行空格、全角空格、控制字符分别认出来', () => {
    const t = '\uFEFFa\u200Bb\u00A0c\u3000d\u0007e\uFEFF'
    expect(findSuspects(t).map((s) => [s.at, s.kind, s.code])).toEqual([[0, 'bom', 'U+FEFF'], [2, 'zw', 'U+200B'], [4, 'nbsp', 'U+00A0'], [6, 'wide', 'U+3000'], [8, 'ctrl', 'U+0007'], [10, 'zw', 'U+FEFF']])
    expect(findSuspects('a\tb\nc')).toEqual([])
  })
  it('行尾空白、缩进混用、换行符混用', () => {
    expect(trailingSpaces('a  \nb\t\nc')).toEqual([{ start: 1, end: 3 }, { start: 5, end: 6 }])
    expect(indentInfo('a:\n  b: 1\n    c: 2\n\td: 3')).toMatchObject({ tabs: 1, spaces: 2, unit: '  ', tabLines: [3], spaceLines: [1, 2] })
    expect(indentInfo('x\n    y\n        z').unit).toBe('    ')
    expect(eolInfo('a\r\nb\nc\r\n')).toEqual({ crlf: 2, lf: 1, cr: 0 })
  })
  it('一键清理', () => {
    expect(cleanText('\uFEFFkey\u00A0=\u3000v\u200B  \nx\t\n')).toBe('key = v\nx\n')
  })
})

describe('查找 / 位置', () => {
  it('大小写、整词、替换全部', () => {
    const t = 'Port port PORT import'
    expect(findAll(t, 'port').length).toBe(4)
    expect(findAll(t, 'port', { caseSensitive: true }).length).toBe(2)
    expect(findAll(t, 'port', { wholeWord: true }).length).toBe(3)
    expect(findAll('a.b a*b', '.')).toEqual([{ start: 1, end: 2 }])
    expect(replaceAll(t, findAll(t, 'port', { wholeWord: true }), 'p')).toBe('p p p import')
    expect(findAll('端口 端口号', '端口', { wholeWord: true }).length).toBe(1)
  })
  it('行列', () => {
    expect(lineCol('ab\ncd\nef', 4)).toEqual({ line: 2, col: 2 })
    expect(lineStart('ab\ncd\nef', 3)).toBe(6)
    expect(lineStart('ab', 9)).toBe(0)
  })
})

describe('编辑操作', () => {
  it('缩进 / 反缩进多行，选区跟着动', () => {
    const r = indentLines('a\nb\nc', { start: 0, end: 3 }, '  ')
    expect(r.text).toBe('  a\n  b\nc')
    expect(r.sel).toEqual({ start: 2, end: 7 })
    expect(outdentLines(r.text, r.sel, '  ').text).toBe('a\nb\nc')
    expect(outdentLines('\tx', { start: 1, end: 1 }, '  ').text).toBe('x')
  })
  it('回车保持缩进', () => {
    expect(newlineKeepIndent('  a: 1', { start: 6, end: 6 })).toEqual({ text: '  a: 1\n  ', sel: { start: 9, end: 9 } })
  })
  it('注释切换：加在最小缩进处，全注释了就去掉', () => {
    const on = toggleComment('  a\n    b\n', { start: 0, end: 8 }, '#')
    expect(on.text).toBe('  # a\n  #   b\n')
    expect(toggleComment(on.text, { start: 0, end: 12 }, '#').text).toBe('  a\n    b\n')
    expect(toggleComment('x = 1', { start: 2, end: 2 }, '//').text).toBe('// x = 1')
  })
  it('上下移动、复制、删除行', () => {
    expect(moveLines('a\nb\nc', { start: 2, end: 2 }, -1)).toEqual({ text: 'b\na\nc', sel: { start: 0, end: 0 } })
    expect(moveLines('a\nb\nc', { start: 2, end: 2 }, 1)).toEqual({ text: 'a\nc\nb', sel: { start: 4, end: 4 } })
    expect(moveLines('a\nb', { start: 0, end: 0 }, -1).text).toBe('a\nb')
    expect(duplicateLines('a\nb', { start: 0, end: 1 })).toEqual({ text: 'a\na\nb', sel: { start: 2, end: 3 } })
    expect(deleteLines('a\nb\nc', { start: 2, end: 2 }).text).toBe('a\nc')
    expect(deleteLines('a\nb', { start: 2, end: 3 }).text).toBe('a')
  })
})

describe('保存前语法检查', () => {
  it('JSON 出错给行号；YAML 的 Tab 缩进、引号没闭合', () => {
    expect(checkSyntax('{"a": 1}', 'x.json')).toBeUndefined()
    expect(checkSyntax('{\n "a": 1,\n}', 'x.json')?.line).toBe(3)
    expect(checkSyntax('a:\n\tb: 1', 'x.yaml')).toEqual({ line: 2, message: 'YAML 不能用 Tab 缩进' })
    expect(checkSyntax('a: "x', 'x.yml')).toBeUndefined()
    expect(checkSyntax('- "x', 'x.yml')?.message).toBe('引号没有闭合')
    expect(checkSyntax('anything', 'x.conf')).toBeUndefined()
  })
})
