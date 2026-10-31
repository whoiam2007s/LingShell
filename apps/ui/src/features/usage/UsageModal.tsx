// 「用量统计」独立弹窗：左侧菜单（总览 / 按日趋势 / 按来源 / 按会话 / 按模型 / 单价设置），右侧内容，顶部时间范围 + 刷新。
// 自挂载：App 里常驻 <UsageModal />，任何地方 openUsage(view) 打开（标题栏、命令面板、帮助链接、对话头部）。
import { useEffect, useRef, useState } from 'react'
import { X, RefreshCw, ChevronRight, LayoutDashboard, CalendarDays, ChartPie, MessagesSquare, Cpu, Coins } from 'lucide-react'
import { USAGE_RANGES, PROVIDERS, cacheHitRate, fmtTokens, fmtCost, totalTokens, tr, type UsageRange, type UsageSummary, type UsageTotals } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { HelpTip, BTN2 } from '../../components/ui/form.js'
import { USAGE_VIEWS, USAGE_OPEN_EVENT, SOURCES, fillDays, shares, type UsageView } from './usageData.js'
import { DailyChart, Donut, BarList, SortTable, totalsCols, PALETTE, type Col } from './charts.js'
import { PriceEditor, errText } from './PriceEditor.js'

const ICONS: Record<UsageView, React.ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard, daily: CalendarDays, source: ChartPie, session: MessagesSquare, model: Cpu, prices: Coins,
}
const pct = (r: number) => `${(r * 100).toFixed(1)}%`
const providerLabel = (id: string) => { const l = PROVIDERS.find((p) => p.id === id)?.label; return l ? tr(l) : id }

export function UsageModal({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [open, setOpen] = useState<{ view: UsageView; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ view: (e as CustomEvent<UsageView>).detail ?? 'overview', n: (o?.n ?? 0) + 1 }))
    window.addEventListener(USAGE_OPEN_EVENT, f)
    return () => window.removeEventListener(USAGE_OPEN_EVENT, f)
  }, [])
  if (!open) return null
  return <UsageBody key={open.n} initial={open.view} onClose={() => setOpen(null)} onOpenSession={(sid) => { setOpen(null); onOpenSession(sid) }} />
}

type SessionRow = UsageSummary['sessions'][number] & { title?: string }
type ModelRow = UsageSummary['models'][number]
type SourceRow = UsageTotals & { key: string; label: string }

