// 告警「用 AI 排查」（终端关键字告警 / 主机体检问题项 / 仪表盘异常卡片共用）：脱敏后开新会话发出
import { redactSecrets, troubleshootPrompt, troubleshootTitle, type TroubleshootReq } from '@lingshell/shared'
import { sendToNewChat } from './sendToChat.js'

export function askAiTroubleshoot(req: TroubleshootReq): void {
  sendToNewChat(redactSecrets(troubleshootPrompt(req)), troubleshootTitle(req))
}
