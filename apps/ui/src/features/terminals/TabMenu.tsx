import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Pencil, X, XCircle, ArrowRightToLine, Ban, LayoutGrid, Pin, PinOff, FileDown, ClipboardCopy } from 'lucide-react'
import { TAB_COLORS, TAB_COLOR_LABEL, closeTargets, tr, type TabColor, type TabMeta, type TerminalInfo } from '@lingshell/shared'
import { ConfirmDialog } from '../common/index.js'
import { TmuxMenuSection } from './TmuxParts.js'

const ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-[var(--color-bg-hover)] disabled:pointer-events-none disabled:opacity-40'

// 标签右键菜单：复制会话 / 重命名 / 固定 / 显示在当前窗格（分屏时）/ 标签色 / 导出缓冲区 / 关闭 / 关闭其他 / 关闭右侧 / 全部关闭。
// 关闭其他 / 右侧 / 全部都跳过固定标签（terms 为显示顺序，固定的在前）。
// 关闭时若有终端正被 AI 执行命令，先二次确认（确认框显示期间菜单本身收起）。
export function TabMenu({ x, y, id, terms, meta, isPinned, onPin, onDuplicate, onRename, onShowHere, onColor, onCloseMany, onCloseThis, onClose, onAttachTmux, onSaveBuffer, onCopyBuffer }: {
  x: number; y: number; id: string; terms: TerminalInfo[]; meta?: TabMeta
  isPinned: (id: string) => boolean; onPin: () => void
  onDuplicate: () => void; onRename: () => void; onShowHere?: () => void; onColor: (c: TabColor | undefined) => void
  onCloseMany: (ids: string[]) => void; onCloseThis: () => void; onClose: () => void
  onAttachTmux?: (name: string) => void   // 接回同主机保留的 tmux 会话（已存主机的 SSH 终端才有）
  onSaveBuffer: () => void; onCopyBuffer: () => void   // 导出缓冲区（含回滚）
}) {
  const ref = useRef<HTMLDivElement>(null)
  // pending.self：确认的是「关闭此标签」（关后焦点按常规规则移走，不走 closeMany 的 keep）
  const [pending, setPending] = useState<{ ids: string[]; self?: boolean } | null>(null)
  useEffect(() => {
    if (pending) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [pending])

  const i = terms.findIndex((t) => t.id === id)
  const pin = (t: TerminalInfo) => isPinned(t.id)
  const others = closeTargets(terms, id, 'others', pin), right = closeTargets(terms, id, 'right', pin), all = closeTargets(terms, id, 'all', pin)
  const busy = (ids: string[]) => terms.filter((t) => ids.includes(t.id) && t.locked).length
  const closeMany = (ids: string[]) => { if (busy(ids)) setPending({ ids }); else { onCloseMany(ids); onClose() } }
  const closeThis = () => { if (busy([id])) setPending({ ids: [id], self: true }); else { onCloseThis(); onClose() } }
  const act = (f: () => void) => () => { f(); onClose() }

  if (pending) return (
    <ConfirmDialog open title={tr('关闭终端')} confirmText={tr('关闭')}
      message={pending.self ? tr('这个终端正被 AI 执行命令，关闭会中断执行。确认关闭？')
        : tr('要关闭的 {n} 个终端里有 {busy} 个正被 AI 执行命令，关闭会中断执行。确认关闭？', { n: pending.ids.length, busy: busy(pending.ids) })}
      onConfirm={() => { if (pending.self) onCloseThis(); else onCloseMany(pending.ids); onClose() }} onCancel={onClose} />
  )
  return createPortal((
    // 贴着鼠标展开，靠近窗口右缘时往左让
    <div ref={ref} style={{ left: Math.min(x, window.innerWidth - 232), top: y }}
      className="fixed z-50 w-56 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 text-[12px] text-[var(--color-text-primary)] shadow-lg">
      <button onClick={act(onDuplicate)} className={ITEM}><Copy className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('复制会话')}<span className="ml-auto text-[10px] text-[var(--color-text-muted)]">Ctrl+Shift+D</span></button>
      <button onClick={act(onRename)} className={ITEM}><Pencil className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('重命名标签')}</button>
      <button onClick={act(onPin)} className={ITEM}>
        {isPinned(id) ? <PinOff className="h-3.5 w-3.5 text-[var(--color-accent)]" /> : <Pin className="h-3.5 w-3.5 text-[var(--color-accent)]" />}{isPinned(id) ? tr('取消固定') : tr('固定')}
      </button>
      {onShowHere && <button onClick={act(onShowHere)} className={ITEM}><LayoutGrid className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('显示在当前窗格')}</button>}
      <div className="flex items-center gap-1 px-2.5 py-1.5">
        <span className="mr-1 text-[var(--color-text-muted)]">{tr('颜色')}</span>
        {(Object.keys(TAB_COLORS) as TabColor[]).map((c) => (
          <button key={c} title={tr(TAB_COLOR_LABEL[c])} onClick={act(() => onColor(c))} style={{ background: TAB_COLORS[c] }}
            className={`h-3.5 w-3.5 rounded-full ${meta?.color === c ? 'ring-2 ring-[var(--color-text-primary)] ring-offset-1 ring-offset-[var(--color-bg-panel)]' : 'hover:opacity-80'}`} />
        ))}
        <button title={tr('清除颜色')} onClick={act(() => onColor(undefined))} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><Ban className="h-3.5 w-3.5" /></button>
      </div>
      <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
      <button onClick={act(onSaveBuffer)} title={tr('整个缓冲区（含已滚上去的）存成纯文本，不带颜色')} className={ITEM}><FileDown className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('导出缓冲区为 .txt…')}</button>
      <button onClick={act(onCopyBuffer)} title={tr('整个缓冲区（含已滚上去的）复制到剪贴板')} className={ITEM}><ClipboardCopy className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('复制全部缓冲区')}</button>
      {terms[i]?.type === 'ssh' && <TmuxMenuSection term={terms[i]} itemClass={ITEM} onAttach={onAttachTmux && ((n) => { onAttachTmux(n); onClose() })} />}
      <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
      <button onClick={closeThis} className={ITEM}><X className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('关闭标签')}<span className="ml-auto text-[10px] text-[var(--color-text-muted)]">Ctrl+Shift+W</span></button>
      <button disabled={!others.length} onClick={() => closeMany(others)} className={ITEM}><XCircle className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('关闭其他标签')}</button>
      <button disabled={!right.length} onClick={() => closeMany(right)} className={ITEM}><ArrowRightToLine className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('关闭右侧标签')}</button>
      <button disabled={!all.length} onClick={() => closeMany(all)} title={tr('固定的标签不关')} className={ITEM}><XCircle className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('全部关闭')}</button>
    </div>
  ), document.body)
}

// 标签内联重命名：Enter / 失焦保存，Esc 放弃；清空 = 恢复默认名
export function TabTitleInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const done = useRef(false)
  const finish = (r: string | null) => { if (!done.current) { done.current = true; onDone(r) } }
  return (
    <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()} onBlur={() => finish(v.trim())}
      onKeyDown={(e) => { e.stopPropagation(); if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') finish(v.trim()); else if (e.key === 'Escape') finish(null) }}
      className="w-28 rounded border border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] bg-[var(--color-bg-base)] px-1 text-[12px] text-[var(--color-text-primary)] outline-none" />
  )
}
