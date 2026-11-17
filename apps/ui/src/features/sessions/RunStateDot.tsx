// 会话状态点：历史会话抽屉、会话下拉共用同一份渲染，保证"状态逻辑一致"。
// 口径见 lib/sessionStates.ts：running(蓝·呼吸) / awaiting(橙) / failed(红)，正常结束不画。
import { tr } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import type { RunState } from '../../lib/sessionStates.js'

const COLOR: Record<RunState, string> = {
  running: 'var(--color-accent)',
  awaiting: 'var(--color-warn)',
  failed: 'var(--color-danger)',
}

export const runStateTitle = (s: RunState): string =>
  s === 'running' ? tr('正在进行中') : s === 'awaiting' ? tr('等你确认') : tr('上次执行失败')

/** 会话列表里用的写法：图标右上角一个 1.5px 小点 */
export function RunStateDot({ state, corner = true, className }: { state?: RunState; corner?: boolean; className?: string }) {
  if (!state) return null
  return (
    <span data-session-state={state} title={runStateTitle(state)}
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', corner && 'absolute -right-1 -top-1', state === 'running' && 'animate-pulse', className)}
      style={{ background: COLOR[state] }} />
  )
}
