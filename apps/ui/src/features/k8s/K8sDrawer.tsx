import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRightLeft, Boxes, HeartPulse, Loader2, LogIn, MessageSquareQuote, RotateCcw, ScrollText, Sparkles, Square, SquareTerminal } from 'lucide-react'
import {
  K8S_KIND_OF, K8S_RESOURCES, fmtK8sAge, k8sDescribePrompt, k8sHealthPrompt, k8sHealthTitle, k8sProdContext, k8sRestartLabel, k8sSupported, podLevel, portsSupported, redactSecrets, workloadLevel, tr,
  type K8sForward, type K8sHealth, type K8sKind, type K8sList, type K8sPod, type K8sProbe, type K8sResource, type K8sRestartKind, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ConfirmDialog } from '../common/index.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { NumberInput } from '../../components/ui/NumberInput.js'
import { HelpTip } from '../../components/ui/form.js'
import { sendToChat, sendToNewChat } from '../../lib/sendToChat.js'
import { openLogViewer } from '../logs/index.js'
import { BTN, DrawerHeader, MUTED, PRIMARY, errText } from '../../components/ui/drawer.js'
import { noteKubectl } from '../../lib/kubectlSeen.js'
import { trx } from '../../lib/trx.js'

// Kubernetes 视图（参照 k9s）：当前终端所在机器（SSH 主机 / 本机）上的 kubectl，按上下文 + 命名空间看 Pod / Deployment / StatefulSet / Service / Ingress / 事件，
// 异常置顶标红；选中后看 describe / YAML / 日志（含上一个容器），进入容器、跟踪日志、端口转发、滚动重启（确认 + 执行记录，生产多一步确认）、交给 AI；另有集群体检。
// 读操作都走独立通道（见 desktop/main/k8sIpc.ts），选的上下文只加在本视图的命令上，不改 kubeconfig 默认值。切终端时由外层 key 重挂载
type Tab = K8sResource | 'health'
type Sel = { res: K8sResource; name: string; namespace: string }
type Detail = { mode: 'describe' | 'yaml' | 'logs'; key: string; text?: string; error?: string }
const ALL = '*'   // 命名空间下拉里的「全部命名空间」
const TAB = 'shrink-0 rounded px-2 py-0.5 text-[11.5px]'
const ON = 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]'
const OFF = 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
const levelText = (l?: 'error' | 'warn') => (l === 'error' ? 'text-[var(--color-danger)]' : l === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-primary)]')
const levelDot = (l?: 'error' | 'warn') => (l === 'error' ? 'bg-[var(--color-danger)]' : l === 'warn' ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-success)]')

// 每台主机记住上次选的上下文 / 命名空间（只是本视图的选择，不写 kubeconfig）
const prefKey = (t: TerminalInfo) => `lingshell.k8s.view:${t.type === 'local' ? 'local' : t.hostId ?? t.detail ?? t.title}`
const loadPref = (t: TerminalInfo): { ctx?: string; ns?: string } => { try { return JSON.parse(localStorage.getItem(prefKey(t)) ?? '{}') } catch { return {} } }

