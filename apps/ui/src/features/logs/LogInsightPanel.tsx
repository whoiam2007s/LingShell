import { useEffect, useMemo, useRef, useState } from 'react'
import { Filter, MessageSquareQuote, Sparkles, X } from 'lucide-react'
import { buildHistogram, buildLogDigest, fmtLogClock, fmtStep, patternQuote, redactSecrets, LEVEL_LABEL, tk, tr, dateLocale, type LogInsight, type LogLevel, type LogPattern } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { Select } from '../../components/ui/Select.js'

// 日志「洞察」侧栏：同类归并 Top 模式 / 时间分布柱状图 / 「这段时间发生了什么」发给 AI。
// 归并在 LogInsight 里随新行增量做；这里每秒取一次结果重画，几万行也不卡
export interface TimeRange { from: number; to: number }
const LV_COLOR: Record<LogLevel, string> = { error: 'var(--color-danger)', warn: 'var(--color-warn)', info: 'var(--color-accent)', debug: 'var(--color-text-muted)' }
const OTHER = 'color-mix(in srgb, var(--color-text-muted) 55%, transparent)'
const RECENT = [['5', tk('最近 5 分钟')], ['15', tk('最近 15 分钟')], ['60', tk('最近 1 小时')], ['0', tk('全部')]] as const
const BTN = 'flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'

const aiRedact = async () => {
  const s = await client.settings.get().catch(() => undefined)
  return s?.system?.aiRedact === false ? (x: string) => x : redactSecrets
}

