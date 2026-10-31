import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Maximize2, Sheet, X } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { rowsToMarkdown, rowsToTsv, tableRows, type HNode } from '../mdTable.js'

// 对话里的 Markdown 表格：外面包一层横向滚动（表格按内容撑开，列有最小 / 最大宽度，超宽才滚动；首列固定；两侧阴影提示还有内容），
// 右上角悬停出「展开」（大窗口全宽看）和「复制」（Markdown / 制表符分隔粘进 Excel）。样式见 index.css 的 .md-table
export function MdTable({ node, children }: { node?: unknown; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const rows = () => tableRows(node as HNode | undefined)
  return (
    <div data-md-table className="md-table group/tbl relative my-[0.6em]">
      <TableTools rows={rows} onExpand={() => setOpen(true)} />
      <ScrollBox><table>{children}</table></ScrollBox>
      {open && <Expanded rows={rows} onClose={() => setOpen(false)}><table>{children}</table></Expanded>}
    </div>
  )
}

// 横向滚动容器 + 左右阴影（只在那一侧还有内容时出现）
function ScrollBox({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ l: false, r: false, w: 0 })
  const update = () => {
    const el = ref.current
    // w = 固定首列宽：左侧阴影从它右边开始
    if (el) setEdge({ l: el.scrollLeft > 1, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 1, w: (el.querySelector('th, td') as HTMLElement | null)?.offsetWidth ?? 0 })
  }
  useLayoutEffect(() => {
    update()
    const ro = new ResizeObserver(update)
    if (ref.current) { ro.observe(ref.current); const t = ref.current.firstElementChild; if (t) ro.observe(t) }
    return () => ro.disconnect()
  }, [])
  return (
    <div className={`md-table-frame relative ${className}`} data-edge-l={edge.l || undefined} data-edge-r={edge.r || undefined} style={{ '--md-sticky-w': `${edge.w}px` } as React.CSSProperties}>
      <div ref={ref} onScroll={update} className="md-table-scroll">{children}</div>
    </div>
  )
}

function TableTools({ rows, onExpand, inModal }: { rows: () => string[][]; onExpand?: () => void; inModal?: boolean }) {
  const [done, setDone] = useState<'' | 'md' | 'tsv'>('')
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(''), 1500); return () => clearTimeout(t) }, [done])
  const copy = (kind: 'md' | 'tsv') => {
    const r = rows()
    void navigator.clipboard.writeText(kind === 'md' ? rowsToMarkdown(r) : rowsToTsv(r)).then(() => setDone(kind), () => {})
  }
  const B = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'
  return (
    <div data-md-table-tools className={inModal ? 'flex items-center gap-0.5' : 'absolute -top-3 right-1 z-[2] flex items-center gap-0.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-0.5 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover/tbl:opacity-100'}>
      {onExpand && <button data-md-table-expand onClick={onExpand} title={tr('展开：在大窗口里全宽查看')} className={B}><Maximize2 className="h-3.5 w-3.5" /></button>}
      <button data-md-table-copy="md" onClick={() => copy('md')} title={tr('复制为 Markdown 表格')} className={B}>{done === 'md' ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}</button>
      <button data-md-table-copy="tsv" onClick={() => copy('tsv')} title={tr('复制到 Excel：制表符分隔，粘贴后自动分列')} className={B}>{done === 'tsv' ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Sheet className="h-3.5 w-3.5" />}</button>
    </div>
  )
}

function Expanded({ rows, onClose, children }: { rows: () => string[][]; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return createPortal((
    <div data-md-table-modal className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex max-h-[88vh] w-[min(1400px,95vw)] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
          <span className="text-[12.5px] font-semibold text-[var(--color-text-primary)]">{tr('表格')}</span>
          <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 行', { n: Math.max(0, rows().length - 1) })}</span>
          <span className="ml-auto" />
          <TableTools rows={rows} inModal />
          <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="markdown-body min-h-0 overflow-auto p-3 text-[13px]">
          <div className="md-table md-table-wide"><ScrollBox>{children}</ScrollBox></div>
        </div>
      </div>
    </div>
  ), document.body)
}
