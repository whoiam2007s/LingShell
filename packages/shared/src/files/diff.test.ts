import { describe, it, expect } from 'vitest'
import { diffLines, unifiedDiff } from './diff.js'

// 把 ops 应用回去，两边都能还原 —— 任何 diff 的正确性底线
const sides = (ops: { t: string; s: string }[]) => ({
  a: ops.filter((o) => o.t !== '+').map((o) => o.s),
  b: ops.filter((o) => o.t !== '-').map((o) => o.s),
})

describe('diffLines', () => {
  it('结果能还原两边，且是最小改动', () => {
    const a = ['a', 'b', 'c', 'd', 'e'], b = ['a', 'x', 'c', 'd', 'e', 'f']
    const ops = diffLines(a, b)
    expect(sides(ops)).toEqual({ a, b })
    expect(ops.filter((o) => o.t !== ' ').map((o) => o.t + o.s)).toEqual(['-b', '+x', '+f'])
  })

  it('乱序/重复行也能还原', () => {
    const a = ['x', 'y', 'x', 'z', 'y'], b = ['y', 'x', 'x', 'y', 'z']
    expect(sides(diffLines(a, b))).toEqual({ a, b })
  })
})

describe('unifiedDiff', () => {
  it('git 风格头与 hunk 行号', () => {
    const old = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    const next = old.replace('L10\n', 'L10 changed\n')
    expect(unifiedDiff(old, next, 'etc/x.conf')).toBe([
      '--- a/etc/x.conf', '+++ b/etc/x.conf',
      '@@ -7,7 +7,7 @@', ' L7', ' L8', ' L9', '-L10', '+L10 changed', ' L11', ' L12', ' L13',
    ].join('\n'))
  })

  it('相距远的改动分成两个 hunk，近的合并', () => {
    const old = Array.from({ length: 30 }, (_, i) => `L${i + 1}`)
    const far = [...old]; far[1] = 'X'; far[25] = 'Y'
    expect(unifiedDiff(old.join('\n'), far.join('\n'), 'f').match(/^@@/gm)).toHaveLength(2)
    const near = [...old]; near[1] = 'X'; near[7] = 'Y'
    expect(unifiedDiff(old.join('\n'), near.join('\n'), 'f').match(/^@@/gm)).toHaveLength(1)
  })

  it('新建文件 / 无变化', () => {
    expect(unifiedDiff('', 'a\nb\n', 'n')).toBe(['--- a/n', '+++ b/n', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'))
    expect(unifiedDiff('same\n', 'same\n', 'n')).toBe('')
    expect(unifiedDiff('same', 'same\n', 'n')).toContain('仅文件末尾换行不同')
  })

  it('中段过大时退化为整段替换，仍可还原', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`), b = Array.from({ length: 3000 }, (_, i) => `b${i}`)
    const ops = diffLines(a, b)
    expect(sides(ops)).toEqual({ a, b })
    expect(ops[0]).toEqual({ t: '-', s: 'a0' })
  })
})
