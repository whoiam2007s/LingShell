import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Bot, CheckCircle2, HardDrive, Loader2, Play, Stethoscope, X, Sparkles } from 'lucide-react'
import { paletteSend } from '../../lib/paletteBus.js'
import {
  certDaysLeft, diffIsEmpty, diffProfiles, findIssues, hostCheckSupported, profileReportText, redactSecrets, summarizeDiff,
  basisText, certForecastText, dayText, trendLevel, tr,
  type HostProfile, type HostTrend, type ProfileMeta, type TerminalInfo,
} from '@lingshell/shared'
import { HelpTip } from '../../components/ui/form.js'
import { askAiTroubleshoot } from '../../lib/askAi.js'
import { ComplianceTab } from './ComplianceTab.js'
import { trx } from '../../lib/trx.js'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { Select } from '../../components/ui/Select.js'
import { ProfileDiffView, errText, fmtTime, BTN } from './ProfileDiffView.js'

// 主机体检：当前 SSH 终端所在主机（Linux）一次只读采集 → 结构化档案（按主机存最近 20 份）→ 分区卡片 + 「发现的问题」；
// 顶部「和上次比」看配置漂移；「让 AI 解读」把报告摘要（脱敏）发到对话。切终端时由外层 key 重挂载

const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
const kb = (n?: number) => (n === undefined ? '?' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} GB` : `${Math.round(n / 1024)} MB`)
const metaLabel = (m: ProfileMeta) => `${fmtTime(m.at)} · ${m.type === 'check' ? tr('体检') : tr('AI 变更快照')}${m.type === 'check' ? ` · ${m.issues ? tr('{n} 个问题', { n: m.issues }) : tr('无问题')}` : ''}`

function Card({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">{title}<span className="ml-auto font-normal">{extra}</span></div>
      <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)]">{children}</div>
    </div>
  )
}
const KV = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex gap-2 py-[1px]"><span className="w-20 shrink-0 text-[var(--color-text-muted)]">{k}</span><span className="min-w-0 break-all">{children}</span></div>
)
const Muted = ({ children }: { children: ReactNode }) => <span className="text-[var(--color-text-muted)]">{children}</span>
const pctColor = (p: number) => (p >= 95 ? 'var(--color-danger)' : p > 85 ? 'var(--color-warn)' : 'var(--color-accent)')

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-bg-hover)]">
      <div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: pctColor(pct) }} />
    </div>
  )
}

const LEVEL_COLOR = { danger: 'var(--color-danger)', warn: 'var(--color-warn)', normal: 'var(--color-text-primary)' } as const
// 「趋势」分区：磁盘按体检档案（长期）/ 仪表盘采样（短期）线性外推约几天写满；证书按到期日算剩几天。数据不足的不预测
function TrendCard({ trend }: { trend?: HostTrend }) {
  const certs = (trend?.certs ?? []).filter((c) => c.days <= 90)
  const none = !trend || (!trend.disks.length && !trend.samples && !certs.length)
  return (
    <Card title={tr('趋势')} extra={<HelpTip>{tr('磁盘：按各次体检的已用比例做最小二乘直线外推（优先近 7 天；清理过磁盘的从清理后算起），至少 3 次体检、跨半天以上且在涨才预测；另按仪表盘最近的采样（只有约 60 个点，短期）给一份参考。证书：直接按到期日算，只列 90 天内到期的。< 14 天标黄，< 3 天标红。')}</HelpTip>}>
      <div data-hostcheck-trend>
        {none ? <Muted>{trend && trend.profiles < 3 ? tr('体检档案只有 {n} 份，至少 3 份（跨半天以上）才预测磁盘；没有 90 天内到期的证书', { n: trend.profiles }) : tr('磁盘没有明显增长、数据不足或没有 90 天内到期的证书，暂无预测')}</Muted> : <>
          {trend.disks.map((f) => (
            <div key={f.mount} data-trend-disk={f.mount} className="flex items-baseline gap-1.5 py-[1px]">
              <span className="font-mono">{f.mount}</span>
              <span style={{ color: LEVEL_COLOR[trendLevel(f.days)] }}>{tr('{days}后写满', { days: dayText(f.days) })}</span>
              <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]">{tr('（当前 {pct}%，{basis}）', { pct: Math.round(f.current), basis: basisText(f) })}</span>
            </div>
          ))}
          {trend.samples && (
            <div data-trend-samples className="flex items-baseline gap-1.5 py-[1px]">
              <span className="font-mono">{trend.samples.mount}</span>
              <span style={{ color: LEVEL_COLOR[trendLevel(trend.samples.days)] }}>{trend.samples.days < 1 ? tr('按最近采样不到 1 天写满') : tr('按最近采样约 {n} 天写满', { n: Math.round(trend.samples.days) })}</span>
              <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]">{tr('（{s}）', { s: basisText(trend.samples) })}</span>
            </div>
          )}
          {certs.map((c) => (
            <div key={c.path} data-trend-cert className="flex items-baseline gap-1.5 py-[1px]">
              <span style={{ color: LEVEL_COLOR[c.days < 0 ? 'danger' : trendLevel(c.days)] }}>{certForecastText(c)}</span>
            </div>
          ))}
        </>}
      </div>
    </Card>
  )
}

export function HostCheckDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && hostCheckSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const [hist, setHist] = useState<{ hostKey: string; items: ProfileMeta[] }>()
  const [cur, setCur] = useState<HostProfile>()
  const [baseId, setBaseId] = useState<string>('')
  const [base, setBase] = useState<HostProfile>()
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')

  const loadHist = useCallback(() => ok ? client.hostCheck.history(tid).then((h) => { setHist(h); return h }) : Promise.resolve(undefined), [ok, tid])
  const open = useCallback((id: string) => { client.hostCheck.get(tid, id).then(setCur, (e) => setErr(errText(e))) }, [tid])
  // 首次打开：显示最近一份体检（没有就最近一份快照）
  useEffect(() => {
    loadHist().then((h) => { const m = h?.items.find((x) => x.type === 'check') ?? h?.items[0]; if (m) open(m.id) }).catch((e) => setErr(errText(e)))
  }, [loadHist, open])

  // 对比基准：默认是这份之前最近的一份体检（没有体检就最近一份快照）
  const older = useMemo(() => (hist && cur ? hist.items.filter((m) => m.at < cur.at) : []), [hist, cur])
  useEffect(() => { setBaseId((older.find((m) => m.type === 'check') ?? older[0])?.id ?? '') }, [older])
  useEffect(() => {
    setBase(undefined)
    if (baseId) client.hostCheck.get(tid, baseId).then(setBase, () => setBase(undefined))
  }, [tid, baseId])

  const run = () => {
    setRunning(true); setErr('')
    client.hostCheck.run(tid).then((p) => { setCur(p); return loadHist() }).catch((e) => setErr(errText(e))).finally(() => setRunning(false))
  }
  const issues = useMemo(() => (cur ? findIssues(cur) : []), [cur])
  const diff = useMemo(() => (cur && base ? diffProfiles(base, cur) : undefined), [cur, base])
  // 「体检 | 合规」两页；趋势（磁盘约几天写满 / 证书剩几天）按体检档案 + 仪表盘采样算，换档案 / 新体检后刷新
  const [tab, setTab] = useState<'check' | 'compliance'>('check')
  const [trend, setTrend] = useState<HostTrend>()
  const hostKey = hist?.hostKey
  useEffect(() => {
    if (!hostKey) return
    client.trend.get([hostKey]).then((r) => setTrend(r[hostKey])).catch(() => setTrend(undefined))
  }, [hostKey, hist?.items.length])
  // 问题项「用 AI 排查」：开新会话，带上这份体检的摘要
  const askIssue = (text: string) => {
    if (!cur || !term) return
    askAiTroubleshoot({ host: term.title, ...(hostKey && !hostKey.includes(':') ? { hostId: hostKey } : {}), terminalId: term.id, alert: text, context: `主机体检报告摘要（${fmtTime(cur.at)}）：\n${profileReportText(cur, issues, diff)}` })   // i18n-ignore 发给模型的上下文
  }
  const explain = () => {
    if (!cur) return
    const text = redactSecrets(profileReportText(cur, issues, diff))
    // i18n-ignore-next 发给模型的提示词
    sendToChat(`请解读下面这份主机体检报告（应用自动只读采集），按严重程度列出问题和处理建议；需要在主机上执行命令时先说明目的再执行。\n\n${text}`)
  }

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <Stethoscope className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">{tr('主机体检')}</span>
      {term && <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]">{term.title}</span>}
      <span className="ml-auto" />
      {ok && tab === 'check' && (
        <button data-hostcheck-run disabled={running} onClick={run} title={tr('只读采集一次（独立通道，不进终端和命令历史，不经过 AI），最长约 45 秒')}
          className="flex shrink-0 items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{running ? tr('体检中…') : tr('开始体检')}
        </button>
      )}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )
  if (!ok) return (
    <div className="flex h-full flex-col">{header}
      <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('主机体检只支持 Linux 的 SSH 终端：先切到一个 SSH 终端再打开。')}</div>
    </div>
  )

  const p = cur
  const tabs = (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 pt-1" role="tablist">
      {([['check', tr('体检')], ['compliance', tr('合规')]] as const).map(([k, label]) => (
        <button key={k} role="tab" aria-selected={tab === k} data-hostcheck-tab={k} onClick={() => setTab(k)}
          className={cn('-mb-px border-b-2 px-2 pb-1 text-[12px]', tab === k ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>{label}</button>
      ))}
    </div>
  )
  if (tab === 'compliance' && term) return (
    <div className="flex h-full flex-col" data-hostcheck-drawer>
      {header}{tabs}
      <ComplianceTab term={term} hostKey={hostKey} />
    </div>
  )
  return (
    <div className="flex h-full flex-col" data-hostcheck-drawer>
      {header}{tabs}
      {hist && hist.items.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('档案')}</span>
          <Select size="sm" className="min-w-0 flex-1" value={p?.id ?? ''} onValueChange={open} options={hist.items.map((m) => ({ value: m.id, label: metaLabel(m) }))} />
          <button data-hostcheck-ai disabled={!p} onClick={explain} title={tr('把报告摘要（已脱敏）发到对话，请 AI 给处理建议')} className={cn(BTN, 'h-7 text-[var(--color-accent)]')}><Bot className="h-3 w-3" />{tr('让 AI 解读')}</button>
        </div>
      )}
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {!p && !running && <div className="py-2 text-[12px] text-[var(--color-text-muted)]">{hist ? tr('这台主机还没有体检记录，点右上角「开始体检」。') : tr('读取中…')}</div>}
        {!p && running && <div className="flex items-center gap-1.5 py-2 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('正在采集（最长约 45 秒）…')}</div>}
        {p && <>
          <div className="text-[10.5px] text-[var(--color-text-muted)]">
            {p.type === 'check' ? tr('体检') : tr('AI 变更快照（只采端口 / 失败服务 / 容器 / 配置文件）')} · {fmtTime(p.at)}
            {p.partial && <span className="text-[var(--color-warn)]">{tr(' · 采集超时，部分内容缺失')}</span>}
          </div>

          <Card title={tr('和上次比')} extra={older.length > 0 && (
            <Select size="sm" className="w-56" value={baseId} onValueChange={setBaseId} options={older.map((m) => ({ value: m.id, label: metaLabel(m) }))} />
          )}>
            {!older.length ? <Muted>{tr('这是这台主机的第一份档案，下次体检后就能看到变化。')}</Muted>
              : !diff ? <Muted>{tr('读取中…')}</Muted>
              : <div data-hostcheck-drift>
                <div className="mb-1 flex flex-wrap gap-1">
                  {diffIsEmpty(diff) ? <span className="flex items-center gap-1 text-[var(--color-success)]"><CheckCircle2 className="h-3 w-3" />{tr('没有变化')}</span>
                    : summarizeDiff(diff).map((s) => <span key={s} className="rounded bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-1.5 text-[10.5px] text-[var(--color-warn)]">{s}</span>)}
                </div>
                {!diffIsEmpty(diff) && <ProfileDiffView diff={diff} hostKey={p.hostKey} terminalId={tid} />}
              </div>}
          </Card>

          {p.type === 'check' && (
            <Card title={tr('发现的问题（{n}）', { n: issues.length })}>
              <div data-hostcheck-issues>
                {issues.length === 0 ? <span className="flex items-center gap-1 text-[var(--color-success)]"><CheckCircle2 className="h-3 w-3" />{tr('没有发现问题')}</span>
                  : issues.map((i) => (
                    <div key={i.text} data-issue={i.kind} className="group flex items-start gap-1.5 py-[1px]">
                      <AlertTriangle className={cn('mt-[2px] h-3 w-3 shrink-0', i.level === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]')} />
                      <span className={cn('min-w-0 flex-1', i.level === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>{i.text}</span>
                      {i.kind === 'disk' && i.path && (
                        <button data-issue-disk onClick={() => paletteSend({ type: 'diskUsage', path: i.path })} title={tr('打开「磁盘占用」，逐层看这个分区里谁占了空间（只读）')}
                          className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] text-[var(--color-accent)] opacity-60 hover:bg-[var(--color-bg-hover)] group-hover:opacity-100"><HardDrive className="h-3 w-3" />{tr('分析占用')}</button>
                      )}
                      <button data-issue-ai onClick={() => askIssue(i.text)} title={tr('新开一个会话，把这个问题和体检摘要发给 AI 排查原因')}
                        className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] text-[var(--color-accent)] opacity-60 hover:bg-[var(--color-bg-hover)] group-hover:opacity-100"><Sparkles className="h-3 w-3" />{tr('用 AI 排查')}</button>
                    </div>
                  ))}
              </div>
            </Card>
          )}

          {p.type === 'check' && <TrendCard trend={trend} />}

          {(p.sys || p.cpu || p.mem) && (
            <Card title={tr('系统')}>
              {p.sys && <>
                <KV k={tr('系统')}>{p.sys.os ?? <Muted>?</Muted>}</KV>
                <KV k={tr('内核')}>{tr('{kernel}（{arch}）', { kernel: p.sys.kernel ?? '?', arch: p.sys.arch ?? '?' })}</KV>
                <KV k={tr('主机名')}>{p.sys.hostname ?? '?'}</KV>
                {p.sys.uptimeSec !== undefined && <KV k={tr('运行时间')}>{tr('{d} 天 {h} 小时', { d: Math.floor(p.sys.uptimeSec / 86400), h: Math.floor((p.sys.uptimeSec % 86400) / 3600) })}</KV>}
              </>}
              {p.cpu && <KV k="CPU">{tr('{n} 核 · 负载 {load}', { n: p.cpu.cores ?? '?', load: p.cpu.load?.join(' / ') ?? '?' })}</KV>}
              {p.mem && <KV k={tr('内存')}>{tr('共 {total} · 可用 {avail}', { total: kb(p.mem.totalKb), avail: kb(p.mem.availKb) })}{p.mem.swapTotalKb ? tr(' · swap 已用 {used} / {total}', { used: kb((p.mem.swapTotalKb ?? 0) - (p.mem.swapFreeKb ?? 0)), total: kb(p.mem.swapTotalKb) }) : tr(' · 无 swap')}</KV>}
            </Card>
          )}

          {p.disks && (
            <Card title={tr('磁盘')}>
              {p.disks.length === 0 ? <Muted>{tr('没有读到挂载点')}</Muted> : p.disks.map((d) => (
                <div key={d.mount} className="py-0.5">
                  <div className="flex items-baseline gap-1.5"><span className="min-w-0 flex-1 truncate font-mono" title={`${d.fs} → ${d.mount}`}>{d.mount}</span>
                    <span style={{ color: pctColor(d.usedPct) }}>{d.usedPct}%</span>
                    <span className="w-24 shrink-0 text-right text-[10.5px] text-[var(--color-text-muted)]">{kb(d.sizeKb)}{d.inodePct !== undefined && <> · inode <span style={{ color: d.inodePct > 85 ? pctColor(d.inodePct) : undefined }}>{d.inodePct}%</span></>}</span>
                  </div>
                  <Bar pct={d.usedPct} />
                </div>
              ))}
            </Card>
          )}

          {p.ports !== undefined && (
            <Card title={p.ports ? tr('监听端口（{n}）', { n: p.ports.length }) : tr('监听端口')}>
              {p.ports === null ? <Muted>{tr('远端没有 ss / netstat')}</Muted> : p.ports.length === 0 ? <Muted>{tr('没有 TCP 监听')}</Muted>
                : <div className="flex flex-wrap gap-1 font-mono">{p.ports.map((x) => <span key={`${x.addr}|${x.port}`} title={x.process ? tr('{name}（PID {pid}）', { name: x.process, pid: x.pid ?? '' }) : x.addr} className="rounded bg-[var(--color-bg-hover)] px-1">{x.addr === '0.0.0.0' || x.addr === '::' || x.addr === '*' ? '' : `${x.addr}:`}{x.port}{x.process && <span className="text-[var(--color-text-muted)]"> {x.process}</span>}</span>)}</div>}
            </Card>
          )}

          {p.failedUnits !== undefined && (
            <Card title={tr('systemd 失败服务')}>
              {p.failedUnits === null ? <Muted>{tr('没有 systemctl（非 systemd 系统）')}</Muted> : p.failedUnits.length === 0 ? <span className="text-[var(--color-success)]">{tr('无')}</span>
                : p.failedUnits.map((u) => <div key={u} className="font-mono text-[var(--color-danger)]">{u}</div>)}
            </Card>
          )}

          {p.containers !== undefined && (
            <Card title={p.containers ? tr('容器（{n}）', { n: p.containers.length }) : tr('容器')}>
              {p.containers === null ? <Muted>{tr('没有 docker，或当前用户无权访问 docker')}</Muted> : p.containers.length === 0 ? <Muted>{tr('没有容器')}</Muted>
                : p.containers.map((c) => (
                  <div key={c.name} className="flex items-baseline gap-1.5 py-[1px]">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.state === 'running' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]')} />
                    <span className="shrink-0 font-mono text-[var(--color-text-primary)]">{c.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-muted)]" title={c.image}>{c.image}</span>
                    <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{c.status ?? c.state}</span>
                  </div>
                ))}
            </Card>
          )}

          {p.files && (
            <Card title={tr('关键配置文件')}>
              {p.files.length === 0 ? <Muted>{tr('一个都不存在')}</Muted> : p.files.map((f) => (
                <div key={f.path} className="flex items-baseline gap-1.5 py-[1px]">
                  <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>{f.path}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]" title={f.sha256}>{f.unreadable ? tr('无权读取') : `${f.sha256?.slice(0, 10)}…`}</span>
                </div>
              ))}
            </Card>
          )}

          {(p.sshd || p.uid0 || p.logins) && (
            <Card title={tr('账号与 SSH')}>
              {p.sshd && <KV k="sshd">PermitRootLogin <b>{p.sshd.permitRootLogin}</b> · PasswordAuthentication <b>{p.sshd.passwordAuthentication}</b> <Muted>{p.sshd.source === 'sshd -T' ? tr('（生效配置）') : tr('（配置文件，未写的按默认值）')}</Muted></KV>}
              {p.uid0 && <KV k="UID 0">{p.uid0.join(tr('、')) || '?'}</KV>}
              {p.logins && <KV k={tr('最近登录')}>{p.logins.length === 0 ? <Muted>{tr('没有记录（或 last 不可用）')}</Muted>
                : p.logins.map((l, i) => <div key={i}><span className="font-mono">{l.user}@{l.ip}</span> <Muted>{l.time}</Muted></div>)}</KV>}
            </Card>
          )}

          {p.certs && (
            <Card title={tr('证书到期')}>
              {p.certs.length === 0 ? <Muted>{tr('没找到证书（/etc/letsencrypt/live 与 nginx 的 ssl_certificate）')}</Muted> : p.certs.map((c) => {
                const left = c.notAfter ? certDaysLeft(c.notAfter, new Date(p.at)) : undefined
                return (
                  <div key={c.path} className="flex items-baseline gap-1.5 py-[1px]">
                    <span className="min-w-0 flex-1 truncate font-mono" title={c.path}>{c.path}</span>
                    {left === undefined ? <Muted>{c.error}</Muted>
                      : <span className={left < 0 ? 'text-[var(--color-danger)]' : left <= 30 ? 'text-[var(--color-warn)]' : ''}>{tr('{date}（{left}）', { date: c.notAfter!.slice(0, 10), left: left < 0 ? tr('已过期') : tr('剩 {n} 天', { n: left }) })}</span>}
                  </div>
                )
              })}
            </Card>
          )}

          {p.updates && (
            <Card title={tr('可更新包')}>
              {p.updates.manager === 'none' && !p.updates.unknown ? <Muted>{tr('没有 dnf / yum / apt')}</Muted>
                : p.updates.unknown ? <Muted>{p.updates.unknown === 'timeout' ? tr('未知（检查超过 15 秒）') : tr('未知（包管理器报错）')}</Muted>
                : <>{trx('{manager}：共 {total} 个可更新，其中安全更新 {security} 个', { security: <span className={p.updates.security ? 'text-[var(--color-warn)]' : ''}>{p.updates.security ?? '?'}</span> }, { manager: p.updates.manager, total: p.updates.total ?? '?' })} <Muted>{tr('（按本地缓存，未联网刷新）')}</Muted></>}
            </Card>
          )}

          {p.notes?.map((n) => <div key={n} className="text-[10.5px] text-[var(--color-text-muted)]">{tr(n)}</div>)}
        </>}
      </div>
      <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1.5 text-[10.5px] text-[var(--color-text-muted)]">
        {tr('只读采集，走单独通道，不进终端和命令历史；每台主机保留最近 20 份体检和 20 份 AI 变更快照。')}
      </div>
    </div>
  )
}
