// 传输任务的前端镜像 + 面板开关：主进程是权威（transfer:progress 事件 + 启动时 list 补齐），组件经 useTransfers 订阅
import { useSyncExternalStore } from 'react'
import type { TransferProgressEvent } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { isActive } from './transferView.js'

type Ev = TransferProgressEvent
let tasks = new Map<string, Ev>()
let snap: { tasks: Ev[]; open: boolean } = { tasks: [], open: false }
const subs = new Set<() => void>()

function publish(open = snap.open) {
  snap = { tasks: [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt), open }
  for (const f of subs) f()
}

// 挂一次（App 里的 TransferToast）：先订阅事件，再拉一次快照补上已有任务（事件里的更新，快照不覆盖）
export function startTransferSync(): () => void {
  const off = client.on((ev) => {
    if (ev.type !== 'transfer:progress') return
    tasks.set(ev.taskId, ev)
    publish()
  })
  client.transfer.list().then((list) => {
    for (const t of list) if (!tasks.has(t.taskId)) tasks.set(t.taskId, t)
    publish()
  }).catch(() => {})
  return off
}

export function useTransfers() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => snap)
}

export const openTransferPanel = (): void => publish(true)
export const closeTransferPanel = (): void => publish(false)

// 已暂停的留着（还能继续），与主进程一致
export function clearFinished(): void {
  tasks = new Map([...tasks].filter(([, t]) => isActive(t) || t.paused))
  publish()
  client.transfer.clearFinished().catch(() => {})
}
// 放弃：主进程删半截文件并移出列表（不再发事件），这边同步移掉
export function discardTask(id: string): void {
  tasks.delete(id)
  publish()
  client.transfer.discard(id).catch(() => {})
}
