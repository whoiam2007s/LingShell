import { tr, type AppEvent, type AuthRequestEvent, type PlanRequestEvent } from '@lingshell/shared'

// 手机端要看的数据：从主进程发给界面的同一路事件里旁听出来（不另读 dsh 日志）。
// 只在内存，只留每个会话最近的若干条；会话历史在本次启动后被打开过（界面重连会回放）或有新对话才看得到。

export const MAX_ITEMS = 60
const MAX_SESSIONS = 40
const MAX_TEXT = 4000

export type MobileItem =
  | { id: string; role: 'user' | 'ai'; text: string; at: number }
  | { id: string; role: 'tool'; text: string; status: 'running' | 'done' | 'failed'; at: number }

export type SessionStatus = 'running' | 'waiting' | 'done'

export interface PendingApproval {
  approvalId: string
  sessionId: string
  kind: 'auth' | 'plan'
  at: number
  deadline: number
  auth?: Omit<AuthRequestEvent, 'type' | 'approvalId' | 'sessionId' | 'deadlineMs'>
  plan?: Pick<PlanRequestEvent, 'title' | 'steps'>
}

interface Track { items: Map<string, MobileItem>; tools: Map<string, { name: string; input?: unknown }>; running: boolean; updatedAt: number }

/** 工具调用的一行摘要：「执行了 xxx · 退出码 N」。不带输出（输出可能很长、也可能含敏感内容） */
export function toolSummary(name: string, input: unknown, output?: string, status?: string): string {
  const a = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const what = name === 'exec_in_terminal' || name === 'start_background' ? tr('执行了 {cmd}', { cmd: s(a.command) })
    : name === 'exec_on_terminals' ? (Array.isArray(a.terminal_ids) ? tr('在 {n} 台主机执行了 {cmd}', { n: a.terminal_ids.length, cmd: s(a.command) }) : tr('在多台主机执行了 {cmd}', { cmd: s(a.command) }))
    : name === 'run_on_hosts' ? tr('跨主机执行了 {cmd}', { cmd: s(a.command) })
    : name === 'read_terminal' ? tr('读取了终端屏幕')
    : name === 'read_file' ? tr('读取了 {path}', { path: s(a.path) })
    : name === 'write_file' ? tr('修改了 {path}', { path: s(a.path) })
    : name === 'upload_file' ? tr('上传了 {path}', { path: s(a.local_path) })
    : name === 'download_file' ? tr('下载了 {path}', { path: s(a.path) })
    : tr('调用了 {name}', { name })
  let exit: number | undefined
  if (output) { try { const j = JSON.parse(output) as { exit_code?: unknown }; if (typeof j.exit_code === 'number') exit = j.exit_code } catch { /* 不是 JSON */ } }
  const tail = exit !== undefined ? ` · ${tr('退出码 {n}', { n: exit })}` : status === 'failed' ? ` · ${tr('失败')}` : status === 'in_progress' ? ` · ${tr('进行中')}` : ''
  return (what + tail).slice(0, 600)
}

export class MobileHub {
  private tracks = new Map<string, Track>()
  private approvals = new Map<string, PendingApproval>()
  constructor(private now: () => number = Date.now) {}

  private track(sid: string): Track {
    let t = this.tracks.get(sid)
    if (!t) {
      t = { items: new Map(), tools: new Map(), running: false, updatedAt: this.now() }
      this.tracks.set(sid, t)
      if (this.tracks.size > MAX_SESSIONS) {   // 丢最久没动静的
        const old = [...this.tracks].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
        if (old && old[0] !== sid) this.tracks.delete(old[0])
      }
    }
    return t
  }

  private put(t: Track, item: MobileItem): void {
    t.items.delete(item.id)
    t.items.set(item.id, item)   // 重新插入 = 移到末尾（同一条更新后保持在原顺序附近即可）
    while (t.items.size > MAX_ITEMS) t.items.delete(t.items.keys().next().value as string)
    t.updatedAt = this.now()
  }

