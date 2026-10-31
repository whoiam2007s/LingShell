import { describe, it, expect } from 'vitest'
import type { HostSummary, SessionMeta, TerminalInfo } from '@lingshell/shared'
import { atItems } from './AtMenu.js'

const terms = [
  { id: 't1', title: '本地 1', type: 'local', status: 'running' },
  { id: 't2', title: 'web1', type: 'ssh', status: 'disconnected' },
] as TerminalInfo[]
const hosts = [
  { id: 'h2', label: 'db1', host: '10.0.0.2', username: 'root', group: 'db' },
  { id: 'h1', label: 'web1', host: '10.0.0.1', username: 'ops', group: 'web' },
  { id: 'h3', label: 'jump', host: '10.0.0.9', username: 'ops' },
] as HostSummary[]
const sessions = [
  { id: 's1', title: '排查 nginx', createdAt: '2026-10-01T00:00:00Z', lastActiveAt: '2026-10-01T00:00:00Z' },
  { id: 's2', title: '磁盘清理', createdAt: '2026-10-02T00:00:00Z', lastActiveAt: '2026-10-05T00:00:00Z' },
  { id: 'cur', title: '当前', createdAt: '2026-10-03T00:00:00Z', lastActiveAt: '2026-10-09T00:00:00Z' },
] as SessionMeta[]

describe('atItems（@ 候选）', () => {
  it('空查询：终端 → 主机（按分组）→ 历史会话（新的在前，不含当前）→ 文件', () => {
    const r = atItems('', terms, hosts, sessions, 'cur', Date.parse('2026-10-10T00:00:00Z'))
    expect(r.map((x) => x.key)).toEqual(['t:t1', 't:t2', 'h:h3', 'h:h2', 'h:h1', 's:s2', 's:s1', 'file'])
    expect(r.find((x) => x.key === 't:t2')?.sub).toBe('SSH · 已断开')
    expect(r.find((x) => x.key === 'h:h2')?.sub).toBe('db · root@10.0.0.2')
  })
  it('按名称 / 地址 / 分组过滤，不区分大小写', () => {
    expect(atItems('WEB', terms, hosts, sessions, 'cur').map((x) => x.key)).toEqual(['t:t2', 'h:h1'])
    expect(atItems('nginx', terms, hosts, sessions, 'cur').map((x) => x.key)).toEqual(['s:s1'])
    expect(atItems('10.0.0.9', terms, hosts, sessions, 'cur').map((x) => x.key)).toEqual(['h:h3'])
    expect(atItems('文件', terms, hosts, sessions, 'cur').map((x) => x.key)).toEqual(['file'])
  })
})
