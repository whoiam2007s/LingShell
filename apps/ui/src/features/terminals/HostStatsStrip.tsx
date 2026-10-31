import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { HostStats, TerminalInfo } from '@lingshell/shared'
import { HOT_PCT, dateLocale, fmtBytes, fmtRate, fmtUptime, loadPct, memPct, scaleToPct, sparkPoints, tr } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 主机状态（主进程按 terminal:hostStats 推）：每终端最近 30 个样本 + 最近一次错误 / 不支持
const MAX_SAMPLES = 30
export interface StatsEntry { samples: HostStats[]; error?: string; unsupported?: boolean }
let state: Record<string, StatsEntry> = {}
const subs = new Set<() => void>()
client.on((ev) => {
  if (ev.type !== 'terminal:hostStats') return
  const { [ev.terminalId]: prev, ...rest } = state
  if (ev.stats) state = { ...rest, [ev.terminalId]: { samples: [...(prev?.samples ?? []), ev.stats].slice(-MAX_SAMPLES) } }
  else if (ev.error) state = { ...rest, [ev.terminalId]: { samples: prev?.samples ?? [], error: ev.error } }
  else if (ev.unsupported) state = { ...rest, [ev.terminalId]: { samples: [], unsupported: true } }
  else state = rest   // 清空：采集关了 / 不再采
  subs.forEach((f) => f())
})
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
export const useHostStats = () => useSyncExternalStore(subscribe, () => state)

// 告诉主进程只采这些可见终端；窗口最小化 / 切到后台时报空列表，回来再报
export function useWatchStats(visibleIds: string[]) {
  const key = visibleIds.filter(Boolean).join(',')
  useEffect(() => {
    const report = () => { client.terminal.watchStats(document.hidden || !key ? [] : key.split(',')).catch(() => {}) }
    report()
    document.addEventListener('visibilitychange', report)
    return () => { document.removeEventListener('visibilitychange', report); client.terminal.watchStats([]).catch(() => {}) }
  }, [key])
}

// 健康色：≤75% 绿，≤90% 黄，>90% 红
const WARN_PCT = 75
const tone = (n?: number) => n === undefined ? 'var(--color-text-muted)' : n > HOT_PCT ? 'var(--color-danger)' : n > WARN_PCT ? 'var(--color-warn)' : 'var(--color-success)'
const pctText = (n?: number) => n === undefined ? '—' : `${Math.round(n)}%`

function Bar({ label, value, detail }: { label: string; value?: number; detail: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between gap-2 tabular-nums">
        <span className="text-[var(--color-text-muted)]">{label}</span>
        <span style={{ color: tone(value) }}>{detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-border-default)]">
        {value !== undefined && <div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, background: tone(value) }} />}
      </div>
    </div>
  )
}

// 一或两条折线（第二条用警示色）；title 悬浮看刻度
function Spark({ values, values2, label, title }: { values: (number | undefined)[]; values2?: (number | undefined)[]; label: string; title?: string }) {
  const pts = sparkPoints(values, 180, 24), pts2 = values2 ? sparkPoints(values2, 180, 24) : ''
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className="w-12 shrink-0 truncate text-[var(--color-text-muted)]">{label}</span>
      <svg width="180" height="24" className="rounded bg-[var(--color-bg-base)]" aria-hidden>
        {pts && <polyline points={pts} fill="none" stroke="var(--color-accent)" strokeWidth="1.2" />}
        {pts2 && <polyline points={pts2} fill="none" stroke="var(--color-warn)" strokeWidth="1.2" />}
      </svg>
    </div>
  )
}
// 速率走势：两条序列按共同最大值缩放
function RateSpark({ label, a, b, names }: { label: string; a: (number | undefined)[]; b: (number | undefined)[]; names: [string, string] }) {
  const { scaled, max } = scaleToPct([a, b])
  return <Spark label={label} values={scaled[0]} values2={scaled[1]} title={tr('蓝线 {a}，黄线 {b}；顶部 = {max}', { a: names[0], b: names[1], max: fmtRate(max) })} />
}
const netTitle = (s: HostStats) => s.nets?.length
  ? `${tr('网络（每秒）：')}\n${s.nets.slice(0, 8).map((n) => `${n.name}${n.virtual ? tr('（虚拟）') : ''}  ↓${fmtRate(n.rx)}  ↑${fmtRate(n.tx)}`).join('\n')}`
  : `${tr('网络（每秒）：')}↓${fmtRate(s.netRx)}  ↑${fmtRate(s.netTx)}`