  onEvent(ev: AppEvent): void {
    const now = this.now()
    switch (ev.type) {
      case 'auth:request': {
        const { type: _t, approvalId, sessionId, deadlineMs, ...auth } = ev
        this.approvals.set(approvalId, { approvalId, sessionId, kind: 'auth', at: now, deadline: now + deadlineMs, auth })
        this.track(sessionId).updatedAt = now
        return
      }
      case 'plan:request':
        this.approvals.set(ev.approvalId, { approvalId: ev.approvalId, sessionId: ev.sessionId, kind: 'plan', at: now, deadline: now + ev.deadlineMs, plan: { title: ev.title, steps: ev.steps } })
        this.track(ev.sessionId).updatedAt = now
        return
      case 'auth:resolved': this.approvals.delete(ev.approvalId); return
      case 'agent:turnStarted': { const t = this.track(ev.sessionId); t.running = true; t.updatedAt = now; return }
      case 'agent:turnCompleted': case 'agent:turnFailed': {
        const t = this.track(ev.sessionId); t.running = false; t.updatedAt = now
        for (const [id, a] of this.approvals) if (a.sessionId === ev.sessionId) this.approvals.delete(id)   // 回合结束，残留的卡也随之失效
        return
      }
      case 'agent:itemStarted': {
        if (ev.kind !== 'tool_call' || !ev.tool || ev.phase === 'preparing') return
        const t = this.track(ev.sessionId)
        t.tools.set(ev.itemId, { name: ev.tool.name, input: ev.tool.input })
        this.put(t, { id: ev.itemId, role: 'tool', text: toolSummary(ev.tool.name, ev.tool.input, undefined, 'in_progress'), status: 'running', at: ev.at ?? now })
        return
      }
      case 'agent:itemDelta': {
        if (ev.kind !== 'agent_message') return
        const t = this.track(ev.sessionId)
        const prev = t.items.get(ev.itemId)
        const text = ((prev && prev.role === 'ai' ? prev.text : '') + ev.text).slice(0, MAX_TEXT)
        if (prev) { (prev as { text: string }).text = text; t.updatedAt = now }
        else this.put(t, { id: ev.itemId, role: 'ai', text, at: ev.at ?? now })
        return
      }
      case 'agent:itemUpdated': {
        const t = this.track(ev.sessionId)
        if (ev.kind === 'user_message' || ev.kind === 'agent_message') {
          if (!ev.text) return
          const prev = t.items.get(ev.itemId)
          const item: MobileItem = { id: ev.itemId, role: ev.kind === 'user_message' ? 'user' : 'ai', text: ev.text.slice(0, MAX_TEXT), at: prev?.at ?? ev.at ?? now }
          if (prev) { t.items.set(ev.itemId, item); t.updatedAt = now } else this.put(t, item)
        } else if (ev.kind === 'tool_call') {
          const meta = t.tools.get(ev.itemId) ?? (ev.tool ? { name: ev.tool.name, input: ev.tool.input } : undefined)
          if (!meta) return
          const status = ev.status === 'failed' ? 'failed' : ev.status === 'completed' ? 'done' : 'running'
          const prev = t.items.get(ev.itemId)
          const item: MobileItem = { id: ev.itemId, role: 'tool', text: toolSummary(meta.name, meta.input ?? ev.tool?.input, ev.tool?.output, ev.status), status, at: prev?.at ?? ev.at ?? now }
          if (prev) { t.items.set(ev.itemId, item); t.updatedAt = now } else this.put(t, item)
          if (status !== 'running') t.tools.delete(ev.itemId)
        }
        return
      }
      default: return
    }
  }

  status(sessionId: string): SessionStatus {
    if ([...this.approvals.values()].some((a) => a.sessionId === sessionId)) return 'waiting'
    return this.tracks.get(sessionId)?.running ? 'running' : 'done'
  }
  updatedAt(sessionId: string): number | undefined { return this.tracks.get(sessionId)?.updatedAt }
  items(sessionId: string): MobileItem[] { return [...(this.tracks.get(sessionId)?.items.values() ?? [])] }
  pending(sessionId?: string): PendingApproval[] {
    const now = this.now()
    return [...this.approvals.values()].filter((a) => a.deadline > now && (!sessionId || a.sessionId === sessionId))
  }
  approval(id: string): PendingApproval | undefined { return this.approvals.get(id) }
}

// 手机上能直接「允许」的：单台主机的执行命令 / 读终端，且不是生产主机上的危险命令。
// 其余（改文件看不到 diff、多主机、MCP、计划）只给「拒绝」或「去电脑上处理」——安全取舍，见使用帮助
const MOBILE_ALLOW_TOOLS = new Set(['exec_in_terminal', 'read_terminal'])
export function mobileAllowBlock(a: PendingApproval, isProd: boolean): string | undefined {
  if (a.kind !== 'auth' || !a.auth) return tr('计划审批请在电脑上处理')
  if (!MOBILE_ALLOW_TOOLS.has(a.auth.tool)) return tr('这类操作（改文件 / 多主机 / MCP 等）请在电脑上查看详情后处理')
  if (isProd && a.auth.risk === 'dangerous') return tr('生产主机上的危险命令只能在电脑上允许')
  return undefined
}
