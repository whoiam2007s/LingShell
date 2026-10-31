import { tr, type AgentEvent } from '@lingshell/shared'

// AI 回合完成 / 出错的系统通知（窗口不在前台时由调用方弹，点通知切到那个会话）。
// 只认实时的轮：回放历史也会发 turnFailed（显示出错的轮），但不会先发 turnStarted——没见过开始的结束一律不通知。
// 用户主动停止（stopped）不通知；巡检这类无人值守会话另有通知
export interface TurnNotifyDeps {
  enabled(): boolean
  unattended(sessionId: string): boolean
  title(sessionId: string): string
  notify(title: string, body: string, sessionId: string): void
}

/** 通知文案（纯函数）：完成 → 标题带会话名；出错 → 标题带错误摘要、正文是会话名；用户停止 → null */
export function turnNotice(ev: AgentEvent, sessionTitle: string): { title: string; body: string } | null {
  const name = sessionTitle || tr('会话')
  if (ev.type === 'agent:turnCompleted') return { title: tr('AI 已完成：{name}', { name }), body: tr('点击查看结果') }
  if (ev.type !== 'agent:turnFailed' || ev.stopped) return null
  const err = ev.error.replace(/\s+/g, ' ').trim() || tr('未知错误')
  return { title: tr('AI 出错：{err}', { err: err.length > 60 ? err.slice(0, 60) + '…' : err }), body: tr('会话「{name}」', { name }) }
}

export function createTurnNotifier(d: TurnNotifyDeps): (ev: AgentEvent) => void {
  const live = new Set<string>()
  return (ev) => {
    if (!('sessionId' in ev) || !('turnId' in ev)) return
    const key = `${ev.sessionId}\n${ev.turnId}`
    if (ev.type === 'agent:turnStarted') { live.add(key); return }
    if (ev.type !== 'agent:turnCompleted' && ev.type !== 'agent:turnFailed') return
    if (!live.delete(key) || d.unattended(ev.sessionId) || !d.enabled()) return
    const n = turnNotice(ev, d.title(ev.sessionId))
    if (n) d.notify(n.title, n.body, ev.sessionId)
  }
}
