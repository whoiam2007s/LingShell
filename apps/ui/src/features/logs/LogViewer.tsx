import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as RMouseEvent } from 'react'
import { ArrowDownToLine, BarChart3, Copy, Download, Eraser, Maximize2, Minimize2, Minus, MessageSquareQuote, Pause, Play, Plus, RotateCw, ScrollText, X, Layers } from 'lucide-react'
import {
  LOG_COMMON_PATHS, LogInsight, fmtLogClock, tr, dateLocale, logSourceLabel, logSupported, redactSecrets, mergeSearchResults, LOG_SEARCH_RAW_MAX,
  type LogSource, type TerminalInfo, type MultiLogTarget, type LogSearchQuery, type LogSearchHostResult, type MultiLogHostState,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { Select } from '../../components/ui/Select.js'
import { themeOf, useTermPrefs } from '../../lib/termPrefs.js'
import {
  DEFAULT_MAX_LINES, MAX_LINES_CHOICES, appendLines, bufferPaused, insightFilter, syncInsight, compileColorRules, compileFilter, countMatches, logQuote, pickRange, segments, visibleLines, withHost, type LogLine, type LogIn,
} from './logView.js'
import { LogInsightPanel, type TimeRange } from './LogInsightPanel.js'
import { trx } from '../../lib/trx.js'

// 日志查看器（tail -F / journalctl -f）：终端区底部的面板，可开多个日志标签。
// 入口：终端工具栏「日志」按钮、资源管理器远程文件右键「实时查看（tail -f）」。主进程见 desktop/main/ops/logTail.ts
// 多主机标签（multi）：实时合流（desktop/main/ops/logMulti.ts，按时间归并）/ 历史检索（每台一次，界面按时间归并），每行前标主机
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IB = 'flex h-6 shrink-0 items-center justify-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40 disabled:hover:bg-transparent'
const ON = 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'
const ROW_H = 18
// 主机前缀的颜色：取终端配色主题的 12 种彩色（深浅主题都可读）
const HOST_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'brightCyan', 'brightGreen', 'brightYellow', 'brightMagenta', 'brightBlue', 'brightRed'] as const

// ── 面板状态（工具栏按钮与面板共用，资源管理器也能直接打开）──
export interface MultiLogSpec { mode: 'follow' | 'search'; hosts: MultiLogTarget[]; query?: Omit<LogSearchQuery, 'src'> }
export interface LogTabSpec { key: string; terminalId: string; src: LogSource; multi?: MultiLogSpec }
let state: { tabs: LogTabSpec[]; active?: string; shown: boolean } = { tabs: [], shown: false }
const subs = new Set<() => void>()
const set = (p: Partial<typeof state>) => { state = { ...state, ...p }; subs.forEach((f) => f()) }
const useLogState = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => state)
let seq = 0
export function openLogViewer(terminalId: string, src: LogSource) {
  const key = `log-${++seq}`
  set({ tabs: [...state.tabs, { key, terminalId, src }], active: key, shown: true })
}
/** 多主机日志标签（实时合流 / 历史检索） */
export function openMultiLog(src: LogSource, multi: MultiLogSpec) {
  const key = `log-${++seq}`
  set({ tabs: [...state.tabs, { key, terminalId: '', src, multi }], active: key, shown: true })
}
const multiTitle = (m: MultiLogSpec) => (m.mode === 'search' ? tr('{n} 台主机 · 检索', { n: m.hosts.length }) : tr('{n} 台主机 · 合流', { n: m.hosts.length }))
const closeTab = (key: string) => {
  const tabs = state.tabs.filter((t) => t.key !== key)
  set({ tabs, active: state.active === key ? tabs.at(-1)?.key : state.active, shown: state.shown && tabs.length > 0 })
}