function UsageBody({ initial, onClose, onOpenSession }: { initial: UsageView; onClose: () => void; onOpenSession: (sid: string) => void }) {
  const [view, setView] = useState<UsageView>(initial)
  const [range, setRange] = useState<UsageRange>('7d')
  const [sum, setSum] = useState<UsageSummary | null>(null)
  const [titles, setTitles] = useState<Map<string, string>>(new Map())
  const [err, setErr] = useState<string | null>(null)
  const load = () => {
    client.usage.summary(range).then((s) => { setSum(s); setErr(null) }).catch((e) => setErr(errText(e)))
    client.agent.listPersisted().then((l) => setTitles(new Map(l.map((m) => [m.id, m.title])))).catch(() => {})
  }
  useEffect(load, [range])

  // Esc 关闭：上面还盖着别的弹层时不关；焦点在输入框里先失焦（单价没保存别丢）
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current && !rootRef.current?.contains(o))) return
      const a = document.activeElement
      if (a instanceof HTMLInputElement || a instanceof HTMLSelectElement) { a.blur(); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const label = USAGE_VIEWS.find((v) => v.id === view)?.label
  return (
    <div ref={rootRef} data-usage-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <nav className="flex w-[160px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5">
          <div className="px-2.5 pb-2 pt-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('用量统计')}</div>
          {USAGE_VIEWS.map((v, i) => {
            const Icon = ICONS[v.id]
            return (
              <button key={v.id} data-usage-view={v.id} onClick={() => setView(v.id)}
                className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                  i === USAGE_VIEWS.length - 1 && 'mt-2',
                  view === v.id ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>
                <Icon className="h-4 w-4 text-[var(--color-accent)]" />{tr(v.label)}
              </button>
            )
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{label && tr(label)}</span>
            <HelpTip>{tr('统计每次模型请求的 tokens，按「单价设置」里填的单价估算花费。记录保存在本机，保留最近 180 天。')}</HelpTip>
            {view !== 'prices' && (
              <div className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-0.5">
                {USAGE_RANGES.map((r) => (
                  <button key={r.id} onClick={() => setRange(r.id)}
                    className={cn('rounded px-2.5 py-0.5 text-[12px]', range === r.id ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>{tr(r.label)}</button>
                ))}
              </div>
            )}
            {view !== 'prices' && <button onClick={load} title={tr('刷新')} className={cn('flex items-center gap-1 py-1', BTN2)}><RefreshCw className="h-3.5 w-3.5" />{tr('刷新')}</button>}
            <button onClick={onClose} title={tr('关闭（Esc）')} className={cn('flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]', view === 'prices' && 'ml-auto')}><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-[880px] space-y-3">
              {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
              {view === 'prices' ? <PriceEditor seen={sum?.models ?? []} onSaved={load} />
                : !sum ? <Muted>{tr('加载中…')}</Muted>
                : view === 'overview' ? <Overview sum={sum} titles={titles} go={setView} />
                : view === 'daily' ? <DailyView sum={sum} />
                : view === 'source' ? <SourceView sum={sum} />
                : view === 'session' ? <SessionView sum={sum} titles={titles} onOpenSession={onOpenSession} />
                : <ModelView sum={sum} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const Muted = ({ children }: { children: React.ReactNode }) => <div className="py-8 text-center text-[12px] text-[var(--color-text-muted)]">{children}</div>
const Empty = () => <Muted>{tr('该范围内没有记录')}</Muted>

/** 卡片：标题 + 右侧「详情 ›」；给了 onMore 时整块可点，跳到对应详细菜单 */
function Card({ title, tip, onMore, children, className }: { title: string; tip?: React.ReactNode; onMore?: () => void; children: React.ReactNode; className?: string }) {
  return (
    <section onClick={onMore} className={cn('rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]', onMore && 'cursor-pointer transition-colors hover:border-[var(--color-border-default)]', className)}>
      <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2.5">
        <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
        {tip && <span onClick={(e) => e.stopPropagation()}><HelpTip>{tip}</HelpTip></span>}
        {onMore && <span className="ml-auto flex items-center text-[11px] text-[var(--color-text-muted)]">{tr('详情')}<ChevronRight className="h-3.5 w-3.5" /></span>}
      </div>
      <div className="px-3.5 pb-3 pt-1">{children}</div>
    </section>
  )
}

function Stat({ label, value, hint, muted, onClick }: { label: string; value: string; hint?: string; muted?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} title={hint} className="min-w-0 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-border-default)]">
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
      <div className={cn('mt-0.5 truncate tabular-nums', muted ? 'text-[13px] leading-[22px] text-[var(--color-text-muted)]' : 'text-[18px] font-medium leading-[22px] text-[var(--color-text-primary)]')}>{value}</div>
      <div className="h-4 truncate text-[10.5px] text-[var(--color-text-muted)]">{hint}</div>
    </button>
  )
}

const sourceRows = (sum: UsageSummary): SourceRow[] => SOURCES.map(([k, label]) => ({ ...sum.bySource[k], key: k, label: tr(label) }))
const sourceShares = (sum: UsageSummary) => shares(sourceRows(sum).map((r) => ({ label: r.label, value: totalTokens(r) }))).map((x, i) => ({ ...x, color: PALETTE[i] }))
const modelShares = (sum: UsageSummary) => shares(sum.models.map((m) => ({ label: m.model, value: totalTokens(m) }))).map((x, i) => ({ ...x, color: x.item ? PALETTE[i] : PALETTE[5] }))   // 并入的「其它」用灰色
const sessionName = (s: SessionRow) => (s.title !== undefined ? tr(s.title) : tr('{id}…（已删除）', { id: s.sessionId.slice(0, 8) }))

function Overview({ sum, titles, go }: { sum: UsageSummary; titles: Map<string, string>; go: (v: UsageView) => void }) {
  const t = sum.totals
  const total = fmtTokens(totalTokens(t))
  return (
    <>
      <div className="grid grid-cols-5 gap-2">
        <Stat label={tr('请求数')} value={t.requests.toLocaleString()} hint={tr('共 {n} tokens', { n: total })} onClick={() => go('daily')} />
        <Stat label={tr('输入 tokens')} value={fmtTokens(t.input)} hint={tr('未命中缓存')} onClick={() => go('daily')} />
        <Stat label={tr('缓存 tokens')} value={fmtTokens(t.cacheRead)} hint={tr('命中率 {pct}', { pct: pct(cacheHitRate(t)) })} onClick={() => go('daily')} />
        <Stat label={tr('输出 tokens')} value={fmtTokens(t.output)} onClick={() => go('daily')} />
        <Stat label={tr('估算花费')} value={fmtCost(t.cost, sum.currency)} muted={t.cost === undefined}
          hint={t.cost === undefined ? tr('点这里填单价') : t.unpriced ? tr('另有 {n} 次未设单价', { n: t.unpriced }) : undefined} onClick={() => go(t.cost === undefined ? 'prices' : 'model')} />
      </div>
      <Card title={tr('每日 tokens')} onMore={() => go('daily')}>
        {t.requests ? <DailyChart days={fillDays(sum)} currency={sum.currency} /> : <Empty />}
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Card title={tr('来源占比')} onMore={() => go('source')}>
          {t.requests ? <Donut items={sourceShares(sum)} total={total} /> : <Empty />}
        </Card>
        <Card title={tr('模型占比')} onMore={() => go('model')}>
          {t.requests ? <Donut items={modelShares(sum)} total={total} /> : <Empty />}
        </Card>
      </div>
      <Card title={tr('会话 Top 5')} onMore={() => go('session')}>
        {sum.sessions.length ? (
          <BarList items={sum.sessions.slice(0, 5).map((s) => ({ key: s.sessionId, label: sessionName({ ...s, title: titles.get(s.sessionId) }), value: totalTokens(s), text: fmtTokens(totalTokens(s)) }))} />
        ) : <Empty />}
      </Card>
    </>
  )
}

function DailyView({ sum }: { sum: UsageSummary }) {
  const days = fillDays(sum)
  const cols: Col<UsageSummary['days'][number]>[] = [{ key: 'day', label: tr('日期'), left: true, sort: (r) => r.day, render: (r) => r.day }, ...totalsCols(sum.currency)]
  return (
    <>
      <Card title={tr('每日 tokens')} tip={tr('鼠标停在柱子上看当天明细。')}>
        {sum.totals.requests ? <DailyChart days={days} currency={sum.currency} className="h-52" /> : <Empty />}
      </Card>
      <Card title={tr('每日明细')} tip={tr('只列有请求的日子；点表头排序。')}>
        {sum.days.length ? <SortTable cols={cols} rows={sum.days} rowKey={(r) => r.day} initial={{ key: 'day', dir: 'desc' }} /> : <Empty />}
      </Card>
    </>
  )
}

function SourceView({ sum }: { sum: UsageSummary }) {
  const cols: Col<SourceRow>[] = [{ key: 'label', label: tr('来源'), left: true, sort: (r) => r.label, render: (r) => r.label }, ...totalsCols<SourceRow>(sum.currency)]
  return (
    <>
      <Card title={tr('来源占比（tokens）')} tip={tr('对话 = 你在会话里发起的请求；定时巡检 = 无人值守巡检会话；其它 = 不属于会话的一次性调用（如自然语言写命令）。')}>
        {sum.totals.requests ? <Donut items={sourceShares(sum)} total={fmtTokens(totalTokens(sum.totals))} /> : <Empty />}
      </Card>
      <Card title={tr('来源明细')}>
        <SortTable cols={cols} rows={sourceRows(sum)} rowKey={(r) => r.key} initial={{ key: 'tokens', dir: 'desc' }} />
      </Card>
    </>
  )
}

function SessionView({ sum, titles, onOpenSession }: { sum: UsageSummary; titles: Map<string, string>; onOpenSession: (sid: string) => void }) {
  const rows: SessionRow[] = sum.sessions.map((s) => ({ ...s, title: titles.get(s.sessionId) }))
  const cols: Col<SessionRow>[] = [
    { key: 'name', label: tr('会话'), left: true, sort: sessionName, render: (s) => (
      <button disabled={!s.title} onClick={() => onOpenSession(s.sessionId)} title={s.title ? tr('打开会话') : tr('会话已删除')}
        className="max-w-[240px] truncate text-left hover:text-[var(--color-accent)] disabled:text-[var(--color-text-muted)] disabled:hover:text-[var(--color-text-muted)]">
        {sessionName(s)}{s.unattended && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">{tr('巡检')}</span>}
      </button>
    ) },
    ...totalsCols<SessionRow>(sum.currency),
  ]
  if (!rows.length) return <Card title={tr('会话排行')}><Empty /></Card>
  return (
    <>
      <Card title={tr('会话排行（tokens）')} tip={tr('只列 tokens 最多的 20 个会话。')}>
        <BarList items={rows.slice(0, 10).map((s, i) => ({ key: s.sessionId, label: sessionName(s), value: totalTokens(s), text: fmtTokens(totalTokens(s)), color: PALETTE[i % 5] }))} />
      </Card>
      <Card title={tr('会话明细')} tip={tr('点会话名打开该会话；已删除的会话只显示 id。点表头排序。')}>
        <SortTable cols={cols} rows={rows} rowKey={(r) => r.sessionId} initial={{ key: 'tokens', dir: 'desc' }} />
      </Card>
    </>
  )
}

function ModelView({ sum }: { sum: UsageSummary }) {
  const cols: Col<ModelRow>[] = [
    { key: 'model', label: tr('模型'), left: true, sort: (r) => r.model, render: (r) => <span className="inline-block max-w-[200px] truncate align-bottom" title={r.model}>{r.model}</span> },
    { key: 'provider', label: tr('提供商'), left: true, sort: (r) => providerLabel(r.provider), render: (r) => <span className="text-[var(--color-text-secondary)]">{providerLabel(r.provider)}</span> },
    ...totalsCols<ModelRow>(sum.currency),
  ]
  if (!sum.models.length) return <Card title={tr('模型占比')}><Empty /></Card>
  return (
    <>
      <Card title={tr('模型占比（tokens）')}>
        <Donut items={modelShares(sum)} total={fmtTokens(totalTokens(sum.totals))} />
      </Card>
      <Card title={tr('模型明细')} tip={tr('花费按「单价设置」里的单价估算；没设单价的模型显示「未设置单价」。')}>
        <SortTable cols={cols} rows={sum.models} rowKey={(r) => `${r.provider}/${r.model}`} initial={{ key: 'tokens', dir: 'desc' }} />
      </Card>
    </>
  )
}
