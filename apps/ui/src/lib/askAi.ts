// 面板「问 AI」的统一入口。
//
// 0.1.7 起统一成 **上下文 chip**（和 git / @终端 同一套交互）：
//   面板 → 点 ✨ → 输入框上方多一个 chip（代表要问的对象），输入框里预填一句可改的问题，
//   用户自己补充问题再发送；发送出去后 chip 显示在用户气泡下方，悬停能看随消息发给 AI 的全文。
// 这样做而不是把整段事实糊进输入框：事实可以给得更全（id / 端口 / 时间都放进去），
// 又不占用户的输入区；同一个对象重复点只保留一个 chip（addContext 会覆盖同名同类的）。
import { redactSecrets, tr, troubleshootPrompt, type ContextKind, type TroubleshootReq } from '@lingshell/shared'
import { client } from '../client/index.js'
import { pushChatContext } from './chatBus.js'

const redactOn = async (): Promise<boolean> => (await client.settings.get().catch(() => undefined))?.system?.aiRedact !== false

/** 把一段文字当引用放进输入框（老的「整段文字」通道，保留给少数场景） */
export async function askAi(text: string): Promise<void> {
  const on = await redactOn()
  const { quoteToChat } = await import('./quoteToChat.js')
  quoteToChat(on ? redactSecrets(text) : text)
}

export interface ChipAsk {
  /** 引用类型：决定 chip 的图标和标签 */
  ctx: ContextKind
  /** chip 上显示的名字（短：容器名 / 端口 / 「10 条命令」），重名只留一个 */
  name: string
  /** 随消息发给 AI 的全文（事实 + id，尽量全）；悬停可见 */
  text: string
  /** 预填到输入框的问题（用户可改；输入框已有内容时不覆盖） */
  question?: string
}

/** 面板 → 上下文 chip。数据按设置脱敏后再挂上去 */
export async function askAiChip(a: ChipAsk): Promise<void> {
  const on = await redactOn()
  pushChatContext({
    chips: [{ ctx: a.ctx, name: a.name, text: on ? redactSecrets(a.text) : a.text }],
    ...(a.question ? { text: a.question } : {}),
  })
}

/** 告警「用 AI 排查」（终端关键字告警 / 主机体检 / 仪表盘）：挂成「告警」chip */
export function askAiTroubleshoot(req: TroubleshootReq): void {
  void askAiChip({
    ctx: 'alert',
    name: req.host || tr('告警'),
    text: troubleshootPrompt(req),
    question: tr('帮我排查这个告警：最可能的原因、怎么验证、修复命令'),
  })
}
