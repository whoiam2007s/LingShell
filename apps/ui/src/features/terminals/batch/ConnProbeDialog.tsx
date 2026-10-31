import { useEffect, useRef, useState } from 'react'
import { Loader2, MonitorDot, Radar, Server, X } from 'lucide-react'
import {
  batchGroups, toggleGroup, pickedTargets, parseProbeTargets, cellStatus, cellText, probeMarkdown, runPool, plannedChecks, redactSecrets,
  PROBE_CHECKS, PROBE_CHECK_LABEL, PROBE_MAX_SOURCES, probeStatusText, tr,
  type BatchGroup, type BatchChoice, type ProbeCheck, type ProbeSourceResult, type ProbeStatus, type ProbeTarget,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { onPalette } from '../../../lib/paletteBus.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { cn } from '../../../lib/cn.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { HelpTip } from '../../../components/ui/form.js'
import { ProdBadge } from '../../../components/sshParts.js'

// 连通性探测矩阵：多个源（本机 / 已保存主机 / 在线终端）× 多个目标，测 DNS / TCP / HTTP，点格子看明细。只读。
// 打开：命令面板「连通性探测」、防火墙视图「测连通」（预选当前主机）。主进程见 desktop/main/ops/connProbe.ts
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const SMALL_BTN = 'rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const CELL_CLS: Record<ProbeStatus, string> = {
  ok: 'text-[var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]',
  warn: 'text-[var(--color-warn)] bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)]',
  fail: 'text-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)]',
  na: 'text-[var(--color-text-muted)] bg-[var(--color-bg-raised)]',
  skip: 'text-[var(--color-text-muted)]',
}
const ITEM_CLS: Record<ProbeStatus, string> = { ok: 'text-[var(--color-success)]', warn: 'text-[var(--color-warn)]', fail: 'text-[var(--color-danger)]', na: 'text-[var(--color-text-muted)]', skip: 'text-[var(--color-text-muted)]' }

export function ConnProbeDialog() {
  const [open, setOpen] = useState<{ source?: string } | null>(null)
  useEffect(() => onPalette((c) => { if (c.type === 'connProbe') setOpen({ source: c.source }) }), [])
  return open ? <Body preset={open.source} onClose={() => setOpen(null)} /> : null
}

interface Run { sources: BatchChoice[]; targets: ProbeTarget[]; checks: ProbeCheck[] }

