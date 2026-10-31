import type { ConvItem } from './useConversation.js'

const PROPOSAL_NAMES = new Set(['propose_quick_commands', 'propose_runbook'])
export const PROPOSAL_SUFFIX = ':proposal'
/** groupTurns 拆出来的提议预览卡（快速命令 / 运维手册） */
export const isProposalCard = (i: ConvItem) => i.kind === 'tool_call' && i.itemId.endsWith(PROPOSAL_SUFFIX)

// 一轮对话：用户消息 → 中间执行步骤 → 最终 AI 回复。
// steps 收工具调用/思考/todo/授权/中间 text；final 是本轮末尾那段连续 agent_message（留在容器外直接显示）。
// 相邻 agent_message 已在 useConversation 层各为独立 item，这里把连续的合并为一个渲染块。
export interface Turn {
  key: string                 // 稳定 key：首个 item 的 itemId（无 item 的裸轮用 userMsg id）
  userMsg?: ConvItem          // 本轮的用户消息（可能没有，如重放的首轮）
  steps: ConvItem[]           // 中间步骤（进【执行过程】容器）
  final: ConvItem[]           // 最终回复（末尾连续 agent_message，留容器外）
  notice?: ConvItem           // 系统提示：独占一轮，不挂在任何 AI 回合下
  turnId?: string             // 对应的 dsh 轮（取本轮首个带 turnId 的条目），用来查回合时间
}

// 把扁平 items 按 user_message 边界切成轮次。
// 分组规则：遇 user_message 开新轮；轮内末尾连续的 agent_message 归 final，其余归 steps。
export function groupTurns(items: ConvItem[]): Turn[] {
  const turns: Turn[] = []
  let cur: Turn | null = null
  for (const it of items) {
    if (it.kind === 'user_message') {
      cur = { key: it.itemId, userMsg: it, steps: [], final: [] }
      turns.push(cur)
      continue
    }
    if (it.kind === 'system_notice') { turns.push({ key: it.itemId, notice: it, steps: [], final: [] }); cur = null; continue }
    if (!cur) { cur = { key: it.itemId, steps: [], final: [] }; turns.push(cur) }
    cur.steps.push(it)
  }
  // 二次划分：把每轮末尾连续的 agent_message 从 steps 移到 final。
  // 中间隔了非 agent_message（工具/思考/todo…）就断开——只取真正结尾那段连续文本。
  for (const t of turns) {
    // 知识卡提议、提问卡（ask_user）要用户操作：不收进折叠的【执行过程】，放在最终回复前面。
    // 快速命令 / 运维手册提议：工具卡留在执行过程里，另出一张预览卡（itemId 加 PROPOSAL_SUFFIX）放到外面
    const isCard = (i: ConvItem) => i.kind === 'host_note' || i.kind === 'ask_request'
    const cards = [
      ...t.steps.filter(isCard),
      ...t.steps.filter((i) => i.kind === 'tool_call' && i.status === 'completed' && PROPOSAL_NAMES.has(i.tool?.name ?? '')).map((i) => ({ ...i, itemId: i.itemId + PROPOSAL_SUFFIX })),
    ]
    if (cards.length) t.steps = t.steps.filter((i) => !isCard(i))
    while (t.steps.length && t.steps[t.steps.length - 1].kind === 'agent_message') {
      t.final.unshift(t.steps.pop()!)
    }
    t.final.unshift(...cards)
    t.turnId = t.userMsg?.turnId ?? t.steps.find((i) => i.turnId)?.turnId ?? t.final.find((i) => i.turnId)?.turnId
  }
  return turns
}

// 尾部渲染窗口的起点下标：max(最新一轮, 最近 visible 条)——谁起点更靠前谁显示得更多。
// 长会话（历史重放可达几千条 item）全量渲染 markdown 会卡死，只渲染这个窗口。
export function windowStart(items: ConvItem[], visible: number): number {
  const byCount = Math.max(0, items.length - visible)
  // 从尾部倒找最新一轮起点（代价≈最新一轮长度，不再每次 map 全量）
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user_message') return Math.min(byCount, i)
  return byCount
}

