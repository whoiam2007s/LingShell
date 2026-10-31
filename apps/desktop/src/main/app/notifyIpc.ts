// 渲染层发起的系统通知（终端长命令完成 / 关键字告警）。该不该发由终端判断（窗口不在前台或标签不可见）；
// 这里只校验参数、截断长度，交给 notify.ts（锁定时换通用文案、任务栏闪烁）。点击通知回到窗口。
import { tr } from '@lingshell/shared'
export interface NotifyIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  notify(title: string, body: string): void
}

export function registerNotify(d: NotifyIpcDeps): void {
  d.handle('system:notify', (_e, title, body) => {
    if (typeof title !== 'string' || typeof body !== 'string' || !title) throw new Error(tr('非法的通知内容'))
    d.notify(title.slice(0, 80), body.slice(0, 300))
  })
}
