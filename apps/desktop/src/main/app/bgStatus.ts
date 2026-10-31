// 托盘 / 悬浮球的状态聚合：旁听发给界面的同一路事件（同手机访问，复用 MobileHub 记会话运行 / 待授权），
// 再加上看门狗、传输队列、主机状态采样，拼成 BgSnapshot（见 trayModel.ts）。只在内存。
import { tr, type AppEvent, type TransferProgressEvent } from '@lingshell/shared'
import { MobileHub, type PendingApproval } from '../mobile/index.js'
import type { BgApproval, BgSnapshot } from './trayModel.js'

export const ERROR_TTL_MS = 10 * 60_000     // 「最近出错」红球保留多久（看到主窗口就清）
export const STATS_TTL_MS = 60_000          // 主机状态多久没更新就不显示

export interface BgStatusDeps {
  sessions(): { id: string; title: string }[]          // 用户可见的会话（不含无人值守巡检）
  hostLabelOf(hostKey: string): string | undefined      // 授权卡的 terminalId 实为 hostKey（local / 主机 id / mcp:服务）
  terminalTitle(terminalId: string): string | undefined // 终端还在才有
  locked(): boolean
  lockEnabled(): boolean
  watchdog(): { paused: boolean; firing: number }
  transfers(): Pick<TransferProgressEvent, 'state' | 'overallPercent'>[]
  hosts(): { id: string; label: string }[]
  ball(): { visible: boolean; opacity: number }
  now?(): number
}

/** 授权卡的一行摘要：命令 / MCP 工具 / 读终端 / 计划标题 */
export function approvalCommand(a: PendingApproval): string {
  const au = a.auth
  if (a.plan) return tr('计划：{title}（{n} 步）', { title: a.plan.title, n: a.plan.steps.length })
  if (!au) return ''
  if (au.command) return au.command
  if (au.mcp) return `${au.mcp.server} · ${au.mcp.tool}`
  return au.tool === 'read_terminal' ? tr('读取终端') : au.tool === 'write_file' ? tr('修改文件') : au.tool
}

export class BgStatus {
  private hub: MobileHub
  private stats = new Map<string, { at: number; cpuPct?: number; memPct?: number }>()
  private lastError?: { sessionId: string; at: number }
  constructor(private d: BgStatusDeps) { this.hub = new MobileHub(() => this.now()) }
  private now() { return this.d.now?.() ?? Date.now() }

  onEvent = (ev: AppEvent): void => {
    this.hub.onEvent(ev)
    if (ev.type === 'agent:turnFailed' && !ev.stopped) this.lastError = { sessionId: ev.sessionId, at: this.now() }
    else if (ev.type === 'agent:turnStarted' && this.lastError?.sessionId === ev.sessionId) this.lastError = undefined
    else if (ev.type === 'terminal:hostStats' && ev.stats) {
      const s = ev.stats
      this.stats.set(ev.terminalId, { at: this.now(), cpuPct: s.cpuPct, ...(s.memUsed !== undefined && s.memTotal ? { memPct: Math.round((s.memUsed / s.memTotal) * 1000) / 10 } : {}) })
    }
  }
  /** 用户看到主窗口了：「最近出错」不再标红 */
  clearError(): void { this.lastError = undefined }

  snapshot(): BgSnapshot {
    const now = this.now()
    const metas = this.d.sessions()
    const titleOf = (id: string) => metas.find((m) => m.id === id)?.title ?? tr('会话')
    const sessions = metas.map((m) => ({ id: m.id, title: m.title, status: this.hub.status(m.id) }))
      .filter((x): x is { id: string; title: string; status: 'running' | 'waiting' } => x.status !== 'done')
    const approvals: BgApproval[] = this.hub.pending().map((a) => {
      const targets = a.auth?.targets
      const host = targets?.length ? tr('{n} 台主机', { n: targets.length }) : a.auth ? this.d.hostLabelOf(a.auth.terminalId) : undefined
      return { approvalId: a.approvalId, sessionId: a.sessionId, sessionTitle: titleOf(a.sessionId), command: approvalCommand(a), ...(host ? { host } : {}) }
    })
    // 主机状态：最近一次采样（只采可见终端，基本就是当前活动终端）
    let stats: BgSnapshot['stats']
    let best = 0
    for (const [tid, s] of this.stats) {
      const title = this.d.terminalTitle(tid)
      if (!title || now - s.at > STATS_TTL_MS) { if (!title) this.stats.delete(tid); continue }
      if (s.at > best) { best = s.at; stats = { title, ...(s.cpuPct !== undefined ? { cpuPct: s.cpuPct } : {}), ...(s.memPct !== undefined ? { memPct: s.memPct } : {}) } }
    }
    const act = this.d.transfers().filter((t) => t.state === 'running' || t.state === 'queued')
    const run = act.filter((t) => t.state === 'running' && t.overallPercent >= 0)
    const err = this.lastError && now - this.lastError.at < ERROR_TTL_MS ? titleOf(this.lastError.sessionId) : undefined
    const ball = this.d.ball()
    return {
      locked: this.d.locked(), lockEnabled: this.d.lockEnabled(),
      sessions, approvals, watchdog: this.d.watchdog(),
      transfers: { active: act.length, ...(run.length ? { percent: Math.round(run.reduce((n, t) => n + t.overallPercent, 0) / run.length) } : {}) },
      ...(stats ? { stats } : {}), ...(err ? { error: err } : {}),
      hosts: this.d.hosts(), ball: ball.visible, ballOpacity: ball.opacity,
    }
  }
}