export function LogInsightPanel({ insight, source, host, fp, onFp, range, onRange, samples, flash }: {
  insight: LogInsight
  source: string; host: string
  fp?: string; onFp: (fp?: string) => void
  range?: TimeRange; onRange: (r?: TimeRange) => void
  samples: (fp: string) => string[]   // 某模式最近几条原文（问 AI 用）
  flash: (t: string) => void
}) {
  // 每秒按 version 刷新一次（新行到达时 LogInsight.version 变）
  const [ver, setVer] = useState(insight.version)
  useEffect(() => { const id = setInterval(() => setVer(insight.version), 1000); return () => clearInterval(id) }, [insight])
  const [recent, setRecent] = useState('15')
  const metas = useMemo(() => insight.all(), [insight, ver])
  const hist = useMemo(() => buildHistogram(metas), [metas])
  const top = useMemo(() => insight.top(50, range), [insight, ver, range])
  const totals = useMemo(() => {
    const c = { lines: 0, error: 0, warn: 0 }
    for (const m of metas) if (!m.cont && (!range || (m.t >= range.from && m.t < range.to))) { c.lines++; if (m.level === 'error') c.error++; else if (m.level === 'warn') c.warn++ }
    return c
  }, [metas, range])
  const kinds = range ? top.length : insight.patterns.size

  // 「这段时间发生了什么」：选中的时间段；没选就按日志时间取最近 N 分钟
  const digestRange = (): TimeRange | undefined => {
    if (range) return range
    if (!hist) return undefined
    const end = metas.reduce((t, m) => (m.cont ? t : Math.max(t, m.t)), 0) + 1
    return recent === '0' ? { from: hist.from, to: end } : { from: end - Number(recent) * 60_000, to: end }
  }
  const digest = async () => {
    const r = digestRange()
    if (!r) return
    const red = await aiRedact()
    const inRange = metas.filter((m) => m.t >= r.from && m.t < r.to)
    sendToChat(buildLogDigest({ source, host, from: r.from, to: r.to, metas: inRange, patterns: insight.top(1e9, r), redact: red }))
    flash(tr('已把这段时间的统计发给 AI'))
  }
  const ask = async (p: LogPattern) => {
    const red = await aiRedact()
    quoteToChat(red(patternQuote(source, host, p, samples(p.fp))))
    flash(tr('已放入对话输入框'))
  }

  return (
    <div data-log-insight className="flex w-[40%] min-w-[300px] max-w-[420px] shrink-0 flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] text-[11.5px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-1 text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text-primary)]">{tr('洞察')}</span>
        <span data-insight-totals>{tr('{n} 行 · {k} 种模式', { n: totals.lines.toLocaleString(dateLocale()), k: kinds })} · <span style={{ color: LV_COLOR.error }}>ERROR {totals.error}</span> · <span style={{ color: LV_COLOR.warn }}>WARN {totals.warn}</span></span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-[var(--color-border-subtle)] px-2 pb-2 pt-1.5">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-[var(--color-text-muted)]">
            <span>{hist ? tr('时间分布（每格 {step}）', { step: fmtStep(hist.step) }) : tr('时间分布')}</span>
            <span className="ml-auto flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: LV_COLOR.error }} />{tr('错误')}</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: LV_COLOR.warn }} />{tr('警告')}</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: OTHER }} />{tr('其他')}</span>
          </div>
          {hist ? <Histogram hist={hist} range={range} onRange={onRange} /> : <div className="py-4 text-center text-[var(--color-text-muted)]">{tr('还没有日志')}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {range ? (
              <span data-insight-range className="flex h-6 items-center gap-1 rounded bg-[var(--color-accent-bg)] px-1.5 text-[11px] text-[var(--color-accent)]">
                {fmtLogClock(range.from)} – {fmtLogClock(range.to)}
                <button title={tr('清除时间段（原始视图也恢复显示全部）')} onClick={() => onRange(undefined)}><X className="h-3 w-3" /></button>
              </span>
            ) : (
              <Select size="sm" value={recent} onValueChange={setRecent} className="h-6 w-auto text-[11px]" title={tr('没选时间段时，按日志里的时间取最近一段')}
                options={RECENT.map(([v, l]) => ({ value: v, label: tr(l) }))} />
            )}
            <button data-insight-digest disabled={!hist} onClick={() => void digest()} className={BTN}
              title={tr('把这段时间的归并统计（级别计数、时间分布、Top 模式和少量脱敏示例）作为一条消息发给 AI，让它概括发生了什么')}>
              <Sparkles className="h-3.5 w-3.5" />{tr('这段时间发生了什么')}
            </button>
          </div>
          {!range && hist && <div className="mt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('点柱子只看那段时间的日志，按住拖动可选一段')}</div>}
        </div>
        <div className="px-1 py-1">
          <div className="px-1 pb-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('同类归并（数字、IP、ID 等已归一，按严重程度和次数排序）')}</div>
          {top.map((p) => (
            <div key={p.fp} data-insight-pattern onClick={() => onFp(fp === p.fp ? undefined : p.fp)} title={`${tr('示例：')}\n${p.sample}`}
              className={`group cursor-pointer rounded px-1.5 py-1 ${fp === p.fp ? 'bg-[var(--color-accent-bg)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
              <div className="flex items-center gap-1.5">
                <span className="w-11 shrink-0 font-mono text-[10px] font-semibold" style={{ color: p.level ? LV_COLOR[p.level] : 'var(--color-text-muted)' }}>{p.level ? LEVEL_LABEL[p.level] : '—'}</span>
                <span data-count className="w-12 shrink-0 text-right font-mono tabular-nums text-[var(--color-text-primary)]">{p.count.toLocaleString(dateLocale())}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-text-muted)]">{fmtLogClock(p.first)} → {fmtLogClock(p.last)}</span>
                <button title={fp === p.fp ? tr('取消只看这类') : tr('原始视图只看这类日志')} onClick={(e) => { e.stopPropagation(); onFp(fp === p.fp ? undefined : p.fp) }}
                  className={`shrink-0 rounded p-0.5 hover:text-[var(--color-accent)] ${fp === p.fp ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100'}`}><Filter className="h-3 w-3" /></button>
                <button data-insight-ask title={tr('问 AI：这类日志的模式、次数和几条示例放进对话输入框（按设置脱敏，不自动发送）')} onClick={(e) => { e.stopPropagation(); void ask(p) }}
                  className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] opacity-0 hover:text-[var(--color-accent)] group-hover:opacity-100"><MessageSquareQuote className="h-3 w-3" /></button>
              </div>
              <div data-fp className="mt-0.5 line-clamp-2 break-all pl-[50px] font-mono text-[11px] leading-[15px] text-[var(--color-text-secondary)]">{p.fp}</div>
            </div>
          ))}
          {kinds > top.length && <div className="px-1.5 py-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('只列前 {n} 种，共 {total} 种', { n: top.length, total: kinds })}</div>}
        </div>
      </div>
    </div>
  )
}

// 柱状图（SVG 自绘）：错误 / 警告 / 其他堆叠；点一根选那一格，按住拖动选一段
function Histogram({ hist, range, onRange }: { hist: NonNullable<ReturnType<typeof buildHistogram>>; range?: TimeRange; onRange: (r?: TimeRange) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  const [drag, setDragS] = useState<{ a: number; b: number }>()
  const dragRef = useRef(drag)   // 按下 / 松开可能在同一帧内（还没重渲染），用 ref 取最新值
  const setDrag = (d?: { a: number; b: number }) => { dragRef.current = d; setDragS(d) }
  const n = hist.buckets.length
  const max = Math.max(1, ...hist.buckets.map((b) => b.total))
  const H = 64
  const idx = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(n - 1, Math.floor(((x - r.left) / r.width) * n)))
  }
  const sel = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] : undefined
  const inSel = (i: number) => {
    if (sel) return i >= sel[0] && i <= sel[1]
    if (!range) return true
    const t = hist.buckets[i].t
    return t + hist.step > range.from && t < range.to
  }
  const end = () => {
    const d = dragRef.current
    if (!d) return
    const [a, b] = [Math.min(d.a, d.b), Math.max(d.a, d.b)]
    setDrag(undefined)
    onRange({ from: hist.buckets[a].t, to: hist.buckets[b].t + hist.step })
  }
  return (
    <div>
      <svg ref={ref} data-insight-hist viewBox={`0 0 ${n} ${H}`} preserveAspectRatio="none" className="block h-16 w-full cursor-crosshair select-none"
        onMouseDown={(e) => { const i = idx(e.clientX); setDrag({ a: i, b: i }) }}
        onMouseMove={(e) => { const d = dragRef.current; if (d) setDrag({ ...d, b: idx(e.clientX) }) }}
        onMouseUp={end} onMouseLeave={end}>
        <rect x={0} y={H - 0.5} width={n} height={0.5} fill="var(--color-border-default)" />
        {hist.buckets.map((b, i) => {
          const h = (v: number) => (v / max) * (H - 2)
          const other = b.total - b.error - b.warn
          const tip = tr('{from} – {to}：共 {n} 行，ERROR {e}，WARN {w}', { from: fmtLogClock(b.t), to: fmtLogClock(b.t + hist.step), n: b.total, e: b.error, w: b.warn })
          return (
            <g key={b.t} opacity={inSel(i) ? 1 : 0.3}>
              <title>{tip}</title>
              <rect x={i} y={0} width={1} height={H} fill="transparent" />
              <rect x={i + 0.12} width={0.76} y={H - h(b.error)} height={h(b.error)} fill="var(--color-danger)" />
              <rect x={i + 0.12} width={0.76} y={H - h(b.error + b.warn)} height={h(b.warn)} fill="var(--color-warn)" />
              <rect x={i + 0.12} width={0.76} y={H - h(b.total)} height={h(other)} fill={OTHER} />
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-[var(--color-text-muted)]">
        <span>{fmtLogClock(hist.from, true)}</span><span>{fmtLogClock(hist.to, true)}</span>
      </div>
    </div>
  )
}
