// 传输队列 IPC：任务快照 / 重试 / 清除已结束 / 本地落点在文件夹中显示；关窗口时有进行中的传输先确认。
// （取消沿用 explorerIpc 里的 transfer:cancel。）渲染层参数一律当不可信。
import type { TransferService } from './transfer.js'
import { isQueueMove } from './transferQueue.js'
import { tr } from '@lingshell/shared'

export interface TransferIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  transfer: Pick<TransferService, 'list' | 'retry' | 'clearFinished' | 'reorder' | 'activeCount' | 'cancelAll'>
  showItemInFolder(path: string): void
  // 窗口 close 事件（可 preventDefault）；确认后要再次关闭窗口
  onWindowClose(h: (e: { preventDefault(): void }) => void): void
  closeWindow(): void
  confirmQuit(active: number): Promise<boolean>   // true = 仍要退出
}

const id = (v: unknown): string => { if (typeof v !== 'string' || !v) throw new Error(tr('非法的任务')); return v }

export function registerTransfer(d: TransferIpcDeps): void {
  d.handle('transfer:list', () => d.transfer.list())
  d.handle('transfer:retry', (_e, t) => d.transfer.retry(id(t)))
  d.handle('transfer:clearFinished', () => d.transfer.clearFinished())
  // 排队顺序：优先传输（移到队首）/ 上移 / 下移
  d.handle('transfer:reorder', (_e, t, to) => {
    if (!isQueueMove(to)) throw new Error(tr('非法的移动方向'))
    d.transfer.reorder(id(t), to)
  })
  // 只认队列里记下的本地落点，不接受渲染层传任意路径
  d.handle('transfer:revealLocal', (_e, t) => {
    const r = d.transfer.list().find((x) => x.taskId === id(t))?.reveal
    if (r && 'local' in r) d.showItemInFolder(r.local)
  })

  // 关窗口（含退出应用：app.quit 会先关窗口）时还有传输未结束 → 先问；仍要退出就全部中止再关
  let asking = false, confirmed = false
  d.onWindowClose((e) => {
    const n = d.transfer.activeCount()
    if (confirmed || n === 0) return
    e.preventDefault()
    if (asking) return
    asking = true
    void d.confirmQuit(n).then((ok) => {
      asking = false
      if (!ok) return
      confirmed = true
      d.transfer.cancelAll()
      d.closeWindow()
    })
  })
}
