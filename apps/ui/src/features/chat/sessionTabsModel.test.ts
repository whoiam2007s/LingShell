import { describe, it, expect } from 'vitest'
import type { SessionMeta } from '@lingshell/shared'
import {
  MAX_TABS, RECENT_N, TAB_TITLE_MAX, closeTab, openTab, recentSessions, restoreTabs, splitTabs, tabTitle,
} from './sessionTabsModel.js'

const s = (id: string, at: string, title = id): SessionMeta => ({ id, title, threadId: id, createdAt: at, lastActiveAt: at })

describe('标签标题', () => {
  it('去换行、超长截断', () => {
    expect(tabTitle('a\nb\tc')).toBe('a b c')
    const long = 'x'.repeat(TAB_TITLE_MAX + 5)
    expect(tabTitle(long)).toBe(`${'x'.repeat(TAB_TITLE_MAX)}…`)
  })

  it('空标题返回空串（占位由调用方给）', () => {
    expect(tabTitle('')).toBe('')
    expect(tabTitle(undefined)).toBe('')
  })
})

describe('最近会话（下拉用）', () => {
  it('按最后活跃倒序，最多 10 条', () => {
    const list = Array.from({ length: RECENT_N + 4 }, (_, i) => s(`s${i}`, `2026-11-0${(i % 9) + 1}T00:00:00.000Z`))
    const r = recentSessions(list, 'none', RECENT_N)
    expect(r).toHaveLength(RECENT_N)
    expect(r[0].lastActiveAt! >= r[1].lastActiveAt!).toBe(true)
  })

  it('当前会话不在最近 10 条里时也要补进来（否则切不回去）', () => {
    const list = Array.from({ length: 12 }, (_, i) => s(`s${i}`, `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`))
    const old = list[11]
    const r = recentSessions(list, old.id, RECENT_N)
    expect(r[0].id).toBe(old.id)
    expect(r).toHaveLength(RECENT_N)
  })
})

describe('标签开合', () => {
  it('重复打开不产生第二个', () => {
    expect(openTab(['a'], 'a')).toEqual(['a'])
    expect(openTab(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('超过上限丢最久没用的，当前会话和新打开的不会被丢', () => {
    const ids = Array.from({ length: MAX_TABS }, (_, i) => `t${i}`)
    const next = openTab(ids, 'new', 't1')
    expect(next).toHaveLength(MAX_TABS)
    expect(next).toContain('new')
    expect(next).toContain('t1')
    expect(next).not.toContain('t0')
  })

  it('关闭：普通标签能关，当前会话关不掉', () => {
    expect(closeTab(['a', 'b'], 'a')).toEqual(['b'])
    expect(closeTab(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
  })
})

describe('持久化恢复', () => {
  it('过滤已删除的会话、去重，并保证当前会话在末尾', () => {
    const got = restoreTabs(['gone', 'a', 'a', 'b'], ['a', 'b', 'c'], 'c')
    expect(got).toEqual(['a', 'b', 'c'])
  })

  it('脏数据不炸', () => {
    expect(restoreTabs(null, ['a'], 'a')).toEqual(['a'])
    expect(restoreTabs([1, 'a', null], ['a'], 'a')).toEqual(['a'])
  })
})

describe('溢出', () => {
  it('不超过上限时全显示；超了留一格给「…」', () => {
    expect(splitTabs(['a', 'b'])).toEqual({ shown: ['a', 'b'], overflow: 0 })
    const many = Array.from({ length: MAX_TABS + 2 }, (_, i) => `t${i}`)
    const r = splitTabs(many)
    expect(r.shown).toHaveLength(MAX_TABS - 1)
    expect(r.overflow).toBe(3)
  })
})
