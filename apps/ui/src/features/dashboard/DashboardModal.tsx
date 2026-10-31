// 「主机仪表盘」：每台已保存主机一张卡片（CPU / 内存 / 最满挂载点 / 负载 + 迷你走势、失败服务、容器、最近告警、体检问题数），
// 异常（CPU / 内存 > 90%、磁盘 > 85%、有失败服务、看门狗报警中）描红边排前面。
// 数据：主进程 dashboard:*（见 desktop/main/ops/hostDashboard.ts），打开期间每 2 秒拉一次快照；关闭时停掉未连接主机的采样。
// 自挂载：App 里常驻 <DashboardModal />，openDashboard() 打开。不能点遮罩关闭（按钮 / Esc）
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, LayoutDashboard, Search, MoreHorizontal, Stethoscope, Cog, EthernetPort, BookMarked, Network, Sparkles, AlertTriangle } from 'lucide-react'
import {
  DASH_INTERVALS, DASH_LIMITS, dashAskText, dashOnline, dashProblems, dashSummary, latestOf, sortDashCards, sparkPoints, tk, tr,
  type DashLatest, type DashOnline, type DashPoint, type DashSnapshot, type HostSummary, type Watchdog, type WatchdogState,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { Switch } from '../../components/ui/Switch.js'
import { HelpTip } from '../../components/ui/form.js'
import { ProdBadge } from '../../components/sshParts.js'
import { openKnowledge } from '../knowledge/index.js'
import { recordRecentHost } from '../hosts/index.js'
import { DASHBOARD_CLOSE_EVENT, DASHBOARD_OPEN_EVENT, useTermAlerts } from './dashboardBus.js'
import { basisText, diskForecastText, forecastFromSamples, fullShort, trendLevel, type DiskForecast, type HostTrend } from '@lingshell/shared'
import { askAiTroubleshoot } from '../../lib/askAi.js'
import { CertSoonBadge } from '../settings/index.js'

export function DashboardModal() {
  const [n, setN] = useState(0)   // 0 = 关；每次打开换 key 重新拉数据
  useEffect(() => {
    const f = () => setN((x) => x || Date.now())
    const c = () => setN(0)
    window.addEventListener(DASHBOARD_OPEN_EVENT, f)
    window.addEventListener(DASHBOARD_CLOSE_EVENT, c)
    return () => { window.removeEventListener(DASHBOARD_OPEN_EVENT, f); window.removeEventListener(DASHBOARD_CLOSE_EVENT, c) }
  }, [])
  // 锁定应用时收起
  useEffect(() => client.on((ev) => { if (ev.type === 'app:lock' && ev.locked) setN(0) }), [])
  if (!n) return null
  return <DashboardBody key={n} onClose={() => setN(0)} />
}

interface Card {
  h: HostSummary
  points: DashPoint[]
  latest: DashLatest
  online: DashOnline
  problems: string[]
  prod: boolean
  label: string
  sampling: boolean
  error?: string
  alerts: { at: number; text: string }[]   // 新的在前
  lastCheck?: { at: string; issues: number }
  trend?: DiskForecast                     // 最快写满的那个预测（体检档案 / 采样，见 shared/ops/trend.ts）
  trendTip?: string
  lastOkAt?: number                        // 最近一次成功采样（显示数据时间，避免把旧数据当当前值）
}
type Menu = { x: number; y: number; card: Card }

const pad = (n: number) => String(n).padStart(2, '0')
const hm = (t: number) => { const d = new Date(t); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
const ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--color-bg-hover)]'
const ONLINE: Record<DashOnline, [string, string]> = {
  connected: [tk('已连接'), 'var(--color-success)'],
  reachable: [tk('在线（采样）'), 'var(--color-success)'],
  error: [tk('采样失败'), 'var(--color-danger)'],
  idle: [tk('未采样'), 'var(--color-text-muted)'],
}

