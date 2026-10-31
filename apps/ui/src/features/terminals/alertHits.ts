// 关键字告警命中汇总（参考 iTerm2 Captured Output）：TerminalPane 每命中一行记一条（不受通知的 30 秒节流），内存保留最近 500 条。
// 右侧活动栏「告警」按钮显示未读数，抽屉打开即全部标为已读。goto / context 由 TerminalPane 给（行被回滚缓冲裁掉后返回 false / null）
import { useSyncExternalStore } from 'react'

export interface AlertHitEntry {
  id: number
  at: number
  terminalId: string
  terminalTitle: string
  rule: string          // 规则的关键字 / 正则
  line: string
  goto: () => boolean                // 切到终端并滚到这一行
  context: (n: number) => string | null   // 这一行前后各 n 行
}

export const ALERT_HITS_MAX = 500

export interface AlertHitsState { list: readonly AlertHitEntry[]; unread: number }

/** 纯状态变换（便于测试）：追加（超上限丢最旧）/ 已读 / 清空 */
export function pushHit(s: AlertHitsState, e: AlertHitEntry, read: boolean, max = ALERT_HITS_MAX): AlertHitsState {
  const list = [...s.list, e]
  const over = Math.max(0, list.length - max)
  return { list: over ? list.slice(over) : list, unread: read ? 0 : Math.min(max, s.unread + 1) }
}

let state: AlertHitsState = { list: [], unread: 0 }
let seq = 0
let viewing = false   // 抽屉开着：新命中直接算已读
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function recordAlertHit(e: Omit<AlertHitEntry, 'id' | 'at'>, at = Date.now()): void {
  state = pushHit(state, { ...e, id: ++seq, at }, viewing)
  emit()
}
export function markAlertsRead(open: boolean): void {
  viewing = open
  if (open && state.unread) { state = { ...state, unread: 0 }; emit() }
}
export function clearAlertHits(): void { state = { list: [], unread: 0 }; emit() }
export const useAlertHits = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)

/** 在缓冲里找命中行：从光标所在行往上找最近一行含该文本的（命中是在写入前扫出来的，写完它就在光标上方几行内）。找不到返回 undefined */
export function findHitLine(getLine: (y: number) => string | undefined, cursorLine: number, text: string, maxBack = 5000): number | undefined {
  const needle = text.trim().slice(0, 60)
  if (!needle) return undefined
  for (let y = cursorLine; y >= Math.max(0, cursorLine - maxBack); y--) {
    // 软折行：把下一行拼上再比，免得关键字恰好跨行
    const s = (getLine(y) ?? '') + (getLine(y + 1) ?? '')
    if (s.includes(needle)) return y
  }
  return undefined
}
