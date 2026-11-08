// 告警「用 AI 排查」（终端关键字告警 / 主机体检问题项 / 仪表盘异常卡片共用）。
//
// 0.1.7 起统一成「进输入框」：和容器 / 命令历史 / 监听端口那几个「问 AI」一样，
// 模板只是初稿，用户可以在输入框里改完再自己按发送 —— 不再直接开新会话把它发出去。
// 想「一事一会话」自己新开一个就行，不需要入口替他决定。
import { redactSecrets, troubleshootPrompt, type TroubleshootReq } from '@lingshell/shared'
import { client } from '../client/index.js'
import { quoteToChat } from './quoteToChat.js'

export async function askAi(text: string): Promise<void> {
  const s = await client.settings.get().catch(() => undefined)
  quoteToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
}

export function askAiTroubleshoot(req: TroubleshootReq): void {
  void askAi(troubleshootPrompt(req))
}
