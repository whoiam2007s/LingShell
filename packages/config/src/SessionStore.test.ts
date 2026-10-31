import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './SessionStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })
const meta = (id: string, t = '0') => ({ id, title: id, threadId: `thr_${id}`, createdAt: t, lastActiveAt: t })

describe('SessionStore', () => {
  it('upsert + list 倒序(lastActiveAt)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = new SessionStore(dir)
    s.upsert(meta('a', '2026-01-01'))
    s.upsert(meta('b', '2026-01-02'))
    expect(s.list().map((m) => m.id)).toEqual(['b', 'a'])
  })
  it('upsert 同 id 更新', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = new SessionStore(dir)
    s.upsert(meta('a'))
    s.upsert({ ...meta('a'), title: '改名' })
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0].title).toBe('改名')
  })
  it('remove', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = new SessionStore(dir)
    s.upsert(meta('a')); s.remove('a')
    expect(s.list()).toHaveLength(0)
  })
  it('touch 更新 lastActiveAt 影响排序', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = new SessionStore(dir)
    s.upsert(meta('a', '2026-01-01')); s.upsert(meta('b', '2026-01-02'))
    s.touch('a', '2026-01-03')
    expect(s.list().map((m) => m.id)).toEqual(['a', 'b'])
  })
  it('损坏/不存在返回空', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = new SessionStore(join(dir, 'nope'))
    expect(s.list()).toEqual([])
  })
  it('旧记录缺 lastActiveAt / 非法记录：不影响其余会话', () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-'))
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify([
      { id: 'old', title: '旧', threadId: 't1', createdAt: '2026-01-01' },   // 没有 lastActiveAt
      null,
      { title: '没 id' },
      meta('new', '2026-01-02'),
    ]))
    const s = new SessionStore(dir)
    expect(s.list().map((m) => m.id)).toEqual(['new', 'old'])
  })
})
