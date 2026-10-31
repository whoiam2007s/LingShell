/* eslint-disable @typescript-eslint/no-explicit-any */
// 从 dsh 会话事件日志抽两样东西（纯函数）：
//  - searchDocs：跨会话检索用的文本（用户提问 / AI 回复 / 执行过的命令），带对话里对应条目的 itemId（点击结果跳过去）；
//  - sessionDigest：@ 引用历史会话时附给 AI 的摘要（优先压缩摘要，否则最近几轮「用户问题 + AI 最终回复」，≤2000 字）。
import type { ChatSearchDoc } from '@lingshell/shared'
import { userMessageView, type DshEvent } from './relay.js'

const textOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
  : ''
const argsOf = (raw: unknown): any => { if (typeof raw !== 'string') return raw; try { return JSON.parse(raw) } catch { return undefined } }

/** 检索文本：itemId 与 relay 给界面的一致（用户消息 = 消息 id，AI 文本块 = blk_轮_步_下标，工具 = callId） */
export function searchDocs(sessionId: string, events: DshEvent[]): ChatSearchDoc[] {
  const out: ChatSearchDoc[] = []
  let turn: unknown = 0, step: unknown = 0
  for (const ev of events) {
    const d = ev.data ?? {}
    const at = ev.time > 0 ? ev.time : undefined
    if (ev.type === 'turn/start') turn = d.turn
    else if (ev.type === 'step/start') step = d.step
    else if (ev.type === 'user/message' && d.source?.kind === 'user') {
      const text = userMessageView(d.content).text
      if (text.trim()) out.push({ sessionId, kind: 'user', text, itemId: String(d.id ?? `user_${ev.seq}`), at })
    } else if (ev.type === 'assistant/message') {
      const blocks: any[] = Array.isArray(d.message?.content) ? d.message.content : []
      blocks.forEach((b, i) => {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ sessionId, kind: 'ai', text: b.text, itemId: `blk_${d.turn ?? turn}_${d.step ?? step}_${i}`, at })
      })
    } else if (ev.type === 'tool/call') {
      const a = argsOf(d.arguments)
      const cmd = typeof a?.command === 'string' ? a.command : typeof a?.path === 'string' ? a.path : ''
      if (cmd.trim()) out.push({ sessionId, kind: 'cmd', text: cmd, itemId: String(d.callId), at })
    }
  }
  return out
}

// compaction/summary 的 summary 是 ContentBlock[]
const summaryOf = (ev: DshEvent): string => textOf(ev.data?.summary).trim()
const cut = (s: string, n: number) => { const t = s.replace(/\n{3,}/g, '\n\n').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

/** 历史会话摘要（≤ max 字） */
export function sessionDigest(events: DshEvent[], max = 2000): string {
  let summary = ''
  for (const ev of events) if (ev.type === 'compaction/summary') summary = summaryOf(ev) || summary
  if (summary) return cut(`（较早对话的压缩摘要）\n${summary}`, max)   // i18n-ignore 附给模型的会话摘要
  // 每轮：用户问题 + 本轮最后一段 AI 文字（= 最终回复）
  const turns: { q: string; a: string }[] = []
  for (const ev of events) {
    const d = ev.data ?? {}
    if (ev.type === 'user/message' && d.source?.kind === 'user') turns.push({ q: userMessageView(d.content).text, a: '' })
    else if (ev.type === 'assistant/message' && turns.length) {
      const t = textOf(d.message?.content).trim()
      if (t) turns[turns.length - 1].a = t
    }
  }
  const parts: string[] = []
  let len = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const p = `用户：${cut(turns[i].q || '（只发了附件）', 300)}\nAI：${cut(turns[i].a || '（没有回复）', 600)}`   // i18n-ignore 附给模型的会话摘要
    if (len + p.length > max && parts.length) break
    parts.unshift(p); len += p.length + 2
  }
  return cut(parts.join('\n\n'), max)
}
