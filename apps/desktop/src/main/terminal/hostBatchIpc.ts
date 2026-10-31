// 批量修改主机（设置 → SSH 连接管理 →「批量修改」）：预览 / 执行（先备份 hosts.json）/ 撤销上次
import type { HostStore } from '@lingshell/config'
import { tr, type HostBatchPatch } from '@lingshell/shared'

export interface HostBatchIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  hosts: Pick<HostStore, 'previewBatch' | 'applyBatch' | 'lastBatch' | 'undoBatch'>
}

const ids = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(tr('非法的主机列表'))
  return v as string[]
}
const patch = (v: unknown): HostBatchPatch => {
  if (!v || typeof v !== 'object') throw new Error(tr('非法的修改内容'))
  return v as HostBatchPatch
}

export function registerHostBatch(d: HostBatchIpcDeps): void {
  d.handle('hostBatch:preview', (_e, i, p) => d.hosts.previewBatch(ids(i), patch(p)))
  d.handle('hostBatch:apply', (_e, i, p) => d.hosts.applyBatch(ids(i), patch(p)))
  d.handle('hostBatch:last', () => d.hosts.lastBatch())
  d.handle('hostBatch:undo', () => d.hosts.undoBatch())
}
