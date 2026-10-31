import { describe, it, expect } from 'vitest'
import { filterHosts, groupHosts, hostGroupNames } from './hostGroups.js'
import type { HostSummary } from '../protocol/index.js'

const h = (id: string, extra: Partial<HostSummary> = {}): HostSummary =>
  ({ id, label: id, host: `${id}.example.com`, port: 22, username: 'root', authType: 'password', ...extra })

describe('hostGroups', () => {
  const hosts = [
    h('web1', { group: '生产' }), h('misc'), h('db1', { group: '数据库', notes: 'MySQL 主库' }), h('web2', { group: '生产', username: 'deploy' }),
  ]
  it('groupHosts：有名分组排序在前，未分组最后，组内保序', () => {
    const g = groupHosts(hosts)
    expect(g.map((x) => x.group)).toEqual(['生产', '数据库', ''].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN'))))
    expect(g[g.length - 1]).toEqual({ group: '', hosts: [hosts[1]] })
    expect(g.find((x) => x.group === '生产')!.hosts.map((x) => x.id)).toEqual(['web1', 'web2'])
  })
  it('filterHosts：按标签/地址/用户/分组/备注匹配，多词全部命中，不分大小写', () => {
    expect(filterHosts(hosts, '').length).toBe(4)
    expect(filterHosts(hosts, 'mysql').map((x) => x.id)).toEqual(['db1'])
    expect(filterHosts(hosts, '生产 deploy').map((x) => x.id)).toEqual(['web2'])
    expect(filterHosts(hosts, 'DB1.EXAMPLE').map((x) => x.id)).toEqual(['db1'])
    expect(filterHosts(hosts, 'nope')).toEqual([])
  })
  it('hostGroupNames 去重去空', () => {
    expect(hostGroupNames(hosts).sort()).toEqual(['数据库', '生产'].sort())
  })
})
