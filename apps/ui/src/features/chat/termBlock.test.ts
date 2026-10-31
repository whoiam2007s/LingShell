import { describe, it, expect } from 'vitest'
import { clipBlock, termBlockName, termBlockText, withTermBlocks, parseBlockDrag, splitTermBlocks, TERM_BLOCK_MAX } from '../../lib/termBlock.js'

describe('终端块', () => {
  const b = { terminalTitle: 'web-1', command: 'systemctl status nginx', exitCode: 3, cwd: '/etc', output: 'inactive (dead)\n' }
  it('拼给模型的文本：命令、退出码、目录、输出', () => {
    const t = termBlockText(b)
    expect(t).toContain('[终端块] 终端「web-1」里的命令（退出码 3，目录 /etc）')
    expect(t).toContain('$ systemctl status nginx\ninactive (dead)')
    expect(termBlockText({ terminalTitle: 'x', output: 'sel' })).toContain('输出片段')
  })
  it('输出超 8KB 只留末尾', () => {
    const c = clipBlock({ ...b, output: 'a'.repeat(TERM_BLOCK_MAX) + 'TAIL' })
    expect(c.output.endsWith('TAIL')).toBe(true)
    expect(c.output).toContain('前面省略 4 字')
    expect(clipBlock(b).output).toBe('inactive (dead)')
  })
  it('多块接在用户的话后面；没有块原样', () => {
    expect(withTermBlocks('看看', [])).toBe('看看')
    const s = withTermBlocks('为什么挂了', [b, { terminalTitle: 'x', output: 'y' }])
    expect(s.startsWith('为什么挂了\n\n[终端块]')).toBe(true)
    expect(s.match(/\[终端块\]/g)).toHaveLength(2)
    expect(withTermBlocks('  ', [b]).startsWith('[终端块]')).toBe(true)
  })
  it('反解回用户原话 + 各块（气泡显示用）', () => {
    const blocks = [b, { terminalTitle: 'x', output: 'line1\nline2' }, { terminalTitle: 'y', command: 'true', output: '' }]
    const r = splitTermBlocks(withTermBlocks('为什么挂了\n第二行', blocks.map((x) => clipBlock(x))))
    expect(r.text).toBe('为什么挂了\n第二行')
    expect(r.blocks).toEqual([{ ...b, output: 'inactive (dead)' }, { terminalTitle: 'x', output: 'line1\nline2' }, { terminalTitle: 'y', command: 'true', output: '（无输出）' }])
    expect(splitTermBlocks(withTermBlocks('', [b])).text).toBe('')
    expect(splitTermBlocks('普通消息')).toEqual({ text: '普通消息', blocks: [] })
  })
  it('tag 名与拖拽数据校验', () => {
    expect(termBlockName(b)).toBe('web-1 · systemctl status nginx')
    expect(termBlockName({ terminalTitle: 'x', output: '' })).toBe('x · 输出片段')
    expect(parseBlockDrag(JSON.stringify({ terminalTitle: 't', output: 'o', exitCode: '1' }))).toEqual({ terminalTitle: 't', output: 'o' })
    expect(parseBlockDrag('{bad')).toBeUndefined()
    expect(parseBlockDrag(JSON.stringify({ output: 1 }))).toBeUndefined()
  })
})
