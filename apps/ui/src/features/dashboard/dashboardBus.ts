// 主机仪表盘的打开通道（标题栏 / 命令面板 / 帮助都走这里），以及终端关键字告警的最近记录（仪表盘「最近告警」读它）
import { useSyncExternalStore } from 'react'

export const DASHBOARD_OPEN_EVENT = 'lingshell:dashboard-open'
export const DASHBOARD_CLOSE_EVENT = 'lingshell:dashboard-close'
export function openDashboard(): void {
  window.dispatchEvent(new Event(DASHBOARD_OPEN_EVENT))
}
/** 通知 / 托盘要切到某个会话时先收起仪表盘，否则新会话被全屏弹窗盖住 */
export function closeDashboard(): void {
  window.dispatchEvent(new Event(DASHBOARD_CLOSE_EVENT))
}

// 关键字告警只在渲染页里扫描（见 TerminalPane），这里记最近 100 条：终端 id + 时间 + 文本
export interface TermAlert { terminalId: string; at: number; text: string }
const MAX = 100
let alerts: readonly TermAlert[] = []
const subs = new Set<() => void>()
export function recordTermAlert(terminalId: string, text: string): void {
  alerts = [...alerts, { terminalId, at: Date.now(), text }].slice(-MAX)
  subs.forEach((f) => f())
}
export const useTermAlerts = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => alerts)
