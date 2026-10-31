import { describe, it, expect } from 'vitest'
import type { HostSummary, Workspace } from '../protocol/index.js'
import { pushRecentHost, toggleFavorite, pickHosts, probeLabel, probeTone, groupNeedsConfirm, autoSplitMode, groupLayout, workspaceFromLayout, upsertWorkspace, renameWorkspace, removeWorkspace, workspaceSummary } from './hostPanel.js'
import { restoreView } from './split.js'

const h = (id: string, env?: 'prod'): HostSummary => ({ id, label: id, host: 'x', port: 22, username: 'u', authType: 'password', ...(env ? { env } : {}) })

describe('hostPanel', () => {
  it('最近连接：提前、去重、最多 10', () => {
    expect(pushRecentHost(['a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(pushRecentHost(undefined, 'a')).toEqual(['a'])
    expect(pushRecentHost(Array.from({ length: 10 }, (_, i) => `h${i}`), 'new')).toHaveLength(10)
  })
  it('收藏开关 + 按 id 取主机（跳过已删）', () => {
    expect(toggleFavorite(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b'])
    expect(pickHosts([h('a'), h('b')], ['b', 'gone', 'a']).map((x) => x.id)).toEqual(['b', 'a'])
  })
  it('延迟文案与色档', () => {
    expect(probeLabel({ state: 'ok', ms: 42 })).toBe('42ms')
    expect(probeLabel({ state: 'down' })).toBe('不可达')
    expect(probeLabel({ state: 'jump' })).toBe('经跳板')
    expect(probeLabel(undefined)).toBe('')
    expect(probeTone({ state: 'ok', ms: 99 })).toBe('good')
    expect(probeTone({ state: 'ok', ms: 200 })).toBe('fair')
    expect(probeTone({ state: 'ok', ms: 300 })).toBe('slow')
    expect(probeTone({ state: 'down' })).toBe('down')
    expect(probeTone({ state: 'jump' })).toBe('none')
  })
  it('整组打开：生产多于 1 台才确认；≤4 台自动分屏', () => {
    expect(groupNeedsConfirm([h('a', 'prod'), h('b')])).toBe(false)
    expect(groupNeedsConfirm([h('a', 'prod'), h('b', 'prod')])).toBe(true)
    expect([1, 2, 3, 4, 5].map(autoSplitMode)).toEqual(['single', 'cols2', 'cols3', 'grid4', 'single'])
    const g = groupLayout(['a', 'b', 'c', 'd'])
    expect(g.terminals).toEqual(['a', 'b', 'c', 'd'].map((hostId) => ({ kind: 'ssh', hostId })))
    expect(g.terminalSplit).toEqual({ mode: 'grid4', panes: [0, 1, 2, 3], sizes: [0.5, 0.5] })
    expect(groupLayout(['a', 'b', 'c', 'd', 'e']).terminalSplit).toBeUndefined()
    // 与打开逻辑配合：一台连不上 → 四宫格降级为三列
    expect(restoreView(g.terminalSplit, ['t1', '', 't3', 't4'], 't1').mode).toBe('cols3')
  })
  it('从布局存工作区：去掉 tmux 名，带上分屏和标签色', () => {
    const w = workspaceFromLayout({
      terminals: [{ kind: 'local' }, { kind: 'ssh', hostId: 'a', tmux: 'ais-1', color: 'red' }],
      activeTerminalIndex: 1, terminalSplit: { mode: 'cols2', panes: [0, 1], sizes: [0.5] }, chatWidth: 600,
    }, ' 订单系统 ', 'w1', new Date('2026-01-01T00:00:00Z'))
    expect(w).toEqual({
      id: 'w1', name: '订单系统', terminals: [{ kind: 'local' }, { kind: 'ssh', hostId: 'a', color: 'red' }],
      activeTerminalIndex: 1, terminalSplit: { mode: 'cols2', panes: [0, 1], sizes: [0.5] }, savedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(workspaceSummary(w)).toBe('2 个终端 · 左右分屏')
  })
  it('工作区增删改：同名覆盖保留原 id', () => {
    const mk = (id: string, name: string, n = 1): Workspace => ({ id, name, terminals: Array.from({ length: n }, () => ({ kind: 'local' as const })), savedAt: '' })
    let list = upsertWorkspace(undefined, mk('1', 'A'))
    list = upsertWorkspace(list, mk('2', 'B'))
    list = upsertWorkspace(list, mk('3', 'A', 3))
    expect(list.map((w) => [w.id, w.name, w.terminals.length])).toEqual([['1', 'A', 3], ['2', 'B', 1]])
    list = renameWorkspace(list, '2', ' C ')
    expect(list[1].name).toBe('C')
    expect(removeWorkspace(list, '1').map((w) => w.id)).toEqual(['2'])
  })
})
