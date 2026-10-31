import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostSummary, KnowledgeCard } from '@lingshell/shared'
import { buildProposal, knowledgeHosts, registerKnowledge } from './knowledgeIpc.js'

const host = (id: string, label: string, group?: string, notes?: string) => ({ id, label, host: 'x', port: 22, username: 'u', authType: 'password', group, notes }) as HostSummary
const hosts = knowledgeHosts([host('h1', 'web-1', 'web'), host('h2', 'db-1')])
const existing: KnowledgeCard = { id: 'kb_1', scope: 'group', target: 'web', title: '旧标题', content: '旧内容', category: 'logs', updatedAt: '2026-01-01T00:00:00Z', source: 'manual' }

describe('buildProposal（AI 提议 → 卡片草稿）', () => {
  it('新建：主机 / 分组 / 全局，归属给人看的文字', () => {
    expect(buildProposal([], hosts, { scope: 'host', target: 'h1', title: 't', content: 'c', category: 'deploy' }))
      .toEqual({ draft: { scope: 'host', target: 'h1', title: 't', content: 'c', category: 'deploy', source: 'ai' }, targetLabel: '主机「web-1」' })
    expect(buildProposal([], hosts, { scope: 'host', target: 'local', title: 't', content: 'c' }).targetLabel).toBe('主机「本机」')
    expect(buildProposal([], hosts, { scope: 'group', target: 'web', title: 't', content: 'c', category: 'bad' }).draft.category).toBe('other')
    expect(buildProposal([], hosts, { scope: 'global', target: '', title: 't', content: 'c' }).targetLabel).toBe('全局')
  })
  it('更新：只给 card_id 时沿用原卡归属与分类，带上原内容对照', () => {
    const p = buildProposal([existing], hosts, { cardId: 'kb_1', title: '新标题', content: '新内容' })
    expect(p.draft).toEqual({ id: 'kb_1', scope: 'group', target: 'web', title: '新标题', content: '新内容', category: 'logs', source: 'ai' })
    expect(p.previous).toEqual({ title: '旧标题', content: '旧内容' })
  })
  it('校验：卡片 / 主机 / 分组不存在、临时主机，报给模型', () => {
    expect(() => buildProposal([], hosts, { cardId: 'nope', title: 't', content: 'c' })).toThrow(/知识卡不存在/)
    expect(() => buildProposal([], hosts, { scope: 'host', target: '1.2.3.4:22', title: 't', content: 'c' })).toThrow(/临时主机/)
    expect(() => buildProposal([], hosts, { scope: 'host', target: 'h9', title: 't', content: 'c' })).toThrow(/主机不存在/)
    expect(() => buildProposal([], hosts, { scope: 'group', target: 'db', title: 't', content: 'c' })).toThrow(/分组不存在：db（现有分组：web）/)
  })
})

describe('registerKnowledge', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  it('读之前同步旧主机备注；注入只给会话用到的主机（+分组 + 全局）；标题按主机列', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kbi-'))
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const k = registerKnowledge({ handle: (ch, fn) => handlers.set(ch, fn), dir, hosts: () => [host('h1', 'web-1', 'web', '日志在 /var/log/app'), host('h2', 'db-1')], localNotes: () => '' })
    await handlers.get('knowledge:save')!(null, { scope: 'group', target: 'web', title: '组卡', content: 'g', category: 'ops', source: 'manual' })
    await handlers.get('knowledge:save')!(null, { scope: 'host', target: 'h2', title: 'db 卡', content: 'd', category: 'ops', source: 'manual' })
    const list = await handlers.get('knowledge:list')!(null) as KnowledgeCard[]
    expect(list.map((c) => c.title).sort()).toEqual(['db 卡', '主机备注', '组卡'])
    const t = k.context(['h1'])
    expect(t).toContain('日志在 /var/log/app')
    expect(t).toContain('组卡')
    expect(t).not.toContain('db 卡')
    expect(k.context([])).toBe('')
    expect(k.titles('h1')).toEqual(['主机备注'])
  })
})
