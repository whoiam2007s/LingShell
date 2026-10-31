/* eslint-disable @typescript-eslint/no-explicit-any */
// 计划模式：AI 先用 propose_plan 把多步改动一次性摆给用户，批准后计划内的命令免逐条授权。
//
// 安全边界：只放行与已批准步骤**完全一致**（仅去首尾空白）的调用——exec_in_terminal 比 (主机, 命令)，
// write_file 比 (主机, 文件路径)（写入照样自动备份、工具卡可看 diff）；每步只能用一次；
// 计划外的照常走授权；只读信任档照样拒写；本轮结束计划作废。
import { dangerCheck } from '@lingshell/auth-registry'
import { tr, type ApprovalAnswer, type PlanStep, type PlanStepView } from '@lingshell/shared'
import { terminalIdOf, type Decision, type TerminalToolDeps } from './terminalTools.js'

export interface PlanRequest { sessionId: string; title: string; steps: PlanStepView[] }

const norm = (s: string) => s.trim()
// 步骤的匹配键：写文件步骤按路径，命令步骤按命令原文
const keyOf = (s: { command: string; path?: string }) => (s.path ? `write:${norm(s.path)}` : `exec:${norm(s.command)}`)

/** 每会话一份已批准、未用完的计划步骤 */
export class PlanBook {
  private plans = new Map<string, { hostKey: string; key: string; used: boolean }[]>()

  /** 批准新计划：替换该会话旧计划 */
  approve(sessionId: string, steps: { hostKey: string; command: string; path?: string }[]): void {
    this.plans.set(sessionId, steps.map((s) => ({ hostKey: s.hostKey, key: keyOf(s), used: false })))
  }

  /** 命中一条未用过的步骤就标记已用并返回 true（path 有值按写文件匹配） */
  consume(sessionId: string, hostKey: string, command: string, path?: string): boolean {
    const k = keyOf({ command, path })
    const step = this.plans.get(sessionId)?.find((s) => !s.used && s.hostKey === hostKey && s.key === k)
    if (!step) return false
    step.used = true
    return true
  }

  /** 剩余未用步骤数（给测试/日志看） */
  remaining(sessionId: string): number {
    return this.plans.get(sessionId)?.filter((s) => !s.used).length ?? 0
  }

  /** 轮结束 / 中断 / 关会话：计划作废 */
  clear(sessionId: string): void { this.plans.delete(sessionId) }
}

/**
 * 网关前置：exec_in_terminal / write_file 命中已批准计划步骤 → 直接放行（落 allow:plan）。
 * 不命中、或信任档本身就拒（只读）→ 返回 undefined，交回常规 decideFor。
 */
export function planDecision(
  deps: Pick<TerminalToolDeps, 'resolveHostKey' | 'decide' | 'audit'>,
  book: PlanBook, sessionId: string, toolName: string, args: unknown,
): Decision | undefined {
  if (toolName !== 'exec_in_terminal' && toolName !== 'write_file') return undefined
  const terminalId = terminalIdOf(args)
  const isWrite = toolName === 'write_file'
  const path = isWrite ? (args as any)?.path : undefined
  const command = isWrite ? (typeof path === 'string' ? tr('写入 {path}', { path: path.trim() }) : undefined) : (args as any)?.command
  if (!terminalId || typeof command !== 'string') return undefined
  const hostKey = deps.resolveHostKey(terminalId)
  if (deps.decide(sessionId, hostKey, 'write', isWrite ? undefined : command).kind === 'deny') return undefined
  if (!book.consume(sessionId, hostKey, command, path)) return undefined
  deps.audit({ sessionId, terminalId, command, decision: 'allow:plan' })
  return { kind: 'allow' }
}

/** 清洗模型给的步骤：丢掉缺 terminal_id / 既无命令又无路径的；写文件步骤没给 command 时补一个展示用的 */
export function sanitizeSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s: any) => {
    if (typeof s?.terminal_id !== 'string') return []
    const path = typeof s.path === 'string' && s.path.trim() ? s.path.trim() : undefined
    const command = typeof s.command === 'string' && s.command.trim() ? s.command.trim() : path ? tr('写入 {path}', { path }) : ''
    if (!command) return []
    return [{
      terminal_id: s.terminal_id, command,
      ...(path ? { path } : {}), ...(typeof s.purpose === 'string' ? { purpose: s.purpose } : {}),
    }]
  })
}

export const PLAN_GUIDANCE = '计划模式：要做多步改动（3 条及以上会写入/修改系统的命令，如安装、改配置、重启服务、部署）时，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '先调用 propose_plan 把全部步骤一次列给用户批准，再按批准结果逐条执行：命令步骤用 exec_in_terminal，'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '写文件步骤（step 带 path）用 write_file 写同一路径；'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '执行时命令必须与批准的步骤逐字一致（用户可能改过命令或删掉步骤，以返回结果为准），一步对应一次调用，不要合并或改写。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
  + '计划外的命令仍需逐条授权；计划只在本轮有效。只读排查（查看日志、状态、配置）不需要也不要用 propose_plan。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果

