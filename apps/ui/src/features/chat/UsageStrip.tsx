import { Loader2 } from 'lucide-react'
import { tr, type UsageTotals } from '@lingshell/shared'

export interface TurnStatsView { outputTokens: number; inputTokens: number; cacheReadTokens: number; ms: number; thinkingTokens?: number; thinkingChars?: number }

export interface UsageStripProps {
  /** 上一次调用的输出速度（tok/s）；没有调用过时显示 -- */
  tokPerSec?: number
  stats?: TurnStatsView
  /** 本会话累计（tokens / 花费）；总量与 tooltip 用 */
  totals?: UsageTotals | null
  /** 已格式化的花费（带货币符号，如 ¥0.0123）；由调用方用 fmtCost 生成 */
  costText?: string
  cacheRate?: number
  ctxTokens?: number
  window?: number
  /** 自动压缩阈值（tokens） */
  compactAt?: number
  pct?: number
  compacting?: boolean
  note?: 'ok' | 'fail'
  onCompact?: () => void
}

/** 大数字按 G / M / K 折算，不做成清一色 K */
export const fmtCount = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`
  return String(Math.round(n))
}
const rate = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))

/**
 * 输入框底部的性能指标，只放数字与单位：`94.1 tok/s · 92.5% · 12.3K · ◔20%`。
 * 每一项的含义放各自 tooltip；圆环是唯一可点的（压缩上下文，会先弹确认）。
 */
export function UsageStrip({ tokPerSec, stats, totals, costText, cacheRate, ctxTokens, window: win, compactAt, pct, compacting, note, onCompact }: UsageStripProps) {
  // 缓存命中只按「上一次调用」算：没有调用记录就是 --，不拿会话累计冒充
  const hitRate = stats && cacheRate !== undefined ? (cacheRate * 100).toFixed(1) : undefined
  const totalTokens = totals ? totals.input + totals.cacheRead + totals.output : undefined
  const line = (...xs: (string | undefined)[]) => xs.filter(Boolean).join('\n')

  // 速率：总输出 / 总请求耗时
  const tipRate = tokPerSec !== undefined
    ? line(
      tr('速率：{n} tok/s', { n: rate(tokPerSec) }),
      tr('输出 token：{n}', { n: fmtCount(stats?.outputTokens ?? 0) }),
      tr('请求耗时：{n} 秒', { n: ((stats?.ms ?? 0) / 1000).toFixed(1) }),
    )
    : tr('还没有调用记录')
  // 缓存：缓存 token / 总输入 token
  const tipCache = line(
    tr('缓存率：{n}%', { n: hitRate ?? '--' }),
    tr('缓存输入：{n}', { n: fmtCount(stats?.cacheReadTokens ?? 0) }),
    tr('输出：{n}', { n: fmtCount(stats?.outputTokens ?? 0) }),
    tr('thinking：{n}', { n: stats?.thinkingTokens ? fmtCount(stats.thinkingTokens) : stats?.thinkingChars ? tr('{n} 字', { n: stats.thinkingChars }) : '—' }),
  )
  const tipTotal = totals
    ? line(
      tr('总 token：{n}', { n: fmtCount(totalTokens ?? 0) }),
      tr('请求数量：{n}', { n: totals.requests }),
      tr('总输入：{n}', { n: fmtCount(totals.input) }),
      tr('总缓存：{n}', { n: fmtCount(totals.cacheRead) }),
      tr('总输出：{n}', { n: fmtCount(totals.output) }),
      tr('总花费：{n}', { n: costText ?? '—' }),
    )
    : tr('本会话还没有用量记录')
  const tipCtx = pct !== undefined
    ? [
      win ? tr('上下文 {used} / {window}（{pct}%）', { used: fmtCount(ctxTokens ?? 0), window: fmtCount(win), pct }) : tr('上下文 {used}（未设上限）', { used: fmtCount(ctxTokens ?? 0) }),
      // 自动压缩说明保留（用户要的），但只放在这里
      compactAt ? tr('达到 {at} 自动压缩（最近一轮原文保留）', { at: fmtCount(compactAt) }) : '',
      onCompact ? tr('点击压缩（会先弹确认）') : '',
    ].filter(Boolean).join('\n')
    : ''

  return (
    <div className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-[var(--color-text-muted)]" data-usage-strip>
      <span data-tok-rate title={tipRate} className="hidden md:inline">{tokPerSec !== undefined ? rate(tokPerSec) : '--'} tok/s</span>
      <span className="hidden text-[var(--color-border-default)] md:inline">·</span>
      <span data-cache-rate title={tipCache} className="hidden md:inline">{hitRate ?? '--'}%</span>
      <span className="hidden text-[var(--color-border-default)] md:inline">·</span>
      <span data-usage-total title={tipTotal} className="hidden md:inline">{totalTokens !== undefined ? fmtCount(totalTokens) : '--'}</span>
      {pct !== undefined && <span className="text-[var(--color-border-default)]">·</span>}
      {pct !== undefined && (
        <button type="button" data-ctx-ring onClick={onCompact} disabled={compacting}
          title={tipCtx} aria-label={tipCtx}
          className="flex items-center gap-1 rounded px-0.5 transition-colors hover:text-[var(--color-text-secondary)] disabled:opacity-60">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" style={{ stroke: 'var(--color-bg-hover)' }} />
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" strokeLinecap="round" pathLength={100}
              strokeDasharray={`${Math.max(pct, 1)} 100`} style={{ stroke: pct >= 95 ? 'var(--color-danger)' : pct >= 80 ? 'var(--color-warn)' : 'var(--color-accent)' }}
              className="transition-[stroke-dasharray]" />
          </svg>
          {compacting
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <span style={{ color: note ? (note === 'ok' ? 'var(--color-success)' : 'var(--color-danger)') : undefined }}>
                {note ? (note === 'ok' ? tr('已压缩') : tr('失败')) : `${pct}%`}
              </span>}
        </button>
      )}
    </div>
  )
}
