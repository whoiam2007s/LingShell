import { describe, it, expect } from 'vitest'
import { activate, assign, clampDivider, defaultSizes, dropTerm, EMPTY_VIEW, migrateSplit, neighborPane, normSizes, restoreView, setMode, splitTracks, toSplitLayout, type PaneView } from './split.js'

const v = (mode: PaneView['mode'], panes: string[], focus = 0): PaneView => ({ mode, panes, focus, sizes: defaultSizes(mode) })

describe('migrateSplit', () => {
  it('旧版两窗格 → cols2 / rows2，占比夹到 0.15~0.85', () => {
    expect(migrateSplit({ left: 0, right: 2, ratio: 0.3 })).toEqual({ mode: 'cols2', panes: [0, 2], sizes: [0.3] })
    expect(migrateSplit({ left: 1, right: 0, ratio: 0.99, vertical: true })).toEqual({ mode: 'rows2', panes: [1, 0], sizes: [0.85] })
    expect(migrateSplit({ left: 0, right: 1 })).toEqual({ mode: 'cols2', panes: [0, 1], sizes: [0.5] })
  })
  it('新格式校验：窗格数对不上 / 非法 → undefined；坏 sizes 回默认', () => {
    expect(migrateSplit({ mode: 'grid4', panes: [0, 1, 2, 3], sizes: [0.3, 0.7] })).toEqual({ mode: 'grid4', panes: [0, 1, 2, 3], sizes: [0.3, 0.7] })
    expect(migrateSplit({ mode: 'cols3', panes: [0, 1, 2], sizes: [0.6, 0.4] })?.sizes).toEqual(defaultSizes('cols3'))
    expect(migrateSplit({ mode: 'grid4', panes: [0, 1] })).toBeUndefined()
    expect(migrateSplit({ mode: 'bogus', panes: [0] })).toBeUndefined()
    expect(migrateSplit({ mode: 'single', panes: [0] })).toBeUndefined()
    expect(migrateSplit(undefined)).toBeUndefined()
  })
})

describe('setMode', () => {
  it('焦点终端 + 标签顺序里之后的终端依次填格（环绕）', () => {
    expect(setMode(v('single', ['b']), 'grid4', ['a', 'b', 'c', 'd'])).toEqual(v('grid4', ['b', 'c', 'd', 'a']))
  })
  it('已显示的窗格优先保留；终端不够留空位', () => {
    expect(setMode(v('cols2', ['a', 'c'], 1), 'cols3', ['a', 'b', 'c']).panes).toEqual(['c', 'a', 'b'])
    expect(setMode(v('single', ['a']), 'cols3', ['a']).panes).toEqual(['a', '', ''])
  })
  it('降为单屏只留焦点终端；同模式保留 sizes', () => {
    expect(setMode(v('grid4', ['a', 'b', 'c', 'd'], 2), 'single', ['a', 'b', 'c', 'd']).panes).toEqual(['c'])
    expect(setMode({ ...v('cols2', ['a', 'b']), sizes: [0.3] }, 'cols2', ['a', 'b']).sizes).toEqual([0.3])
  })
})

describe('activate / assign', () => {
  it('已在窗格 → 只移焦点；否则先填空位，再换焦点窗格', () => {
    expect(activate(v('cols2', ['a', 'b']), 'b')).toMatchObject({ panes: ['a', 'b'], focus: 1 })
    expect(activate(v('cols3', ['a', '', '']), 'x')).toMatchObject({ panes: ['a', 'x', ''], focus: 1 })
    expect(activate(v('cols2', ['a', 'b'], 1), 'c')).toMatchObject({ panes: ['a', 'c'], focus: 1 })
    expect(activate(EMPTY_VIEW, 'a').panes).toEqual(['a'])
  })
  it('assign 选中已在别的窗格的终端 → 互换', () => {
    expect(assign(v('grid4', ['a', 'b', 'c', 'd']), 0, 'c')).toMatchObject({ panes: ['c', 'b', 'a', 'd'], focus: 0 })
  })
})