function DashboardBody({ onClose }: { onClose: () => void }) {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [snap, setSnap] = useState<DashSnapshot | null>(null)
  const [dogs, setDogs] = useState<Watchdog[]>([])
  const [dogStates, setDogStates] = useState<Map<string, WatchdogState>>(new Map())
  const [termHost, setTermHost] = useState<Record<string, string>>({})   // 终端 id → 主机 id（关键字告警归到主机）
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('*')
  const [onlyConnected, setOnlyConnected] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [now, setNow] = useState(Date.now())
  const termAlerts = useTermAlerts()
  // 趋势：体检档案的长期外推每分钟拉一次（采样的短期外推随快照现算）
  const [trends, setTrends] = useState<Record<string, HostTrend>>({})
  const hostIds = hosts.map((h) => h.id).join(',')
  useEffect(() => {
    if (!hostIds) return
    const pull = () => client.trend.get(hostIds.split(',')).then(setTrends).catch(() => {})
    pull()
    const t = setInterval(pull, 60_000)
    return () => clearInterval(t)
  }, [hostIds])

  // 打开：开始采样并拉快照；之后每 2 秒拉一次。关闭：停掉未连接主机的采样
  const [err, setErr] = useState('')
  const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  useEffect(() => {
    let alive = true
    client.hosts.list().then((x) => alive && setHosts(x)).catch((e) => { if (alive) setErr(tr('读取主机列表失败：{e}', { e: errText(e) })) })
    client.dashboard.open().then((s) => alive && setSnap(s)).catch((e) => { if (alive) setErr(tr('打开仪表盘失败：{e}', { e: errText(e) })) })
    client.watchdogs.list().then((x) => alive && setDogs(x)).catch(() => {})
    client.watchdogs.states().then((ss) => alive && setDogStates(new Map(ss.map((s) => [s.id, s])))).catch(() => {})
    const pull = () => {
      client.dashboard.snapshot().then((s) => { if (alive) { setSnap(s); setErr('') } }).catch((e) => { if (alive) setErr(tr('刷新失败：{e}', { e: errText(e) })) })
      client.terminal.list().then((ts) => alive && setTermHost(Object.fromEntries(ts.flatMap((t) => (t.hostId ? [[t.id, t.hostId]] : []))))).catch(() => {})
      setNow(Date.now())
    }
    // 不在这里再拉一次快照：open() 已经返回了同一份
    const t = setInterval(pull, 2000)
    const off = client.on((ev) => { if (ev.type === 'watchdog:state') setDogStates((m) => new Map(m).set(ev.state.id, ev.state)) })
    return () => { alive = false; clearInterval(t); off(); client.dashboard.close().catch(() => {}) }
  }, [])

  // Esc：先收菜单；上面还盖着别的弹层（下拉 / 确认框）时不关
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef(menu); menuRef.current = menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (menuRef.current) { setMenu(null); return }
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current && !rootRef.current?.contains(o))) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dogName = useMemo(() => new Map(dogs.map((w) => [w.id, w.name])), [dogs])
  const cards: Card[] = useMemo(() => {
    const interval = snap?.intervalSec ?? 30
    return hosts.map((h) => {
      const s = snap?.hosts[h.id]
      const points = s?.points ?? []
      const latest = latestOf(points)
      // 看门狗：这台正在报警的个数；最近的触发记录
      let firing = 0
      const alerts: Card['alerts'] = []
      for (const st of dogStates.values()) {
        if (st.hosts[h.id]?.status === 'firing') firing++
        for (const e of st.history) if (e.hostKey === h.id && e.kind === 'fire') alerts.push({ at: Date.parse(e.at), text: tr('看门狗「{name}」：{value}', { name: dogName.get(st.id) ?? st.id, value: e.value || tr('触发') }) })
      }
      for (const a of termAlerts) if (termHost[a.terminalId] === h.id) alerts.push({ at: a.at, text: tr('关键字告警：{text}', { text: a.text }) })
      alerts.sort((x, y) => y.at - x.at)
      // 磁盘预测：体检档案（各挂载点）+ 采样（最满挂载点）里最快写满的那个；全部写进悬停说明
      const fs = [...(trends[h.id]?.disks ?? []), ...[forecastFromSamples(points, now)].filter((x): x is DiskForecast => !!x)].sort((a, b) => a.days - b.days)
      const online = dashOnline({ connected: !!s?.connected, error: s?.error, lastOkAt: s?.lastOkAt }, interval, now)
      return {
        h, points, latest, label: h.label, prod: h.env === 'prod',
        ...(fs[0] ? { trend: fs[0], trendTip: fs.map((f) => tr('{text}（{basis}）', { text: diskForecastText(f), basis: basisText(f) })).join('\n') } : {}),
        online,
        // 数据已经过期（采样关了 / 停了很久）时不再拿旧指标报「异常」，看门狗报警仍然算
        problems: dashProblems(online === 'idle' ? {} : latest, firing),
        sampling: !!s?.sampling, error: s?.error, alerts, lastCheck: s?.lastCheck, lastOkAt: s?.lastOkAt,
      }
    })
  }, [hosts, snap, dogStates, dogName, termAlerts, termHost, now, trends])

  const groups = useMemo(() => [...new Set(hosts.map((h) => h.group ?? ''))].sort(), [hosts])
  const ql = q.trim().toLowerCase()
  const shown = sortDashCards(cards.filter((c) =>
    (group === '*' || (c.h.group ?? '') === group)
    && (!onlyConnected || c.online === 'connected')
    && (!ql || [c.h.label, c.h.host, c.h.group, c.h.username].some((x) => x?.toLowerCase().includes(ql)))))
  const sum = dashSummary(cards)
  const unconnected = cards.filter((c) => c.online !== 'connected')
  const allOn = unconnected.length > 0 && unconnected.every((c) => c.sampling)

  const refresh = () => client.dashboard.snapshot().then((s) => { setSnap(s); setErr('') }).catch((e) => setErr(tr('刷新失败：{e}', { e: errText(e) })))
  const retry = () => {
    setErr('')
    client.hosts.list().then(setHosts).catch((e) => setErr(tr('读取主机列表失败：{e}', { e: errText(e) })))
    void refresh()
  }
  const setSampling = (ids: string[], on: boolean) => { client.dashboard.setSampling(ids, on).then(refresh).catch((e) => setErr(tr('切换采样失败：{e}', { e: errText(e) }))) }

  // 点卡片：该主机已有终端就切过去，否则新连一个；关掉仪表盘
  const openTerm = async (h: HostSummary) => {
    onClose()
    const t = (await client.terminal.list().catch(() => [])).find((x) => x.hostId === h.id && x.status !== 'disconnected')
    if (t) { paletteSend({ type: 'focusTerm', id: t.id }); void recordRecentHost(h.id); return }
    paletteSend({ type: 'connectHost', hostId: h.id })
  }
  const act = (f: () => void) => () => { setMenu(null); onClose(); setTimeout(f, 0) }
  // 异常卡片「用 AI 排查」：开新会话，带上当前指标 / 最近告警 / 体检 / 趋势
  const askCard = (c: Card) => {
    const l = c.latest
    const ctx = [
      // i18n-ignore-next 发给模型的上下文
      `CPU ${pct(l.cpu)}${l.cores ? `（${l.cores} 核）` : ''}；内存 ${pct(l.mem)}；磁盘最满 ${l.diskMount ?? ''} ${pct(l.disk)}；负载 ${l.load1 !== undefined ? l.load1.toFixed(2) : '—'}；失败服务 ${l.failed ?? '—'}；容器 ${l.ctTotal !== undefined ? `${l.ctRunning ?? 0}/${l.ctTotal} 运行` : '—'}`,
      ...(c.alerts.length ? [`最近告警：${c.alerts.slice(0, 3).map((a) => `${hm(a.at)} ${a.text}`).join('；')}`] : []),   // i18n-ignore 发给模型的上下文
      ...(c.lastCheck ? [`最近一次主机体检（${hm(Date.parse(c.lastCheck.at))}）发现 ${c.lastCheck.issues} 个问题`] : []),   // i18n-ignore 发给模型的上下文
      ...(c.trendTip ? [`趋势：${c.trendTip.replace(/\n/g, '；')}`] : []),   // i18n-ignore 发给模型的上下文
    ].join('\n')
    askAiTroubleshoot({ host: c.label, hostId: c.h.id, alert: c.problems.join('；'), context: ctx })   // i18n-ignore 发给模型
    onClose()   // 仪表盘是全屏弹层：不关掉的话，新会话在下面根本看不见
  }

  return (
    <div ref={rootRef} data-dashboard-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onMouseDown={() => { if (menu) setMenu(null) }}>
      <div className="flex h-[94vh] w-[96vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        {/* 标题 + 汇总条 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--color-border-subtle)] px-4 py-2">
          <LayoutDashboard className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('主机仪表盘')}</span>
          <HelpTip>
            {tr('每台已保存主机一张卡片。已连接的主机直接用终端的连接采样；未连接的打开卡片上的「采样」（或顶部「全部采样」）后，按间隔临时连上去跑一条固定的只读命令（读 /proc、df、systemctl、docker）， 不在主机上写任何东西；关闭仪表盘即停止并断开。异常（CPU / 内存 > {cpu}%、磁盘 > {disk}%、有失败服务、看门狗报警中）描红边排在前面。点卡片打开该主机的终端。', { cpu: DASH_LIMITS.cpu, disk: DASH_LIMITS.disk })}
          </HelpTip>
          <div data-dash-summary className="flex items-center gap-1.5 text-[12px]">
            <Stat label={tr('主机')} value={sum.total} />
            <Stat label={tr('在线')} value={sum.online} color="var(--color-success)" />
            <Stat label={tr('异常')} value={sum.abnormal} color={sum.abnormal ? 'var(--color-danger)' : undefined} />
            <Stat label={tr('生产')} value={sum.prod} />
            <CertSoonBadge />
          </div>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-[var(--color-text-secondary)]">
            <label className="flex items-center gap-1.5" title={tr('对所有未连接的主机开 / 关采样')}>
              {tr('全部采样')}<Switch data-dash-all checked={allOn} disabled={!unconnected.length} onCheckedChange={(v) => setSampling(unconnected.map((c) => c.h.id), v)} />
            </label>
            <label className="flex items-center gap-1.5">{tr('间隔')}
              <Select size="sm" className="w-24" aria-label={tr('采样间隔')} value={String(snap?.intervalSec ?? 30)}
                onValueChange={(v) => { client.dashboard.setInterval(Number(v)).then(refresh).catch(() => {}) }}
                options={DASH_INTERVALS.map((s) => ({ value: String(s), label: tr('{n} 秒', { n: s }) }))} />
            </label>
            <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
          </div>
        </div>
        {err && (
          <div data-dash-error className="flex shrink-0 items-center gap-2 border-b border-[color:color-mix(in_srgb,var(--color-danger)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-4 py-1.5 text-[11.5px] text-[var(--color-danger)]">
            <span className="min-w-0 flex-1 truncate" title={err}>{err}</span>
            <button onClick={retry} className="shrink-0 rounded px-2 py-0.5 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">{tr('重试')}</button>
          </div>
        )}
        {/* 筛选 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索名称 / 地址 / 分组')} className="pl-8" aria-label={tr('搜索主机')} />
          </div>
          <Select size="sm" className="w-40" aria-label={tr('分组筛选')} value={group} onValueChange={setGroup}
            options={[{ value: '*', label: tr('全部分组') }, ...groups.map((g) => ({ value: g, label: g || tr('未分组') }))]} />
          <Select size="sm" className="w-32" aria-label={tr('范围')} value={onlyConnected ? 'conn' : 'all'} onValueChange={(v) => setOnlyConnected(v === 'conn')}
            options={[{ value: 'all', label: tr('全部主机') }, { value: 'conn', label: tr('只看已连接') }]} />
          <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('每张卡显示最近 60 个采样点 · 采样间隔 {n} 秒', { n: snap?.intervalSec ?? 30 })}</span>
        </div>
        {/* 卡片网格：按宽度自动分列 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!hosts.length && !err && <div className="py-16 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有已保存的主机。在「设置 → SSH 连接」里添加后，这里会出现它们的卡片。')}</div>}
          {hosts.length > 0 && !shown.length && <div className="py-16 text-center text-[12px] text-[var(--color-text-muted)]">{tr('没有符合筛选条件的主机')}</div>}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))' }}>
            {shown.map((c) => (
              <HostCard key={c.h.id} c={c} onOpen={() => void openTerm(c.h)} onSampling={(v) => setSampling([c.h.id], v)} onAskAi={act(() => askCard(c))}
                onMenu={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom + 4, card: c }) }} />
            ))}
          </div>
        </div>
      </div>
      {menu && (
        <div data-dash-menu style={{ left: Math.min(menu.x - 176, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 250) }} onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] w-44 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 text-[var(--color-text-primary)] shadow-lg">
          <button onClick={act(() => paletteSend({ type: 'hostDrawer', hostId: menu.card.h.id, drawer: 'hostcheck' }))} className={ITEM}><Stethoscope className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('主机体检')}</button>
          <button onClick={act(() => paletteSend({ type: 'hostDrawer', hostId: menu.card.h.id, drawer: 'systemd' }))} className={ITEM}><Cog className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('服务')}</button>
          <button onClick={act(() => paletteSend({ type: 'hostDrawer', hostId: menu.card.h.id, drawer: 'ports' }))} className={ITEM}><EthernetPort className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('端口')}</button>
          <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
          <button onClick={act(() => openKnowledge({ scope: 'host', target: menu.card.h.id }))} className={ITEM}><BookMarked className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{tr('知识库')}</button>
          <button onClick={act(() => quoteToChat(menu.card.h.group ? tr('在 {group} 所有主机上检查：', { group: menu.card.h.group }) : tr('在所有主机上检查：')))} className={ITEM}>
            <Network className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{menu.card.h.group ? tr('跨主机提问（{group}）', { group: menu.card.h.group }) : tr('跨主机提问')}
          </button>
          <button onClick={act(() => sendToChat(dashAskText(menu.card.h, menu.card.latest, { problems: menu.card.problems, alerts: menu.card.alerts.slice(0, 3).map((a) => `${hm(a.at)} ${a.text}`), lastCheck: menu.card.lastCheck ? { at: hm(Date.parse(menu.card.lastCheck.at)), issues: menu.card.lastCheck.issues } : undefined })))} className={ITEM}>
            <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('问 AI')}
          </button>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2 py-0.5">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <b className="tabular-nums" style={{ color: color ?? 'var(--color-text-primary)' }}>{value}</b>
    </span>
  )
}

// 颜色：超过异常阈值红，超过 75% 黄，其余绿；没数据灰
const tone = (v: number | undefined, limit: number) => v === undefined ? 'var(--color-text-muted)' : v > limit ? 'var(--color-danger)' : v > 75 ? 'var(--color-warn)' : 'var(--color-success)'
const pct = (v?: number) => (v === undefined ? '—' : `${Math.round(v)}%`)

function Metric({ label, value, text, series, limit, title, extra }: { label: string; value?: number; text: string; series: (number | undefined)[]; limit: number; title?: string; extra?: React.ReactNode }) {
  const pts = sparkPoints(series, 100, 20)
  const c = tone(value, limit)
  return (
    <div className="flex items-center gap-2 text-[11.5px]" title={title}>
      <span className="w-11 shrink-0 truncate text-[var(--color-text-muted)]">{tr(label)}</span>
      <span className="w-[5rem] shrink-0 truncate tabular-nums" style={{ color: c }}>{text}</span>
      <svg data-spark={label} data-points={series.filter((x) => x !== undefined).length} viewBox="0 0 100 20" preserveAspectRatio="none" className="h-5 min-w-0 flex-1 rounded bg-[var(--color-bg-panel)]" aria-hidden>
        {pts && <polyline points={pts} fill="none" stroke={c === 'var(--color-text-muted)' ? 'var(--color-accent)' : c} strokeWidth="1.3" vectorEffect="non-scaling-stroke" />}
      </svg>
      {extra}
    </div>
  )
}

// 磁盘行旁的「约 N 天满」：< 14 天黄、< 3 天红；挂载点不是当前显示的最满那个时带上挂载点
const TREND_COLOR = { danger: 'var(--color-danger)', warn: 'var(--color-warn)', normal: 'var(--color-text-muted)' } as const
function TrendTag({ f, mount }: { f: DiskForecast; mount?: string }) {
  return <span data-dash-trend={f.basis} className="shrink-0 text-[10.5px] tabular-nums" style={{ color: TREND_COLOR[trendLevel(f.days)] }}>{f.mount !== mount ? `${f.mount} ` : ''}{fullShort(f)}</span>
}

function HostCard({ c, onOpen, onSampling, onMenu, onAskAi }: { c: Card; onOpen: () => void; onSampling: (v: boolean) => void; onMenu: (e: React.MouseEvent) => void; onAskAi: () => void }) {
  const l = c.latest, bad = c.problems.length > 0
  const [onText, onColor] = c.online === 'idle' && c.sampling ? [tr('采样中'), 'var(--color-text-muted)'] : ONLINE[c.online]
  const loadPctOf = (p: DashPoint) => (p.load1 !== undefined && p.cores ? (p.load1 / p.cores) * 100 : undefined)
  const hasData = c.points.length > 0
  return (
    <div data-dash-card={c.h.label} data-abnormal={bad ? '1' : undefined} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      title={`${c.h.label} — ${c.h.username}@${c.h.host}:${c.h.port}\n${tr('点击打开终端')}`}
      className={cn('flex cursor-pointer flex-col gap-2 rounded-lg border bg-[var(--color-bg-base)] p-3 transition-colors hover:border-[var(--color-accent)]',
        bad ? 'border-[var(--color-danger)] shadow-[0_0_0_1px_var(--color-danger)]' : 'border-[var(--color-border-subtle)]')}>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: onColor }} title={tr(onText)} />
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{c.h.label}</span>
        {c.prod && <ProdBadge />}
        {c.h.group && <span className="shrink-0 truncate rounded bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-1.5 text-[10.5px] text-[var(--color-accent)]">{c.h.group}</span>}
        <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: onColor }}>{tr(onText)}</span>
        <button onClick={onMenu} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }} title={tr('更多')} aria-label={tr('更多')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {hasData ? (
        <div className="space-y-1">
          <Metric label="CPU" value={l.cpu} text={`${pct(l.cpu)}${l.cores ? ` · ${tr('{n}核', { n: l.cores })}` : ''}`} series={c.points.map((p) => p.cpu)} limit={DASH_LIMITS.cpu} />
          <Metric label={tk('内存')} value={l.mem} text={pct(l.mem)} series={c.points.map((p) => p.mem)} limit={DASH_LIMITS.mem} />
          <Metric label={tk('磁盘')} value={l.disk} text={`${pct(l.disk)}${l.diskMount ? ` ${l.diskMount}` : ''}`} series={c.points.map((p) => p.disk)} limit={DASH_LIMITS.disk}
            title={[l.diskMount ? tr('最满的挂载点：{mount}', { mount: l.diskMount }) : '', c.trendTip ?? ''].filter(Boolean).join('\n') || undefined}
            extra={c.trend && <TrendTag f={c.trend} mount={l.diskMount} />} />
          <Metric label={tk('负载')} value={l.load1 !== undefined && l.cores ? (l.load1 / l.cores) * 100 : undefined} text={l.load1 !== undefined ? l.load1.toFixed(2) : '—'}
            series={c.points.map(loadPctOf)} limit={100} title={tr('1 分钟负载；走势按核数折成百分比')} />
        </div>
      ) : (
        <div className="flex h-[6.5rem] items-center justify-center rounded border border-dashed border-[var(--color-border-subtle)] px-3 text-center text-[11.5px] text-[var(--color-text-muted)]">
          {c.online === 'connected' ? tr('采样中…') : c.sampling ? (c.error ? tr('采样失败：{e}', { e: c.error }) : tr('采样中…')) : tr('未连接。打开右下角「采样」查看状态')}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-secondary)]">
        <span>{tr('失败服务')} <b style={{ color: l.failed ? 'var(--color-danger)' : undefined }}>{l.failed ?? '—'}</b></span>
        <span>{tr('容器')} <b>{l.ctTotal !== undefined ? `${l.ctRunning ?? 0}/${l.ctTotal}` : '—'}</b></span>
        <span title={c.lastCheck ? tr('最近一次主机体检：{at}', { at: hm(Date.parse(c.lastCheck.at)) }) : tr('还没做过主机体检')}>
          {tr('体检')} <b style={{ color: c.lastCheck?.issues ? 'var(--color-warn)' : undefined }}>{c.lastCheck ? tr('{n} 个问题', { n: c.lastCheck.issues }) : '—'}</b>
        </span>
      </div>
      {c.problems.length > 0 && (
        <div data-dash-problems className="flex items-start gap-1 text-[11px] text-[var(--color-danger)]"><AlertTriangle className="mt-px h-3 w-3 shrink-0" /><span className="min-w-0 flex-1">{c.problems.join(' · ')}</span>
          <button data-dash-ai onClick={(e) => { e.stopPropagation(); onAskAi() }} title={tr('新开一个会话，把异常和当前指标发给 AI 排查原因')}
            className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"><Sparkles className="h-3 w-3" />{tr('用 AI 排查')}</button>
        </div>
      )}
      {c.alerts[0] && (
        <div className="truncate text-[11px] text-[var(--color-warn)]" title={c.alerts.slice(0, 5).map((a) => `${hm(a.at)} ${a.text}`).join('\n')}>
          {hm(c.alerts[0].at)} {c.alerts[0].text}
        </div>
      )}
      {c.error && hasData && <div className="truncate text-[11px] text-[var(--color-danger)]" title={c.error}>{tr('最近一次采样失败：{e}', { e: c.error })}</div>}
      <div className="mt-auto flex items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-1.5 text-[11px] text-[var(--color-text-muted)]"
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}>
        {c.lastOkAt !== undefined && c.online !== 'connected' && <span data-dash-at title={tr('最近一次成功采样的时间（旧数据不代表当前状态）')}>{tr('更新 {at}', { at: hm(c.lastOkAt) })}</span>}
        {c.online === 'connected'
          ? <span title={tr('已连接：直接用终端的连接采样')}>{tr('用终端连接采样')}</span>
          : <label className="flex items-center gap-1.5" title={tr('开启后仪表盘打开期间按间隔临时连接采样（只读）')}>{tr('采样')}<Switch data-dash-sample={c.h.label} checked={c.sampling} onCheckedChange={onSampling} /></label>}
      </div>
    </div>
  )
}
