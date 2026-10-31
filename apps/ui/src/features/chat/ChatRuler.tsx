import { useEffect, useState, type RefObject } from 'react'
import { tr } from '@lingshell/shared'

// 对话区滚动条标尺（同终端的滚动条标记）：右侧细条上按位置标出「我的提问」，悬停看提问的前部分，点击滚过去并闪一下。
// 只标已渲染的消息（往上翻加载更早的之后会补上）；内容不够一屏不显示
const clip = (s: string, n = 60) => { const l = s.trim().replace(/\s+/g, ' '); return l.length > n ? `${l.slice(0, n)}…` : l }

export function ChatRuler({ scrollRef, contentRef, msgs, onGo }: {
  scrollRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null>
  msgs: { itemId: string; text: string }[]
  onGo: (el: HTMLElement) => void   // ChatPanel 的 scrollToEl：先解除「贴底」再滚，否则会被拽回底部
}) {
  const [marks, setMarks] = useState<{ id: string; pct: number; label: string }[]>([])
  useEffect(() => {
    const sc = scrollRef.current, ct = contentRef.current
    if (!sc || !ct) return
    const measure = () => {
      if (sc.scrollHeight <= sc.clientHeight + 4) { setMarks([]); return }
      const top0 = ct.getBoundingClientRect().top   // 用差值算消息在内容里的位置，与当前滚到哪无关
      setMarks(msgs.flatMap((m) => {
        const el = ct.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(m.itemId)}"]`)
        if (!el) return []
        const y = el.getBoundingClientRect().top - top0
        return [{ id: m.itemId, pct: Math.min(99.5, (y / ct.scrollHeight) * 100), label: clip(m.text) || tr('（空消息）') }]
      }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(ct); ro.observe(sc)
    return () => ro.disconnect()
  }, [scrollRef, contentRef, msgs])
  if (!marks.length) return null
  const go = (id: string) => { const el = scrollRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`); if (el) onGo(el) }
  return (
    // 盖在滚动条上：条本身不接鼠标（拖滚动条照常），只有标记能点
    <div data-chat-ruler aria-hidden className="pointer-events-none absolute inset-y-2 right-0 w-2.5">
      {marks.map((m) => (
        <button key={m.id} data-ruler-mark={m.id} title={m.label} onClick={() => go(m.id)} tabIndex={-1}
          style={{ top: `${m.pct}%` }}
          className="pointer-events-auto absolute right-0.5 h-[3px] w-2 -translate-y-1/2 rounded-sm bg-[var(--color-user)] opacity-80 hover:h-[5px] hover:opacity-100" />
      ))}
    </div>
  )
}
