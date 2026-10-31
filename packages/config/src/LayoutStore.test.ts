import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LayoutStore } from './LayoutStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('LayoutStore', () => {
  it('save then get roundtrips', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    new LayoutStore(dir).save({ terminals: [{ kind: 'local' }, { kind: 'ssh', hostId: 'h1' }], activeSessionId: 'sess_1' })
    const got = new LayoutStore(dir).get()
    expect(got.terminals).toEqual([{ kind: 'local' }, { kind: 'ssh', hostId: 'h1' }])
    expect(got.activeSessionId).toBe('sess_1')
  })
  it('主机面板偏好与工作区：往返、与终端布局互不抹除、坏数据丢弃', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = new LayoutStore(dir)
    s.save({ terminals: [{ kind: 'local' }] })
    s.save({ favoriteHosts: ['a'], recentHosts: ['b', 'a'], hostProbe: false })
    s.save({ workspaces: [
      { id: 'w1', name: '订单', terminals: [{ kind: 'ssh', hostId: 'a' }, { kind: 'local' }], terminalSplit: { mode: 'cols2', panes: [0, 1], sizes: [0.5] }, savedAt: 't' },
      { id: 'bad' } as never,
    ] })
    s.save({ terminals: [] })
    const got = s.get()
    expect(got).toMatchObject({ favoriteHosts: ['a'], recentHosts: ['b', 'a'], hostProbe: false })
    expect(got.workspaces?.map((w) => w.id)).toEqual(['w1'])
    expect(got.workspaces?.[0].terminalSplit).toEqual({ mode: 'cols2', panes: [0, 1], sizes: [0.5] })
  })
  it('missing → empty layout', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    expect(new LayoutStore(join(dir, 'nope')).get()).toEqual({ terminals: [] })
  })
  it('save 浅合并：只传一个字段不抹除另一个', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = new LayoutStore(dir)
    s.save({ terminals: [{ kind: 'local' }] })       // 只更新终端
    s.save({ activeSessionId: 'sess_2' })             // 只更新活动会话，不应抹掉 terminals
    const got = s.get()
    expect(got.terminals).toEqual([{ kind: 'local' }])
    expect(got.activeSessionId).toBe('sess_2')
  })
  it('分屏状态往返；传 undefined 即清除', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = new LayoutStore(dir)
    s.save({ terminals: [{ kind: 'local' }, { kind: 'local' }], terminalSplit: { mode: 'grid4', panes: [0, 1, 0, 1], sizes: [0.4, 0.6] } })
    expect(s.get().terminalSplit).toEqual({ mode: 'grid4', panes: [0, 1, 0, 1], sizes: [0.4, 0.6] })
    // 旧版两窗格格式读出即迁移
    s.save({ terminalSplit: { left: 0, right: 1, ratio: 0.4, vertical: true } as never })
    expect(s.get().terminalSplit).toEqual({ mode: 'rows2', panes: [0, 1], sizes: [0.4] })
    s.save({ terminalSplit: undefined })
    expect(s.get().terminalSplit).toBeUndefined()
    expect(s.get().terminals).toHaveLength(2)
  })
  it('标签颜色 / 重命名往返', () => {
    dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const items = [{ kind: 'local' as const, color: 'green', title: '构建' }, { kind: 'ssh' as const, hostId: 'h1', color: 'red' }, { kind: 'local' as const, shell: 'wsl:Ubuntu' }]
    new LayoutStore(dir).save({ terminals: items })
    expect(new LayoutStore(dir).get().terminals).toEqual(items)
  })
})
