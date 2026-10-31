// AI 执行的命令 ↔ 对话工具卡片的双向关联（内存表，重启即清）。
// 关联方式不经主进程：对话事件里工具开始执行（itemStarted，带 callId 与 terminal_id）先到，
// 随后同一终端的 terminal:locked=true 就是这次执行开始（execCapture 加锁在回显命令之前），TerminalPane 据此在当前行打紫色标记。
// 回滚、巡检等不经对话的执行没有待配对项，不打标记。
import { tr } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 往终端里发命令、输出留在终端里的工具。后台任务（start_background / check_background）走独立通道，终端里没有它们的输出，不打标记、卡片也不显示「在终端中定位」
export const LINGSHELL_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals'])
const PENDING_TTL = 15 * 60_000   // 授权卡可能等很久；太久没配上的丢掉

export interface AiExecPending { callId: string; sessionId: string; terminalId: string; command: string; at: number }

/** 待配对表：工具开始执行时登记（每个目标终端一条），终端加锁时按终端取最早的一条；工具结束时清掉没配上的 */
export class AiExecTracker {
  private list: AiExecPending[] = []
  add(p: Omit<AiExecPending, 'terminalId'>, terminalIds: string[]) {
    for (const terminalId of terminalIds) if (!this.list.some((x) => x.callId === p.callId && x.terminalId === terminalId)) this.list.push({ ...p, terminalId })
  }
  take(terminalId: string, now = Date.now()): AiExecPending | undefined {
    this.list = this.list.filter((x) => now - x.at < PENDING_TTL)
    const i = this.list.findIndex((x) => x.terminalId === terminalId)
    return i < 0 ? undefined : this.list.splice(i, 1)[0]
  }
  done(callId: string) { this.list = this.list.filter((x) => x.callId !== callId) }
  get size() { return this.list.length }
}

/** 从工具参数里取目标终端：exec_on_terminals 是 terminal_ids，其余 terminal_id */
export function targetsOf(name: string, input: unknown): string[] {
  const a = (input ?? {}) as { terminal_id?: unknown; terminal_ids?: unknown }
  if (name === 'exec_on_terminals') return Array.isArray(a.terminal_ids) ? a.terminal_ids.filter((x): x is string => typeof x === 'string') : []
  return typeof a.terminal_id === 'string' ? [a.terminal_id] : []
}

export const tracker = new AiExecTracker()
let watching = false
/** 首个终端挂载时开始监听对话事件（全局一份，不随会话切换） */
export function watchAiExec(): void {
  if (watching) return
  watching = true
  client.on((ev) => {
    if (ev.type === 'agent:itemStarted' && ev.kind === 'tool_call' && !ev.phase && ev.tool && LINGSHELL_TOOLS.has(ev.tool.name)) {
      const input = ev.tool.input as { command?: unknown; job_id?: unknown } | undefined
      tracker.add({ callId: ev.itemId, sessionId: ev.sessionId, command: typeof input?.command === 'string' ? input.command : `check_background ${String(input?.job_id ?? '')}`, at: Date.now() }, targetsOf(ev.tool.name, input))
    } else if (ev.type === 'agent:itemUpdated' && ev.kind === 'tool_call' && ev.status !== 'in_progress') tracker.done(ev.itemId)
  })
}

// ── 已打的标记：callId → 定位函数（TerminalPane 登记；marker 被回滚缓冲裁掉 / 终端关了时 goto 返回 false）──
export interface AiMark { callId: string; terminalId: string; sessionId: string; at: number; goto: () => boolean }
const marks = new Map<string, AiMark[]>()   // exec_on_terminals 一个 callId 对应多个终端
export function addAiMark(m: AiMark): () => void {
  marks.set(m.callId, [...(marks.get(m.callId) ?? []), m])
  return () => { const l = (marks.get(m.callId) ?? []).filter((x) => x !== m); if (l.length) marks.set(m.callId, l); else marks.delete(m.callId) }
}
/** 工具卡片「在终端中定位」：依次试该 callId 的标记（多主机时取第一个还在的）；都不在返回 false */
export function gotoAiMark(callId: string): boolean {
  for (const m of marks.get(callId) ?? []) if (m.goto()) return true
  return false
}
export const hasAiMark = (callId: string) => marks.has(callId)

// ── 终端标记 → 对话：滚到工具卡片并闪一下（ChatPanel 处理，必要时先切会话）──
const FOCUS_EVT = 'lingshell:focus-tool-card'
export interface ToolFocus { sessionId: string; callId: string }
export function focusToolCard(f: ToolFocus): void { window.dispatchEvent(new CustomEvent<ToolFocus>(FOCUS_EVT, { detail: f })) }
export function onFocusToolCard(h: (f: ToolFocus) => void): () => void {
  const f = (e: Event) => h((e as CustomEvent<ToolFocus>).detail)
  window.addEventListener(FOCUS_EVT, f)
  return () => window.removeEventListener(FOCUS_EVT, f)
}

// 会话标题（悬停提示用）：用到时取一次列表，缓存 30 秒
let titles: { at: number; map: Map<string, string> } | undefined
export async function sessionTitle(id: string): Promise<string> {
  if (!titles || Date.now() - titles.at > 30_000) {
    const l = await client.agent.listPersisted().catch(() => [])
    titles = { at: Date.now(), map: new Map(l.map((s) => [s.id, s.title])) }
  }
  return titles.map.get(id) || tr('会话')
}