export interface PlanToolDeps {
  resolveHostKey(terminalId: string): string
  requestPlan?(req: PlanRequest): Promise<ApprovalAnswer>
  sessionIdOf?(agentId: string): string
  // 预演模式（只说不做）：不弹审批卡，步骤作为「方案步骤」回给界面（工具结果带 preview=true），不记入已批准计划
  isPreview?(sessionId: string): boolean
}

export const PREVIEW_PLAN_NOTE = '预演模式：方案已作为「方案步骤」卡片展示给用户，没有执行、也没有批准。请在回复里给出完整方案和每条命令的影响，不要执行；用户勾选并点「执行选中步骤」后会告诉你。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果

/** propose_plan 工具定义：阻塞到用户批准/拒绝，批准后把（可能改过的）步骤记入 PlanBook 并回给模型 */
export function planToolDef(deps: PlanToolDeps, book: PlanBook) {
  return {
    name: 'propose_plan',
    description: '提交一个多步执行计划给用户审批（用户可删步骤、改命令，然后批准或拒绝）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      + '批准后，exec_in_terminal 执行与批准步骤逐字一致的命令、write_file 写批准步骤里的同一路径时免逐条授权（每步一次，本轮有效）。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      + '要用 write_file 写文件的步骤必须填 path（文件绝对路径），command 写一句「写入 <路径>：内容要点」即可。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      + '用于 3 条及以上写操作的多步改动，执行前先调用；只读排查不要用。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
    parameters: {
      title: { type: 'string' as const, required: true as const, description: '计划标题，一句话说明要做什么' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      steps: {
        type: 'array' as const, required: true as const, description: '按执行顺序排列的步骤',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
        items: {
          type: 'object' as const, additionalProperties: true,
          properties: {
            terminal_id: { type: 'string' as const, required: true as const, description: '在哪个终端执行' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
            command: { type: 'string' as const, required: true as const, description: '将要执行的完整命令（执行时须逐字一致）；写文件步骤写「写入 <路径>：内容要点」' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
            path: { type: 'string' as const, description: '仅写文件步骤：write_file 要写的文件绝对路径（执行时须一致）' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
            purpose: { type: 'string' as const, required: true as const, description: '这一步的目的' },   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          },
        },
      },
    },
    output: { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] },
    async execute(args: any, exec: any) {
      if (!deps.requestPlan) throw new Error(tr('计划审批不可用'))
      const sessionId = deps.sessionIdOf?.(String(exec?.agent?.id ?? '')) ?? String(exec?.agent?.id ?? '')
      const steps = sanitizeSteps(args.steps)
      if (!steps.length) throw new Error(tr('steps 为空：每步需有 terminal_id 与 command'))
      const title = String(args.title ?? '').trim() || tr('执行计划')
      const view = steps.map((s) => ({ ...s, hostKey: deps.resolveHostKey(s.terminal_id), dangerous: dangerCheck(s.command) === 'dangerous' }))
      if (deps.isPreview?.(sessionId)) return JSON.stringify({ preview: true, approved: false, title, steps: view, note: PREVIEW_PLAN_NOTE })
      const ans = await untilAborted(deps.requestPlan({ sessionId, title, steps: view }), exec?.signal)
      const note = ans.note?.trim()
      if (ans.decision === 'deny') throw new Error(note ? tr('用户拒绝了计划。原因：{reason}', { reason: note }) : tr('用户拒绝了计划'))
      // 用户只能删步骤、改命令；终端不在原计划里的步骤不认
      const tids = new Set(steps.map((s) => s.terminal_id))
      const approved = ans.steps ? sanitizeSteps(ans.steps).filter((s) => tids.has(s.terminal_id)) : steps
      if (!approved.length) throw new Error(tr('用户删掉了计划的全部步骤，等同拒绝'))
      book.approve(sessionId, approved.map((s) => ({ hostKey: deps.resolveHostKey(s.terminal_id), command: s.command, path: s.path })))
      return JSON.stringify({
        approved: true, title, steps: approved,
        note: '计划已批准。请按顺序执行：无 path 的步骤用 exec_in_terminal，命令须与上面 steps 逐字一致；带 path 的步骤用 write_file 写该路径。'   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
          + '计划外操作仍需授权；本轮结束计划失效。',   // i18n-ignore 模型提示词 / 工具说明 / 给模型的结果
      })
    },
  }
}

// turn 被取消时别一直挂着
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
