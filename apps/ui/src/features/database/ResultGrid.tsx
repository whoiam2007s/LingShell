import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Copy, Download, SearchX } from 'lucide-react'
import { cellNumber, tableToText, tk, tr, type DbCopyFormat, type DbKind, type DbTable } from '@lingshell/shared'
import { createPortal } from 'react-dom'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { BTN, MUTED } from '../../components/ui/drawer.js'

export const TH = 'sticky top-0 z-[1] cursor-pointer select-none whitespace-nowrap border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5 py-1 text-left text-[10.5px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] first:pl-3'
export const TD = 'whitespace-nowrap border-b border-[var(--color-border-subtle)] px-1.5 py-1 font-mono first:pl-3'
const PAGE = 1000
const ITEM = 'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
type Sort = { col: number; desc: boolean } | null
const COPY_FMT: [DbCopyFormat, string][] = [['tsv', tk('制表符（粘贴到 Excel）')], ['csv', 'CSV'], ['markdown', tk('Markdown 表格')], ['insert', tk('INSERT 语句')]]

const sortRows = (rows: string[][], s: Sort) => {
  if (!s) return rows
  return [...rows].sort((a, b) => {
    const x = cellNumber(a[s.col] ?? ''), y = cellNumber(b[s.col] ?? '')
    const c = x !== undefined && y !== undefined ? x - y : (a[s.col] ?? '').localeCompare(b[s.col] ?? '')
    return s.desc ? -c : c
  })
}

// 菜单开着时 Esc 只关菜单（捕获阶段拦下，不让抽屉跟着关）；点外面 / 滚动也关
function useDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() } }
    const down = () => close()
    window.addEventListener('keydown', key, true)
    window.addEventListener('mousedown', down)
    window.addEventListener('scroll', down, true)
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('mousedown', down); window.removeEventListener('scroll', down, true) }
  }, [open])
}

/** 单元格提示：最大宽度 / 最多行数（长内容悬停显示，代替会占满窗口的原生 title） */
const TIP_W = 420
const TIP_LINES = 5
/**
 * 数据库结果表：表头点击排序（每张表各自的）、表内筛选、列宽拖动、超过 1000 行分批显示、输出被截断时提示；
 * 复制整表（制表符 / CSV / Markdown / INSERT）、导出 CSV；单击选中单元格后 Ctrl+C 复制，右键复制单元格 / 整行 / 本行 INSERT。
 * lead：每行最前面的操作列（会话页的「终止」）；rowClass：行底色；toolbar：false = 不要工具栏（小表）
 */
