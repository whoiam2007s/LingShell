import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Braces, ChevronDown, ChevronRight, Columns3, Copy, MessageSquareQuote, Table2, X } from 'lucide-react'
import {
  analyzeOutput, cellNumber, filterRows, isDurationColumn, jsonPath, jsonSearch, redactSecrets, sortRows, tableQuote, toCsv, toMarkdown,
  tr, tk, type OutTable, type TableMode,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { cn } from '../../lib/cn.js'
import { uiLayerBusy } from '../../components/ui/layer.js'
import { trx } from '../../lib/trx.js'

// 命令输出 → 表格 / JSON 树的查看弹窗（解析见 shared/terminal/outputTable.ts）。入口：终端命令红点菜单「表格查看」、命令块右上角的「⊞ 表格」。
// 弹窗只能点 × / 按 Esc 关，不点遮罩关
export interface TableSource { title: string; command: string; output: string }
const EVT = 'lingshell:table-view'
export function openTableView(src: TableSource) { window.dispatchEvent(new CustomEvent<TableSource>(EVT, { detail: src })) }

export function TableViewerHost() {
  const [src, setSrc] = useState<TableSource | null>(null)
  useEffect(() => {
    const f = (e: Event) => setSrc((e as CustomEvent<TableSource>).detail)
    window.addEventListener(EVT, f)
    return () => window.removeEventListener(EVT, f)
  }, [])
  return src ? <TableDialog key={`${src.command}\n${src.output.length}`} src={src} onClose={() => setSrc(null)} /> : null
}

const BTN = 'flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const MAX_SHOWN = 2000
const MODES: { value: TableMode; label: string }[] = [{ value: 'auto', label: tk('自动识别') }, { value: 'whitespace', label: tk('按空白分隔') }, { value: 'fixed', label: tk('按固定宽度') }]

function TableDialog({ src, onClose }: { src: TableSource; onClose: () => void }) {
  const [mode, setMode] = useState<TableMode>('auto')
  const view = useMemo(() => analyzeOutput(src.output, src.command, mode), [src, mode])
  const [jsonAs, setJsonAs] = useState<'tree' | 'table'>('tree')
  const [note, setNote] = useState('')
  const popOpen = useRef(false)   // 列显隐面板开着时 Esc 先关它
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !popOpen.current && !uiLayerBusy()) { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote((n) => (n === t ? '' : n)), 2000) }
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => flash(tr('已复制 {what}', { what })), () => flash(tr('复制失败')))
  const ask = async (text: string) => {
    const s = await client.settings.get().catch(() => undefined)
    quoteToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
    onClose()
  }
  const isJson = view.kind === 'json'
  const table: OutTable | undefined = view.kind === 'table' ? view.table : view.kind === 'json' && jsonAs === 'table' ? view.table : undefined

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div data-table-dialog className="flex h-[82vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          {isJson ? <Braces className="h-4 w-4 shrink-0 text-[var(--color-accent)]" /> : <Table2 className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />}
          <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-primary)]">{isJson ? tr('JSON 查看') : tr('表格查看')}</span>
          <code className="min-w-0 truncate font-mono text-[11.5px] text-[var(--color-text-muted)]" title={src.command}>{src.title} · {src.command || tr('（未取到命令行）')}</code>
          {note && <span className="shrink-0 text-[11.5px] text-[var(--color-success)]">{note}</span>}
          <button title={tr('关闭（Esc）')} onClick={onClose} className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        {view.kind === 'empty' && <div className="p-6 text-[12.5px] text-[var(--color-text-muted)]">{tr('这条命令没有输出（或输出已滚出终端缓冲）。')}</div>}
        {/* JSON 是对象数组时可切到表格看 */}
        {view.kind === 'json' && view.table && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-4 py-1.5 text-[11.5px]">
            <span className="text-[var(--color-text-muted)]">{tr('显示为')}</span>
            <button onClick={() => setJsonAs('tree')} className={cn(BTN, jsonAs === 'tree' && 'border-[var(--color-accent)] text-[var(--color-accent)]')}>{tr('树')}</button>
            <button onClick={() => setJsonAs('table')} className={cn(BTN, jsonAs === 'table' && 'border-[var(--color-accent)] text-[var(--color-accent)]')}>{tr('表格')}</button>
          </div>
        )}
        {view.kind === 'json' && jsonAs === 'tree' && (
          <JsonView value={view.value} onCopy={copy}
            onAsk={() => { const t = JSON.stringify(view.value, null, 2); void ask(tr('终端「{title}」里命令 `{cmd}` 输出的 JSON：', { title: src.title, cmd: src.command.slice(0, 300) }) + `\n\`\`\`json\n${t.length > 12000 ? `${t.slice(0, 12000)}\n${tr('…（后面省略 {n} 字）', { n: t.length - 12000 })}` : t}\n\`\`\`\n`) }} />
        )}
        {table && (
          <TableView key={`${mode}|${jsonAs}`} table={table} popOpen={popOpen} onCopy={copy}
            modePicker={view.kind === 'table' ? (
              <Select size="sm" title={tr('切法：认不准时手动改')} value={mode} onValueChange={(v) => setMode(v as TableMode)} className="h-7 w-[118px] shrink-0 text-[11.5px]"
                options={MODES.map((m) => ({ value: m.value, label: tr(m.label) }))} />
            ) : null}
            onAsk={(cols, rows, total) => void ask(tableQuote({ title: src.title, command: src.command, columns: cols, rows, total }))} />
        )}
      </div>
    </div>
  )
}

