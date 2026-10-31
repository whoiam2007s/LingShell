// 用量统计的图表（纯 SVG / div，无依赖）：每日堆叠柱、环形占比、横向条形、可排序表格
import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cacheHitRate, fmtCost, fmtTokens, totalTokens, tr, tk, type UsageCurrency, type UsageTotals } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { sortRows, type SortDir } from './usageData.js'

// 堆叠三段：命中缓存 / 未命中输入 / 输出
export const SEG = [['cacheRead', tk('命中缓存'), 'var(--color-accent-dim)'], ['input', tk('输入'), 'var(--color-accent)'], ['output', tk('输出'), 'var(--color-success)']] as const
// 分类配色（来源 / 模型 / 会话），最后一个给「其它」
export const PALETTE = ['var(--color-accent)', 'var(--color-success)', 'var(--color-warn)', 'var(--color-reasoning)', 'var(--color-user)', 'var(--color-text-muted)']

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
      {items.map((x) => <span key={x.label} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: x.color }} />{x.label}</span>)}
    </div>
  )
}

/** 每日 tokens 堆叠柱。鼠标停在某天上显示浮层明细 */
export function DailyChart({ days, currency, className = 'h-36' }: { days: (UsageTotals & { day: string })[]; currency: UsageCurrency; className?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...days.map(totalTokens))
  const n = Math.max(1, days.length), W = 100, H = 40, bw = W / n, gap = n > 60 ? 0.1 : 0.3
  const h = hover === null ? undefined : days[hover]
  const x = hover === null ? 0 : ((hover + 0.5) / n) * 100
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div className="mb-1 flex items-center justify-between">
        <Legend items={SEG.map(([, label, color]) => ({ label: tr(label), color }))} />
        <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{tr('峰值 {n}', { n: fmtTokens(max) })}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn('w-full', className)} role="img" aria-label={tr('每日 tokens 柱状图')}>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="var(--color-border-subtle)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />)}
        {days.map((d, i) => {
          let y = H
          return (
            <g key={d.day}>
              {hover === i && <rect x={i * bw} y={0} width={bw} height={H} fill="var(--color-bg-hover)" />}
              {SEG.map(([k, , color]) => {
                const hh = (d[k] / max) * H
                y -= hh
                return hh > 0 ? <rect key={k} x={i * bw + (bw * gap) / 2} y={y} width={bw * (1 - gap)} height={hh} fill={color} /> : null
              })}
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          )
        })}
      </svg>
      {h && (
        <div style={{ left: `${x}%`, transform: `translateX(${x < 20 ? '0' : x > 80 ? '-100%' : '-50%'})` }}
          className="pointer-events-none absolute top-6 z-10 whitespace-nowrap rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11px] leading-[1.6] text-[var(--color-text-secondary)] shadow-lg">
          <div className="font-medium text-[var(--color-text-primary)]">{h.day}</div>
          <div className="tabular-nums">{tr('{n} 次请求 · 共 {total}', { n: h.requests, total: fmtTokens(totalTokens(h)) })}</div>
          {SEG.map(([k, label, color]) => <div key={k} className="flex items-center gap-1 tabular-nums"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />{tr(label)} {fmtTokens(h[k])}</div>)}
          {h.requests > 0 && <div className="tabular-nums">{tr('花费 {cost}', { cost: fmtCost(h.cost, currency) })}</div>}
        </div>
      )}
      <div className="mt-0.5 flex justify-between text-[10px] text-[var(--color-text-muted)]">
        <span>{days[0]?.day}</span>{days.length > 2 && <span>{days[Math.floor(days.length / 2)].day}</span>}{days.length > 1 && <span>{days[days.length - 1].day}</span>}
      </div>
    </div>
  )
}

