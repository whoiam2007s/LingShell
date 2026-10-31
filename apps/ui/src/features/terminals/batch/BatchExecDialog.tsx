import { useEffect, useRef, useState } from 'react'
import { X, Layers, Server, MonitorDot, Loader2, AlertTriangle, ChevronRight, ChevronDown } from 'lucide-react'
import {
  batchGroups, toggleGroup, pickedTargets, batchGate, batchStatusText, isBatchFailed, maybeExecuted, firstLine, fmtMs, groupOutputs, outliers, batchMarkdown, batchTsv, runPool, unifiedDiff, clampInt, healthCommand,
  BATCH_DEFAULT_TIMEOUT_SEC, BATCH_MAX_TIMEOUT_SEC, BATCH_DEFAULT_CONCURRENCY, BATCH_MAX_CONCURRENCY, BATCH_MAX_OUTPUT, tr,
  type BatchGroup, type BatchChoice, type BatchRow, type BatchExecResult,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { onPalette, paletteSend } from '../../../lib/paletteBus.js'
import { DiffView } from '../../../components/DiffView.js'
import { ProdBadge } from '../../../components/sshParts.js'
import { cn } from '../../../lib/cn.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { Switch } from '../../../components/ui/Switch.js'
import { ROLLOUT_DEFAULTS, type RolloutOpts } from '@lingshell/shared'
import { RolloutOptions, RolloutTable, useRollout } from './RolloutRun.js'

// 批量执行：勾选多台主机 + 命令 → 并发跑（独立 exec channel），汇总表 + 输出分组 / 与多数比对 / 导出 / 只重跑失败的。
// 打开：终端工具栏按钮 / 命令面板「批量执行」（都走 paletteBus 的 batchExec）
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const ICON_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'
const SMALL_BTN = 'rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const INPUT = 'rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'

const STATUS_CLS: Record<BatchRow['status'], string> = {
  pending: 'text-[var(--color-text-muted)]', running: 'text-[var(--color-accent)]', ok: 'text-[var(--color-success)]',
  fail: 'text-[var(--color-danger)]', timeout: 'text-[var(--color-warn)]', conn_error: 'text-[var(--color-danger)]', canceled: 'text-[var(--color-text-muted)]',
}

export function BatchExecButton() {
  return <button title={tr('批量执行')} onClick={() => paletteSend({ type: 'batchExec' })} className={ICON_BTN}><Layers className="h-3.5 w-3.5" /></button>
}

export function BatchExecDialog() {
  const [open, setOpen] = useState(false)
  useEffect(() => onPalette((c) => { if (c.type === 'batchExec') setOpen(true) }), [])
  return open ? <BatchBody onClose={() => setOpen(false)} /> : null
}

// 不再起新的 + 主进程关掉这批在跑的 channel
function cancelRun(a: { ac: AbortController; runId: string } | null) {
  if (!a) return
  a.ac.abort()
  client.batch.cancel(a.runId).catch(() => {})
}

// 一次运行的快照：之后改勾选 / 命令不会让表格错位
interface Run { command: string; items: BatchChoice[]; timeoutMs: number; concurrency: number }

function BatchBody({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [timeoutSec, setTimeoutSec] = useState(String(BATCH_DEFAULT_TIMEOUT_SEC))
  const [conc, setConc] = useState(String(BATCH_DEFAULT_CONCURRENCY))
  const [error, setError] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [rows, setRows] = useState<BatchRow[]>([])
  const [busy, setBusy] = useState(false)
  // danger：生产 + 危险命令；rerun：重跑里有「可能已经执行过」的主机（超时 / 中途中止）
  const [confirm, setConfirm] = useState<{ kind: 'danger' | 'rerun'; prod: string[]; command: string; health?: string; hosts?: string[]; go: () => void } | null>(null)
  const [closeAsk, setCloseAsk] = useState(false)   // 执行中关闭：先确认（关闭 = 中止，结果表也会丢）
  const [expanded, setExpanded] = useState<number | null>(null)
  const [diffOf, setDiffOf] = useState<number | null>(null)
  const [onlyOdd, setOnlyOdd] = useState(false)
  const [flash, setFlash] = useState('')
  const active = useRef<{ ac: AbortController; runId: string } | null>(null)
  // 分批执行（滚动发布 / 金丝雀）：打开后「开始」走分批调度，结果区换成按批分段的进度
  const [rolloutOn, setRolloutOn] = useState(false)
  const [ro, setRo] = useState<RolloutOpts>(ROLLOUT_DEFAULTS)
  const [view, setView] = useState<'batch' | 'rollout'>('batch')
  const rollout = useRollout()
  const rolloutBusy = !!rollout.phase && !rollout.ended

  useEffect(() => {
    Promise.all([client.hosts.list(), client.terminal.list()]).then(([hs, ts]) => {
      const gs = batchGroups(hs, ts)
      setGroups(gs)
      // 默认勾上有在线连接的远程主机，本机不默认勾
      setPicked(gs.flatMap((g) => g.items).filter((c) => c.live && c.key !== 'local').map((c) => c.key))
    }).catch((e) => setError(errText(e)))
  }, [])
  const cancel = () => cancelRun(active.current)
  // 关闭面板 = 取消还在跑的
  useEffect(() => () => cancelRun(active.current), [])
  const running = busy || rolloutBusy || rollout.rbBusy
  // 执行中关闭会中止整轮（分批的进度表和回滚入口也一起没了）：先确认；空闲时直接关
  const askClose = () => { if (running) setCloseAsk(true); else onClose() }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 下拉 / 其它浮层自己处理 Esc：已被消费就不再关弹窗
      if (e.defaultPrevented || document.querySelector('[data-radix-popper-content-wrapper]')) return
      if (closeAsk) setCloseAsk(false); else if (confirm) setConfirm(null); else askClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, confirm, closeAsk, running])

  const targets = pickedTargets(groups, picked)
  // 健康检查命令也会在每台（含生产）主机上执行：一起过危险 / 生产确认
  const hc = rolloutOn ? healthCommand(ro) : undefined
  const gate = batchGate([command, hc ?? ''], targets)
  const healthMissing = rolloutOn && ro.health !== 'none' && !ro.healthCmd.trim()
  const canRun = targets.length > 0 && !!command.trim() && !busy && !rolloutBusy && !rollout.rbBusy && !healthMissing

  const setRow = (i: number, r: BatchRow) => setRows((rs) => rs.map((x, j) => (j === i ? r : x)))
  const exec = async (snap: Run, indices: number[]) => {
    const runId = crypto.randomUUID(), ac = new AbortController()
    active.current = { ac, runId }
    setBusy(true); setError('')
    setRows((rs) => rs.map((x, i) => (indices.includes(i) ? { status: 'pending' } : x)))
    await runPool(indices.length, snap.concurrency, async (k) => {
      const i = indices[k]
      setRow(i, { status: 'running' })
      const r: BatchExecResult = await client.batch.exec(runId, snap.items[i].target, snap.command, snap.timeoutMs)
        .catch((e) => ({ status: 'conn_error', error: errText(e), ms: 0 }))
      setRow(i, { status: r.status, result: r })
    }, ac.signal)
    // 取消后没轮到的标「已取消」
    setRows((rs) => rs.map((x, i) => (indices.includes(i) && x.status === 'pending' ? { status: 'canceled' } : x)))
    if (active.current?.runId === runId) active.current = null
    setBusy(false)
  }
  // 闸门：生产 + 危险命令先红色确认。fresh = 新一轮（换掉旧表格）
  const guarded = (snap: Run, indices: number[], fresh: boolean) => {
    const go = () => {
      setConfirm(null)
      if (rolloutOn && fresh) { setView('rollout'); rollout.start({ ...snap, opts: ro }); return }   // 生产 + 危险命令的确认在开始时做一次，覆盖全部批次
      setView('batch')
      if (fresh) { setRun(snap); setRows(snap.items.map(() => ({ status: 'pending' }))); setExpanded(null); setDiffOf(null); setOnlyOdd(false) }
      void exec(snap, indices)
    }
    // 分批执行：健康检查命令在每批每台都会跑，和主命令一起过闸门，确认框里也单独列出来
    const health = rolloutOn && fresh ? healthCommand(ro) : undefined
    const g = batchGate([snap.command, health ?? ''], indices.map((i) => snap.items[i]))
    if (g.level === 'danger') setConfirm({ kind: 'danger', prod: g.prod, command: snap.command, ...(health ? { health: ro.health === 'url' ? tr('访问 {url}', { url: ro.healthCmd.trim() }) : health } : {}), go })
    else go()
  }
  const start = () => {
    if (!canRun) return
    const snap: Run = {
      command, items: targets,
      timeoutMs: clampInt(Number(timeoutSec), 1, BATCH_MAX_TIMEOUT_SEC, BATCH_DEFAULT_TIMEOUT_SEC) * 1000,
      concurrency: clampInt(Number(conc), 1, BATCH_MAX_CONCURRENCY, BATCH_DEFAULT_CONCURRENCY),
    }
    guarded(snap, snap.items.map((_, i) => i), true)
  }
  const failed = rows.flatMap((r, i) => (isBatchFailed(r.status) ? [i] : []))
  const rerun = () => {
    if (!run || !failed.length || busy) return
    // 超时 / 中途中止的主机上命令可能已经执行（远端没被杀掉）：非幂等命令重跑会执行两次，先确认
    const risky = failed.filter((i) => maybeExecuted(rows[i]))
    if (risky.length) setConfirm({ kind: 'rerun', prod: [], command: run.command, hosts: risky.map((i) => run.items[i].label), go: () => { setConfirm(null); guarded(run, failed, false) } })
    else guarded(run, failed, false)
  }

  const { group, counts, majority } = groupOutputs(rows)
  const odd = new Set(outliers(rows))
  const majorityOutput = majority >= 0 ? rows[group.indexOf(majority)]?.result?.output ?? '' : ''
  const exportRows = run ? run.items.map((c, i) => ({ label: c.label, row: rows[i] })) : []
  const copy = (text: string, note: string) => navigator.clipboard?.writeText(text).then(() => setFlash(note), () => setFlash(tr('复制失败'))).finally(() => setTimeout(() => setFlash(''), 1500))
  const tally = (['ok', 'fail', 'timeout', 'conn_error', 'canceled', 'running', 'pending'] as const)
    .map((s) => [s, rows.filter((r) => r.status === s).length] as const).filter(([, n]) => n)

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="relative flex max-h-[88vh] w-[920px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Layers className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('批量执行')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('命令走单独通道，不进终端 · 每台输出上限 {n}KB', { n: BATCH_MAX_OUTPUT / 1024 })}</span>
          <button onClick={askClose} title={running ? tr('关闭（会中止正在执行的任务）') : tr('关闭')} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
          <div className="grid grid-cols-[1fr_300px] gap-3">
            <div className="flex flex-col">
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('命令（可多行，Ctrl+Enter 执行）')}</div>
              <textarea value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} rows={6}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start() } }}
                placeholder={tr('如：{cmd}', { cmd: 'df -h / | tail -1' })}
                className={cn(INPUT, 'min-h-[120px] flex-1 resize-none font-mono')} />
              <div className="mt-2 flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">{tr('超时（秒）')}
                  <input value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value.replace(/\D/g, ''))} className={cn(INPUT, 'w-16 tabular-nums')} /></label>
                <label className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">{tr('并发')}
                  <input value={conc} onChange={(e) => setConc(e.target.value.replace(/\D/g, ''))} className={cn(INPUT, 'w-12 tabular-nums')} /></label>
                {error && <span className="min-w-0 flex-1 truncate text-[var(--color-danger)]" title={error}>{error}</span>}
                <button disabled={!canRun} onClick={start}
                  className="ml-auto flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
                  {(busy || rolloutBusy || rollout.rbBusy) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{rollout.rbBusy ? tr('回滚中…') : busy || rolloutBusy ? tr('执行中…') : rolloutOn ? tr('开始分批执行') : tr('开始执行')}
                </button>
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('选择主机（已选 {n} 台）', { n: targets.length })}</div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--color-border-subtle)]">
                {groups.length === 0 && <div className="px-3 py-2 text-[var(--color-text-muted)]">{tr('加载中…')}</div>}
                {groups.map((g) => {
                  const keys = g.items.map((c) => c.key), n = keys.filter((k) => picked.includes(k)).length
                  return (
                    <div key={g.name}>
                      <label className="flex cursor-pointer items-center gap-2 bg-[var(--color-bg-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                        <Checkbox checked={n === keys.length ? true : n > 0 ? 'indeterminate' : false}
                          onCheckedChange={() => setPicked((p) => toggleGroup(p, keys))} />
                        <span className="min-w-0 flex-1 truncate font-medium">{tr(g.name)}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{n}/{keys.length}</span>
                      </label>
                      {g.items.map((c) => (
                        <label key={c.key} title={c.detail} className="flex cursor-pointer items-center gap-2 py-1 pl-6 pr-2.5 hover:bg-[var(--color-bg-hover)]">
                          <Checkbox checked={picked.includes(c.key)} onCheckedChange={() => setPicked((p) => toggleGroup(p, [c.key]))} />
                          {c.key === 'local' ? <MonitorDot className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" /> : <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
                          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{c.label}</span>
                          {c.env === 'prod' && <ProdBadge />}
                          {c.key !== 'local' && <span className={cn('shrink-0 text-[10px]', c.live ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]')}>{c.live ? tr('已连接') : tr('临时连接')}</span>}
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
              <Switch data-rollout-switch checked={rolloutOn} onCheckedChange={setRolloutOn} disabled={rolloutBusy} />{tr('分批执行（滚动发布 / 金丝雀）')}
              <span className="text-[11px] text-[var(--color-text-muted)]">{tr('按批推进，每批后做健康检查，失败自动停')}</span>
            </label>
            {rolloutOn && <RolloutOptions o={ro} set={(p) => setRo((x) => ({ ...x, ...p }))} total={targets.length} />}
            {healthMissing && <div className="text-[11.5px] text-[var(--color-warn)]">{ro.health === 'url' ? tr('请填写健康检查的 URL，或选「不检查」') : tr('请填写健康检查的命令，或选「不检查」')}</div>}
          </div>
          {gate.prod.length > 0 && (
            <div className="flex items-start gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--color-warn)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-warn)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{tr('包含 {n} 台生产主机：{list}。执行前请确认命令无误{danger}。', {
                n: gate.prod.length, list: gate.prod.join(tr('list|、')),
                danger: gate.level === 'danger' ? tr('；该命令命中危险模式，开始前还会再确认一次') : '',
              })}</span>
            </div>
          )}
          {view === 'rollout' && <RolloutTable r={rollout} flash={copy} note={flash} />}
          {view === 'batch' && run && (
            <div className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">
                <span className="max-w-[260px] truncate font-mono text-[var(--color-text-secondary)]" title={run.command}>$ {firstLine(run.command)}</span>
                {tally.map(([s, n]) => <span key={s} className={STATUS_CLS[s]}>{batchStatusText({ status: s }).replace(/\s*[（(].*[)）]/, '')} {n}</span>)}
                <label className={cn('flex items-center gap-1', majority < 0 ? 'opacity-40' : 'cursor-pointer')} title={majority < 0 ? tr('没有占多数的输出') : undefined}>
                  <Checkbox disabled={majority < 0} checked={onlyOdd && majority >= 0} onCheckedChange={setOnlyOdd} />{majority >= 0 ? tr('与多数不同（{n}）', { n: odd.size }) : tr('与多数不同')}
                </label>
                <span className="ml-auto flex items-center gap-1.5">
                  {flash && <span className="text-[var(--color-success)]">{flash}</span>}
                  {busy && <button onClick={cancel} className={cn(SMALL_BTN, 'text-[var(--color-danger)]')}>{tr('取消')}</button>}
                  <button disabled={busy || !failed.length} onClick={rerun} className={SMALL_BTN}>{failed.length ? tr('只重跑失败的（{n}）', { n: failed.length }) : tr('只重跑失败的')}</button>
                  <button onClick={() => copy(batchMarkdown(run.command, exportRows), tr('已复制 Markdown'))} className={SMALL_BTN}>{tr('复制为 Markdown')}</button>
                  <button onClick={() => copy(batchTsv(exportRows), tr('已复制 TSV'))} className={SMALL_BTN}>{tr('复制为 TSV')}</button>
                </span>
              </div>
              <div className="grid grid-cols-[minmax(0,200px)_110px_60px_minmax(0,1fr)_auto] gap-x-2 border-b border-[var(--color-border-subtle)] px-2.5 py-1 text-[10.5px] text-[var(--color-text-muted)]">
                <span>{tr('主机')}</span><span>{tr('状态')}</span><span className="text-right">{tr('耗时')}</span><span>{tr('输出首行')}</span><span />
              </div>
              {run.items.map((c, i) => {
                const r = rows[i]
                if (!r || (onlyOdd && majority >= 0 && !odd.has(i))) return null
                const res = r.result, out = (res?.error ? `${res.error}\n` : '') + (res?.output ?? '')
                const same = group[i] >= 0 && counts[group[i]] >= 2 ? counts[group[i]] : 0
                const canDiff = majority >= 0 && group[i] !== majority && res?.output !== undefined
                return (
                  <div key={c.key} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                    <div onClick={() => { setExpanded(expanded === i ? null : i); setDiffOf(null) }}
                      className={cn('grid cursor-pointer grid-cols-[minmax(0,200px)_110px_60px_minmax(0,1fr)_auto] items-center gap-x-2 px-2.5 py-1.5 hover:bg-[var(--color-bg-hover)]', expanded === i && 'bg-[var(--color-accent-bg)]')}>
                      <span className="flex min-w-0 items-center gap-1">
                        {expanded === i ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />}
                        <span className="truncate text-[var(--color-text-primary)]" title={c.detail}>{c.label}</span>
                        {c.env === 'prod' && <ProdBadge />}
                      </span>
                      <span className={cn('flex items-center gap-1 truncate', STATUS_CLS[r.status])}>
                        {r.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}{batchStatusText(r)}
                      </span>
                      <span className="text-right tabular-nums text-[var(--color-text-muted)]">{res ? fmtMs(res.ms) : ''}</span>
                      <span className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]" title={firstLine(out)}>{firstLine(out)}</span>
                      <span className="flex items-center gap-1">
                        {same > 0 && <span className={cn('rounded px-1 text-[10px]', group[i] === majority ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]' : 'bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] text-[var(--color-warn)]')}>{tr('{n} 台输出相同', { n: same })}</span>}
                        {odd.has(i) && same === 0 && <span className="rounded bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-1 text-[10px] text-[var(--color-warn)]">{tr('与多数不同')}</span>}
                      </span>
                    </div>
                    {expanded === i && (
                      <div className="space-y-1.5 bg-[var(--color-bg-base)] px-2.5 pb-2 pt-1">
                        <div className="flex items-center gap-2 text-[10.5px] text-[var(--color-text-muted)]">
                          <span>{c.detail ?? c.label}</span>
                          {res?.truncated && <span className="text-[var(--color-warn)]">{tr('输出超过 {n}KB，已截断', { n: BATCH_MAX_OUTPUT / 1024 })}</span>}
                          {canDiff && <button onClick={() => setDiffOf(diffOf === i ? null : i)} className={cn(SMALL_BTN, 'ml-auto')}>{diffOf === i ? tr('看完整输出') : tr('与多数比对')}</button>}
                        </div>
                        {diffOf === i
                          ? <DiffView diff={unifiedDiff(majorityOutput, res?.output ?? '', 'output') || tr('（输出相同，仅退出码不同）')} maxHeight="max-h-[40vh]" legend={tr('红色＝只在多数主机的输出里，绿色＝只在 {name} 的输出里', { name: c.label })} />
                          : <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border-subtle)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{out || (r.status === 'running' || r.status === 'pending' ? tr('还没有输出') : tr('（无输出）'))}</pre>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {confirm && (
          <div data-batch-confirm={confirm.kind} className="absolute inset-0 z-10 flex items-center justify-center bg-black/55" onClick={() => setConfirm(null)}>
            <div className="w-[480px] rounded-lg border border-[var(--color-danger)] bg-[var(--color-bg-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              {confirm.kind === 'danger' ? <>
                <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-danger)]"><AlertTriangle className="h-4 w-4" />{tr('危险命令将在生产主机上执行')}</div>
                <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">{tr('命令命中危险模式，以下 {n} 台生产主机会执行：', { n: confirm.prod.length })}</p>
                <div className="mb-2 max-h-28 overflow-y-auto rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[12px] text-[var(--color-text-primary)]">{confirm.prod.map((l) => <div key={l}>{l}</div>)}</div>
              </> : <>
                <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-warn)]"><AlertTriangle className="h-4 w-4" />{tr('这些主机上命令可能已经执行过')}</div>
                <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">{tr('以下 {n} 台是超时或执行中被中止的，远端命令可能已经跑完或仍在跑。命令不能重复执行（如数据库迁移、扣费、追加配置）时请先去主机上确认：', { n: confirm.hosts?.length ?? '' })}</p>
                <div className="mb-2 max-h-28 overflow-y-auto rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[12px] text-[var(--color-text-primary)]">{confirm.hosts?.map((l) => <div key={l}>{l}</div>)}</div>
              </>}
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('命令')}</div>
              <pre className="mb-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-base)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">{confirm.command}</pre>
              {confirm.health && <>
                <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('每批后的健康检查（每台都会执行）')}</div>
                <pre data-batch-confirm-health className="mb-2 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-base)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">{confirm.health}</pre>
              </>}
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
                <button data-batch-confirm-ok onClick={confirm.go} className="rounded-md bg-[var(--color-danger)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-on-danger)] hover:opacity-90">{confirm.kind === 'danger' ? tr('仍要执行') : tr('仍要重跑')}</button>
              </div>
            </div>
          </div>
        )}
        {closeAsk && (
          <div data-batch-close-ask className="absolute inset-0 z-20 flex items-center justify-center bg-black/55" onClick={() => setCloseAsk(false)}>
            <div className="w-[440px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-warn)]"><AlertTriangle className="h-4 w-4" />{tr('还有任务在执行')}</div>
              <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
                {tr('关闭会立即中止{what}，结果表{extra}也会一起消失。已经发出去的命令不会被撤回。', {
                  what: rolloutBusy ? tr('分批执行（后面的批次不再执行）') : rollout.rbBusy ? tr('close|回滚') : tr('正在跑的主机'),
                  extra: rolloutBusy ? tr('和「对已执行的主机运行回滚命令」') : '',
                })}
              </p>
              <div className="flex justify-end gap-2">
                <button autoFocus onClick={() => setCloseAsk(false)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('继续执行')}</button>
                <button data-batch-close-ok onClick={() => { setCloseAsk(false); onClose() }} className="rounded-md bg-[var(--color-danger)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-on-danger)] hover:opacity-90">{tr('中止并关闭')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