// fill：撑满父容器，工具栏固定、只有表格区域滚动（「查询」页签用）
export function ResultGrid({ table, kind, name, lead, rowAttr, rowClass, align, toolbar = true, extra, empty = tr('没有返回任何行'), fill = false }: {
  table: DbTable; kind?: DbKind; name?: string
  lead?: (r: string[]) => ReactNode; rowAttr?: (r: string[]) => Record<string, string>; rowClass?: (r: string[]) => string; align?: (col: number) => string
  toolbar?: boolean; extra?: ReactNode; empty?: string; fill?: boolean
}) {
  const [sort, setSort] = useState<Sort>(null)
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [w, setW] = useState<Record<number, number>>({})
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  // 单元格提示：不用原生 title（长文本会占满整个窗口），自己画一个定宽、最多 5 行的浮层
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const tipT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tipFor = (e: React.MouseEvent<HTMLTableCellElement>, v: string) => {
    clearTimeout(tipT.current)
    if (v.length <= 24 && !v.includes('\n')) return
    const r = e.currentTarget.getBoundingClientRect()
    tipT.current = setTimeout(() => {
      const x = Math.max(8, Math.min(r.left, window.innerWidth - TIP_W - 16))
      const below = r.bottom + 4
      setTip({ x, y: below + TIP_LINES * 18 + 12 < window.innerHeight ? below : Math.max(8, r.top - TIP_LINES * 18 - 16), text: v })
    }, 300)
  }
  const tipOff = () => { clearTimeout(tipT.current); setTip(null) }
  useEffect(() => {
    const off = () => { clearTimeout(tipT.current); setTip(null) }
    window.addEventListener('scroll', off, true)
    window.addEventListener('mousedown', off, true)
    return () => { clearTimeout(tipT.current); window.removeEventListener('scroll', off, true); window.removeEventListener('mousedown', off, true) }
  }, [])
  const [menu, setMenu] = useState<{ x: number; y: number; r: string[]; c: number } | null>(null)
  const [copyOpen, setCopyOpen] = useState<{ x: number; y: number } | null>(null)
  const [flash, setFlash] = useState('')
  const drag = useRef<{ col: number; x: number; w: number } | null>(null)
  useDismiss(!!menu, () => setMenu(null))
  useDismiss(!!copyOpen, () => setCopyOpen(null))

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return sortRows(q ? table.rows.filter((r) => r.some((v) => v.toLowerCase().includes(q))) : table.rows, sort)
  }, [table, filter, sort])
  useEffect(() => { setShown(PAGE); setSel(null) }, [table, filter])
  // 数字列右对齐（看前 200 行：非空值全是数字）
  const numCol = useMemo(() => table.columns.map((_c, k) => {
    const vs = table.rows.slice(0, 200).map((r) => r[k] ?? '').filter((v) => v && v !== 'NULL')
    return vs.length > 0 && vs.every((v) => /^-?\d+(\.\d+)?$/.test(v))
  }), [table])

  const note = (t: string) => { setFlash(t); setTimeout(() => setFlash((x) => (x === t ? '' : x)), 1800) }
  // done：复制成功后的提示（整句，如「已复制单元格」）
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => note(done), () => note(tr('复制失败')))
  const view = { columns: table.columns, rows }
  const copyAs = (fmt: DbCopyFormat) => { setCopyOpen(null); void copy(tableToText(view, fmt, { kind, table: name }), tr('已复制 {n} 行（{fmt}）', { n: rows.length, fmt: tr(COPY_FMT.find((f) => f[0] === fmt)?.[1] ?? '') })) }
  const exportCsv = async () => {
    const file = await client.system.saveTextFile(`${(name || 'result').replace(/[\\/:*?"<>|]+/g, '_')}.csv`, `\uFEFF${tableToText(view, 'csv')}`).catch(() => undefined)
    if (file) note(tr('已导出 {n} 行', { n: rows.length }))
  }
  const startDrag = (e: React.PointerEvent, col: number) => {
    e.preventDefault(); e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).parentElement!
    drag.current = { col, x: e.clientX, w: th.getBoundingClientRect().width }
    const move = (ev: PointerEvent) => { const d = drag.current; if (d) setW((m) => ({ ...m, [d.col]: Math.max(40, Math.round(d.w + ev.clientX - d.x)) })) }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!table.columns.length) return <Empty text={empty} />
  return (
    <div data-db-result className={fill ? 'flex h-full min-h-0 flex-col' : ''}>
      {toolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-1">
          <Input data-db-grid-filter size="sm" className="!h-6 w-[150px]" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={tr('在结果里筛选')} />
          <span data-db-count className={`text-[10.5px] ${MUTED}`}>{filter.trim() ? tr('筛出 {n} / {total} 行', { n: rows.length, total: table.rows.length }) : tr('{n} 行', { n: table.rows.length })}</span>
          {extra}
          {flash && <span className="text-[10.5px] text-[var(--color-success)]">{flash}</span>}
          <span className="ml-auto" />
          <button data-db-copy disabled={!rows.length} onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setCopyOpen(copyOpen ? null : { x: b.right, y: b.bottom + 2 }) }} onMouseDown={(e) => e.stopPropagation()}
            title={tr('复制当前显示的全部行（筛选后、按当前排序）')} className={`${BTN} text-[var(--color-text-secondary)]`}><Copy className="h-3 w-3" />{tr('复制')}<ChevronDown className="h-3 w-3" /></button>
          <button data-db-export disabled={!rows.length} onClick={() => void exportCsv()} title={tr('把当前显示的全部行导出成 CSV 文件（带 BOM，Excel 打开不乱码）')} className={`${BTN} text-[var(--color-text-secondary)]`}><Download className="h-3 w-3" />{tr('导出 CSV')}</button>
        </div>
      )}
      {table.truncated && <div data-db-truncated className="shrink-0 px-3 pb-1 text-[10.5px] text-[var(--color-warn)]">{table.rows.length
        ? tr('这一页数据太大（超过 6MB），只取回了前面一部分（{n} 行）。分页浏览时把每页行数调小；其它查询请加条件 / LIMIT，或在终端里导出。', { n: table.rows.length })
        : tr('这一页数据太大（超过 6MB），只取回了前面一部分。分页浏览时把每页行数调小；其它查询请加条件 / LIMIT，或在终端里导出。')}</div>}
      <div data-db-grid-scroll className={fill ? 'min-h-0 flex-1 overflow-auto' : ''}>
      <table data-db-grid tabIndex={0} className="w-full border-collapse text-[11px] outline-none"
        onKeyDown={(e) => { if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { e.preventDefault(); void copy(rows[sel.r]?.[sel.c] ?? '', tr('已复制单元格')) } }}>
        <thead><tr>
          {lead && <th className={`${TH} cursor-default`} />}
          {table.columns.map((c, i) => (
            <th key={i} data-db-th={c} className={`${TH} relative ${!align && numCol[i] ? '!text-right' : ''}`} style={w[i] ? { width: w[i], minWidth: w[i], maxWidth: w[i] } : undefined}
              onClick={() => setSort(sort?.col === i ? (sort.desc ? { col: i, desc: false } : null) : { col: i, desc: true })}>
              <div className="truncate pr-1">{c}{sort?.col === i && (sort.desc ? <ArrowDown className="ml-0.5 inline h-3 w-3" /> : <ArrowUp className="ml-0.5 inline h-3 w-3" />)}</div>
              <span data-db-resize={i} onPointerDown={(e) => startDrag(e, i)} onClick={(e) => e.stopPropagation()} title={tr('拖动调整列宽')}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--color-accent)]" />
            </th>
          ))}
        </tr></thead>
        <tbody>
          {rows.slice(0, shown).map((r, i) => (
            <tr key={i} {...rowAttr?.(r)} className={`hover:bg-[var(--color-bg-hover)] ${rowClass?.(r) ?? ''}`}>
              {lead && <td className="border-b border-[var(--color-border-subtle)] py-0.5 pl-2 pr-0.5">{lead(r)}</td>}
              {table.columns.map((_c, k) => {
                const v = r[k] ?? ''
                const on = sel?.r === i && sel.c === k
                return (
                  <td key={k} data-cell={v} onMouseEnter={(e) => tipFor(e, v)} onMouseLeave={tipOff} onClick={() => { tipOff(); setSel({ r: i, c: k }) }} onContextMenu={(e) => { e.preventDefault(); tipOff(); setSel({ r: i, c: k }); setMenu({ x: e.clientX, y: e.clientY, r, c: k }) }}
                    className={`${TD} ${align?.(k) ?? (numCol[k] ? 'text-right' : '')} text-[var(--color-text-primary)] ${on ? 'outline outline-1 -outline-offset-1 outline-[var(--color-accent)]' : ''}`}>
                    <div className="truncate" style={w[k] ? { maxWidth: w[k] - 12 } : { maxWidth: 260 }}>{v}</div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty text={filter.trim() ? tr('没有包含「{q}」的行', { q: filter.trim() }) : empty} />}
      {rows.length > shown && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[10.5px]">
          <span className={MUTED}>{tr('显示了前 {shown} 行，共 {n} 行', { shown, n: rows.length })}</span>
          <button data-db-more onClick={() => setShown((n) => n + PAGE)} className={`${BTN} text-[var(--color-accent)]`}>{tr('再显示 {n} 行', { n: Math.min(PAGE, rows.length - shown) })}</button>
          <button onClick={() => setShown(rows.length)} className={`${BTN} text-[var(--color-text-secondary)]`}>{tr('全部显示')}</button>
        </div>
      )}
      </div>
      {tip && createPortal(
        <div data-db-celltip style={{ left: tip.x, top: tip.y, width: TIP_W }} className="pointer-events-none fixed z-[95] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-[var(--color-text-primary)] shadow-lg">
          <div className="line-clamp-5 whitespace-pre-wrap break-all">{tip.text}</div>
        </div>, document.body)}
      {/* 菜单挂到 body：抽屉有 transform，里面的 fixed 会按抽屉定位、跑到屏幕外 */}
      {menu && createPortal(
        <div data-db-cellmenu onMouseDown={(e) => e.stopPropagation()} style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 130) }}
          className="fixed z-[90] w-48 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 shadow-lg">
          <button className={ITEM} onClick={() => { setMenu(null); void copy(menu.r[menu.c] ?? '', tr('已复制单元格')) }}>{tr('复制单元格')}</button>
          <button className={ITEM} onClick={() => { setMenu(null); void copy(menu.r.join('\t'), tr('已复制整行')) }}>{tr('复制整行（制表符分隔）')}</button>
          <button className={ITEM} onClick={() => { setMenu(null); void copy(tableToText({ columns: table.columns, rows: [menu.r] }, 'insert', { kind, table: name }), tr('已复制 INSERT 语句')) }}>{tr('复制本行为 INSERT')}</button>
          <button className={ITEM} onClick={() => { setMenu(null); void copy(table.columns[menu.c] ?? '', tr('已复制列名')) }}>{tr('复制列名')}</button>
        </div>, document.body,
      )}
      {copyOpen && createPortal(
        <div data-db-copymenu onMouseDown={(e) => e.stopPropagation()} style={{ left: Math.max(8, copyOpen.x - 190), top: copyOpen.y }}
          className="fixed z-[90] w-[190px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 shadow-lg">
          {COPY_FMT.map(([f, label]) => <button key={f} data-db-copy-as={f} className={ITEM} onClick={() => copyAs(f)}>{tr(label)}</button>)}
        </div>, document.body,
      )}
    </div>
  )
}

export function Empty({ text, icon }: { text: string; icon?: ReactNode }) {
  return <div data-db-empty className={`flex items-center gap-1.5 px-3 py-3 text-[11.5px] ${MUTED}`}>{icon ?? <SearchX className="h-3.5 w-3.5 shrink-0" />}{text}</div>
}