function TableView({ table, popOpen, onCopy, onAsk, modePicker }: {
  table: OutTable
  popOpen: React.MutableRefObject<boolean>
  onCopy: (text: string, what: string) => void
  onAsk: (columns: string[], rows: string[][], total: number) => void
  modePicker: React.ReactNode
}) {
  const n = table.columns.length
  const [q, setQ] = useState('')
  const [colQ, setColQ] = useState<Record<number, string>>({})
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [colsOpen, setColsOpen] = useState(false)
  popOpen.current = colsOpen
  const colsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!colsOpen) return
    const onDown = (e: MouseEvent) => { if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setColsOpen(false) } }
    document.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); popOpen.current = false }
  }, [colsOpen, popOpen])

  const order = useMemo(() => (sort ? sortRows(table.rows, sort.col, sort.desc) : table.rows.map((_, i) => i)), [table, sort])
  const shownIdx = useMemo(() => filterRows(table.rows, order, q, colQ), [table, order, q, colQ])
  const visCols = useMemo(() => table.columns.map((_, i) => i).filter((i) => !hidden.has(i)), [table, hidden])
  // 数值列（大多能认成数字 / 大小）右对齐
  const numeric = useMemo(() => table.columns.map((_, c) => {
    const vals = table.rows.map((r) => r[c] ?? '').filter((v) => v.trim())
    const dur = isDurationColumn(vals)
    return vals.length > 0 && vals.filter((v) => cellNumber(v, dur) !== undefined).length / vals.length >= 0.8
  }), [table])
  const clickHead = (c: number) => setSort((s) => (!s || s.col !== c ? { col: c, desc: numeric[c] } : s.desc === numeric[c] ? { col: c, desc: !s.desc } : null))
  const exportRows = () => shownIdx.map((i) => visCols.map((c) => table.rows[i][c] ?? ''))
  const exportCols = () => visCols.map((c) => table.columns[c] || tr('列{n}', { n: c + 1 }))
  const filtered = !!q.trim() || Object.values(colQ).some((v) => v.trim())

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-4 py-1.5">
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索全部列')} className="w-56" data-table-search />
        {modePicker}
        <div ref={colsRef} className="relative">
          <button onClick={() => setColsOpen((o) => !o)} className={BTN} title={tr('显示 / 隐藏列')}><Columns3 className="h-3.5 w-3.5" />{tr('列（{shown}/{n}）', { shown: visCols.length, n })}</button>
          {colsOpen && (
            <div className="absolute left-0 top-8 z-10 max-h-72 w-56 overflow-y-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] p-1.5 text-[12px] shadow-lg">
              {table.columns.map((name, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-bg-hover)]">
                  <Checkbox checked={!hidden.has(i)} disabled={!hidden.has(i) && visCols.length === 1}
                    onCheckedChange={(v) => setHidden((h) => { const x = new Set(h); if (v) x.delete(i); else x.add(i); return x })} />
                  <span className="truncate font-mono">{name || tr('列{n}', { n: i + 1 })}</span>
                </label>
              ))}
              <button onClick={() => setHidden(new Set())} className="mt-1 w-full rounded px-1.5 py-1 text-left text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">{tr('全部显示')}</button>
            </div>
          )}
        </div>
        {(filtered || sort) && <button className={BTN} onClick={() => { setQ(''); setColQ({}); setSort(null) }}>{tr('清除排序和过滤')}</button>}
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('{n} 行', { n: filtered ? `${shownIdx.length} / ${table.rows.length}` : table.rows.length })}{table.header ? '' : tr(' · 没认出表头')}</span>
        <button className={BTN} title={tr('复制当前显示的行和列（CSV）')} onClick={() => onCopy(toCsv(exportCols(), exportRows()), 'CSV')}><Copy className="h-3.5 w-3.5" />{tr('复制 CSV')}</button>
        <button className={BTN} title={tr('复制当前显示的行和列（Markdown 表格）')} onClick={() => onCopy(toMarkdown(exportCols(), exportRows()), 'Markdown')}><Copy className="h-3.5 w-3.5" />{tr('复制 Markdown')}</button>
        <button className={cn(BTN, 'text-[var(--color-accent)]')} title={tr('把当前显示的表格（Markdown）放进对话输入框（按设置脱敏，不自动发送）')} onClick={() => onAsk(exportCols(), exportRows(), table.rows.length)}><MessageSquareQuote className="h-3.5 w-3.5" />{tr('问 AI')}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse font-mono text-[11.5px]">
          <thead className="sticky top-0 z-[1] bg-[var(--color-bg-panel)]">
            <tr>
              {visCols.map((c) => (
                <th key={c} className="border-b border-[var(--color-border-subtle)] px-2 pb-0.5 pt-1.5 text-left font-semibold text-[var(--color-text-secondary)]">
                  <button onClick={() => clickHead(c)} title={tr('点击排序（再点反向，第三次取消）')} data-col={table.columns[c]}
                    className={cn('flex w-full items-center gap-0.5 whitespace-nowrap hover:text-[var(--color-accent)]', numeric[c] && 'justify-end', sort?.col === c && 'text-[var(--color-accent)]')}>
                    {table.columns[c] || <span className="italic text-[var(--color-text-muted)]">{tr('列{n}', { n: c + 1 })}</span>}
                    {sort?.col === c && (sort.desc ? <ArrowDown className="h-3 w-3 shrink-0" /> : <ArrowUp className="h-3 w-3 shrink-0" />)}
                  </button>
                </th>
              ))}
              {/* 末尾占位列吃掉多余宽度：各列按内容宽度排，不被拉散 */}
              <th className="w-full border-b border-[var(--color-border-subtle)]" />
            </tr>
            <tr>
              {visCols.map((c) => (
                <th key={c} className="border-b border-[var(--color-border-default)] px-1.5 pb-1.5 font-normal">
                  <Input size="sm" value={colQ[c] ?? ''} onChange={(e) => setColQ((x) => ({ ...x, [c]: e.target.value }))} placeholder={tr('过滤')} className="h-6 min-w-[72px] px-1.5 text-[11px]" />
                </th>
              ))}
              <th className="border-b border-[var(--color-border-default)]" />
            </tr>
          </thead>
          <tbody>
            {shownIdx.slice(0, MAX_SHOWN).map((i) => (
              <tr key={i} className="hover:bg-[var(--color-bg-hover)]">
                {visCols.map((c) => {
                  const v = table.rows[i][c] ?? ''
                  return <td key={c} title={v.length > 60 ? v : undefined} className={cn('max-w-[480px] truncate whitespace-pre border-b border-[var(--color-border-subtle)] px-2 py-[3px] text-[var(--color-text-primary)]', numeric[c] && 'text-right')}>{v}</td>
                })}
                <td className="border-b border-[var(--color-border-subtle)]" />
              </tr>
            ))}
          </tbody>
        </table>
        {shownIdx.length === 0 && <div className="px-4 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('没有匹配的行')}</div>}
        {shownIdx.length > MAX_SHOWN && <div className="px-4 py-2 text-[11.5px] text-[var(--color-text-muted)]">{tr('只显示前 {max} 行；复制 / 问 AI 包含全部 {n} 行。', { max: MAX_SHOWN, n: shownIdx.length })}</div>}
      </div>
    </>
  )
}

