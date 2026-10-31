import type { HostSummary } from '../protocol/index.js'

// 主机搜索：标签/地址/用户/分组/备注 任一包含关键词（不分大小写；空格分隔多词需全部命中）
export function filterHosts(hosts: HostSummary[], query: string): HostSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return hosts
  return hosts.filter((h) => {
    const text = [h.label, h.host, h.username, h.group ?? '', h.notes ?? ''].join('\n').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

// 按分组归类：有名分组按名称排序在前，未分组（group=''）最后；组内保持原顺序
export function groupHosts(hosts: HostSummary[]): { group: string; hosts: HostSummary[] }[] {
  const map = new Map<string, HostSummary[]>()
  for (const h of hosts) {
    const g = h.group?.trim() ?? ''
    map.set(g, [...(map.get(g) ?? []), h])
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')))
    .map(([group, hosts]) => ({ group, hosts }))
}

// 已有分组名（去重排序），表单 datalist 用
export function hostGroupNames(hosts: HostSummary[]): string[] {
  return [...new Set(hosts.map((h) => h.group?.trim() ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}
