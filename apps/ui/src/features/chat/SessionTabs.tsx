// 会话切换器：不再占一行 tab —— 就是标题后面那个向下箭头，hover 展开最近的会话列表。
//
// 约定（与用户定稿）：
//  - 当前会话用**主题色高亮**，不打勾。
//  - 列表是**最近 10 条**会话（按最后活跃时间），底部固定「全部会话…」「新建会话」。
//  - 列表用 tooltip 的方式浮在最上层（挂 body + fixed 定位），不受父级层叠上下文影响。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { tr, type SessionMeta } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { RECENT_N, recentSessions, tabTitle } from './sessionTabsModel.js'

export interface SessionSwitcherProps {
  sessions: SessionMeta[]
  activeId: string
  /** 当前会话是否在跑（转圈） */
  activeBusy?: boolean
  activeAttention?: 'confirm' | 'failed'
  onSwitch: (id: string) => void
  onNew?: () => void
  onOpenHistory?: () => void
}

const whenOf = (iso?: string): string => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return tr('刚刚')
  if (mins < 60) return tr('{n} 分钟前', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return tr('{n} 小时前', { n: hours })
  return tr('{n} 天前', { n: Math.floor(hours / 24) })
}

const OPEN_DELAY = 90      // 悬停多久出列表（鼠标扫过标题时不要闪）
const CLOSE_DELAY = 180    // 移开后多久收起（给鼠标从箭头移到列表留时间）

export function SessionSwitcher(p: SessionSwitcherProps) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 浮层挂 body、fixed 定位（同全局 tooltip）：不会被消息气泡 / 工具卡片盖住
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const clear = () => { clearTimeout(timer.current); timer.current = undefined }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (!boxRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDoc)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDoc) }
  }, [open])
  useEffect(() => clear, [])

  // 位置：贴箭头下方，超出视口就往上翻，左右夹在视口里
  useLayoutEffect(() => {
    if (!open || !boxRef.current || !menuRef.current) return
    const a = boxRef.current.getBoundingClientRect()
    const m = menuRef.current.getBoundingClientRect()
    const pad = 8
    const left = Math.min(Math.max(a.left, pad), Math.max(pad, window.innerWidth - pad - m.width))
    const below = a.bottom + 4
    const top = below + m.height <= window.innerHeight - pad ? below : Math.max(pad, a.top - 4 - m.height)
    setAt((cur) => (cur && Math.abs(cur.left - left) < 0.5 && Math.abs(cur.top - top) < 0.5 ? cur : { left, top }))
  }, [open])

  const recent = recentSessions(p.sessions, p.activeId, RECENT_N)
  if (!p.sessions.length) return null

  const dot = () => {
    if (p.activeBusy) return <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-accent)]" />
    if (p.activeAttention === 'confirm') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warn)]" />
    if (p.activeAttention === 'failed') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-danger)]" />
    return null
  }

  return (
    <div ref={boxRef} data-session-switcher className="relative shrink-0"
      onMouseEnter={() => { clear(); timer.current = setTimeout(() => setOpen(true), OPEN_DELAY) }}
      onMouseLeave={() => { clear(); timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY) }}>
      <button data-session-switcher-btn aria-expanded={open} aria-haspopup="menu"
        title={tr('切换会话（最近 {n} 条）', { n: RECENT_N })}
        onClick={() => setOpen((v) => !v)}
        className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && createPortal(
        <div ref={menuRef} data-session-switcher-menu role="menu"
          style={{ left: at?.left ?? -9999, top: at?.top ?? -9999 }}
          className="fixed z-[1000] w-[300px] overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-xl">
          <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] text-[var(--color-text-muted)]">
            <span>{tr('最近的会话')}</span>{dot()}
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {recent.map((s) => {
              const active = s.id === p.activeId
              return (
                <button key={s.id} data-session-menu-item={s.id} role="menuitem"
                  onClick={() => { p.onSwitch(s.id); setOpen(false) }}
                  className={cn('flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11.5px] transition-colors hover:bg-[var(--color-bg-hover)]',
                    active
                      ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]'
                      : 'text-[var(--color-text-secondary)]')}>
                  <span className="min-w-0 flex-1 truncate">{tabTitle(s.title) || tr('新会话')}</span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{whenOf(s.lastActiveAt)}</span>
                </button>
              )
            })}
          </div>
          <div className="border-t border-[var(--color-border-subtle)]">
            {p.onOpenHistory && (
              <button role="menuitem" onClick={() => { setOpen(false); p.onOpenHistory?.() }}
                className="flex w-full items-center px-2.5 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('全部会话…')}</button>
            )}
            {p.onNew && (
              <button role="menuitem" onClick={() => { setOpen(false); p.onNew?.() }}
                className="flex w-full items-center px-2.5 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('新建会话')}</button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
