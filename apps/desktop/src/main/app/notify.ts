import { Notification, type BrowserWindow } from 'electron'
import { tr, tk } from '@lingshell/shared'

// 锁定时通知只给通用文案：不泄露命令、主机、会话标题、巡检摘要。锁状态由 ipc.ts 注入（不直接引 appLock，免循环依赖）
export const LOCKED_TITLE = tk('灵壳')   // 显示处 tr()
export const LOCKED_BODY = tk('有新的待处理事项（应用已锁定）')
let isLocked: () => boolean = () => false
export function setNotifyLockState(fn: () => boolean): void { isLocked = fn }

// 窗口不在前台时提醒用户：任务栏闪烁 + 系统通知（点击回到窗口）。在前台时什么都不做，免得打扰。
// Windows 通知要 AppUserModelId 与安装包快捷方式一致（index.ts 里设为 electron-builder 的 appId）；
// 开发模式下 electron.exe 没有对应快捷方式，系统通知可能不弹，任务栏闪烁照常。
// 用户真的在看界面：有焦点、没最小化、没隐藏到托盘。Windows 上最小化后 isFocused() 仍可能是 true，
// 只看它会把「最小化时也要提醒」吞掉
export function userWatching(win: BrowserWindow): boolean {
  return !win.isDestroyed() && win.isFocused() && !win.isMinimized() && win.isVisible()
}

export function notifyIfUnfocused(win: BrowserWindow, title: string, body: string): void {
  if (userWatching(win) && !isLocked()) return   // 锁定界面也算「没人在看内容」：照常提醒（notify 内部会换成通用文案）
  notify(win, title, body)
}

// 同一内容短时间内只弹一次：一轮里多个授权 / 多条告警命中不会刷出一串相同通知
const recent = new Map<string, number>()
const RECENT_MS = 3000
/** 测试用：清掉短期去重记录 */
export const clearNotifyCache = () => recent.clear()
// 任务栏闪烁只挂一个 focus 监听：以前每条通知挂一个，通知一多就堆积（>10 还会触发 MaxListeners 警告）
const flashing = new WeakSet<BrowserWindow>()

// 不论前台与否都弹（巡检异常这类必须让人看到的）。onClick：回到窗口后再做的事（如打开对应会话）
export function notify(win: BrowserWindow, title: string, body: string, onClick?: () => void): void {
  if (win.isDestroyed()) return
  if (isLocked()) { title = tr(LOCKED_TITLE); body = tr(LOCKED_BODY); onClick = undefined }   // 点击只回窗口（显示锁屏）
  const key = `${title}\u0000${body}`
  const now = Date.now()
  if (now - (recent.get(key) ?? 0) < RECENT_MS) return
  recent.set(key, now)
  if (recent.size > 200) for (const [k, t] of recent) if (now - t > RECENT_MS) recent.delete(k)
  if (!win.isFocused()) {
    win.flashFrame(true)
    if (!flashing.has(win)) {
      flashing.add(win)
      win.once('focus', () => { flashing.delete(win); if (!win.isDestroyed()) win.flashFrame(false) })
    }
  }
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body: body.length > 120 ? body.slice(0, 120) + '…' : body })
  n.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
    if (!isLocked()) onClick?.()   // 发出后才上锁的也不跳转
  })
  n.show()
}
