import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Trash2, Pencil, Check, X, Search, Loader2, User, Bot, TerminalSquare, Sparkles } from 'lucide-react'
import { sessionTime, searchTokens, searchContextText, fmtDateTime, tr, tk, type SessionMeta, type ChatSearchHit } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { useNow } from '../../lib/useNow.js'
import { Highlight } from '../help/index.js'
import { pushChatContext, requestChatJump } from '../../lib/chatBus.js'

const KIND = { user: { icon: User, label: tk('提问') }, ai: { icon: Bot, label: 'AI' }, cmd: { icon: TerminalSquare, label: tk('命令') } } as const

// 历史会话抽屉内容：列表 + 切换 + 改名（内联）+ 删除（当前会话不显示删除，防误删）。
// 删除的二次确认由父级（App）用 ConfirmDialog 处理，这里只回调 onDelete。
// 顶部搜索：标题本地即时过滤 + 跨会话全文检索（用户提问 / AI 回复 / 执行过的命令，中文按二元组切词），
// 每个会话列出最多 3 条命中片段（高亮）与时间，点片段打开会话并滚到那条消息；「问 AI」把前 3 条片段作为上下文发到当前对话。
export function HistoryDrawer({ sessions, activeId, onSelect, onRename, onDelete, onClose, initialQuery }: {
  sessions: SessionMeta[]
  activeId: string
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string, title: string) => void
  onClose: () => void
  initialQuery?: string   // 命令面板「搜索历史会话内容」带进来的词
}) {
  const now = useNow(60_000)   // 相对时间每分钟刷新
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const commit = (id: string, fallback: string) => { onRename(id, draft.trim() || fallback); setEditing('') }

  const [query, setQuery] = useState(initialQuery ?? '')
  const [hits, setHits] = useState<ChatSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const seq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (initialQuery !== undefined) { setQuery(initialQuery); inputRef.current?.focus() } }, [initialQuery])
  // 停手 300ms 再搜；只认最后一次请求的结果
  useEffect(() => {
    const q = query.trim()
    const my = ++seq.current
    if (!q) { setHits([]); setSearching(false); setSearchErr(''); return }
    setSearching(true)
    const t = setTimeout(() => {
      client.chatPlus.search(q)
        .then((r) => { if (my === seq.current) { setHits(r); setSearchErr('') } })
        .catch((e) => { if (my === seq.current) setSearchErr(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) })
        .finally(() => { if (my === seq.current) setSearching(false) })
    }, 300)
    return () => clearTimeout(t)
  }, [query])
  const q = query.trim().toLowerCase()
  const tokens = searchTokens(q)
  const bySession = new Map<string, ChatSearchHit[]>()
  for (const h of hits) bySession.set(h.sessionId, [...(bySession.get(h.sessionId) ?? []), h])
  // 有内容命中的按命中先后（得分高的在前），其后是只有标题匹配的
  const ranked = [...bySession.keys()].map((id) => sessions.find((s) => s.id === id)).filter((s): s is SessionMeta => !!s)
  // 标题过滤同时比对原文和显示的译文（默认标题「新会话」英文界面显示为 New session）
  const shown = q ? [...ranked, ...sessions.filter((s) => !bySession.has(s.id) && (s.title.toLowerCase().includes(q) || tr(s.title).toLowerCase().includes(q)))] : sessions
  const titleOf = (id: string) => { const t = sessions.find((s) => s.id === id)?.title; return t ? tr(t) : tr('会话') }

  const openHit = (h: ChatSearchHit) => { requestChatJump({ sessionId: h.sessionId, itemId: h.itemId, q: query.trim() }); onSelect(h.sessionId) }
  const askAi = () => {
    const top = hits.slice(0, 3).map((h) => ({ ...h, title: titleOf(h.sessionId), when: h.at ? fmtDateTime(h.at) : undefined }))
    if (!top.length) return
    pushChatContext({ chips: [{ ctx: 'session', name: tr('检索：{q}', { q: query.trim() }), text: searchContextText(query.trim(), top) }], text: tr('上次怎么解决「{q}」的？参考这些历史片段，说说当时的原因和处理步骤，现在能不能照做。', { q: query.trim() }), send: true })
    onClose()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 pl-3.5">
        <span className="flex-1 text-[12.5px] font-semibold text-[var(--color-text-primary)]">{tr('历史会话')}</span>
        <button onClick={onClose} title={tr('关闭')} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
      </div>
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]">
          {searching ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]" /> : <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
          <input ref={inputRef} data-history-search value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('搜索标题、对话内容、执行过的命令')}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
          {query && <button onClick={() => setQuery('')} title={tr('清空')}><X className="h-3 w-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" /></button>}
        </div>
        {searchErr && <div className="mt-1 px-0.5 text-[11px] text-[var(--color-danger)]">{tr('内容搜索失败：{err}（标题过滤仍有效）', { err: searchErr })}</div>}
        {q && hits.length > 0 && (
          <button data-history-ask onClick={askAi} title={tr('把下面前 3 条命中片段作为上下文发到当前对话，让 AI 总结上次是怎么解决的')}
            className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-2 py-1 text-left text-[11.5px] text-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]">
            <Sparkles className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{tr('问 AI：上次怎么解决「{q}」的', { q: query.trim() })}</span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-[var(--color-text-muted)]">{q ? (searching ? tr('搜索中…') : tr('没有匹配的会话')) : tr('暂无会话')}</div>}
        {shown.map((s) => {
          const isActive = s.id === activeId
          const sh = bySession.get(s.id) ?? []
          return (
            <div key={s.id} className="mb-0.5">
              <div onClick={() => onSelect(s.id)} title={tr(s.title)} role="button" tabIndex={0}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return   // 行内按钮 / 输入框自己的键
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.id) }
                }}
                className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${isActive ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                {editing === s.id ? (
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') commit(s.id, s.title); else if (e.key === 'Escape') setEditing('') }}
                    onBlur={() => commit(s.id, s.title)}
                    className="min-w-0 flex-1 rounded bg-[var(--color-bg-base)] px-1 text-[var(--color-text-primary)] outline-none" />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{q ? <Highlight text={tr(s.title)} tokens={tokens} /> : tr(s.title)}</span>
                )}
                {isActive && editing !== s.id && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{tr('当前')}</span>}
                {editing !== s.id && (() => {
                  const t = sessionTime(s, now)
                  return t && <span data-session-time className="shrink-0 tabular-nums text-[10.5px] text-[var(--color-text-muted)]" title={t.title}>{t.text}</span>
                })()}
                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                  {editing === s.id ? (
                    <button onClick={(e) => { e.stopPropagation(); commit(s.id, s.title) }} title={tr('确定')}><Check className="h-3 w-3 text-[var(--color-success)]" /></button>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); setEditing(s.id); setDraft(s.title) }} title={tr('重命名')}><Pencil className="h-3 w-3 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" /></button>
                  )}
                  {/* 当前会话不显示删除图标，防误删正在用的会话 */}
                  {!isActive && (
                    <button onClick={(e) => { e.stopPropagation(); onDelete(s.id, s.title) }} title={tr('删除')}><Trash2 className="h-3 w-3 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" /></button>
                  )}
                </div>
              </div>
              {/* 命中片段：点击打开会话并滚到那条消息 */}
              {sh.map((h, i) => {
                const K = KIND[h.kind]
                return (
                  <div key={i} data-search-hit={h.itemId ?? ''} onClick={() => openHit(h)} title={tr('{kind}：{text}\n点击打开会话并定位', { kind: tr(K.label), text: h.snippet })}
                    role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHit(h) } }}
                    className="ml-6 mr-1 flex cursor-pointer items-start gap-1.5 rounded px-1.5 py-1 text-[11px] text-[var(--color-text-muted)] outline-none hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
                    <K.icon className="mt-[1px] h-3 w-3 shrink-0" />
                    <span className={`min-w-0 flex-1 line-clamp-2 break-all ${h.kind === 'cmd' ? 'font-mono' : ''}`}><Highlight text={h.snippet} tokens={tokens} /></span>
                    {h.at && <span className="shrink-0 tabular-nums text-[10px]">{fmtDateTime(h.at).slice(5, 16)}</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
