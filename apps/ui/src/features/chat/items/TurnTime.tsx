import { turnTimeView, elapsedMs, formatDuration, messageTime, fmtDateTime, toolTimeTitle, reasoningTimeTitle, tr, type TurnTimes } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { useNow } from '../../../lib/useNow.js'

// 对话区的时间小部件。时间都来自主进程（dsh 事件时间戳 / 侧车），拿不到就不渲染，不显示猜的时间。
// 进行中的计时各自每秒刷新，只重渲染自己，不带动整条时间线。

const muted = 'shrink-0 whitespace-nowrap tabular-nums text-[11px] text-[var(--color-text-muted)]'

/** 「执行过程 · N 步」后面的整轮耗时；本轮进行中实时走 */
export function TurnElapsed({ times, active }: { times?: TurnTimes; active: boolean }) {
  const now = useNow(1000, active && !times?.endedAt)
  const { duration } = turnTimeView(times, { live: active, now })
  if (!duration) return null
  return <span data-turn-duration className="opacity-70 tabular-nums" title={tr('整个执行过程耗时（从开始到结束）')}>· {duration}</span>
}

/** AI 回合头部：模型首次开始返回的时间点，hover 看距提问多久 */
export function FirstAnswer({ times, askedAt, className }: { times?: TurnTimes; askedAt?: number; className?: string }) {
  const { first } = turnTimeView(times, { live: false, now: 0, askedAt })
  if (!first) return null
  return <span data-first-answer className={`${muted} ${className ?? ''}`} title={first.title}>{first.text}</span>
}

/**
 * 工具卡片标题行末尾的耗时：从模型输出里识别到该工具起（含生成参数），到拿到结果止。
 * live = 所在回合仍在进行（只有这时未结束的工具才实时计时）
 */
export function ToolElapsed({ item, live }: { item: ConvItem; live: boolean }) {
  const running = live && item.status === 'in_progress' && !item.doneAt
  const now = useNow(1000, running)
  const ms = elapsedMs(item.at, item.doneAt, running ? now : undefined)
  if (ms === undefined) return null
  const title = toolTimeTitle({ at: item.at, callAt: item.callAt, doneAt: item.doneAt, preparing: item.phase === 'preparing' })
  return <span data-tool-duration className={muted} title={title}>{formatDuration(ms)}</span>
}

/**
 * 思考过程标题行的思考时长：该思考块开始输出 → 输出完成。live = 所在回合仍在进行（输出中才实时走，0.1 秒刷新与「N.N秒」精度一致）。
 * 没有开始时间（旧会话回放）不显示
 */
export function ReasoningElapsed({ item, live }: { item: ConvItem; live: boolean }) {
  const running = live && item.status === 'in_progress' && !item.doneAt
  const now = useNow(100, running)
  const ms = elapsedMs(item.at, item.doneAt, running ? now : undefined)
  if (ms === undefined) return null
  return <span data-reasoning-duration className="shrink-0 tabular-nums" title={reasoningTimeTitle(item)}>· {formatDuration(ms)}</span>
}

/** 用户消息的发送时间（气泡旁），hover 看完整时间 */
export function UserMsgTime({ at }: { at: number }) {
  return <span data-msg-time className={`${muted} self-end pb-0.5 text-[10.5px]`} title={fmtDateTime(at, true)}>{messageTime(at, Date.now())}</span>
}
