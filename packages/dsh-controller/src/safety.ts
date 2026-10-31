/* eslint-disable @typescript-eslint/no-explicit-any */
// 安全与流程（引擎侧）：分层规则段 / 预演模式（拦截判定 + 提示词）/ AI 复核用的会话上下文摘要。
// 规则文本、复核调用本身在主进程（desktop/main/ai/safetyIpc.ts），这里只管注入与判定。
import { tk } from '@lingshell/shared'
import type { DshEvent } from './relay.js'

// ── 分层规则：按会话现求值（本会话用到过的主机 + 会话工作目录），没有规则时段落消失 ──
// 规则是用户内容，可能含 `{{`，关掉变量插值原样输出。order 898：紧挨知识库段之前
export const RULES_SECTION = 'lingshell:rules'
export function installRulesSection(ctx: any, textFor: (agentId: string) => string): () => void {
  return ctx.systemPrompt.section({ name: RULES_SECTION, order: 898, interpolate: false, text: (c: any) => textFor(String(c?.agent?.id ?? '')) })
}

// ── 预演模式（只说不做）──
// 拒绝原因同时显示在工具卡上：显示处（DshController）再 tr()
export const PREVIEW_DENY = tk('preview_mode: 预演模式：请把要执行的命令列成计划，不要执行。用 propose_plan 列出完整步骤（每步写清命令、目的和影响），用户在「方案步骤」卡片里勾选后才会真正执行。只读排查可以照常进行。')

export const PREVIEW_GUIDANCE = '## 预演模式（只说不做，本会话已开启）\n'   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
  + '- 你不能执行任何写操作：exec_in_terminal / exec_on_terminals / start_background 只允许只读命令（查看类），write_file、upload_file 和外部工具一律会被拦截。只读排查照常进行。\n'   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
  + '- 需要改动时：先只读排查清楚，再用 propose_plan 一次列出完整方案（每步 terminal_id + 将要执行的完整命令 + purpose 写清目的和影响），它不会弹审批，而是作为「方案步骤」卡片展示给用户；不要真的执行。\n'   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
  + '- 回复里同时用文字给出：整体方案、每条命令的作用与影响（会不会中断服务、影响哪些文件 / 数据）、风险与回滚办法。用户勾选步骤并点「执行选中步骤」后会关闭预演、让你按批准的计划执行。'   // i18n-ignore 模型提示词 / 给 AI 复核的上下文

// 写类工具：exec 类非只读命令、写文件、上传。下载（读主机文件到本机）、只读工具照常
const EXEC_TOOLS = new Set(['exec_in_terminal', 'exec_on_terminals', 'start_background'])
const WRITE_TOOLS = new Set(['write_file', 'upload_file'])

/** 预演模式下这次调用要不要拦。isReadOnly 缺省 = 认不出只读，exec 一律拦 */
export function previewBlocks(toolName: string, args: unknown, isReadOnly?: (cmd: string) => boolean): boolean {
  if (WRITE_TOOLS.has(toolName)) return true
  if (!EXEC_TOOLS.has(toolName)) return false
  const cmd = (args as { command?: unknown } | null)?.command
  return typeof cmd !== 'string' || !isReadOnly?.(cmd)
}

/** MCP 工具：预演里只放行用户标了「免确认」的（视为只读查询），其余拦 */
export const previewBlocksMcp = (autoApproved: boolean) => !autoApproved

// ── AI 复核：会话最近上下文摘要（用户说了什么、AI 说了什么、刚执行过什么），从后往前取，总长 max ──
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
}
function argsOf(raw: unknown): any {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return undefined }
}
export function recentContext(events: DshEvent[], max = 1500): string {
  const lines: string[] = []
  let len = 0
  for (let i = events.length - 1; i >= 0 && len < max; i--) {
    const ev = events[i]
    const d = ev.data ?? {}
    let line = ''
    if (ev.type === 'user/message' && d.source?.kind === 'user') line = `用户：${textOf(d.content)}`   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
    else if (ev.type === 'assistant/message') line = textOf(d.message?.content).trim() ? `AI：${textOf(d.message?.content)}` : ''   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
    else if (ev.type === 'tool/call') {
      const a = argsOf(d.arguments)
      if (typeof a?.command === 'string') line = `AI 执行（${String(d.name ?? '')}）：${a.command}`   // i18n-ignore 模型提示词 / 给 AI 复核的上下文
    }
    line = line.replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (line.length > 400) line = `${line.slice(0, 400)}…`
    if (lines.length && len + line.length > max) break   // 放不下的更早内容整条不要
    lines.push(line)
    len += line.length + 1
  }
  return lines.reverse().join('\n').slice(0, max)
}
