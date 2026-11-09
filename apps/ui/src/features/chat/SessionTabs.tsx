// 对话区的会话标签栏：多任务在几个会话间来回切，不用每次都去左边列表找。
//
// 约定（与用户定稿）：
//  - 当前会话用**主题色高亮**（底色 + 字色 + 下边框），不打勾。
//  - 标签放不下时收进「…」，点开是**最近 10 条**会话；下拉里当前会话同样只用主题色高亮。
//  - 关闭标签只是从标签栏移除，不删会话。
//  - 状态点：正在跑（转圈）、待确认（橙）、失败（红）——只有当前会话拿得到 phase，其它会话留给外层以后接。
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Plus, X } from 'lucide-react'
import { tr, type SessionMeta } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { RECENT_N, recentSessions, splitTabs, tabTitle } from './sessionTabsModel.js'

export interface SessionTabsProps {
  sessions: SessionMeta[]
  activeId: string
  tabs: string[]
  /** 当前会话是否在跑 / 待确认 / 失败（其它会话暂无状态） */
  activeBusy?: boolean
  activeAttention?: 'confirm' | 'failed'
  onSwitch: (id: string) => void
  onClose: (id: string) => void
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

export function SessionTabs(p: SessionTabsProps) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const titleOf = (id: string) => tabTitle(p.sessions.find((s) => s.id === id)?.title) || tr('新会话')
  const { shown, overflow } = splitTabs(p.tabs)
  const recent = recentSessions(p.sessions, p.activeId, RECENT_N)
  if (!p.tabs.length && !p.sessions.length) return null

  const dot = (id: string) => {
    if (id !== p.activeId) return null
    if (p.activeBusy) return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--color-accent)]" />
    if (p.activeAttention === 'confirm') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warn)]" />
    if (p.activeAttention === 'failed') return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-danger)]" />
    return null
  }

  return (
    <div ref={boxRef} data-session-tabs className="relative flex h-8 shrink-0 items-end gap-1 border-b border-[var(--color-border-subtle)] px-2 pt-1">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden">
        {shown.map((id) => {
          const active = id === p.activeId
          return (
            <div key={id} data-session-tab={id} data-active={active ? '1' : undefined} onClick={() => p.onSwitch(id)}
              title={p.sessions.find((s) => s.id === id)?.title ?? id}
              className={cn(
                'group flex h-6 max-w-[180px] shrink-0 cursor-pointer items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11.5px]',
                active
                  ? 'border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]',
              )}>
              {dot(id)}
              <span className="min-w-0 truncate">{titleOf(id)}</span>
              {id !== p.activeId && (
                <button title={tr('从标签栏移除（不会删除会话）')} onClick={(e) => { e.stopPropagation(); p.onClose(id) }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-[var(--color-bg-hover)] group-hover:opacity-100"><X className="h-3 w-3" /></button>
              )}
            </div>
          )
        })}
        <button data-session-tabs-more title={tr('最近的会话（{n} 条）', { n: RECENT_N })} onClick={() => setOpen((v) => !v)}
          className={cn('mb-[1px] flex h-6 shrink-0 items-center gap-0.5 rounded px-1.5 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]',
            overflow > 0 && 'text-[var(--color-accent)]')}>
          {overflow > 0 ? <span className="tabular-nums">+{overflow}</span> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>
      {p.onNew && (
        <button title={tr('新建会话')} onClick={p.onNew} className="mb-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><Plus className="h-3.5 w-3.5" /></button>
      )}

      {open && (
        <div data-session-tabs-menu className="absolute left-2 top-full z-30 mt-0.5 w-[280px] overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-lg">
          <div className="px-2 py-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('最近的会话')}</div>
          {recent.map((s) => {
            const active = s.id === p.activeId
            return (
              <button key={s.id} data-session-menu-item={s.id} onClick={() => { p.onSwitch(s.id); setOpen(false) }}
                className={cn('flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]',
                  active ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]')}>
                <span className="min-w-0 flex-1 truncate">{tabTitle(s.title) || tr('新会话')}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{whenOf(s.lastActiveAt)}</span>
              </button>
            )
          })}
          <div className="border-t border-[var(--color-border-subtle)]">
            {p.onOpenHistory && (
              <button onClick={() => { setOpen(false); p.onOpenHistory?.() }} className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('全部会话…')}</button>
            )}
            {p.onNew && (
              <button onClick={() => { setOpen(false); p.onNew?.() }} className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('新建会话')}</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