// 终端工具栏按钮：点开选日志来源；已有日志标签时多一项「显示日志面板」
export function LogButton({ term }: { term?: TerminalInfo }) {
  const s = useLogState()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  if (!term || !logSupported(term.type, term.os)) return null
  return (
    <div ref={ref} className="relative shrink-0">
      <button title={tr('日志：实时查看服务器日志（tail -F / journalctl -f）')} onClick={() => setOpen((o) => !o)}
        className="relative flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
        <ScrollText className="h-3.5 w-3.5" />
        {s.tabs.length > 0 && !s.shown && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-[var(--color-accent)] px-1 text-[9px] leading-[12px] text-[var(--color-bg-base)]">{s.tabs.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-30 w-72 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-2 text-[12px] shadow-lg">
          {s.tabs.length > 0 && !s.shown && (
            <button onClick={() => { set({ shown: true }); setOpen(false) }} className="mb-1.5 w-full rounded border border-[var(--color-border-default)] px-2 py-1 text-left text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">{tr('显示日志面板（{n} 个日志）', { n: s.tabs.length })}</button>
          )}
          <SourcePicker onPick={(src) => { openLogViewer(term.id, src); setOpen(false) }} />
          <button onClick={() => { paletteSend({ type: 'multiLog' }); setOpen(false) }}
            className="mt-2 flex w-full items-center gap-1.5 rounded border border-[var(--color-border-default)] px-2 py-1 text-left text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
            <Layers className="h-3.5 w-3.5" />{tr('多主机日志 / 历史检索…')}
          </button>
        </div>
      )}
    </div>
  )
}

// 选日志来源：输入路径 / 常用路径 / journalctl（可填单元名）
function SourcePicker({ onPick }: { onPick: (src: LogSource) => void }) {
  const [path, setPath] = useState('')
  const [unit, setUnit] = useState('')
  const inp = 'min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 font-mono text-[11.5px] outline-none focus:border-[var(--color-accent)]'
  const btn = 'shrink-0 rounded bg-[var(--color-accent)] px-2 py-1 text-[11.5px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
  return (
    <div className="space-y-2">
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (path.trim()) onPick({ kind: 'file', path: path.trim() }) }}>
        <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder={tr('日志文件路径，如 /var/log/app.log')} className={inp} />
        <button type="submit" disabled={!path.trim()} className={btn}>{tr('打开')}</button>
      </form>
      <div>
        <div className="pb-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('常用路径')}</div>
        {LOG_COMMON_PATHS.map((p) => (
          <button key={p} onClick={() => onPick({ kind: 'file', path: p })} className="block w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[11.5px] hover:bg-[var(--color-bg-hover)]">{p}</button>
        ))}
      </div>
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); onPick(unit.trim() ? { kind: 'journal', unit: unit.trim() } : { kind: 'journal' }) }}>
        <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={tr('单元名（可空），如 nginx')} className={inp} />
        <button type="submit" className={btn} title={tr('journalctl -f -n 500 [-u 单元]')}>journalctl -f</button>
      </form>
    </div>
  )
}

