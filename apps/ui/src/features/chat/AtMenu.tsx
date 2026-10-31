// 输入框 @ 引用（参考 Cursor @、Claude Code @file）：打 @ 弹出候选——终端（当前打开的）、主机（已保存，按分组）、
// 历史会话（标题 + 时间）、文件（本机文件选择框）。↑↓ 选、Enter / Tab 确认、Esc 关；选中后变成输入框上方的上下文标签。
import { useEffect, useRef, useState } from 'react'
import { TerminalSquare, Server, MessageSquare, FileText, type LucideIcon } from 'lucide-react'
import { atQueryAt, sessionTime, tr, type HostSummary, type SessionMeta, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'

export type AtPick =
  | { type: 'terminal'; t: TerminalInfo }
  | { type: 'host'; h: HostSummary }
  | { type: 'session'; s: SessionMeta; when: string }
  | { type: 'file' }
interface AtItem { key: string; group: string; icon: LucideIcon; title: string; sub?: string; pick: AtPick }

const MAX_PER_GROUP = 8
const has = (q: string, ...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q))

/** 候选列表（纯计算，方便测）：按组排好、每组最多 8 条；文件项总在最后 */
export function atItems(q: string, terms: TerminalInfo[], hosts: HostSummary[], sessions: SessionMeta[], currentSession: string, now = Date.now()): AtItem[] {
  const x = q.toLowerCase()
  const out: AtItem[] = []
  for (const t of terms.filter((t) => has(x, t.title, t.type === 'local' ? '本地 local' : 'ssh', t.type === 'local' ? tr('本地') : '')).slice(0, MAX_PER_GROUP))   // i18n-ignore 搜索关键词（中英文都能搜）
    out.push({ key: `t:${t.id}`, group: tr('终端'), icon: TerminalSquare, title: t.title, sub: t.type === 'local' ? tr('本地') : t.status === 'disconnected' ? tr('SSH · 已断开') : 'SSH', pick: { type: 'terminal', t } })
  const hs = hosts.filter((h) => has(x, h.label, h.host, h.group, h.username))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label)).slice(0, MAX_PER_GROUP)
  for (const h of hs) out.push({ key: `h:${h.id}`, group: tr('主机'), icon: Server, title: h.label, sub: `${h.group ? `${h.group} · ` : ''}${h.username}@${h.host}`, pick: { type: 'host', h } })
  const ss = sessions.filter((s) => s.id !== currentSession && has(x, s.title, tr(s.title))).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)).slice(0, MAX_PER_GROUP)
  for (const s of ss) {
    const when = sessionTime(s, now)?.text ?? ''
    out.push({ key: `s:${s.id}`, group: tr('历史会话'), icon: MessageSquare, title: s.title ? tr(s.title) : tr('会话'), sub: when, pick: { type: 'session', s, when: sessionTime(s, now)?.title ?? when } })
  }
  if (has(x, '文件 file 本机', tr('文件'))) out.push({ key: 'file', group: tr('文件'), icon: FileText, title: tr('选择本机文件…'), sub: tr('只附路径'), pick: { type: 'file' } })   // i18n-ignore 搜索关键词
  return out
}

/** 输入框里的 @ 状态：input / caret 变化时重算；onKey 在 textarea 的 onKeyDown 里先调，返回 true = 已处理 */
export function useAtMenu(input: string, caret: number, sessionId: string, onPick: (p: AtPick, range: { start: number; end: number }) => void) {
  const at = atQueryAt(input, caret)
  const [dismissed, setDismissed] = useState(-1)   // Esc 关掉的那个 @ 的位置（继续打字不再弹，换个 @ 再弹）
  const open = !!at && at.start !== dismissed
  const [data, setData] = useState<{ terms: TerminalInfo[]; hosts: HostSummary[]; sessions: SessionMeta[] }>({ terms: [], hosts: [], sessions: [] })
  const [sel, setSel] = useState(0)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      void Promise.all([client.terminal.list().catch(() => []), client.hosts.list().catch(() => []), client.agent.listPersisted().catch(() => [])])
        .then(([terms, hosts, sessions]) => setData({ terms, hosts, sessions }))
    }
    wasOpen.current = open
  }, [open])
  useEffect(() => { setSel(0) }, [at?.q, at?.start])
  useEffect(() => { if (!at) setDismissed(-1) }, [!at])
  const items = open ? atItems(at!.q, data.terms, data.hosts, data.sessions, sessionId) : []
  const cur = Math.min(sel, Math.max(0, items.length - 1))
  const pick = (i: number) => { const it = items[i]; if (it && at) onPick(it.pick, { start: at.start, end: at.start + 1 + at.q.length }) }
  const onKey = (e: React.KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(at!.start); return true }
    if (!items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSel((cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length); return true }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(cur); return true }
    return false
  }
  return { open, items, cur, setSel, pick, onKey, close: () => at && setDismissed(at.start) }
}

export function AtMenuPopup({ m }: { m: ReturnType<typeof useAtMenu> }) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.querySelector(`[data-at-idx="${m.cur}"]`)?.scrollIntoView({ block: 'nearest' }) }, [m.cur])
  // 点外面收起
  useEffect(() => {
    if (!m.open) return
    const f = (e: MouseEvent) => { if (!(e.target instanceof Element && e.target.closest('[data-at-menu],[data-chat-input]'))) m.close() }
    window.addEventListener('mousedown', f)
    return () => window.removeEventListener('mousedown', f)
  }, [m.open])
  if (!m.open) return null
  let last = ''
  return (
    <div data-at-menu ref={listRef} role="listbox" aria-label={tr('@ 引用')}
      className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-[300px] overflow-y-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] p-1 shadow-lg">
      {!m.items.length && <div className="px-2 py-2 text-[11.5px] text-[var(--color-text-muted)]">{tr('没有匹配的终端 / 主机 / 会话')}</div>}
      {m.items.map((it, i) => {
        const head = it.group !== last ? (last = it.group) : ''
        return (
          <div key={it.key}>
            {head && <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-medium text-[var(--color-text-muted)]">{head}</div>}
            <div data-at-idx={i} data-at-key={it.key} role="option" aria-selected={i === m.cur}
              onMouseMove={() => { if (i !== m.cur) m.setSel(i) }} onMouseDown={(e) => { e.preventDefault(); m.pick(i) }}
              className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px]', i === m.cur ? 'bg-[var(--color-accent-bg)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]')}>
              <it.icon className={cn('h-3.5 w-3.5 shrink-0', i === m.cur ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]')} />
              <span className="min-w-0 max-w-[60%] truncate">{it.title}</span>
              {it.sub && <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{it.sub}</span>}
            </div>
          </div>
        )
      })}
      <div className="mt-0.5 border-t border-[var(--color-border-subtle)] px-2 pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('↑↓ 选择 · Enter 确认 · Esc 关闭')}</div>
    </div>
  )
}
