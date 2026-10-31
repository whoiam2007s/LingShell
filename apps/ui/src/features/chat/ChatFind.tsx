// 会话内搜索条（焦点在对话区时 Ctrl+F）：用 CSS Custom Highlight 高亮命中（不改 React 管的 DOM），
// Enter / Shift+Enter 下一个 / 上一个，Esc 关闭。只搜已渲染的内容（折叠的执行过程不算）；更早的消息由 ChatPanel 按需加载进来。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { tr } from '@lingshell/shared'

type Hl = { new (...r: Range[]): unknown }
const highlights = (): Map<string, unknown> | undefined => (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
const HighlightCtor = (globalThis as unknown as { Highlight?: Hl }).Highlight

/** root 里所有文本节点上 q 的出现位置（不区分大小写；跳过搜索条自己） */
export function findRanges(root: HTMLElement, q: string): Range[] {
  const needle = q.toLowerCase()
  if (!needle) return []
  const out: Range[] = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-chat-find],script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = (n.nodeValue ?? '').toLowerCase()
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + needle.length)) {
      const r = document.createRange()
      r.setStart(n, i); r.setEnd(n, i + needle.length)
      out.push(r)
    }
  }
  return out
}

// ::highlight() 里 var() 在部分 Chromium 版本取不到值：按当前主题把颜色算好写进样式
function ensureStyle() {
  const cs = getComputedStyle(document.documentElement)
  const warn = cs.getPropertyValue('--color-warn').trim() || 'Mark'
  const acc = cs.getPropertyValue('--color-accent').trim() || 'Highlight'
  let el = document.getElementById('chat-find-style')
  if (!el) { el = document.createElement('style'); el.id = 'chat-find-style'; document.head.appendChild(el) }
  el.textContent = `::highlight(chat-find){background-color:color-mix(in srgb,${warn} 38%,transparent)}::highlight(chat-find-cur){background-color:color-mix(in srgb,${acc} 60%,transparent)}`
}

export function ChatFind({ root, tick, onClose, onQuery }: {
  root: React.RefObject<HTMLElement | null>
  tick: unknown                       // 内容变化（新消息 / 加载更早的）时重算
  onClose: () => void
  onQuery?: (q: string) => void       // 让 ChatPanel 把含命中的更早消息加载进窗口
}) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [count, setCount] = useState(0)
  const ranges = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { ensureStyle(); inputRef.current?.focus() }, [])
  useEffect(() => { onQuery?.(q) }, [q])
  useEffect(() => () => { highlights()?.delete('chat-find'); highlights()?.delete('chat-find-cur') }, [])

  const paint = (i: number, scroll: boolean) => {
    const rs = ranges.current
    const reg = highlights()
    if (!reg || !HighlightCtor) return
    reg.set('chat-find', new HighlightCtor(...rs))
    if (rs[i]) reg.set('chat-find-cur', new HighlightCtor(rs[i])); else reg.delete('chat-find-cur')
    if (scroll && rs[i]) rs[i].startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }
  // 查询词 / 内容变化：重找；保持当前序号不越界
  useLayoutEffect(() => {
    const el = root.current
    ranges.current = el ? findRanges(el, q.trim()) : []
    setCount(ranges.current.length)
    const i = Math.min(idx, Math.max(0, ranges.current.length - 1))
    setIdx(i)
    paint(i, false)
  }, [q, tick])
  // 输入变化后跳到最后一个命中（最新的消息在底部）
  useEffect(() => {
    const n = ranges.current.length
    if (!n) return
    setIdx(n - 1); paint(n - 1, true)
  }, [q])
  const go = (d: 1 | -1) => {
    const n = ranges.current.length
    if (!n) return
    const i = (idx + d + n) % n
    setIdx(i); paint(i, true)
  }
  return (
    <div data-chat-find className="absolute right-3 top-1.5 z-20 flex items-center gap-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-1.5 py-1 shadow-lg">
      <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索本会话')} aria-label={tr('搜索本会话')}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        }}
        className="w-40 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
      <span data-chat-find-count className="min-w-[44px] text-right text-[11px] tabular-nums text-[var(--color-text-muted)]">{q.trim() ? (count ? `${idx + 1}/${count}` : tr('无结果')) : ''}</span>
      <button onClick={() => go(-1)} title={tr('上一个（Shift+Enter）')} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><ChevronUp className="h-3.5 w-3.5" /></button>
      <button onClick={() => go(1)} title={tr('下一个（Enter）')} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><ChevronDown className="h-3.5 w-3.5" /></button>
      <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}