export function K8sDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && k8sSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const local = term?.type === 'local'
  const [probe, setProbe] = useState<K8sProbe>()
  const [probeErr, setProbeErr] = useState('')
  const [ctx, setCtx] = useState('')
  const [ns, setNs] = useState('')            // ALL = 全部命名空间
  const [nsList, setNsList] = useState<string[]>()
  const [tab, setTab] = useState<Tab>('pods')
  const [list, setList] = useState<K8sList>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [onlyBad, setOnlyBad] = useState(false)
  const [sel, setSel] = useState<Sel>()
  const [detail, setDetail] = useState<Detail>()
  const [container, setContainer] = useState('')
  const [previous, setPrevious] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: K8sRestartKind; name: string; namespace: string }>()
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState('')
  const [actErr, setActErr] = useState('')
  const [flash, setFlash] = useState('')
  const [fwdAsk, setFwdAsk] = useState<{ kind: 'pod' | 'service'; name: string; namespace: string; ports: number[]; port: number }>()
  const [fwds, setFwds] = useState<K8sForward[]>([])
  const [health, setHealth] = useState<K8sHealth>()
  const [healthErr, setHealthErr] = useState('')
  const now = Date.now()
  const prod = term?.env === 'prod' || k8sProdContext(ctx)
  const c = ctx || undefined
  const nsArg = ns === ALL ? '' : ns
  const bgFwd = !!term && term.type === 'ssh' && portsSupported(term.type, term.os)   // SSH（Linux）：后台转发到本机；其它新开终端标签

  const note = (text: string) => { setFlash(text); setTimeout(() => setFlash((f) => (f === text ? '' : f)), 3000) }

  // 探测 kubectl 与上下文：上下文 / 命名空间默认取上次选的，否则 kubeconfig 当前上下文和它的默认命名空间
  const runProbe = useCallback(() => {
    if (!ok || !term) return
    setProbe(undefined); setProbeErr('')
    client.k8s.probe(tid).then((p) => {
      setProbe(p); noteKubectl(tid, p.kubectl)
      const pref = loadPref(term)
      const cx = pref.ctx && p.contexts.some((x) => x.name === pref.ctx) ? pref.ctx : p.current ?? p.contexts[0]?.name ?? ''
      setCtx(cx)
      setNs(pref.ctx === cx && pref.ns ? pref.ns : p.contexts.find((x) => x.name === cx)?.namespace ?? 'default')
    }).catch((e) => setProbeErr(errText(e)))
  }, [ok, tid])
  useEffect(() => { runProbe() }, [runProbe])
  const ready = !!probe?.kubectl && probe.contexts.length > 0 && !!ns
  useEffect(() => { if (ready && term) localStorage.setItem(prefKey(term), JSON.stringify({ ctx, ns })) }, [ready, ctx, ns])

  // 换上下文：命名空间列表重取（没权限就只给当前的）
  useEffect(() => {
    if (!ready) return
    let alive = true
    setNsList(undefined)
    client.k8s.namespaces(tid, c).then((l) => { if (alive) setNsList(l) }).catch(() => { if (alive) setNsList([]) })
    return () => { alive = false }
  }, [ready, ctx])

  const inflight = useRef(0)
  const refresh = useCallback(() => {
    if (!ready || tab === 'health') return
    const my = ++inflight.current
    setLoading(true)
    client.k8s.list(tid, c, nsArg, tab).then((l) => { if (my === inflight.current) { setList(l); setErr('') } })
      .catch((e) => { if (my === inflight.current) { setList(undefined); setErr(errText(e)) } })
      .finally(() => { if (my === inflight.current) setLoading(false) })
  }, [ready, tab, ctx, ns])
  useEffect(() => { setList(undefined); setSel(undefined); refresh() }, [refresh])

  const healthSeq = useRef(0)
  const runHealth = useCallback(() => {
    if (!ready) return
    const my = ++healthSeq.current
    setHealth(undefined); setHealthErr(''); setLoading(true)
    client.k8s.health(tid, c, nsArg)
      .then((h) => { if (my === healthSeq.current) setHealth(h) })
      .catch((e) => { if (my === healthSeq.current) setHealthErr(errText(e)) })
      .finally(() => { if (my === healthSeq.current) setLoading(false) })
  }, [ready, ctx, ns])
  useEffect(() => { if (tab === 'health' && !health && !healthErr) runHealth() }, [tab, runHealth, health, healthErr])
  // 切上下文 / 命名空间：旧体检结果作废，迟到的响应不能盖到新集群上
  useEffect(() => { healthSeq.current++; setHealth(undefined); setHealthErr('') }, [ctx, ns])

  const loadFwds = useCallback(() => { if (bgFwd) client.k8s.forwards(tid).then(setFwds).catch(() => {}) }, [bgFwd, tid])
  useEffect(() => { loadFwds() }, [loadFwds])
  // 转发在别处被停掉 / 断线重连时同步列表（与端口视图一致）
  useEffect(() => client.on((ev) => { if (ev.type === 'portForward:changed') loadFwds() }), [loadFwds])

  // 选中对象的 describe / YAML / 日志
  const selPod = sel?.res === 'pods' ? list?.pods?.find((p) => p.name === sel.name && p.namespace === sel.namespace) : undefined
  const selKind: K8sKind | undefined = sel && sel.res !== 'events' ? K8S_KIND_OF[sel.res] : undefined
  const loadDetail = useCallback((mode: Detail['mode']) => {
    if (!sel || !selKind) return
    const key = `${sel.namespace}/${sel.name}:${mode}:${container}:${previous}`
    setDetail({ mode, key })
    const p = mode === 'logs'
      ? client.k8s.logs(tid, c, sel.namespace, sel.name, { container: container || undefined, previous })
      : client.k8s.text(tid, c, sel.namespace, selKind, sel.name, mode)
    p.then((text) => setDetail((d) => (d?.key === key ? { ...d, text } : d))).catch((e) => setDetail((d) => (d?.key === key ? { ...d, error: errText(e) } : d)))
  }, [sel, selKind, ctx, container, previous])
  useEffect(() => { setActErr(''); setFwdAsk(undefined); setContainer(''); setPrevious(false); if (!sel) setDetail(undefined) }, [sel?.res, sel?.name, sel?.namespace])
  useEffect(() => { if (sel) loadDetail(detail?.mode === 'logs' && sel.res === 'pods' ? 'logs' : detail?.mode === 'yaml' ? 'yaml' : 'describe') }, [sel?.res, sel?.name, sel?.namespace, container, previous])

  const redact = async (text: string) => ((await client.settings.get().catch(() => undefined))?.system?.aiRedact === false ? text : redactSecrets(text))
  const askAi = async () => {
    if (!sel || !selKind) return
    const text = detail?.mode === 'describe' && detail.text ? detail.text : await client.k8s.text(tid, c, sel.namespace, selKind, sel.name, 'describe').catch((e) => tr('（读取 describe 失败：{err}）', { err: errText(e) }))
    sendToChat(await redact(k8sDescribePrompt(term?.title ?? '', c, selKind, sel.namespace, sel.name, text)))
    onClose()
  }
  const askHealth = async () => { if (health) { sendToNewChat(await redact(k8sHealthPrompt(term?.title ?? '', c, health)), k8sHealthTitle(c)); onClose() } }
  const openTerm = (what: 'exec' | 'logs' | 'portForward', p: { kind?: 'pod' | 'service'; name: string; namespace: string; container?: string; port?: number }) =>
    client.k8s.openTerminal(tid, c, p.namespace, what, p).then(() => onClose()).catch((e) => setActErr(errText(e)))
  // 多容器 Pod：exec / 跟随日志都必须带 -c（kubectl 不会替你选），默认第一个容器
  const containerOf = (p: K8sPod) => container || p.containers[0] || undefined
  const follow = (p: K8sPod) => {
    const cn = containerOf(p)
    if (bgFwd) { openLogViewer(tid, { kind: 'k8s', namespace: p.namespace, pod: p.name, ...(cn ? { container: cn } : {}), ...(c ? { context: c } : {}), ...(previous ? { previous: true } : {}) }); onClose() }
    else void openTerm('logs', { name: p.name, namespace: p.namespace, container: cn })
  }
  const startFwd = () => {
    const f = fwdAsk
    if (!f) return
    if (!bgFwd) { void openTerm('portForward', { kind: f.kind, name: f.name, namespace: f.namespace, port: f.port }); return }
    setBusy('fwd'); setActErr('')
    client.k8s.forward(tid, c, f.namespace, f.kind, f.name, f.port)
      .then((r) => { setFwdAsk(undefined); note(tr('已转发：本机 127.0.0.1:{lp} → {target}:{port}', { lp: r.localPort, target: r.target, port: r.port })); loadFwds() })
      .catch((e) => setActErr(`${tr('端口转发失败：')}\n${errText(e)}`)).finally(() => setBusy(''))
  }
  const doRestart = () => {
    const x = confirm
    if (!x) return
    setConfirm(undefined); setActErr(''); setBusy('restart')
    client.k8s.restart(tid, c, x.namespace, x.kind, x.name).then((out) => note(out || tr('已滚动重启 {obj}', { obj: `${x.kind}/${x.name}` })))
      .catch((e) => setActErr(`${tr('滚动重启 {name} 失败：', { name: x.name })}\n${errText(e)}`)).finally(() => { setBusy(''); refresh() })
  }

  // 列表过滤：名称 / 命名空间 / 状态子串；只看异常
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w))
  const pods = useMemo(() => (list?.pods ?? []).filter((p) => hit(`${p.namespace}/${p.name} ${p.status} ${p.node ?? ''}`) && (!onlyBad || podLevel(p))), [list, q, onlyBad])
  const workloads = useMemo(() => (list?.workloads ?? []).filter((w) => hit(`${w.namespace}/${w.name} ${w.images.join(' ')}`) && (!onlyBad || workloadLevel(w))), [list, q, onlyBad])
  const badCount = list?.pods ? list.pods.filter((p) => podLevel(p)).length : list?.workloads ? list.workloads.filter((w) => workloadLevel(w)).length : 0
  const allNs = ns === ALL
  const nm = (n: string, s: string) => (allNs ? <><span className={MUTED}>{n}/</span>{s}</> : s)
  const row = (key: string, s: Sel | undefined, title: string, cells: ReactNode) => (
    <div key={key} data-k8s-row={key} title={title} onClick={() => s && setSel(sel && sel.name === s.name && sel.namespace === s.namespace && sel.res === s.res ? undefined : s)}
      className={`flex cursor-default items-center gap-2 px-3 py-[3px] hover:bg-[var(--color-bg-hover)] ${s && sel?.name === s.name && sel.namespace === s.namespace && sel.res === s.res ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]' : ''}`}>{cells}</div>
  )
  const head = (cells: ReactNode) => <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-1 text-[10.5px] text-[var(--color-text-muted)]">{cells}</div>

  // ── 头部：上下文 / 命名空间 ──
  const nsOptions = [{ value: ALL, label: tr('全部命名空间') }, ...[...new Set([...(nsList ?? []), ...(ns && ns !== ALL ? [ns] : [])])].sort().map((n) => ({ value: n, label: n }))]
  const header = (
    <DrawerHeader icon={<Boxes className="h-3.5 w-3.5" />} title="Kubernetes" loading={loading}
      onRefresh={ready ? () => (tab === 'health' ? runHealth() : refresh()) : ok ? runProbe : undefined} onClose={onClose}
      extra={ready && probe ? <>
        <span title={tr('上下文：只影响本视图里的 kubectl 命令（加 --context），不改 kubeconfig 的默认上下文')} className="flex min-w-0 items-center gap-1">
          {prod && <span className="shrink-0 rounded bg-[var(--color-danger)] px-1 text-[10px] font-medium text-[var(--color-on-danger)]">{tr('生产')}</span>}
          <Select size="sm" className="w-[150px]" value={ctx} onValueChange={(v) => { setCtx(v); setNs(probe.contexts.find((x) => x.name === v)?.namespace ?? 'default') }}
            options={probe.contexts.map((x) => ({ value: x.name, label: `${x.name}${x.name === probe.current ? tr('（默认）') : ''}` }))} aria-label={tr('上下文')} />
        </span>
        <Select size="sm" className="w-[130px]" value={ns} onValueChange={setNs} options={nsOptions} aria-label={tr('命名空间')} title={tr('命名空间')} />
      </> : undefined} />
  )

  let body: ReactNode
  if (!ok) body = <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('Kubernetes 视图支持本地终端（本机装了 kubectl）和 Linux / macOS 的 SSH 终端：先切到一个这样的终端再打开。')}</div>
  else if (probeErr) body = <div className="whitespace-pre-wrap px-3 py-3 text-[12px] text-[var(--color-danger)]">{tr('探测 kubectl 失败：{err}', { err: probeErr })}</div>
  else if (!probe) body = <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('正在检测 kubectl…')}</div>
  else if (!probe.kubectl || !probe.contexts.length) body = <Guide local={local} noKubectl={!probe.kubectl} host={term?.title ?? ''} onRetry={runProbe} />
  else body = (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--color-border-subtle)] px-2 py-1">
        {K8S_RESOURCES.map((r) => <button key={r.id} data-k8s-tab={r.id} onClick={() => setTab(r.id)} className={`${TAB} ${tab === r.id ? ON : OFF}`}>{tr(r.label)}</button>)}
        <span className="mx-1 h-3.5 w-px bg-[var(--color-border-subtle)]" />
        <button data-k8s-tab="health" onClick={() => setTab('health')} className={`${TAB} flex items-center gap-1 ${tab === 'health' ? ON : OFF}`}><HeartPulse className="h-3 w-3" />{tr('集群体检')}</button>
        {probe.version && <span className={`ml-auto truncate text-[10px] ${MUTED}`} title={probe.version}>{probe.version.replace(/^Client Version:\s*/, 'kubectl ')}</span>}
      </div>
      {tab === 'health' ? <HealthView health={health} err={healthErr} loading={loading} onRun={runHealth} onAsk={() => void askHealth()} />
        : <>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
            <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('按名称 / 状态过滤')} />
            {(tab === 'pods' || tab === 'deployments' || tab === 'statefulsets') && (
              <button data-k8s-bad onClick={() => setOnlyBad((v) => !v)} title={tr('只看异常（状态不对 / 未就绪 / 频繁重启）')}
                className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] hover:bg-[var(--color-bg-hover)] ${onlyBad ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : badCount ? 'text-[var(--color-danger)]' : MUTED}`}>
                <AlertTriangle className="h-3 w-3" />{badCount ? tr('只看异常（{n}）', { n: badCount }) : tr('只看异常')}
              </button>
            )}
          </div>
          {err && <div data-k8s-err className="max-h-28 shrink-0 overflow-auto whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
          {fwds.length > 0 && (
            <div className="shrink-0 space-y-0.5 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px]">
              {fwds.map((f) => (
                <div key={f.id} data-k8s-fwd={f.id} className="flex items-center gap-1.5">
                  <ArrowRightLeft className={`h-3 w-3 shrink-0 ${f.ended ? MUTED : 'text-[var(--color-success)]'}`} />
                  <span className={`min-w-0 flex-1 truncate font-mono ${f.ended ? MUTED : 'text-[var(--color-text-secondary)]'}`} title={f.ended}>127.0.0.1:{f.localPort} → {f.namespace}/{f.target}:{f.port}{f.ended ? tr('（已结束：{reason}）', { reason: f.ended }) : ''}</span>
                  <button className={`${BTN} text-[var(--color-text-secondary)]`} onClick={() => client.k8s.stopForward(tid, f.id).finally(loadFwds)}><Square className="h-2.5 w-2.5" />{f.ended ? tr('移除') : tr('停止')}</button>
                </div>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto text-[11.5px]" data-k8s-list={tab}>
            {!list && !err && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('读取中…') : ''}</div>}
            {list?.pods && <>
              {head(<><span className="w-2" /><span className="min-w-0 flex-1">{tr('名称')}</span><span className="w-10 text-right">{tr('就绪')}</span><span className="w-[120px]">{tr('状态')}</span><span className="w-12 text-right">{tr('k8s|重启')}</span><span className="w-12 text-right">{tr('年龄')}</span></>)}
              {pods.map((p) => { const l = podLevel(p); return row(`${p.namespace}/${p.name}`, { res: 'pods', name: p.name, namespace: p.namespace }, [`${p.namespace}/${p.name}`, p.message, p.lastReason ? tr('上次退出：{reason}', { reason: p.lastReason }) : '', p.node ? tr('节点 {node}', { node: p.node }) : '', p.ip ? `IP ${p.ip}` : ''].filter(Boolean).join('\n'), <>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${levelDot(l)}`} />
                <span className={`min-w-0 flex-1 truncate font-mono ${levelText(l)}`}>{nm(p.namespace, p.name)}</span>
                <span className={`w-10 shrink-0 text-right font-mono ${p.ready < p.total && p.status !== 'Completed' && p.status !== 'Succeeded' ? 'text-[var(--color-warn)]' : MUTED}`}>{p.ready}/{p.total}</span>
                <span className={`w-[120px] shrink-0 truncate ${l === 'error' ? 'font-medium text-[var(--color-danger)]' : l === 'warn' && p.status !== 'Running' ? 'text-[var(--color-warn)]' : p.status === 'Running' ? 'text-[var(--color-success)]' : MUTED}`}>{p.status}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${p.restarts >= 5 ? 'text-[var(--color-warn)]' : MUTED}`}>{p.restarts}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${MUTED}`}>{fmtK8sAge(p.created, now)}</span>
              </>) })}
            </>}
            {list?.workloads && <>
              {head(<><span className="w-2" /><span className="min-w-0 flex-1">{tr('名称')}</span><span className="w-12 text-right">{tr('就绪')}</span><span className="w-14 text-right">{tr('最新')}</span><span className="w-14 text-right">{tr('可用')}</span><span className="w-12 text-right">{tr('年龄')}</span></>)}
              {workloads.map((w) => { const l = workloadLevel(w); return row(`${w.namespace}/${w.name}`, { res: list.res, name: w.name, namespace: w.namespace }, `${w.namespace}/${w.name}\n${w.images.join('\n')}`, <>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${levelDot(l)}`} />
                <span className={`min-w-0 flex-1 truncate font-mono ${levelText(l)}`}>{nm(w.namespace, w.name)}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${l ? levelText(l) : MUTED}`}>{w.ready}/{w.desired}</span>
                <span className={`w-14 shrink-0 text-right font-mono ${MUTED}`}>{w.upToDate}</span>
                <span className={`w-14 shrink-0 text-right font-mono ${MUTED}`}>{w.available}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${MUTED}`}>{fmtK8sAge(w.created, now)}</span>
              </>) })}
            </>}
            {list?.services && <>
              {head(<><span className="min-w-0 flex-1">{tr('名称')}</span><span className="w-20">{tr('类型')}</span><span className="w-[100px]">Cluster IP</span><span className="w-[120px]">{tr('端口')}</span><span className="w-12 text-right">{tr('年龄')}</span></>)}
              {list.services.filter((s) => hit(`${s.namespace}/${s.name} ${s.type} ${s.ports}`)).map((s) => row(`${s.namespace}/${s.name}`, { res: 'services', name: s.name, namespace: s.namespace }, `${s.namespace}/${s.name}${s.external ? `\n${tr('外部地址 {addr}', { addr: s.external })}` : ''}`, <>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">{nm(s.namespace, s.name)}</span>
                <span className={`w-20 shrink-0 truncate ${MUTED}`}>{s.type}</span>
                <span className={`w-[100px] shrink-0 truncate font-mono ${MUTED}`}>{s.clusterIP}</span>
                <span className="w-[120px] shrink-0 truncate font-mono text-[var(--color-text-secondary)]" title={s.ports}>{s.ports}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${MUTED}`}>{fmtK8sAge(s.created, now)}</span>
              </>))}
            </>}
            {list?.ingresses && <>
              {head(<><span className="min-w-0 flex-1">{tr('名称')}</span><span className="w-[160px]">{tr('域名')}</span><span className="w-[110px]">{tr('地址')}</span><span className="w-12 text-right">{tr('年龄')}</span></>)}
              {list.ingresses.filter((i) => hit(`${i.namespace}/${i.name} ${i.hosts}`)).map((i) => row(`${i.namespace}/${i.name}`, { res: 'ingresses', name: i.name, namespace: i.namespace }, `${i.namespace}/${i.name}${i.className ? `\nclass ${i.className}` : ''}`, <>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">{nm(i.namespace, i.name)}</span>
                <span className="w-[160px] shrink-0 truncate font-mono text-[var(--color-text-secondary)]" title={i.hosts}>{i.hosts}</span>
                <span className={`w-[110px] shrink-0 truncate font-mono ${MUTED}`}>{i.address || '—'}</span>
                <span className={`w-12 shrink-0 text-right font-mono ${MUTED}`}>{fmtK8sAge(i.created, now)}</span>
              </>))}
            </>}
            {list?.events && list.events.filter((e) => hit(`${e.namespace} ${e.object} ${e.reason} ${e.message} ${e.type}`)).map((e, i) => (
              <div key={i} data-k8s-event={e.type} className="border-b border-[var(--color-border-subtle)] px-3 py-1">
                <div className="flex items-center gap-2">
                  <span className={`w-12 shrink-0 font-mono ${MUTED}`}>{fmtK8sAge(e.last, now)}</span>
                  <span className={`shrink-0 font-medium ${e.type === 'Warning' ? 'text-[var(--color-warn)]' : MUTED}`}>{e.reason}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]">{allNs && e.namespace ? `${e.namespace}/` : ''}{e.object}</span>
                  {e.count > 1 && <span className={`shrink-0 ${MUTED}`}>×{e.count}</span>}
                </div>
                <div className="break-all pl-14 text-[11px] text-[var(--color-text-muted)]">{e.message}</div>
              </div>
            ))}
            {list && !err && ((list.pods && !pods.length) || (list.workloads && !workloads.length) || list.services?.length === 0 || list.ingresses?.length === 0 || list.events?.length === 0) &&
              <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{onlyBad && !q ? tr('没有异常的对象') : q ? tr('（没有匹配的对象）') : tr('（这个命名空间下没有）')}</div>}
          </div>
          {sel && selKind && (
            <div data-k8s-detail className="flex max-h-[58%] min-h-[180px] shrink-0 flex-col gap-1.5 border-t border-[var(--color-border-default)] px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                <span className="truncate font-mono font-medium text-[var(--color-text-primary)]" title={`${sel.namespace}/${sel.name}`}>{selKind}/{sel.name}</span>
                {selPod && <span className={`shrink-0 ${levelText(podLevel(selPod))}`}>{selPod.status}</span>}
                <span className="ml-auto" />
                {(['describe', 'yaml', ...(sel.res === 'pods' ? ['logs'] as const : [])] as const).map((m) => (
                  <button key={m} data-k8s-mode={m} onClick={() => loadDetail(m)} className={`${TAB} ${detail?.mode === m ? ON : OFF}`}>{m === 'describe' ? 'describe' : m === 'yaml' ? 'YAML' : tr('日志')}</button>
                ))}
              </div>
              {selPod && selPod.containers.length > 1 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <Select size="sm" className="w-[140px]" value={container || selPod.containers[0]} onValueChange={setContainer} options={selPod.containers.map((x) => ({ value: x, label: x }))} aria-label={tr('k8s|容器')} />
                  <span className={`shrink-0 ${MUTED}`}>{tr('多容器 Pod：日志 / 进入容器用这个容器')}</span>
                  {detail?.mode === 'logs' && <label className="flex items-center gap-1 text-[var(--color-text-secondary)]"><Checkbox checked={previous} onCheckedChange={setPrevious} />{tr('上一个容器（--previous）')}</label>}
                  {detail?.mode === 'logs' && <HelpTip>{tr('上一个容器 = 重启前那次运行的日志，排查 CrashLoopBackOff / OOMKilled 时看它。这里显示最后 500 行；要持续看新日志点下面的「跟踪日志」。')}</HelpTip>}
                </div>
              )}
              {detail?.mode === 'logs' && selPod && selPod.containers.length <= 1 && (
                <div className="flex items-center gap-2 text-[11px]">
                  <label className="flex items-center gap-1 text-[var(--color-text-secondary)]"><Checkbox checked={previous} onCheckedChange={setPrevious} />{tr('上一个容器（--previous）')}</label>
                  <HelpTip>{tr('上一个容器 = 重启前那次运行的日志，排查 CrashLoopBackOff / OOMKilled 时看它。这里显示最后 500 行；要持续看新日志点下面的「跟踪日志」。')}</HelpTip>
                </div>
              )}
              <pre data-k8s-text className="min-h-[60px] flex-1 overflow-auto whitespace-pre rounded bg-[var(--color-bg-raised)] p-1.5 font-mono text-[10.5px] leading-[1.45] text-[var(--color-text-secondary)]">
                {!detail || (!detail.text && !detail.error && detail.text !== '') ? tr('读取中…') : detail.error ? <span className="whitespace-pre-wrap text-[var(--color-danger)]">{detail.error}</span> : detail.text || tr('（没有输出）')}
              </pre>
              {actErr && <pre data-k8s-acterr className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-all rounded border border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_8%,transparent)] p-1.5 font-mono text-[10.5px] text-[var(--color-danger)]">{actErr}</pre>}
              {fwdAsk && (
                <div data-k8s-fwdask className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                  <span className="shrink-0">{tr('转发 {kind} 端口', { kind: fwdAsk.kind === 'pod' ? 'Pod' : 'Service' })}</span>
                  {fwdAsk.ports.length > 1 && <Select size="sm" className="w-[90px]" value={String(fwdAsk.port)} onValueChange={(v) => setFwdAsk({ ...fwdAsk, port: Number(v) })} options={fwdAsk.ports.map((p) => ({ value: String(p), label: String(p) }))} aria-label={tr('已声明的端口')} />}
                  <NumberInput size="sm" className="w-[90px]" min={1} max={65535} value={fwdAsk.port} onChange={(n) => setFwdAsk({ ...fwdAsk, port: n })} />
                  <span className={`min-w-0 truncate ${MUTED}`}>{bgFwd ? tr('→ 本机随机空闲端口') : local ? tr('→ 本机同号端口（新终端标签）') : tr('→ 该主机同号端口（新终端标签）')}</span>
                  <button disabled={busy === 'fwd'} onClick={startFwd} className={PRIMARY}>{busy === 'fwd' && <Loader2 className="h-3 w-3 animate-spin" />}{tr('开始转发')}</button>
                  <button onClick={() => setFwdAsk(undefined)} className={`${BTN} ${MUTED}`}>{tr('取消')}</button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {selPod && <>
                  <button title={bgFwd ? tr('在日志面板里跟踪 kubectl logs -f（勾了「上一个容器」则看重启前的日志）') : tr('新开终端标签跑 kubectl logs -f')} onClick={() => follow(selPod)} className={`${BTN} text-[var(--color-text-secondary)]`}><ScrollText className="h-3 w-3" />{tr('跟踪日志')}</button>
                  <button title={tr('新开终端标签：kubectl exec -it（有 bash 用 bash，否则 sh）')} disabled={selPod.ready === 0 && selPod.status !== 'Running'} onClick={() => void openTerm('exec', { name: selPod.name, namespace: selPod.namespace, container: containerOf(selPod) })} className={`${BTN} text-[var(--color-text-secondary)]`}><LogIn className="h-3 w-3" />{tr('进入容器')}</button>
                </>}
                {(sel.res === 'pods' || sel.res === 'services') && (
                  <button data-k8s-fwdbtn title={bgFwd ? tr('远端后台 kubectl port-forward，再经 SSH 转到本机端口') : tr('新开终端标签跑 kubectl port-forward')} onClick={() => {
                    const ports = sel.res === 'pods' ? selPod?.ports ?? [] : list?.services?.find((s) => s.name === sel.name && s.namespace === sel.namespace)?.portNums ?? []
                    setFwdAsk({ kind: sel.res === 'pods' ? 'pod' : 'service', name: sel.name, namespace: sel.namespace, ports, port: ports[0] ?? 8080 })
                  }} className={`${BTN} text-[var(--color-text-secondary)]`}><ArrowRightLeft className="h-3 w-3" />{tr('转发到本机')}</button>
                )}
                {(sel.res === 'deployments' || sel.res === 'statefulsets') && (
                  <button data-k8s-restart disabled={!!busy} title={tr('kubectl rollout restart {obj}（逐个替换 Pod，记入执行记录）', { obj: `${selKind}/${sel.name}` })} onClick={() => { setAck(false); setConfirm({ kind: selKind as K8sRestartKind, name: sel.name, namespace: sel.namespace }) }}
                    className={`${BTN} text-[var(--color-warn)]`}>{busy === 'restart' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}{tr('滚动重启')}</button>
                )}
                <button data-k8s-ai title={tr('把 describe 输出发到对话，让 AI 解读（按设置脱敏）')} onClick={() => void askAi()} className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('describe 交给 AI')}</button>
                {!bgFwd && <span className={`text-[10.5px] ${MUTED}`}><SquareTerminal className="mr-0.5 inline h-3 w-3" />{tr('跟踪 / 进入 / 转发会新开终端标签')}</span>}
                {flash && <span data-k8s-flash className="text-[11px] text-[var(--color-success)]">{flash}</span>}
              </div>
            </div>
          )}
          {!sel && flash && <div data-k8s-flash className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
        </>}
    </>
  )

  return (
    <div className="flex h-full flex-col" data-k8s>
      {header}
      {body}
      <ConfirmDialog open={!!confirm} confirmDisabled={prod && !ack}
        title={confirm ? (prod ? tr('生产环境：滚动重启 {obj}', { obj: `${confirm.kind}/${confirm.name}` }) : tr('滚动重启 {obj}', { obj: `${confirm.kind}/${confirm.name}` })) : ''}
        message={confirm ? tr('确定在「{host}」上执行下面的命令？Pod 会按滚动策略逐个替换，期间服务容量会短暂下降。操作会记入执行记录。', { host: String(term?.title) }) : ''}
        confirmText={prod ? tr('生产环境 · 滚动重启') : tr('滚动重启')}
        onConfirm={doRestart} onCancel={() => setConfirm(undefined)}>
        {confirm && (
          <div className="space-y-2">
            {prod && (
              <div className="flex items-center gap-1.5 rounded border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-2 py-1.5 text-[12px] font-medium text-[var(--color-danger)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{term?.env === 'prod' ? tr('这是生产主机！请确认不会影响线上业务；副本只有 1 个时重启期间服务会中断。') : tr('上下文名像生产集群！请确认不会影响线上业务；副本只有 1 个时重启期间服务会中断。')}
              </div>
            )}
            <div className="rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11.5px] text-[var(--color-text-primary)]">{k8sRestartLabel(c, confirm.namespace, confirm.kind, confirm.name)}</div>
            {prod && <label data-k8s-ack className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]"><Checkbox tone="danger" checked={ack} onCheckedChange={setAck} />{tr('我已确认要在生产环境滚动重启 {name}', { name: confirm.name })}</label>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}

// 没装 kubectl / 没有 kubeconfig 时的说明
function Guide({ local, noKubectl, host, onRetry }: { local: boolean; noKubectl: boolean; host: string; onRetry: () => void }) {
  const code = 'rounded bg-[var(--color-bg-raised)] px-1 font-mono text-[11px]'
  return (
    <div data-k8s-guide className="space-y-2 px-3 py-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
      <div className="font-medium text-[var(--color-text-primary)]">{noKubectl ? (local ? tr('本机没有检测到 kubectl') : tr('「{host}」上没有检测到 kubectl', { host })) : tr('kubectl 已安装，但没有可用的 kubeconfig')}</div>
      {noKubectl ? <>
        <div>{local ? tr('Kubernetes 视图用本机上已有的 kubectl 和 kubeconfig 访问集群（灵壳不自带 kubectl，也不读取本机的凭据）。安装方法：') : tr('Kubernetes 视图用这台主机上已有的 kubectl 和 kubeconfig 访问集群（灵壳不自带 kubectl，也不读取本机的凭据）。安装方法：')}</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>{tr('Linux：')}<span className={code}>curl -LO https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && sudo install kubectl /usr/local/bin/</span></li>
          <li>{trx('macOS：{a}；Windows：{b}', { a: <span className={code}>brew install kubectl</span>, b: <span className={code}>winget install Kubernetes.kubectl</span> })}</li>
          <li>{trx('k3s 自带 kubectl：{cmd}，kubeconfig 在 {path}', { cmd: <span className={code}>sudo ln -s $(which k3s) /usr/local/bin/kubectl</span>, path: <span className={code}>/etc/rancher/k3s/k3s.yaml</span> })}</li>
        </ul>
      </> : (
        <div>{trx('把集群的 kubeconfig 放到 {path}（或设置 {env} 环境变量），在终端里用 {cmd} 能看到上下文即可。', { path: <span className={code}>~/.kube/config</span>, env: <span className={code}>KUBECONFIG</span>, cmd: <span className={code}>kubectl config get-contexts</span> })}</div>
      )}
      <button onClick={onRetry} className={`${BTN} text-[var(--color-accent)]`}>{tr('重新检测')}</button>
    </div>
  )
}

// 集群体检结果：摘要 + 问题清单（严重在前），可「用 AI 排查」
function HealthView({ health, err, loading, onRun, onAsk }: { health?: K8sHealth; err: string; loading: boolean; onRun: () => void; onAsk: () => void }) {
  if (err) return <div className="space-y-2 px-3 py-3"><div className="whitespace-pre-wrap text-[12px] text-[var(--color-danger)]">{err}</div><button onClick={onRun} className={BTN}>{tr('重新体检')}</button></div>
  if (!health) return <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('体检中：读取 Pod、节点、事件…') : ''}</div>
  const chip = (label: string, bad: boolean) => <span className={`rounded px-1.5 py-0.5 text-[11px] ${bad ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)]' : 'bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]'}`}>{label}</span>
  return (
    <div data-k8s-health className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        {health.nodes && chip(`${tr('节点 {node}', { node: health.nodes.total })}${health.nodes.notReady ? ` · NotReady ${health.nodes.notReady}` : ''}`, health.nodes.notReady > 0)}
        {chip(tr('Pod {n} · 异常 {bad}', { n: health.pods.total, bad: health.pods.bad }), health.pods.bad > 0)}
        {chip(tr('近 1 小时 Warning {n} 类', { n: health.warnings }), health.warnings > 0)}
        <span className={`text-[10.5px] ${MUTED}`}>{tr('范围：{scope}', { scope: health.scope })}</span>
        <span className="ml-auto" />
        <button onClick={onRun} disabled={loading} className={BTN}>{tr('重新体检')}</button>
        <button data-k8s-health-ai onClick={onAsk} className={PRIMARY}><Sparkles className="h-3 w-3" />{tr('用 AI 排查')}</button>
      </div>
      {health.notes.length > 0 && <div className={`shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px] ${MUTED}`}>{tr('未查到：{list}', { list: health.notes.join(tr('；')) })}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {health.findings.length === 0 && <div className="px-3 py-4 text-[12px] text-[var(--color-success)]">{tr('没有发现问题：节点都 Ready，Pod 都在正常运行，最近 1 小时没有 Warning 事件。')}</div>}
        {health.findings.map((f, i) => (
          <div key={i} data-k8s-finding={f.kind} className="border-b border-[var(--color-border-subtle)] px-3 py-1.5">
            <div className={`flex items-center gap-1.5 text-[11.5px] font-medium ${levelText(f.level)}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${levelDot(f.level)}`} />
              {f.kind !== 'node' && <span className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1 text-[10px] font-normal text-[var(--color-text-muted)]">{({ pod: 'Pod', pending: 'Pending', restart: tr('重启'), event: tr('k8s|事件') })[f.kind]}</span>}
              <span className="min-w-0 break-all font-mono">{f.title}</span>
            </div>
            {f.detail && <div className="break-all pl-3 text-[11px] text-[var(--color-text-muted)]">{f.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
