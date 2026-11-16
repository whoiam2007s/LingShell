// 子代理（spawn_subagent）：主代理拆出来的单一任务，独立会话跑，只把结论回传给主代理。
//
// 三条硬约束（用户定的）：
// 1. **没有交互能力**：子代理不弹授权卡、不弹提问卡；遇到要用户拍板的事就停下，用 blocked 状态
//    把问题交回主代理，由主会话统一跟用户对话。
// 2. **不能递归**：工具集里没有 spawn_subagent。
// 3. **结论要能直接用**：summary 必须结构化（做了什么 / 关键发现 / 证据 / 结论 / 未尽），
//    主代理不该为了补信息再跑一遍。
//
// 本文件是纯逻辑（提示词、工具拦截、摘要解析），会话编排在 DshController.spawnSubagent。
import { tr } from '@lingshell/shared'

/** 一次最多几个子代理同时跑（再多上下文和费用都失控） */
export const SUBAGENT_MAX_CONCURRENT = 3
/** 默认超时：10 分钟（简单任务够用；超时算 failed，主代理自己决定要不要重派） */
export const SUBAGENT_DEFAULT_TIMEOUT_SEC = 600
export const SUBAGENT_MAX_TIMEOUT_SEC = 1800
/** task 长度上限：子任务描述不该写成一篇方案 */
export const SUBAGENT_TASK_MAX = 2000
/** summary 上限：原定 2000 太紧，装不下路径与报错原文 */
export const SUBAGENT_SUMMARY_MAX = 4000

export type SubagentPermission = 'read' | 'write'
export type SubagentStatus = 'done' | 'blocked' | 'failed'

export interface SubagentResult {
  subagentId: string
  status: SubagentStatus
  /** 结构化总结（done / blocked 都有；failed 时是错误说明） */
  summary: string
  /** blocked 时带回的问题与上下文，主代理据此决定换做法还是去问用户 */
  blocked?: { question: string; context: string }
  error?: string
  elapsedMs: number
  /** 子会话存档位置（排查用；主代理不该去翻） */
  logPath?: string
}

/** 子代理专用系统提示（追加在主提示后）：把「你只是被拆出来的一双手」说清楚 */
// i18n-ignore-next 整段是给子代理看的系统提示词
export const SUBAGENT_BRIEF = `你现在是一个子代理（subagent），由主代理拆分出来执行**单一、明确**的任务。

规则（必须遵守）：
1. 只做任务里描述的这一件事，不扩大范围、不顺手改别的东西。
2. 你没有提问能力，也没有授权卡。遇到必须由用户拍板的事（选哪个路径、要不要覆盖、信息不足、
   多个方案取舍），**立刻停下来**，按下面的 blocked 格式返回，不要猜。
3. 你不能派子代理。任务太大、需要多步判断或跨多个系统时，直接返回 blocked，说明建议怎么拆。
4. 不要把大段日志贴进结论：只摘关键行（报错原文、关键数字、版本号），其余给文件路径。

总结必须按下面五块写，缺一块就算不合格：
- 做了什么：一句话，执行了哪些操作
- 关键发现：具体事实，带路径 / 版本 / 数值 / 数量
- 证据：关键命令 + 输出里的关键行（只摘关键行）
- 结论：能不能继续、要不要修（直接可用的判断）
- 未尽 / 建议：主代理需要决定或补充的部分

需要用户拍板时，把整段总结换成这个格式（第一行必须是 BLOCKED）：

BLOCKED
问题：<一句话，主代理会转给用户或自己决策>
上下文：<已经查到的信息，主代理判断时要用>`

/** 拼给子代理的用户消息：任务 + 可选背景 */
export function composeSubagentTask(task: string, contextHint?: string): string {
  const t = task.trim()
  return contextHint?.trim() ? `${t}\n\n背景：${contextHint.trim()}` : t   // i18n-ignore 拼给子代理的用户消息
}

// ── 工具拦截 ────────────────────────────────────────────────────────
/** 子代理永远不能用的工具（交互 / 递归 / 删除） */
const ALWAYS_DENY = new Set(['ask_user', 'spawn_subagent'])
const DENY_PREFIXES = ['delete_', 'remove_']

