/* eslint-disable @typescript-eslint/no-explicit-any */
// AI 提问卡（参考 Claude Code 的 AskUserQuestion）：AI 需要用户在几个明确方案里拍板时调 ask_user，
// 对话里出选项卡（单选 / 多选 + 「其他」），用户提交后作为工具结果回给 AI。
// 超时 / 跳过 / 停止本轮 / 关掉会话 → 按「用户未回答」返回（不抛错）；AI 不替用户决定、不执行命令，说明后结束本轮。
import { sanitizeAskOptions, askResultText, tr, type AskAnswer, type AskRequest } from '@lingshell/shared'

export interface AskToolDeps {
  requestAsk?(req: AskRequest, signal?: AbortSignal): Promise<AskAnswer | null>
  sessionIdOf?(agentId: string): string
}

const truthy = (v: unknown) => v === true || v === 'true'

export const ASK_GUIDANCE = '提问卡：需要用户在几个明确的方案中拍板时（例如「重启服务还是 reload」「先备份再改还是直接改」「装 A 版本还是 B 版本」），'   // i18n-ignore 模型提示词 / 工具说明
  + '调用 ask_user 给出 2–6 个选项（label 简短，description 写清后果），等用户选完再继续；不要把这类选择写成一段文字让用户回复。'   // i18n-ignore 模型提示词 / 工具说明
  + '开放式问题（「你想做什么」「报错信息是什么」）、只是确认要不要执行命令（授权卡会问）都不要用它。'   // i18n-ignore 模型提示词 / 工具说明
  + '返回 answered=false 表示用户没回答（跳过 / 超时）：不要替用户做决定，也不要执行任何命令，用一两句话说明还需要用户决定什么后结束本轮。'   // i18n-ignore 模型提示词 / 工具说明

/** ask_user 工具定义：阻塞到用户回答 / 跳过 / 超时 */
export function askUserToolDef(deps: AskToolDeps) {
  return {
    name: 'ask_user',
    description: '向用户提一个选择题并等待回答：对话里显示成选项卡（单选或多选，可带「其他」输入框）。'   // i18n-ignore 模型提示词 / 工具说明
      + '只用于需要用户在几个明确方案中拍板的时候（如重启还是 reload）；开放式问题直接用文字问，命令授权不用它。'   // i18n-ignore 模型提示词 / 工具说明
      + '返回 JSON：answered=true 时 selected 是选中的选项 label 数组、other 是用户在「其他」里填的话；answered=false 表示用户没回答。',   // i18n-ignore 模型提示词 / 工具说明
    parameters: {
      question: { type: 'string' as const, required: true as const, description: '问题，一句话说清要用户决定什么' },   // i18n-ignore 模型提示词 / 工具说明
      options: {
        type: 'array' as const, required: true as const, description: '2–6 个选项',   // i18n-ignore 模型提示词 / 工具说明
        items: {
          type: 'object' as const, additionalProperties: true,
          properties: {
            label: { type: 'string' as const, required: true as const, description: '选项名（简短，如「reload（不中断连接）」）' },   // i18n-ignore 模型提示词 / 工具说明
            description: { type: 'string' as const, description: '这个选项会怎样、有什么影响' },   // i18n-ignore 模型提示词 / 工具说明
          },
        },
      },
      multi_select: { type: 'boolean' as const, description: '是否允许多选（缺省单选）' },   // i18n-ignore 模型提示词 / 工具说明
      allow_other: { type: 'boolean' as const, description: '是否给「其他」输入框让用户自己写（缺省允许）' },   // i18n-ignore 模型提示词 / 工具说明
    },
    output: { schema: { type: 'string' as const }, render: (_a: unknown, v: string) => [{ type: 'text' as const, text: v }] },
    async execute(args: any, exec: any) {
      if (!deps.requestAsk) throw new Error(tr('提问卡不可用'))
      const question = String(args?.question ?? '').trim().slice(0, 500)
      if (!question) throw new Error(tr('question 不能为空'))
      const options = sanitizeAskOptions(args?.options)
      if (options.length < 2) throw new Error(tr('options 至少要 2 个不同的选项（开放式问题请直接用文字问）'))
      const sessionId = deps.sessionIdOf?.(String(exec?.agent?.id ?? '')) ?? String(exec?.agent?.id ?? '')
      const req: AskRequest = { sessionId, question, options, multiSelect: truthy(args?.multi_select), allowOther: args?.allow_other === undefined ? true : truthy(args.allow_other) }
      const signal: AbortSignal | undefined = exec?.signal
      // 本轮被停止 / 会话关掉：不再等，按未回答返回（主进程那边同一个 signal 收卡）
      const answer = signal?.aborted ? null : await new Promise<AskAnswer | null>((resolve) => {
        const onAbort = () => resolve(null)
        signal?.addEventListener('abort', onAbort, { once: true })
        deps.requestAsk!(req, signal).then(resolve, () => resolve(null)).finally(() => signal?.removeEventListener('abort', onAbort))
      })
      return askResultText(answer)
    },
  }
}
