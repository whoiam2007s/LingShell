// 告警「用 AI 排查」（终端关键字告警 / 主机体检问题项 / 仪表盘异常卡片共用）：脱敏后开新会话发出
import { redactSecrets, troubleshootPrompt, troubleshootTitle, type TroubleshootReq } from '@lingshell/shared'
import { client } from '../client/index.js'
import { quoteToChat } from './quoteToChat.js'
import { sendToNewChat } from './sendToChat.js'

export function askAiTroubleshoot(req: TroubleshootReq): void {
  sendToNewChat(redactSecrets(troubleshootPrompt(req)), troubleshootTitle(req))
}

/**
 * 面板「问 AI」的统一入口：按设置决定是否脱敏，然后塞进输入框（不自动发送、不占一轮）。
 * 以前每个抽屉各写一遍「读设置 → redactSecrets → quoteToChat」，新加面板容易漏掉脱敏。
 */
export async function askAi(text: string): Promise<void> {
  const s = await client.settings.get().catch(() => undefined)
  quoteToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
}