/**
 * 子代理调用某工具时的拒绝原因（undefined = 放行）。
 * permission=read 的子代理连写工具都不给——spawn 时已一次性判定过，运行中不再弹卡。
 */
export function subagentToolDeny(toolName: string, permission: SubagentPermission): string | undefined {
  const name = String(toolName)
  if (ALWAYS_DENY.has(name)) {
    return name === 'spawn_subagent'
      ? tr('子代理不能再派子代理：把任务拆解交给主代理做')
      : tr('子代理不能跟用户交互：请用 blocked 状态把问题交回主代理')
  }
  if (DENY_PREFIXES.some((p) => name.startsWith(p))) return tr('子代理不能删除东西：需要删除时交回主代理')
  if (permission === 'read' && isWriteTool(name)) {
    return tr('这个子任务只授了只读权限，不能执行写操作；需要写就交回主代理')
  }
  return undefined
}

/** 写类工具（与 execGate 的判定保持一致的子集；只用于「只读子代理」的拦截） */
const WRITE_TOOLS = new Set([
  'write_file', 'upload_file', 'set_app_setting', 'save_skill', 'save_db_connection',
  'save_model_profile', 'save_mcp_server', 'exec_in_terminal', 'exec_on_terminals', 'start_background',
])
export const isWriteTool = (name: string): boolean => WRITE_TOOLS.has(name)

// ── 摘要解析 ────────────────────────────────────────────────────────
const BLOCKED_RE = /^\s*(?:#{1,6}\s*)?BLOCKED\b[：:]?\s*$/im
const QUESTION_RE = /(?:^|\n)\s*(?:问题|question)\s*[：:]\s*([\s\S]*?)(?=\n\s*(?:上下文|context)\s*[：:]|$)/i
const CONTEXT_RE = /(?:^|\n)\s*(?:上下文|context)\s*[：:]\s*([\s\S]*)$/i

/**
 * 把子代理最后一条消息解析成结果。
 * - 出现行首 BLOCKED → status=blocked，抽出「问题」「上下文」
 * - 否则 status=done
 * - 超过 4000 字截断（优先保留前半：五块的顺序是有意设计的，关键发现 / 结论在前）
 */
export function parseSubagentSummary(text: string): { status: SubagentStatus; summary: string; blocked?: { question: string; context: string } } {
  const raw = String(text ?? '').trim()
  if (!raw) return { status: 'done', summary: tr('（子代理没有给出总结）') }
  const blocked = BLOCKED_RE.test(raw)
  const cut = raw.length > SUBAGENT_SUMMARY_MAX
    ? `${raw.slice(0, SUBAGENT_SUMMARY_MAX)}\n\n${tr('…（总结超过 {n} 字已截断，完整内容见子会话记录）', { n: SUBAGENT_SUMMARY_MAX })}`
    : raw
  if (!blocked) return { status: 'done', summary: cut }
  return {
    status: 'blocked',
    summary: cut,
    blocked: {
      question: (raw.match(QUESTION_RE)?.[1] ?? '').trim() || tr('（子代理说要用户拍板，但没写清问题）'),
      context: (raw.match(CONTEXT_RE)?.[1] ?? '').trim() || tr('（没有附上下文）'),
    },
  }
}

/** task 校验（超长 / 空） */
export function checkSubagentTask(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return { ok: false, error: tr('task 不能为空：写清要子代理做的这一件事') }
  if (t.length > SUBAGENT_TASK_MAX) {
    return { ok: false, error: tr('task 太长了（{n} 字上限）：子任务要单一明确，大任务请自己拆成几次调用', { n: SUBAGENT_TASK_MAX }) }
  }
  return { ok: true, value: t }
}

/** 超时时长夹到合理区间（模型爱写 0 或 999999） */
export function clampTimeoutSec(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return SUBAGENT_DEFAULT_TIMEOUT_SEC
  return Math.min(Math.max(Math.round(n), 30), SUBAGENT_MAX_TIMEOUT_SEC)
}