// 面板：挂在 TerminalView 里，覆盖终端区下部；收起不停止（标签继续跟踪），关闭 = 关掉全部日志
export function LogViewerHost({ terms }: { terms: TerminalInfo[] }) {
  const s = useLogState()
  const [max, setMax] = useState(false)
  const [adding, setAdding] = useState(false)
  // 「再开一个日志」小框：点外面 / Esc 收起
  const addRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!adding) return
    const onDown = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAdding(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(false) } }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [adding])
  if (!s.tabs.length) return null
  const termTitle = (id: string) => terms.find((t) => t.id === id)?.title ?? tr('已关闭的终端')
  const title = (t: LogTabSpec) => (t.multi ? multiTitle(t.multi) : termTitle(t.terminalId))
  const cur = s.tabs.find((t) => t.key === s.active)
  return (
    <div className={`absolute inset-x-0 bottom-0 z-30 flex flex-col border-t border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl ${max ? 'top-9' : 'h-[60%]'} ${s.shown ? '' : 'hidden'}`}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-1.5">
        <ScrollText className="mx-1 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {s.tabs.map((t) => (
            <div key={t.key} onClick={() => set({ active: t.key })} title={`${t.multi ? t.multi.hosts.map((h) => h.label).join(tr('、')) : title(t)}\n${logSourceLabel(t.src)}`}
              className={`flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11.5px] ${t.key === s.active ? ON : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
              {t.multi && <Layers className="h-3 w-3 shrink-0" />}
              <span className="max-w-[220px] truncate font-mono">{logSourceLabel(t.src).split('/').pop()}</span>
              <span className="max-w-[120px] truncate text-[10px] opacity-70">{title(t)}</span>
              <button title={tr('关闭此日志')} onClick={(e) => { e.stopPropagation(); closeTab(t.key) }} className="hover:text-[var(--color-danger)]"><X className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
        <div ref={addRef} className="relative shrink-0">
          <button title={tr('再开一个日志（同一终端）')} disabled={!cur || !!cur.multi} onClick={() => setAdding((a) => !a)} className={IB}><Plus className="h-3.5 w-3.5" /></button>
          {adding && cur && (
            <div className="absolute right-0 top-7 z-40 w-72 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-2 text-[12px] shadow-lg">
              <SourcePicker onPick={(src) => { openLogViewer(cur.terminalId, src); setAdding(false) }} />
            </div>
          )}
        </div>
        <button title={max ? tr('还原高度') : tr('最大化')} onClick={() => setMax((m) => !m)} className={IB}>{max ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
        <button title={tr('收起（日志继续跟踪，点工具栏「日志」按钮再显示）')} onClick={() => set({ shown: false })} className={IB}><Minus className="h-3.5 w-3.5" /></button>
        <button title={tr('关闭全部日志')} onClick={() => set({ tabs: [], active: undefined, shown: false })} className={`${IB} hover:text-[var(--color-danger)]`}><X className="h-3.5 w-3.5" /></button>
      </div>
      {s.tabs.map((t) => <LogTab key={t.key} spec={t} host={t.multi ? t.multi.hosts.map((h) => h.label).join(tr('、')) : title(t)} hidden={t.key !== s.active} />)}
    </div>
  )
}

function LogTab({ spec, host, hidden }: { spec: LogTabSpec; host: string; hidden: boolean }) {
  const prefs = useTermPrefs()
  const theme = themeOf(prefs.theme)
  const colors = useMemo(() => (prefs.highlight ? compileColorRules(prefs.highlightRules) : []), [prefs.highlight, prefs.highlightRules])
  const [buf, setBuf] = useState<{ lines: LogLine[]; next: number }>({ lines: [], next: 0 })
  const [maxLines, setMaxLines] = useState(DEFAULT_MAX_LINES)
  const [paused, setPaused] = useState(false)
  const [pend, setPend] = useState({ lines: [] as LogIn[], dropped: 0 })
  const [dropped, setDropped] = useState(0)   // 主进程缓冲 / 暂停缓冲超上限丢掉的
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [cs, setCs] = useState(false)
  const [onlyMatch, setOnlyMatch] = useState(true)
  const [auto, setAuto] = useState(true)
  const [ended, setEnded] = useState<string>()
  const [run, setRun] = useState(0)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number>()
  const [note, setNote] = useState('')
  const pausedRef = useRef(paused); pausedRef.current = paused
  const maxRef = useRef(maxLines); maxRef.current = maxLines
  // 多主机：各台标签、各台状态（实时：通道是否结束；检索：行数 / 出错 / 说明）、勾掉不看的主机
  const multi = spec.multi
  const hostLabels = useMemo(() => multi?.hosts.map((h) => h.label), [multi])
  const [hostInfo, setHostInfo] = useState<{ error?: string; note?: string }[]>([])
  const [hiddenHosts, setHiddenHosts] = useState<Set<number>>(new Set())
  const [done, setDone] = useState<string>()

  // 开通道 + 每 300ms 取一次新行；卸载（关标签 / 关面板）即关通道
  useEffect(() => {
    let alive = true, id: string | undefined, timer: ReturnType<typeof setTimeout> | undefined
    setEnded(undefined); setDone(undefined)
    const ingest = (r: { lines: LogIn[]; dropped: number }) => {
      if (r.dropped) setDropped((d) => d + r.dropped)
      if (!r.lines.length) return
      if (pausedRef.current) setPend((p) => bufferPaused(p, r.lines))
      else setBuf((b) => appendLines(b.lines, r.lines, maxRef.current, b.next))
    }
    if (multi?.mode === 'search') {
      // 历史检索：每台一次，全部回来后按时间归并
      setBuf((b) => ({ lines: [], next: b.next })); setHostInfo([])
      const empty: LogSearchHostResult = { lines: [], times: [], files: [], notes: [], rawCapped: false, capped: 0 }
      void Promise.all(multi.hosts.map((h) => client.logMulti.search(h.target, { ...multi.query, src: spec.src }).catch((e): LogSearchHostResult & { error?: string } => ({ ...empty, error: errText(e) }))))
        .then((rs) => {
          if (!alive) return
          const items = mergeSearchResults(rs)
          ingest({ lines: items, dropped: 0 })
          setHostInfo(rs.map((r) => r.error ? { error: r.error } : {
            note: [tr('line|{n} 行', { n: r.lines.length }), r.capped ? tr('只显示最新 {n} 行（另有 {m} 行更早的）', { n: r.lines.length, m: r.capped }) : '', r.rawCapped ? tr('原始匹配超过 {n} 行，更早的可能没包含', { n: LOG_SEARCH_RAW_MAX }) : '',
              r.files.length ? tr('检索了 {n} 个文件：{files}', { n: r.files.length, files: r.files.map((f) => f.split('/').pop()).join(tr('、')) }) : '', ...r.notes].filter(Boolean).join(tr('；')),
          }))
          const nFail = rs.filter((r) => r.error).length
          setDone(nFail ? tr('检索完成：共 {n} 行，{m} 台失败', { n: items.length.toLocaleString(dateLocale()), m: nFail }) : tr('检索完成：共 {n} 行', { n: items.length.toLocaleString(dateLocale()) }))
        })
      return () => { alive = false }
    }
    if (multi) {
      const tickM = async () => {
        try {
          const r = await client.logMulti.poll(id!)
          if (!alive) return
          ingest({ lines: r.items, dropped: r.dropped })
          setHostInfo(r.hosts.map((h: MultiLogHostState) => (h.ended?.error ? { error: h.ended.error } : h.ended ? { note: tr('已结束') } : {})))
          if (r.ended) { setEnded(tr('已停止：各台的日志通道都已结束')); id = undefined; return }
        } catch { /* 应用锁定等：下次再取 */ }
        if (alive) timer = setTimeout(tickM, 300)
      }
      client.logMulti.start(multi.hosts, spec.src).then((x) => {
        if (!alive) { void client.logMulti.stop(x).catch(() => {}); return }
        id = x; void tickM()
      }).catch((e) => { if (alive) setEnded(errText(e)) })
      return () => { alive = false; clearTimeout(timer); if (id) void client.logMulti.stop(id).catch(() => {}) }
    }
    const tick = async () => {
      try {
        const r = await client.logs.poll(id!)
        if (!alive) return
        ingest(r)
        if (r.ended) { setEnded(r.ended.error || tr('已停止：远端命令已退出或连接已断开')); id = undefined; return }
      } catch { /* 应用锁定等：下次再取 */ }
      if (alive) timer = setTimeout(tick, 300)
    }
    client.logs.start(spec.terminalId, spec.src).then((x) => {
      if (!alive) { void client.logs.stop(x).catch(() => {}); return }
      id = x; void tick()
    }).catch((e) => { if (alive) setEnded(errText(e)) })
    return () => { alive = false; clearTimeout(timer); if (id) void client.logs.stop(id).catch(() => {}) }
  }, [spec.terminalId, spec.src, multi, run])

  const resume = () => {
    setBuf((b) => appendLines(b.lines, pend.lines, maxLines, b.next))
    if (pend.dropped) setDropped((d) => d + pend.dropped)
    setPend({ lines: [], dropped: 0 }); setPaused(false)
  }
  const changeMax = (n: number) => { setMaxLines(n); setBuf((b) => appendLines(b.lines, [], n, b.next)) }

  // 洞察：新行到达时增量归并（渲染时同步，幂等）；侧栏选的模式 / 时间段再筛原始视图
  const insight = useMemo(() => new LogInsight(), [])
  syncInsight(insight, buf.lines)
  const [insightOn, setInsightOn] = useState(false)
  const [fp, setFp] = useState<string>()
  const [range, setRange] = useState<TimeRange>()
  const pickFp = (v?: string) => { setFp(v); if (v) setAuto(true) }
  const pickRangeT = (r?: TimeRange) => { setRange(r); setAuto(!r) }   // 选了时间段：从那段开头看起

  const f = useMemo(() => compileFilter({ query, regex, caseSensitive: cs }), [query, regex, cs])
  const shown = useMemo(() => (hiddenHosts.size ? buf.lines.filter((l) => l.h === undefined || !hiddenHosts.has(l.h)) : buf.lines), [buf.lines, hiddenHosts])
  const visible = useMemo(() => insightFilter(visibleLines(shown, f.re, onlyMatch), insight, fp, range), [shown, f.re, onlyMatch, insight, fp, range])
  const matches = useMemo(() => (f.re && !onlyMatch ? countMatches(shown, f.re) : visibleLines(shown, f.re, true).length), [shown, f.re, onlyMatch])
  const hostColor = (h: number) => (theme as unknown as Record<string, string | undefined>)[HOST_COLORS[h % HOST_COLORS.length]]
  const toggleHost = (h: number) => setHiddenHosts((s) => { const x = new Set(s); if (x.has(h)) x.delete(h); else x.add(h); return x })
  // 选了时间段：滚到顶（那段的开头）
  useLayoutEffect(() => { if (range && box.current) box.current.scrollTop = 0 }, [range])
  const samples = (p: string) => {
    const out: string[] = []
    for (let i = buf.lines.length - 1; i >= 0 && out.length < 3; i--) if (insight.meta(buf.lines[i].n)?.fp === p) out.unshift(buf.lines[i].text)
    return out
  }

  // 虚拟列表：固定行高，只渲染可视区 ± 余量
  const box = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 300 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = box.current
    if (auto && el && !hidden) el.scrollTop = el.scrollHeight
  }, [visible, auto, hidden])
  const onScroll = () => {
    const el = box.current!
    setScroll({ top: el.scrollTop, h: el.clientHeight })
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2
    if (atBottom !== auto) setAuto(atBottom)   // 往上翻自动停止跟随，翻回底部恢复
  }
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 30)
  const rows = visible.slice(first, first + Math.ceil(scroll.h / ROW_H) + 60)

  const clickRow = (e: RMouseEvent, n: number) => {
    if (window.getSelection()?.toString()) return   // 在拖选文字，不算点选行
    if (e.shiftKey && anchor !== undefined) { setSel(pickRange(visible, anchor, n)); return }
    setAnchor(n)
    if (e.ctrlKey || e.metaKey) setSel((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x })
    else setSel((s) => (s.size === 1 && s.has(n) ? new Set() : new Set([n])))
  }
  const selText = () => buf.lines.filter((l) => sel.has(l.n)).map((l) => withHost(l, hostLabels)).join('\n')
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(''), 2000) }
  const copySel = () => navigator.clipboard.writeText(selText()).then(() => flash(tr('已复制 {n} 行', { n: sel.size })), () => flash(tr('复制失败')))
  // 问 AI：选中行 + 来源放进对话输入框（不自动发）；「发给 AI 前脱敏」开着就先按样式脱敏
  const ask = async () => {
    const text = selText()
    const s = await client.settings.get().catch(() => undefined)
    quoteToChat(logQuote(logSourceLabel(spec.src), host, s?.system?.aiRedact === false ? text : redactSecrets(text)))
    flash(tr('已放入对话输入框'))
  }
  // 导出当前显示的内容（过滤「只看匹配行」时只导出匹配行）
  const exportTxt = () => {
    const url = URL.createObjectURL(new Blob([visible.map((l) => withHost(l, hostLabels)).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    const base = (logSourceLabel(spec.src).split('/').pop() || 'log').replace(/[\\/:*?"<>|\s]+/g, '_')
    a.href = url; a.download = `${(multi ? tr('{n}台', { n: multi.hosts.length }) : host).replace(/[\\/:*?"<>|\s]+/g, '_')}-${base}.txt`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  const inp = 'h-6 min-w-0 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 font-mono text-[11.5px] outline-none focus:border-[var(--color-accent)]'
  const segStyle = (c?: string, bold?: boolean, mark?: boolean): CSSProperties => ({
    ...(c ? { color: (theme as unknown as Record<string, string | undefined>)[c] } : {}),
    ...(bold ? { fontWeight: 700 } : {}),
    ...(mark ? { background: 'color-mix(in srgb, var(--color-accent) 35%, transparent)', borderRadius: 2 } : {}),
  })
  return (
    <div className={`min-h-0 flex-1 flex-col ${hidden ? 'hidden' : 'flex'}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1">
        {multi?.mode !== 'search' && (
          <button title={paused ? tr('继续（把暂停期间的新行补上）') : tr('暂停显示（后台继续接收）')} disabled={!!ended && !paused} onClick={() => (paused ? resume() : setPaused(true))} className={`${IB} ${paused ? ON : ''}`}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{paused ? (pend.lines.length ? tr('继续（+{n}）', { n: pend.lines.length }) : tr('继续')) : tr('暂停')}
          </button>
        )}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('过滤：关键字或正则')} className={`${inp} w-48 ${f.error ? 'border-[var(--color-danger)]' : ''}`} title={f.error} />
        <button title={tr('正则表达式')} onClick={() => setRegex((v) => !v)} className={`${IB} font-mono ${regex ? ON : ''}`}>.*</button>
        <button title={tr('区分大小写')} onClick={() => setCs((v) => !v)} className={`${IB} font-mono ${cs ? ON : ''}`}>Aa</button>
        <button title={onlyMatch ? tr('当前：只看匹配行（点此改为显示全部、高亮匹配）') : tr('当前：显示全部、高亮匹配（点此改为只看匹配行）')} onClick={() => setOnlyMatch((v) => !v)} className={`${IB} ${onlyMatch ? ON : ''}`}>{tr('只看匹配行')}</button>
        {query && !f.error && <span className="text-[11px] text-[var(--color-text-muted)]">{tr('{n} 行匹配', { n: matches })}</span>}
        {f.error && <span className="text-[11px] text-[var(--color-danger)]">{f.error}</span>}
        {fp && <Chip title={tr('只看这类日志：{fp}', { fp })} onClear={() => setFp(undefined)}>{trx('模式：{fp}', { fp: <span className="max-w-[220px] truncate font-mono">{fp}</span> })}</Chip>}
        {range && <Chip title={tr('只看这段时间的日志')} onClear={() => pickRangeT(undefined)}>{tr('时间：{from} – {to}', { from: fmtLogClock(range.from), to: fmtLogClock(range.to) })}</Chip>}
        <span className="ml-auto" />
        <button data-insight-toggle title={tr('洞察：同类归并、时间分布、让 AI 概括这段时间发生了什么（侧栏，不影响左边的原始日志）')} onClick={() => setInsightOn((v) => !v)} className={`${IB} ${insightOn ? ON : ''}`}><BarChart3 className="h-3.5 w-3.5" />{tr('洞察')}</button>
        <button title={tr('自动滚动到底')} onClick={() => setAuto((v) => !v)} className={`${IB} ${auto ? ON : ''}`}><ArrowDownToLine className="h-3.5 w-3.5" />{tr('自动滚动')}</button>
        {/* 工具栏一行都是 24px 的小按钮，这里跟着压到 h-6 */}
        <Select size="sm" title={tr('最多保留行数（超出丢弃最早的）')} value={String(maxLines)} onValueChange={(v) => changeMax(Number(v))} className="h-6 w-auto text-[11px]"
          options={MAX_LINES_CHOICES.map((n) => ({ value: String(n), label: tr('最多 {n} 行', { n: n.toLocaleString(dateLocale()) }) }))} />
        <button title={tr('清屏')} onClick={() => { setBuf((b) => ({ lines: [], next: b.next })); setSel(new Set()); setDropped(0) }} className={IB}><Eraser className="h-3.5 w-3.5" /></button>
        <button title={tr('导出当前内容为 .txt')} disabled={!visible.length} onClick={exportTxt} className={IB}><Download className="h-3.5 w-3.5" /></button>
        <button title={tr('复制选中行')} disabled={!sel.size} onClick={copySel} className={IB}><Copy className="h-3.5 w-3.5" /></button>
        <button title={tr('把选中行和文件路径放进对话输入框（按设置脱敏，不自动发送）')} disabled={!sel.size} onClick={() => void ask()} className={IB}><MessageSquareQuote className="h-3.5 w-3.5" />{sel.size ? tr('问 AI（{n} 行）', { n: sel.size }) : tr('问 AI')}</button>
      </div>
      {multi && (
        <div data-log-hosts className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1 text-[11px]">
          <span className="text-[var(--color-text-muted)]">{tr('主机（点击隐藏 / 显示）：')}</span>
          {multi.hosts.map((h, i) => {
            const info = hostInfo[i], off = hiddenHosts.has(i)
            return (
              <button key={i} onClick={() => toggleHost(i)} title={info?.error ? tr('{host}：{value}', { host: h.label, value: info.error }) : info?.note ? tr('{host}：{value}', { host: h.label, value: info.note }) : h.label}
                className={`flex max-w-[260px] items-center gap-1 rounded border px-1.5 py-0.5 ${off ? 'border-dashed border-[var(--color-border-default)] opacity-50' : 'border-[var(--color-border-default)] hover:bg-[var(--color-bg-hover)]'}`}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hostColor(i) }} />
                <span className="truncate text-[var(--color-text-primary)]">{h.label}</span>
                {info?.error ? <span className="truncate text-[var(--color-danger)]">· {info.error}</span>
                  : info?.note && multi.mode === 'search' ? <span className="shrink-0 text-[var(--color-text-muted)]">· {info.note.split(tr('；'))[0]}</span>
                    : info?.note ? <span className="shrink-0 text-[var(--color-text-muted)]">· {info.note}</span> : null}
              </button>
            )
          })}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <div ref={box} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 overflow-auto font-mono text-[12px]" style={{ background: theme.background, color: theme.foreground }}>
        <div className="relative w-max min-w-full" style={{ height: visible.length * ROW_H }}>
          <div style={{ transform: `translateY(${first * ROW_H}px)` }}>
            {rows.map((l) => (
              <div key={l.n} onClick={(e) => clickRow(e, l.n)} style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
                className={`cursor-default whitespace-pre px-2 ${sel.has(l.n) ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_22%,transparent)]' : 'hover:bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)]'}`}>
                {l.h !== undefined && hostLabels && <span data-host={l.h} style={{ color: hostColor(l.h), fontWeight: 600 }}>[{hostLabels[l.h]}] </span>}
                {segments(l.text, colors, f.re).map((g, i) => <span key={i} style={segStyle(g.color, g.bold, g.mark)}>{g.text}</span>)}
                {!l.text && ' '}
              </div>
            ))}
          </div>
        </div>
        {(fp || range) && !visible.length && <div className="p-3 font-sans text-[11.5px] text-[var(--color-text-muted)]">{tr('这类 / 这段时间的日志已不在缓冲里（超过「最多 N 行」被丢弃）')}</div>}
      </div>
      {insightOn && !hidden && <LogInsightPanel insight={insight} source={logSourceLabel(spec.src)} host={host} fp={fp} onFp={pickFp} range={range} onRange={pickRangeT} samples={samples} flash={flash} />}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--color-border-subtle)] px-2 text-[11px] text-[var(--color-text-muted)]">
        <span className="max-w-[40%] truncate font-mono" title={logSourceLabel(spec.src)}>{host} · {logSourceLabel(spec.src)}</span>
        <span>{tr('line|{n} 行', { n: buf.lines.length.toLocaleString(dateLocale()) })}</span>
        {dropped > 0 && <span title={tr('超过保留上限丢弃的最早行数')}>{tr('已丢弃 {n} 行', { n: dropped.toLocaleString(dateLocale()) })}</span>}
        {sel.size > 0 && <span>{tr('已选 {n} 行（Ctrl 多选，Shift 连选）', { n: sel.size })}</span>}
        {note && <span className="text-[var(--color-accent)]">{note}</span>}
        <span className="ml-auto" />
        {multi?.mode === 'search'
          ? <span data-search-state className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">{done ?? tr('检索中…')}
              {done && <button onClick={() => setRun((r) => r + 1)} className="flex items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"><RotateCw className="h-3 w-3" />{tr('重新检索')}</button>}</span>
          : ended
          ? <span className="flex items-center gap-1.5 text-[var(--color-danger)]">{ended}
              <button onClick={() => setRun((r) => r + 1)} className="flex items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"><RotateCw className="h-3 w-3" />{tr('重新开始')}</button></span>
          : paused ? <span className="text-[var(--color-warn)]">{tr('已暂停 · 新增 {n} 行待显示', { n: pend.lines.length.toLocaleString(dateLocale()) })}</span>
            : <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-success)]" />{tr('跟踪中')}</span>}
      </div>
    </div>
  )
}

// 工具栏上的筛选标签（洞察侧栏选的模式 / 时间段），× 清除
function Chip({ title, onClear, children }: { title: string; onClear: () => void; children: React.ReactNode }) {
  return (
    <span data-insight-chip title={title} className="flex h-6 min-w-0 items-center gap-1 rounded bg-[var(--color-accent-bg)] px-1.5 text-[11px] text-[var(--color-accent)]">
      {children}
      <button title={tr('清除')} onClick={onClear} className="shrink-0 hover:text-[var(--color-danger)]"><X className="h-3 w-3" /></button>
    </span>
  )
}