describe('dropTerm', () => {
  it('窗格换上未显示的终端', () => {
    expect(dropTerm(v('cols2', ['a', 'b']), 'b', ['a', 'c']).panes).toEqual(['a', 'c'])
    expect(dropTerm(v('cols2', ['a', 'b']), 'z', ['a', 'b'])).toEqual(v('cols2', ['a', 'b']))
  })
  it('没有可补的终端 → 4→3→2→1 降级，焦点跟着原终端', () => {
    const g = dropTerm(v('grid4', ['a', 'b', 'c', 'd'], 3), 'b', ['a', 'c', 'd'])
    expect(g).toEqual({ mode: 'cols3', panes: ['a', 'c', 'd'], focus: 2, sizes: defaultSizes('cols3') })
    expect(dropTerm(g, 'a', ['c', 'd'])).toMatchObject({ mode: 'cols2', panes: ['c', 'd'], focus: 1 })
    expect(dropTerm(v('rows2', ['a', 'b'], 1), 'b', ['a'])).toMatchObject({ mode: 'single', panes: ['a'], focus: 0 })
    expect(dropTerm(v('single', ['a']), 'a', [])).toEqual(EMPTY_VIEW)
  })
})

describe('restoreView / toSplitLayout', () => {
  it('按下标映射 id，恢复失败的窗格去掉并降级', () => {
    const s = { mode: 'grid4' as const, panes: [0, 1, 2, 3], sizes: [0.3, 0.6] }
    expect(restoreView(s, ['a', 'b', 'c', 'd'], 'c')).toEqual({ mode: 'grid4', panes: ['a', 'b', 'c', 'd'], focus: 2, sizes: [0.3, 0.6] })
    expect(restoreView(s, ['a', '', 'c', 'd'], 'a')).toMatchObject({ mode: 'cols3', panes: ['a', 'c', 'd'], focus: 0 })
    expect(restoreView(s, ['a', '', '', ''], 'a')).toEqual({ ...EMPTY_VIEW, panes: ['a'] })
    expect(restoreView(undefined, ['a'], 'a').panes).toEqual(['a'])
  })
  it('单屏 / 有不可持久化窗格不存', () => {
    const idx = (id: string) => ['a', 'b'].indexOf(id)
    expect(toSplitLayout(v('cols2', ['b', 'a']), idx)).toEqual({ mode: 'cols2', panes: [1, 0], sizes: [0.5] })
    expect(toSplitLayout(v('cols2', ['a', 'tmp']), idx)).toBeUndefined()
    expect(toSplitLayout(v('single', ['a']), idx)).toBeUndefined()
  })
})

describe('分割线', () => {
  it('clampDivider：两侧留最小占比；cols3 不越过另一条线；放不下不动', () => {
    expect(clampDivider('cols2', [0.5], 0, 0.02, 0.1)).toEqual([0.1])
    expect(clampDivider('cols2', [0.5], 0, 0.99, 0.1)).toEqual([0.9])
    expect(clampDivider('cols3', [0.3, 0.6], 0, 0.7, 0.1)).toEqual([0.5, 0.6])
    expect(clampDivider('cols3', [0.3, 0.6], 1, 0.1, 0.1)).toEqual([0.3, 0.4])
    expect(clampDivider('grid4', [0.5, 0.5], 1, 0.7, 0.1)).toEqual([0.5, 0.7])
    expect(clampDivider('cols3', [0.3, 0.4], 0, 0.35, 0.25)).toEqual([0.3, 0.4])
  })
  it('normSizes / splitTracks', () => {
    expect(normSizes('cols2', [0.05])).toEqual([0.5])
    expect(normSizes('grid4', [0.3, 0.8])).toEqual([0.3, 0.8])
    const t = splitTracks('cols3', [0.25, 0.75])
    expect(t).toEqual({ cols: [0.25, 0.5, 0.25], rows: [1] })
    expect(splitTracks('grid4', [0.3, 0.6]).rows.map((x) => +x.toFixed(2))).toEqual([0.6, 0.4])
  })
})

describe('neighborPane', () => {
  it('四宫格四向移动，到边不动', () => {
    expect(neighborPane('grid4', 0, 'right')).toBe(1)
    expect(neighborPane('grid4', 0, 'down')).toBe(2)
    expect(neighborPane('grid4', 3, 'up')).toBe(1)
    expect(neighborPane('grid4', 3, 'left')).toBe(2)
    expect(neighborPane('grid4', 1, 'right')).toBe(1)
  })
  it('三列 / 上下 2 / 单屏', () => {
    expect(neighborPane('cols3', 1, 'right')).toBe(2)
    expect(neighborPane('cols3', 1, 'up')).toBe(1)
    expect(neighborPane('rows2', 0, 'down')).toBe(1)
    expect(neighborPane('rows2', 0, 'right')).toBe(0)
    expect(neighborPane('single', 0, 'left')).toBe(0)
  })
})
