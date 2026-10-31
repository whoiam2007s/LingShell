// 终端里点 AI 命令的紫色标记 → 对话滚到对应工具卡片并闪一下（必要时先切到那个会话、加载更早的消息、展开「执行过程」）
import { createContext, useEffect, useRef, useState } from 'react'
import { onFocusToolCard, type ToolFocus } from '../terminals/index.js'

/** 当前要聚焦的工具卡片：TurnBlock 据此把含它的「执行过程」展开（n 每次递增，同一张卡可以反复定位） */
export const ToolFocusContext = createContext<{ callId: string; n: number } | null>(null)

/** 这张卡在 items 里的下标（工具卡的 itemId 就是 callId） */
export const toolIndex = (items: { itemId: string }[], callId: string) => items.findIndex((x) => x.itemId === callId)

export function flashEl(el: Element) {
  el.classList.remove('ai-flash'); void (el as HTMLElement).offsetWidth; el.classList.add('ai-flash')
  setTimeout(() => el.classList.remove('ai-flash'), 1700)
}

export function useToolFocus(o: {
  items: { itemId: string }[]; sessionId: string; startIdx: number
  openSession?: (id: string) => Promise<void>; showFrom: (count: number) => void; unpin: () => void
  scrollEl: () => HTMLElement | null
}) {
  const [focus, setFocus] = useState<{ callId: string; n: number } | null>(null)
  const pending = useRef<(ToolFocus & { until: number }) | null>(null)
  const [tick, setTick] = useState(0)
  const ref = useRef(o); ref.current = o
  useEffect(() => onFocusToolCard((f) => {
    pending.current = { ...f, until: Date.now() + 15_000 }   // 切会话后历史重放要一会儿
    if (f.sessionId !== ref.current.sessionId) void ref.current.openSession?.(f.sessionId)
    setTick((t) => t + 1)
  }), [])
  useEffect(() => {
    const p = pending.current
    if (!p || p.sessionId !== o.sessionId) return
    if (Date.now() > p.until) { pending.current = null; return }
    const i = toolIndex(o.items, p.callId)
    if (i < 0) return   // 还没回放到：等 items 更新
    o.unpin()
    if (i < o.startIdx) { o.showFrom(o.items.length - i + 10); return }   // 在窗口外：多渲染一些，下次再来
    pending.current = null
    setFocus((f) => ({ callId: p.callId, n: (f?.n ?? 0) + 1 }))
    // 等「执行过程」展开、卡片渲染出来
    let k = 0
    const find = () => {
      const el = o.scrollEl()?.querySelector(`[data-call-id="${CSS.escape(p.callId)}"]`)
      if (el) { el.scrollIntoView({ block: 'center' }); flashEl(el) } else if (++k < 10) requestAnimationFrame(find)
    }
    requestAnimationFrame(find)
  }, [o.items, o.sessionId, o.startIdx, tick])
  return focus
}