function Body({ preset, onClose }: { preset?: string; onClose: () => void }) {
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [checks, setChecks] = useState<ProbeCheck[]>([...PROBE_CHECKS])
  const [run, setRun] = useState<Run | null>(null)
  const [rows, setRows] = useState<(ProbeSourceResult | 'running' | undefined)[]>([])
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<{ s: number; t: number } | null>(null)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const active = useRef<{ runId: string; ac: AbortController } | null>(null)

  useEffect(() => {
    Promise.all([client.hosts.list(), client.terminal.list()]).then(([hs, ts]) => {
      const gs = batchGroups(hs, ts)
      setGroups(gs)
      const keys = gs.flatMap((g) => g.items).map((c) => c.key)
      setPicked(preset && keys.includes(preset) ? [preset] : ['local'])   // 默认本机；从防火墙视图打开则预选那台
    }).catch((e) => setError(errText(e)))
  }, [preset])
  const cancel = () => { const a = active.current; if (a) { a.ac.abort(); client.probe.cancel(a.runId).catch(() => {}) } }
  useEffect(() => () => cancel(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sources = pickedTargets(groups, picked)
  const parsed = parseProbeTargets(text)
  const canRun = sources.length > 0 && sources.length <= PROBE_MAX_SOURCES && parsed.targets.length > 0 && checks.length > 0 && !busy

  const start = async () => {
    if (!canRun) return
    const snap: Run = { sources, targets: parsed.targets, checks }
    const runId = crypto.randomUUID(), ac = new AbortController()
    active.current = { runId, ac }
    setRun(snap); setRows(snap.sources.map(() => undefined)); setSel(null); setBusy(true); setError('')
    await runPool(snap.sources.length, 5, async (i) => {
      setRows((rs) => rs.map((x, j) => (j === i ? 'running' : x)))
      const r = await client.probe.run(runId, snap.sources[i].target, snap.targets, snap.checks).catch((e): ProbeSourceResult => ({ cells: [], error: errText(e) }))
      setRows((rs) => rs.map((x, j) => (j === i ? r : x)))
    }, ac.signal)
    setRows((rs) => rs.map((x) => (x === undefined ? { cells: [], error: tr('已取消') } : x)))
    if (active.current?.runId === runId) active.current = null
    setBusy(false)
  }
  const done = (rows.filter((r) => r && r !== 'running') as ProbeSourceResult[])
  const md = () => run ? probeMarkdown(run.sources.map((s) => s.label), run.targets, rows.map((r) => (r === 'running' ? undefined : r))) : ''
  const note = (t: string) => { setFlash(t); setTimeout(() => setFlash(''), 1500) }
  const copy = () => navigator.clipboard?.writeText(md()).then(() => note(tr('已复制 Markdown')), () => note(tr('复制失败')))
  // 与其它「问 AI」入口一致：按「发给 AI 前脱敏」处理（URL 里的 ?token= 之类）
  const ask = async () => {
    const q = `请根据这张连通性探测结果分析哪里不通、可能的原因（防火墙 / 安全组 / DNS / 服务没起），并给出只读的排查步骤：\n\n${md()}`   // i18n-ignore 发给 AI 的话
    const s = await client.settings.get().catch(() => undefined)
    quoteToChat(s?.system?.aiRedact === false ? q : redactSecrets(q)); note(tr('已放入对话输入框'))
  }
  const toggleCheck = (c: ProbeCheck) => setChecks((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : PROBE_CHECKS.filter((x) => x === c || cs.includes(x))))
  const selRow = sel && run ? rows[sel.s] : undefined
  const selCell = selRow && selRow !== 'running' && !selRow.error ? selRow.cells[sel!.t] : undefined

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div data-probe-dialog className="relative flex max-h-[88vh] w-[960px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Radar className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('连通性探测')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('从多台源主机同时测到各目标的 DNS / TCP / HTTP · 只读')}</span>
          <HelpTip>{tr('远端用 getent / nslookup / host 解析，bash 的 /dev/tcp（或 nc）测端口，curl（或 wget）取 HTTP 状态码；本机用应用自带的网络功能，不依赖本机命令。源主机上缺命令的那一项显示「无法测」并说明缺什么。')}</HelpTip>
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
          <div className="grid grid-cols-[280px_1fr] gap-3">
            <div>
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('源（从哪里测，已选 {n} 个）', { n: sources.length })}</div>
              <div className="max-h-52 overflow-y-auto rounded-md border border-[var(--color-border-subtle)]">
                {groups.map((g) => {
                  const keys = g.items.map((c) => c.key), n = keys.filter((k) => picked.includes(k)).length
                  return (
                    <div key={g.name}>
                      <label className="flex cursor-pointer items-center gap-2 bg-[var(--color-bg-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                        <Checkbox checked={n === keys.length ? true : n > 0 ? 'indeterminate' : false} onCheckedChange={() => setPicked((p) => toggleGroup(p, keys))} />
                        <span className="min-w-0 flex-1 truncate font-medium">{tr(g.name)}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{n}/{keys.length}</span>
                      </label>
                      {g.items.map((c) => (
                        <label key={c.key} title={c.detail} className="flex cursor-pointer items-center gap-2 py-1 pl-6 pr-2.5 hover:bg-[var(--color-bg-hover)]">
                          <Checkbox checked={picked.includes(c.key)} onCheckedChange={() => setPicked((p) => toggleGroup(p, [c.key]))} />
                          {c.key === 'local' ? <MonitorDot className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" /> : <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
                          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{c.label}</span>
                          {c.env === 'prod' && <ProdBadge />}
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="flex flex-col">
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('目标（每行一个：host:port、URL 或域名，最多 20 个）')}</div>
              <textarea data-probe-targets value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={6}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start() } }}
                placeholder={'db.internal:3306\nredis.local:6379\nhttps://api.example.com/health\nexample.com'}
                className="min-h-[120px] flex-1 resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 font-mono text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {PROBE_CHECKS.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]">
                    <Checkbox checked={checks.includes(c)} onCheckedChange={() => toggleCheck(c)} />{c === 'dns' ? tr('DNS 解析') : c === 'tcp' ? tr('TCP 端口') : tr('HTTP 状态')}
                  </label>
                ))}
                {parsed.errors.length > 0 && <span className="min-w-0 flex-1 truncate text-[var(--color-danger)]" title={parsed.errors.join('\n')}>{tr('看不懂：{list}', { list: parsed.errors.join(tr('list|、')) })}</span>}
                {error && <span className="min-w-0 flex-1 truncate text-[var(--color-danger)]">{error}</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  {busy && <button onClick={cancel} className={cn(SMALL_BTN, 'text-[var(--color-danger)]')}>{tr('取消')}</button>}
                  <button data-probe-go disabled={!canRun} onClick={() => void start()}
                    className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? tr('探测中…') : tr('开始探测')}
                  </button>
                </span>
              </div>
            </div>
          </div>
          {run && (
            <div className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
              <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">
                <span>{tr('{s} 个源 × {t} 个目标 · 检查：{checks} · 点格子看明细', { s: run.sources.length, t: run.targets.length, checks: run.checks.map((c) => PROBE_CHECK_LABEL[c]).join(' / ') })}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {flash && <span className="text-[var(--color-success)]">{flash}</span>}
                  <button disabled={!done.length} onClick={copy} className={SMALL_BTN}>{tr('复制为 Markdown')}</button>
                  <button disabled={busy || !done.length} onClick={ask} className={SMALL_BTN}>{tr('让 AI 分析')}</button>
                </span>
              </div>
              <div className="overflow-x-auto">
                <table data-probe-matrix className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="text-[11px] text-[var(--color-text-muted)]">
                      <th className="sticky left-0 border-b border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1 text-left font-normal">{tr('源 \\ 目标')}</th>
                      {run.targets.map((t, j) => <th key={j} title={t.raw} className="max-w-[180px] truncate border-b border-[var(--color-border-subtle)] px-2 py-1 text-left font-mono font-normal">{t.raw}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {run.sources.map((s, i) => {
                      const r = rows[i]
                      return (
                        <tr key={s.key}>
                          <td className="sticky left-0 whitespace-nowrap border-b border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[var(--color-text-primary)]">{s.label}</td>
                          {r === undefined || r === 'running'
                            ? <td colSpan={run.targets.length} className="border-b border-[var(--color-border-subtle)] px-2 py-1.5 text-[var(--color-text-muted)]">{r === 'running' ? <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />{tr('探测中…')}</span> : tr('等待中')}</td>
                            : r.error && !r.cells.length
                              ? <td colSpan={run.targets.length} className="border-b border-[var(--color-border-subtle)] px-2 py-1.5 text-[var(--color-danger)]">{tr('连接失败：{msg}', { msg: r.error })}</td>
                              : run.targets.map((_, j) => {
                                const c = r.cells[j], st = cellStatus(c)
                                return (
                                  <td key={j} data-cell={`${i}-${j}`} data-status={st} onClick={() => setSel(sel?.s === i && sel.t === j ? null : { s: i, t: j })}
                                    title={c.items.map((x) => x.detail
                                      ? tr('{check}：{status}（{detail}）', { check: PROBE_CHECK_LABEL[x.check], status: tr(probeStatusText[x.status]), detail: x.detail })
                                      : tr('{check}：{status}', { check: PROBE_CHECK_LABEL[x.check], status: tr(probeStatusText[x.status]) })).join('\n')}
                                    className={cn('cursor-pointer whitespace-nowrap border-b border-l border-[var(--color-border-subtle)] px-2 py-1.5 font-mono text-[11.5px]', CELL_CLS[st],
                                      sel?.s === i && sel.t === j && 'shadow-[inset_0_0_0_2px_var(--color-accent)]')}>
                                    {cellText(c)}
                                  </td>
                                )
                              })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {sel && selCell && (
                <div data-probe-detail className="space-y-1.5 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
                  <div className="text-[11.5px] text-[var(--color-text-secondary)]">{run.sources[sel.s].label} → <span className="font-mono">{run.targets[sel.t].raw}</span></div>
                  {selCell.items.map((x) => (
                    <div key={x.check} className="text-[11.5px]">
                      <div className="flex items-center gap-2">
                        <span className="w-12 shrink-0 font-medium text-[var(--color-text-primary)]">{PROBE_CHECK_LABEL[x.check]}</span>
                        <span className={ITEM_CLS[x.status]}>{tr(probeStatusText[x.status])}</span>
                        {x.detail && <span className="text-[var(--color-text-secondary)]">{x.detail}</span>}
                        {x.ms !== undefined && <span className="tabular-nums text-[var(--color-text-muted)]">{x.ms}ms</span>}
                        {x.tool && <span className="text-[10.5px] text-[var(--color-text-muted)]">{x.tool === 'node' ? tr('（本机直接测）') : tr('（用 {tool}）', { tool: x.tool })}</span>}
                      </div>
                      {x.raw?.trim() && <pre className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border-subtle)] p-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]">{x.raw.trim()}</pre>}
                    </div>
                  ))}
                  {plannedChecks(run.targets[sel.t], run.checks).length === 0 && <div className="text-[var(--color-text-muted)]">{tr('没有要做的检查')}</div>}
                </div>
              )}
              {sel && selRow && selRow !== 'running' && selRow.error && selRow.cells.length > 0 && <div className="border-t border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-warn)]">{selRow.error}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