// ── JSON 树 ──
type Path = (string | number)[]
const isObj = (v: unknown): v is object => v !== null && typeof v === 'object'
const countNodes = (v: unknown, cap = 400): number => { let n = 0; const w = (x: unknown) => { if (n > cap) return; n++; if (isObj(x)) for (const y of Object.values(x)) w(y) }; w(v); return n }

function JsonView({ value, onCopy, onAsk }: { value: unknown; onCopy: (t: string, what: string) => void; onAsk: () => void }) {
  const [q, setQ] = useState('')
  const small = useMemo(() => countNodes(value) <= 400, [value])
  // 默认：节点不多全展开，多的话只展开前两层；记的是「跟默认相反」的路径
  const [flip, setFlip] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<Path>([])
  const found = useMemo(() => jsonSearch(value, q), [value, q])
  const searching = !!q.trim()
  const isOpen = (p: Path) => searching ? found.keep.has(jsonPath(p)) : (small || p.length < 2) !== flip.has(jsonPath(p))
  const toggle = (p: Path) => setFlip((f) => { const k = jsonPath(p), x = new Set(f); if (x.has(k)) x.delete(k); else x.add(k); return x })
  const selValue = useMemo(() => sel.reduce<unknown>((v, k) => (isObj(v) ? (v as Record<string | number, unknown>)[k] : undefined), value), [sel, value])

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-4 py-1.5">
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索键名 / 值')} className="w-56" data-json-search />
        {searching && <span className="text-[11px] text-[var(--color-text-muted)]">{tr('{n} 处命中', { n: found.hits })}</span>}
        <span className="ml-auto" />
        <button className={BTN} onClick={() => setFlip(new Set())}>{tr('恢复默认展开')}</button>
        <button className={BTN} onClick={() => onCopy(JSON.stringify(value, null, 2), 'JSON')}><Copy className="h-3.5 w-3.5" />{tr('复制 JSON')}</button>
        <button className={cn(BTN, 'text-[var(--color-accent)]')} title={tr('把 JSON 放进对话输入框（按设置脱敏，不自动发送）')} onClick={onAsk}><MessageSquareQuote className="h-3.5 w-3.5" />{tr('问 AI')}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.6]">
        <JsonNode name={undefined} value={value} path={[]} isOpen={isOpen} toggle={toggle} sel={sel} onSel={setSel} keep={searching ? found.keep : undefined} q={q.trim().toLowerCase()} />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 text-[11.5px]">
        <span className="text-[var(--color-text-muted)]">{tr('路径')}</span>
        <code data-json-path className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{jsonPath(sel)}</code>
        <button className={BTN} onClick={() => onCopy(jsonPath(sel), tr('路径'))}><Copy className="h-3.5 w-3.5" />{tr('复制路径')}</button>
        <button className={BTN} onClick={() => onCopy(typeof selValue === 'string' ? selValue : JSON.stringify(selValue, null, 2) ?? '', tr('值'))}><Copy className="h-3.5 w-3.5" />{tr('复制值')}</button>
        <span className="ml-auto text-[var(--color-text-muted)]">{trx('点节点选中；路径是 jq 写法，可直接用于 {code}', { code: <code className="font-mono">jq &apos;{jsonPath(sel)}&apos;</code> })}</span>
      </div>
    </>
  )
}

