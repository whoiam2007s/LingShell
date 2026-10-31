// 当前终端（显示中且是焦点窗格的那个）的登记处：TerminalPane 登记 / 注销，
// 对话里代码块的「插入终端 / 执行」按它找目标并把键盘焦点交给它。两边在组件树里隔得远，用模块级状态直连。
import { useSyncExternalStore } from 'react'

export interface ActiveTerminal { id: string; focus(): void }

let cur: ActiveTerminal | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** 登记为当前终端，返回注销函数（只注销自己，别人已登记就不动） */
export function claimActiveTerminal(t: ActiveTerminal): () => void {
  cur = t; emit()
  return () => { if (cur === t) { cur = null; emit() } }
}

export const getActiveTerminal = (): ActiveTerminal | null => cur

export const useActiveTerminal = (): ActiveTerminal | null =>
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => cur)