/** 环形占比：中间显示悬停项（默认总量）。r=15.915 → 周长 100，dasharray 直接用百分比 */
export function Donut({ items, total, unit = 'tokens' }: { items: { label: string; ratio: number; value: number; color: string }[]; total: string; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const h = hover === null ? undefined : items[hover]
  let off = 25   // 从 12 点钟方向开始
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 42 42" className="h-full w-full" role="img" aria-label={tr('占比环形图')} onMouseLeave={() => setHover(null)}>
          <circle cx={21} cy={21} r={15.915} fill="none" stroke="var(--color-bg-raised)" strokeWidth={6} />
          {items.map((x, i) => {
            const len = x.ratio * 100
            const el = <circle key={x.label} cx={21} cy={21} r={15.915} fill="none" stroke={x.color} strokeWidth={hover === i ? 7.5 : 6}
              strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={off} onMouseEnter={() => setHover(i)} className="cursor-default transition-[stroke-width]" />
            off -= len
            return el
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="max-w-[80px] truncate text-[10px] text-[var(--color-text-muted)]">{h ? tr(h.label) : tr('合计')}</span>
          <span className="text-[13px] font-medium tabular-nums text-[var(--color-text-primary)]">{h ? `${(h.ratio * 100).toFixed(1)}%` : total}</span>
          {!h && <span className="text-[10px] text-[var(--color-text-muted)]">{unit}</span>}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {items.map((x, i) => (
          <div key={x.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            className={cn('flex items-center gap-2 rounded px-1 text-[12px]', hover === i && 'bg-[var(--color-bg-hover)]')}>
            <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: x.color }} />
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={tr(x.label)}>{tr(x.label)}</span>
            <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtTokens(x.value)}</span>
            <span className="w-12 shrink-0 text-right tabular-nums text-[var(--color-text-primary)]">{(x.ratio * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 横向条形：label + 比例条 + 数值 */
export function BarList({ items }: { items: { key: string; label: React.ReactNode; value: number; text: string; color?: string; title?: string }[] }) {
  const max = Math.max(1, ...items.map((x) => x.value))
  return (
    <div className="space-y-1.5">
      {items.map((x) => (
        <div key={x.key} className="flex items-center gap-2 text-[12px]" title={x.title}>
          <div className="w-[38%] min-w-0 shrink-0 truncate text-[var(--color-text-secondary)]">{x.label}</div>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
            <div className="h-full rounded-full" style={{ width: `${(x.value / max) * 100}%`, background: x.color ?? 'var(--color-accent)' }} />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-[var(--color-text-primary)]">{x.text}</span>
        </div>
      ))}
    </div>
  )
}

export interface Col<T> { key: string; label: string; sort?: (r: T) => number | string; render: (r: T) => React.ReactNode; left?: boolean; title?: (r: T) => string }

/** 可排序表格：点表头切换排序（再点反向） */
export function SortTable<T>({ cols, rows, rowKey, initial }: { cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; initial: { key: string; dir: SortDir } }) {
  const [s, setS] = useState(initial)
  const col = cols.find((c) => c.key === s.key)
  const sorted = col?.sort ? sortRows(rows, col.sort, s.dir) : rows
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-[11px] text-[var(--color-text-muted)]">
          {cols.map((c) => (
            <th key={c.key} className={cn('py-1.5 font-normal', c.left ? 'text-left' : 'text-right')}>
              {c.sort ? (
                <button onClick={() => setS((o) => ({ key: c.key, dir: o.key === c.key && o.dir === 'desc' ? 'asc' : 'desc' }))}
                  className={cn('inline-flex items-center gap-0.5 hover:text-[var(--color-text-primary)]', s.key === c.key && 'text-[var(--color-text-primary)]')}>
                  {c.label}{s.key === c.key && (s.dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                </button>
              ) : c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={rowKey(r)} className="border-t border-[var(--color-border-subtle)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
            {cols.map((c) => <td key={c.key} title={c.title?.(r)} className={cn('whitespace-nowrap py-1.5 tabular-nums', c.left ? 'pr-2 text-left' : 'pl-2 text-right')}>{c.render(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`
const hit = (t: UsageTotals) => cacheHitRate(t)
/** UsageTotals 通用列：请求 / 输入 / 命中缓存 / 输出 / 合计 / 命中率 / 花费 */
export function totalsCols<T extends UsageTotals>(currency: UsageCurrency): Col<T>[] {
  return [
    { key: 'requests', label: tr('请求'), sort: (r) => r.requests, render: (r) => r.requests.toLocaleString() },
    { key: 'input', label: tr('输入'), sort: (r) => r.input, render: (r) => fmtTokens(r.input), title: (r) => tr('未命中缓存的输入 {n}', { n: r.input.toLocaleString() }) },
    { key: 'cacheRead', label: tr('命中缓存'), sort: (r) => r.cacheRead, render: (r) => fmtTokens(r.cacheRead), title: (r) => r.cacheRead.toLocaleString() },
    { key: 'output', label: tr('输出'), sort: (r) => r.output, render: (r) => fmtTokens(r.output), title: (r) => r.output.toLocaleString() },
    { key: 'tokens', label: tr('合计'), sort: (r) => totalTokens(r), render: (r) => fmtTokens(totalTokens(r)) },
    { key: 'hit', label: tr('命中率'), sort: hit, render: (r) => (r.requests ? pct(hit(r)) : '—') },
    { key: 'cost', label: tr('花费'), sort: (r) => r.cost ?? -1, render: (r) => (r.requests ? <span className={r.cost === undefined ? 'text-[11px] text-[var(--color-text-muted)]' : ''}>{fmtCost(r.cost, currency)}</span> : '—'),
      title: (r) => (r.cost !== undefined && r.unpriced ? tr('另有 {n} 次请求未设单价', { n: r.unpriced }) : '') },
  ]
}