function JsonNode({ name, value, path, isOpen, toggle, sel, onSel, keep, q }: {
  name: string | number | undefined; value: unknown; path: Path; isOpen: (p: Path) => boolean; toggle: (p: Path) => void
  sel: Path; onSel: (p: Path) => void; keep?: Set<string>; q: string
}) {
  const key = jsonPath(path)
  if (keep && !keep.has(key)) return null
  const obj = isObj(value), arr = Array.isArray(value)
  const open = obj && isOpen(path)
  const entries: [string | number, unknown][] = obj ? (arr ? (value as unknown[]).map((x, i) => [i, x]) : Object.entries(value)) : []
  const selected = jsonPath(sel) === key
  const hit = (s: string) => !!q && s.toLowerCase().includes(q)
  return (
    <div>
      <div onClick={() => { onSel(path); if (obj) toggle(path) }} style={{ paddingLeft: path.length * 14 }}
        className={cn('group flex cursor-default items-center gap-1 rounded px-1 hover:bg-[var(--color-bg-hover)]', selected && 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]')}>
        <span className="flex w-3 shrink-0 justify-center text-[var(--color-text-muted)]">{obj ? (open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : null}</span>
        {name !== undefined && <span className={cn(typeof name === 'number' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-accent)]', typeof name === 'string' && hit(name) && 'rounded bg-[color:color-mix(in_srgb,var(--color-warn)_35%,transparent)]')}>{typeof name === 'number' ? name : JSON.stringify(name)}</span>}
        {name !== undefined && <span className="text-[var(--color-text-muted)]">:</span>}
        {obj
          ? <span className="text-[var(--color-text-muted)]">{arr ? '[' : '{'}{open ? '' : `…${arr ? ']' : '}'} ${tr('{n} 项', { n: entries.length })}`}</span>
          : <span className={cn('min-w-0 truncate', valueCls(value), hit(String(value)) && 'rounded bg-[color:color-mix(in_srgb,var(--color-warn)_35%,transparent)]')}>{JSON.stringify(value)}</span>}
      </div>
      {open && <>
        {entries.map(([k, v]) => <JsonNode key={String(k)} name={k} value={v} path={[...path, k]} isOpen={isOpen} toggle={toggle} sel={sel} onSel={onSel} keep={keep} q={q} />)}
        <div style={{ paddingLeft: path.length * 14 + 20 }} className="text-[var(--color-text-muted)]">{arr ? ']' : '}'}</div>
      </>}
    </div>
  )
}
const valueCls = (v: unknown) => (typeof v === 'string' ? 'text-[var(--color-success)]' : typeof v === 'number' ? 'text-sky-400' : 'text-purple-400')
