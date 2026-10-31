import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore, legacyCardId } from './KnowledgeStore.js'

let dir: string
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

describe('KnowledgeStore', () => {
  it('增删改查，重开后仍在；更新时间随保存刷新', () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-'))
    let t = 0
    const s = new KnowledgeStore(dir, () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)))
    expect(s.list()).toEqual([])
    const c = s.save({ scope: 'host', target: 'h1', title: ' Nginx 日志 ', content: '/var/log/nginx', category: 'logs', source: 'ai' })
    expect(c.id).toMatch(/^kb_/)
    expect(c.title).toBe('Nginx 日志')
    const c2 = s.save({ ...c, content: '/data/log/nginx', source: 'manual' })
    expect(c2.id).toBe(c.id)
    expect(c2.updatedAt > c.updatedAt).toBe(true)
    expect(new KnowledgeStore(dir).list()).toMatchObject([{ id: c.id, content: '/data/log/nginx', source: 'manual' }])
    expect(() => s.save({ scope: 'host', target: 'h1', title: '', content: 'x', category: 'logs', source: 'ai' })).toThrow()
    s.delete(c.id)
    expect(s.list()).toEqual([])
  })

  it('旧主机备注迁移：每台一张「主机备注」卡；备注没变不动，改了更新同一张；空备注不建；用户自己的卡不受影响', () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-'))
    const s = new KnowledgeStore(dir)
    const mine = s.save({ scope: 'host', target: 'h1', title: '我的', content: 'x', category: 'deploy', source: 'manual' })
    expect(s.syncLegacy([{ hostKey: 'h1', notes: ' 服务用 systemctl 管 ' }, { hostKey: 'h2', notes: '' }, { hostKey: 'local', notes: '本机备注' }])).toBe(true)
    let cards = s.list()
    expect(cards).toHaveLength(3)
    expect(cards.find((c) => c.id === legacyCardId('h1'))).toMatchObject({ scope: 'host', target: 'h1', title: '主机备注', content: '服务用 systemctl 管', category: 'other', source: 'manual' })
    expect(cards.find((c) => c.id === legacyCardId('local'))?.content).toBe('本机备注')
    expect(s.syncLegacy([{ hostKey: 'h1', notes: '服务用 systemctl 管' }])).toBe(false)   // 没变
    s.syncLegacy([{ hostKey: 'h1', notes: '服务用 systemctl 管\n日志在 /var/log/app' }])
    cards = s.list()
    expect(cards).toHaveLength(3)
    expect(cards.find((c) => c.id === legacyCardId('h1'))?.content).toContain('/var/log/app')
    expect(cards.find((c) => c.id === mine.id)?.content).toBe('x')
    // 用户删了迁移卡：备注没再改就不会冒出来
    s.delete(legacyCardId('h1'))
    expect(s.syncLegacy([{ hostKey: 'h1', notes: '服务用 systemctl 管\n日志在 /var/log/app' }])).toBe(false)
    expect(s.list().some((c) => c.id === legacyCardId('h1'))).toBe(false)
  })
})