// 右下角两个小标签：CPU / MEM，文字颜色即健康状态；点开向上弹出详情（进度条、负载、运行时长、走势）
export function HostStatsTags({ active }: { active?: TerminalInfo }) {
  const all = useHostStats()
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pos) return
    const onDown = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) setPos(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null) }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [pos])
  useEffect(() => { setPos(null) }, [active?.id])

  const e = active ? all[active.id] : undefined
  if (!active || !e) return null   // 采集关着 / 还没数据：不占地方
  const TAG = 'shrink-0 rounded border border-[var(--color-border-subtle)] px-1.5 py-px text-[11px] tabular-nums'
  if (e.unsupported) return <span className={`${TAG} text-[var(--color-text-muted)]`} title={tr('暂不支持此系统的主机状态采集')}>{tr('状态 —')}</span>
  const s = e.samples.at(-1)
  if (!s) return <span className={`${TAG} text-[var(--color-text-muted)]`} title={e.error}>{tr('状态采集失败')}</span>
  const mp = memPct(s), lp = loadPct(s)
  const toggle = () => {
    if (pos) { setPos(null); return }
    const r = anchor.current!.getBoundingClientRect()
    setPos({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 })
  }
  return (
    <>
      <button ref={anchor} onClick={toggle} aria-expanded={!!pos}
        title={e.error ? tr('最近一次采集失败：{msg}（显示的是上次数据）', { msg: e.error }) : tr('主机状态，点击查看详情')}
        className={`flex shrink-0 items-center gap-1 rounded hover:bg-[var(--color-bg-hover)] ${e.error ? 'opacity-50' : ''}`}>
        <span className={TAG} style={{ color: tone(s.cpuPct) }}>CPU {pctText(s.cpuPct)}</span>
        <span className={TAG} style={{ color: tone(mp) }}>MEM {pctText(mp)}</span>
        {s.netRx !== undefined && <span className={`${TAG} text-[var(--color-text-secondary)]`} title={netTitle(s)}>↓{fmtBytes(s.netRx)} ↑{fmtBytes(s.netTx)}</span>}
        {s.diskRead !== undefined && <span className={`${TAG} text-[var(--color-text-secondary)]`} title={tr('磁盘 IO（每秒）：读 {r}  写 {w}', { r: fmtRate(s.diskRead), w: fmtRate(s.diskWrite) })}>IO {fmtBytes((s.diskRead ?? 0) + (s.diskWrite ?? 0))}</span>}
      </button>
      {pos && createPortal((
        <div ref={pop} role="dialog" aria-label={tr('主机状态')} style={{ right: pos.right, bottom: pos.bottom }}
          className="fixed z-[60] w-72 space-y-2.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-3 text-[11px] text-[var(--color-text-secondary)] shadow-2xl">
          <div className="font-medium text-[var(--color-text-primary)]">{active.title} · {new Date(s.at).toLocaleTimeString(dateLocale(), { hour12: false })}</div>
          <Bar label={s.cores ? tr('CPU（{n} 核）', { n: s.cores }) : 'CPU'} value={s.cpuPct} detail={pctText(s.cpuPct)} />
          <Bar label={tr('内存')} value={mp} detail={tr('{used} / {total}（{pct}）', { used: fmtBytes(s.memUsed), total: fmtBytes(s.memTotal), pct: pctText(mp) })} />
          <Bar label={tr('磁盘 /')} value={s.diskPct} detail={tr('{used} / {total}（{pct}）', { used: fmtBytes(s.diskUsed), total: fmtBytes(s.diskTotal), pct: pctText(s.diskPct) })} />
          {s.load && <Bar label={tr('负载')} value={lp} detail={s.load.map((x) => x.toFixed(2)).join(' / ')} />}
          {s.netRx !== undefined && (
            <div className="flex justify-between tabular-nums" title={netTitle(s)}><span className="text-[var(--color-text-muted)]">{tr('网络')}</span><span>↓ {fmtRate(s.netRx)} · ↑ {fmtRate(s.netTx)}</span></div>
          )}
          {s.nets && s.nets.length > 1 && (
            <div className="space-y-0.5 pl-2 text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {s.nets.slice(0, 4).map((n) => <div key={n.name} className="flex justify-between gap-2"><span className="truncate">{n.name}{n.virtual ? tr('（虚拟）') : ''}</span><span>↓ {fmtRate(n.rx)} · ↑ {fmtRate(n.tx)}</span></div>)}
            </div>
          )}
          {s.diskRead !== undefined && (
            <div className="flex justify-between tabular-nums"><span className="text-[var(--color-text-muted)]">{tr('磁盘 IO')}</span><span>{tr('读 {r} · 写 {w}', { r: fmtRate(s.diskRead), w: fmtRate(s.diskWrite) })}</span></div>
          )}
          <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{tr('运行时长')}</span><span>{fmtUptime(s.uptimeSec)}</span></div>
          {e.samples.length > 1
            ? <div className="space-y-1">
                <Spark label="CPU" values={e.samples.map((x) => x.cpuPct)} /><Spark label={tr('内存')} values={e.samples.map(memPct)} />
                {s.netRx !== undefined && <RateSpark label={tr('网络')} a={e.samples.map((x) => x.netRx)} b={e.samples.map((x) => x.netTx)} names={[tr('下行'), tr('上行')]} />}
                {s.diskRead !== undefined && <RateSpark label="IO" a={e.samples.map((x) => x.diskRead)} b={e.samples.map((x) => x.diskWrite)} names={[tr('io|读'), tr('io|写')]} />}
              </div>
            : <div className="text-[var(--color-text-muted)]">{tr('走势：采样中，几次刷新后显示')}</div>}
          {e.error && <div className="text-[var(--color-danger)]">{tr('最近一次采集失败：{msg}', { msg: e.error })}</div>}
          <div className="border-t border-[var(--color-border-subtle)] pt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            {active.type === 'ssh'
              ? tr('在服务器上经独立通道定时执行固定的只读命令（读 /proc、df 等），不经过你的终端，不进命令历史、日志和录像；服务器侧审计仍可能记下。可在「设置 → 通用」里关闭。')
              : tr('读取本机系统信息，不经过你的终端（Windows 上取网络流量会在后台跑一次 netstat -e）。可在「设置 → 通用」里关闭。')}
          </div>
        </div>
      ), document.body)}
    </>
  )
}
