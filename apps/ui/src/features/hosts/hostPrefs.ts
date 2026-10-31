import { useEffect, useState } from 'react'
import { pushRecentHost, tr, type AppLayout, type TerminalInfo, type TerminalLayoutItem } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 主机面板的偏好：收藏 / 最近连接 / 延迟探测开关 / 工作区，存 layout.json（浅合并，不碰终端区写的字段）。
// 模块级缓存 + 订阅：面板、命令面板、最近连接记录共用一份
export type HostPrefs = Pick<AppLayout, 'favoriteHosts' | 'recentHosts' | 'hostProbe' | 'workspaces'>
let cache: HostPrefs | null = null
let loading: Promise<HostPrefs> | null = null
const subs = new Set<(p: HostPrefs) => void>()

export function loadHostPrefs(): Promise<HostPrefs> {
  if (cache) return Promise.resolve(cache)
  loading ??= client.layout.get()
    .then((l) => ({ favoriteHosts: l.favoriteHosts, recentHosts: l.recentHosts, hostProbe: l.hostProbe, workspaces: l.workspaces }))
    .catch(() => ({}))
    .then((p) => (cache ??= p))
  return loading
}

/** 改偏好：f 拿当前值返回要改的字段；先更新缓存再落盘 */
export async function patchHostPrefs(f: (p: HostPrefs) => Partial<HostPrefs>): Promise<void> {
  await loadHostPrefs()
  const cur = cache ?? {}   // 等待期间别的 patch 可能已改过缓存：基于最新值算，免得连发几次时互相覆盖
  const patch = f(cur)
  cache = { ...cur, ...patch }
  for (const s of subs) s(cache)
  await client.layout.save(patch).catch(() => {})
}

export function useHostPrefs(): HostPrefs {
  const [p, setP] = useState<HostPrefs>(cache ?? {})
  useEffect(() => {
    subs.add(setP)
    void loadHostPrefs().then(setP)
    return () => { subs.delete(setP) }
  }, [])
  return p
}

export const recordRecentHost = (id: string) => patchHostPrefs((p) => ({ recentHosts: pushRecentHost(p.recentHosts, id) }))

/** 按工作区条目依次开终端（TerminalView 打开工作区用）。返回各条目对应的终端 id（失败为 ''，保持下标对齐）和失败说明 */
export async function openLayoutItems(items: TerminalLayoutItem[], onOpened: (info: TerminalInfo, item: TerminalLayoutItem) => void): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [], errors: string[] = []
  const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
  const hosts = items.some((i) => i.kind === 'ssh') ? await client.hosts.list().catch(() => []) : []
  const name = (i: TerminalLayoutItem) => i.title || (i.kind === 'local' ? tr('本地终端') : hosts.find((h) => h.id === i.hostId)?.label ?? tr('已删除的主机'))
  for (const item of items) {
    try {
      const info = item.kind === 'local' ? await client.terminal.createLocal({
        ...(item.shell ? { shell: item.shell } : {}), ...(item.cwd ? { cwd: item.cwd } : {}),
      })
        : item.hostId ? await client.terminal.createSsh({ hostId: item.hostId }) : undefined
      if (!info) { ids.push(''); continue }
      ids.push(info.id)
      onOpened(info, item)
    } catch (e) {
      ids.push('')
      errors.push(tr('{name}：{err}', { name: name(item), err: errText(e) }))
    }
  }
  return { ids, errors }
}
