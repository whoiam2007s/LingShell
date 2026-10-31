import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import {
  runRollout, splitBatches, healthCommand, rolloutExecuted, rolloutUncertain, batchStatusText, firstLine, fmtMs, batchMarkdown, runPool, batchGate,
  HEALTH_TIMEOUT_SEC, ROLLOUT_MAX_INTERVAL_SEC, ROLLOUT_MAX_RETRIES, tk, tr,
  type BatchChoice, type BatchExecResult, type RolloutOpts, type RolloutPhase, type RolloutRow, type BatchTag,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { cn } from '../../../lib/cn.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { Select } from '../../../components/ui/Select.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { Input } from '../../../components/ui/Input.js'
import { HelpTip } from '../../../components/ui/form.js'
import { ProdBadge } from '../../../components/sshParts.js'
import { trx } from '../../../lib/trx.js'

// 分批执行（滚动发布 / 金丝雀）：批量执行弹窗里打开「分批执行」后用。调度见 shared/ops/rollout.ts，
// 单台仍走 client.batch.exec（独立通道 + 执行记录，标「分批执行 · 第 k 批」）
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const SMALL_BTN = 'rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const ACCENT_BTN = 'rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-0.5 text-[11.5px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const STATUS_CLS: Record<string, string> = {
  pending: 'text-[var(--color-text-muted)]', running: 'text-[var(--color-accent)]', ok: 'text-[var(--color-success)]', retry: 'text-[var(--color-warn)]',
  fail: 'text-[var(--color-danger)]', timeout: 'text-[var(--color-warn)]', conn_error: 'text-[var(--color-danger)]', canceled: 'text-[var(--color-text-muted)]',
}
const HEALTH_TEXT = { running: tk('检查中'), retry: tk('重试中'), ok: tk('健康'), fail: tk('不健康'), canceled: tk('已取消') } as const

export interface RolloutSnap { command: string; items: BatchChoice[]; timeoutMs: number; concurrency: number; opts: RolloutOpts }

/** 分批设置（批量执行弹窗里，开关打开时显示） */
export function RolloutOptions({ o, set, total }: { o: RolloutOpts; set: (p: Partial<RolloutOpts>) => void; total: number }) {
  const batches = splitBatches(total, o.sizeKind, o.size)
  const lbl = 'flex items-center gap-1.5 text-[var(--color-text-secondary)]'
  return (
    <div data-rollout-opts className="space-y-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={lbl}>{tr('每批')}
          <NumberInput size="sm" className="w-20" value={o.size} min={1} max={o.sizeKind === 'percent' ? 100 : 999} onChange={(n) => set({ size: n })} />
          <Select size="sm" className="w-16" value={o.sizeKind} onValueChange={(v) => set({ sizeKind: v as RolloutOpts['sizeKind'], size: v === 'percent' ? Math.min(o.size, 100) : o.size })}
            options={[{ value: 'count', label: tr('unit|台') }, { value: 'percent', label: '%' }]} />
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)]">{total ? tr('{n} 台分 {b} 批：{sizes}', { n: total, b: batches.length, sizes: batches.map((b) => b.length).join(' / ') }) : tr('先勾选主机')}</span>
        <label className={cn(lbl, 'cursor-pointer')}><Checkbox checked={o.canary} onCheckedChange={(v) => set({ canary: !!v })} />{tr('第一批（金丝雀）跑完先暂停，等我确认')}</label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={lbl}>{tr('每批后健康检查')}
          <Select size="sm" className="w-44" value={o.health} onValueChange={(v) => set({ health: v as RolloutOpts['health'] })}
            options={[{ value: 'none', label: tr('不检查') }, { value: 'command', label: tr('命令（退出码 0）') }, { value: 'url', label: tr('URL（期望 200）') }]} />
        </span>
        {o.health !== 'none' && (
          <>
            <Input size="sm" className="w-64 font-mono" value={o.healthCmd} onChange={(e) => set({ healthCmd: e.target.value })} spellCheck={false}
              placeholder={o.health === 'url' ? 'http://127.0.0.1:8080/health' : 'systemctl is-active myapp'} />
            <span className={lbl}>{trx('失败重试{n}次', { n: <NumberInput size="sm" className="w-16" value={o.retries} min={0} max={ROLLOUT_MAX_RETRIES} onChange={(n) => set({ retries: n })} /> })}</span>
            <span className={lbl}>{trx('间隔{n}秒', { n: <NumberInput size="sm" className="w-16" value={o.intervalSec} min={1} max={ROLLOUT_MAX_INTERVAL_SEC} onChange={(n) => set({ intervalSec: n })} /> })}</span>
            <HelpTip>{tr('在这一批执行成功的每台主机上跑；{how}。单次最长 {sec} 秒，失败按间隔重试，用完重试次数仍失败算这台失败。', {
              how: o.health === 'url' ? tr('用 curl（没有则 wget）请求这个 URL，状态码 200 算健康') : tr('退出码 0 算健康'), sec: HEALTH_TIMEOUT_SEC,
            })}</HelpTip>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={lbl}>{tr('有主机失败时')}
          <Select size="sm" className="w-40" value={o.onFail} onValueChange={(v) => set({ onFail: v as RolloutOpts['onFail'] })}
            options={[{ value: 'stop', label: tr('rollout|停止') }, { value: 'skip', label: tr('跳过这台继续') }]} />
        </span>
        <span className={cn(lbl, 'min-w-0 flex-1')}>{tr('回滚命令（可选）')}
          <Input size="sm" className="min-w-0 flex-1 font-mono" value={o.rollback} onChange={(e) => set({ rollback: e.target.value })} spellCheck={false} placeholder={tr('结束后可对已执行的主机运行，如 {cmd}', { cmd: './deploy.sh rollback' })} />
        </span>
      </div>
    </div>
  )
}

/** 分批执行的调度与状态：start 由点击触发（不放进 effect，避免开发模式下双跑） */
export function useRollout() {
  const [snap, setSnap] = useState<RolloutSnap | null>(null)
  const [rows, setRows] = useState<RolloutRow[]>([])
  const [phase, setPhase] = useState<RolloutPhase | null>(null)
  const [rbBusy, setRbBusy] = useState(false)
  const [rbDone, setRbDone] = useState(false)   // 这一轮已经回滚过：不能再点一次覆盖上次的结果
  const ctl = useRef<{ runId: string; ac: AbortController; gate?: (go: boolean) => void } | null>(null)
  const rb = useRef<{ runId: string; ac: AbortController; seq: number } | null>(null)
  const rbSeq = useRef(0)
  const stop = () => {
    const c = ctl.current
    if (c) { c.ac.abort(); c.gate?.(false); client.batch.cancel(c.runId).catch(() => {}) }
    const r = rb.current   // 回滚也要能取消 / 关弹窗时中止；单独存，才不会被「开始」覆盖
    if (r) { rbSeq.current++; r.ac.abort(); client.batch.cancel(r.runId).catch(() => {}); rb.current = null; setRbBusy(false) }
  }
  useEffect(() => () => stop(), [])   // 关闭弹窗 = 中止
  const exec = (runId: string, s: RolloutSnap, i: number, cmd: string, ms: number, tag: BatchTag) =>
    client.batch.exec(runId, s.items[i].target, cmd, ms, tag).catch((e): BatchExecResult => ({ status: 'conn_error', error: errText(e), ms: 0 }))

  const start = (s: RolloutSnap) => {
    stop()
    const runId = crypto.randomUUID(), ac = new AbortController()
    const c: { runId: string; ac: AbortController; gate?: (go: boolean) => void } = { runId, ac }
    ctl.current = c
    // 批次号一开始就按切批填好：暂停时复制 Markdown，后面批次的主机不会被标成「第 1 批」
    const batchOf: number[] = []
    splitBatches(s.items.length, s.opts.sizeKind, s.opts.size).forEach((b, k) => b.forEach((i) => { batchOf[i] = k }))
    setSnap(s); setRows(s.items.map((_, i) => ({ batch: batchOf[i] ?? 0, status: 'pending' }))); setPhase({ state: 'running', batch: 0 }); setRbDone(false)
    const hc = healthCommand(s.opts) ?? ''
    void runRollout(s.items.length, s.opts, s.concurrency, {
      run: (i, b) => exec(runId, s, i, s.command, s.timeoutMs, { kind: 'rollout', batch: b + 1 }),
      health: (i, b) => exec(runId, s, i, hc, HEALTH_TIMEOUT_SEC * 1000, { kind: 'health', batch: b + 1 }),
      sleep: (ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) }),
      gate: () => new Promise<boolean>((r) => { c.gate = (go) => { c.gate = undefined; r(go) } }),
      row: (i, r) => setRows((rs) => rs.map((x, j) => (j === i ? { ...r, rollback: x.rollback } : x))),
      phase: (p) => { if (ctl.current === c) setPhase(p) },
      aborted: () => ac.signal.aborted,
    })
  }
  const cont = () => ctl.current?.gate?.(true)
  const rollback = async (indices: number[]) => {
    if (!snap || rbBusy) return
    const runId = crypto.randomUUID(), ac = new AbortController()
    const seq = ++rbSeq.current
    rb.current = { runId, ac, seq }
    setRbBusy(true)
    // 只更新本次回滚那一轮的行：开始新一轮部署后，旧回滚的迟到结果不能覆盖新表格
    const setRb = (i: number, row: RolloutRow['rollback']) => { if (seq === rbSeq.current) setRows((rs) => rs.map((x, j) => (j === i ? { ...x, rollback: row } : x))) }
    indices.forEach((i) => setRb(i, { status: 'pending' }))
    await runPool(indices.length, snap.concurrency, async (k) => {
      if (ac.signal.aborted) return
      const i = indices[k]
      setRb(i, { status: 'running' })
      const r = await exec(runId, snap, i, snap.opts.rollback, snap.timeoutMs, { kind: 'rollback' })
      setRb(i, { status: r.status, result: r })
    })
    if (seq === rbSeq.current) { rb.current = null; setRbBusy(false); if (!ac.signal.aborted) setRbDone(true) }
  }
  const ended = !!phase && phase.state !== 'running' && phase.state !== 'paused'
  return { snap, rows, phase, ended, start, cont, abort: stop, rollback, rbBusy, rbDone }
}

/** 分批执行的进度区：按批分段，每段一个小表；底部 / 顶部是继续、中止、回滚 */
export function RolloutTable({ r, flash, note }: { r: ReturnType<typeof useRollout>; flash: (text: string, note: string) => void; note?: string }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const [confirmRb, setConfirmRb] = useState(false)
  // 回滚确认框：Esc 只关它（捕获阶段拦下，不让批量执行弹窗跟着关）
  useEffect(() => {
    if (!confirmRb) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirmRb(false) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmRb])
  const { snap, rows, phase } = r
  if (!snap || !phase) return null
  const batches = splitBatches(snap.items.length, snap.opts.sizeKind, snap.opts.size)
  const executed = rolloutExecuted(rows)
  const uncertain = rolloutUncertain(rows)
  const rbGate = batchGate(snap.opts.rollback, executed.map((i) => snap.items[i]))
  const label = (i: number) => tr('第 {k} 批 · {name}', { k: rows[i].batch + 1, name: snap.items[i].label })
  const md = () => batchMarkdown(snap.command, snap.items.map((_, i) => ({ label: label(i), row: rows[i] })))
  const head = phase.state === 'running' ? tr('正在执行第 {k} / {n} 批…', { k: phase.batch + 1, n: batches.length })
    : phase.state === 'paused' ? tr('第 1 批（金丝雀）已完成，确认无误后点「继续下一批」')
      : phase.state === 'done' ? tr('全部 {n} 批已完成', { n: batches.length }) : phase.state === 'stopped' ? (phase.reason ? tr(phase.reason) : tr('已停止')) : (phase.reason ? tr(phase.reason) : tr('已中止'))
  const tone = phase.state === 'stopped' ? 'text-[var(--color-danger)]' : phase.state === 'paused' ? 'text-[var(--color-warn)]' : phase.state === 'done' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-secondary)]'
  return (
    <div data-rollout className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11.5px]">
        {(phase.state === 'running') && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />}
        <span data-rollout-phase={phase.state} className={cn('font-medium', tone)}>{head}</span>
        <span className="max-w-[220px] truncate font-mono text-[11px] text-[var(--color-text-muted)]" title={snap.command}>$ {firstLine(snap.command)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {note && <span className="text-[var(--color-success)]">{note}</span>}
          {phase.state === 'paused' && <button onClick={r.cont} className={ACCENT_BTN}>{tr('继续下一批')}</button>}
          {!r.ended && <button onClick={r.abort} className={cn(SMALL_BTN, 'text-[var(--color-danger)]')}>{tr('中止')}</button>}
          {r.ended && snap.opts.rollback.trim() && (
            <button data-rollback-btn disabled={!executed.length || r.rbBusy || r.rbDone} onClick={() => setConfirmRb(true)} className={cn(SMALL_BTN, 'text-[var(--color-warn)]')}
              title={r.rbDone ? tr('这一轮已经回滚过；要再回滚请去终端里处理') : undefined}>
              {r.rbBusy ? tr('回滚中…') : r.rbDone ? tr('已运行回滚') : tr('对已执行的主机运行回滚命令（{n}）', { n: executed.length })}
            </button>
          )}
          <button onClick={() => flash(md(), tr('已复制 Markdown'))} className={SMALL_BTN}>{tr('复制为 Markdown')}</button>
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,200px)_110px_100px_60px_minmax(0,1fr)] gap-x-2 border-b border-[var(--color-border-subtle)] px-2.5 py-1 text-[10.5px] text-[var(--color-text-muted)]">
        <span>{tr('主机')}</span><span>{tr('col|执行')}</span><span>{tr('健康检查')}</span><span className="text-right">{tr('耗时')}</span><span>{tr('输出首行')}</span>
      </div>
      {batches.map((b, k) => {
        const st = k < phase.batch || (k === phase.batch && phase.state !== 'running') ? tr('已结束') : k === phase.batch ? tr('进行中') : r.ended ? tr('未执行') : tr('等待')
        return (
          <div key={k} data-rollout-batch={k}>
            <div className="flex items-center gap-2 bg-[color:color-mix(in_srgb,var(--color-accent)_6%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
              <span className="font-medium">{k === 0 && snap.opts.canary ? tr('第 {k} 批（金丝雀）', { k: k + 1 }) : tr('第 {k} 批', { k: k + 1 })}</span>
              <span className="text-[var(--color-text-muted)]">{tr('{n} 台 · {state}', { n: b.length, state: st })}</span>
            </div>
            {b.map((i) => {
              const row = rows[i], res = row.result, h = row.health
              const out = (res?.error ? `${res.error}\n` : '') + (res?.output ?? '')
              return (
                <div key={i} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
                  <div onClick={() => setExpanded(expanded === i ? null : i)}
                    className={cn('grid cursor-pointer grid-cols-[minmax(0,200px)_110px_100px_60px_minmax(0,1fr)] items-center gap-x-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--color-bg-hover)]', expanded === i && 'bg-[var(--color-accent-bg)]')}>
                    <span className="flex min-w-0 items-center gap-1">
                      {expanded === i ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />}
                      <span className="truncate text-[var(--color-text-primary)]" title={snap.items[i].detail}>{snap.items[i].label}</span>
                      {snap.items[i].env === 'prod' && <ProdBadge />}
                    </span>
                    <span className={cn('flex items-center gap-1 truncate', STATUS_CLS[row.status])}>
                      {row.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}{batchStatusText(row)}{row.skipped && <span className="text-[10px] text-[var(--color-text-muted)]">{tr('· 已跳过')}</span>}
                    </span>
                    <span className={cn('truncate text-[11.5px]', h ? STATUS_CLS[h.status] : 'text-[var(--color-text-muted)]')}>
                      {h ? (h.tries > 1 ? tr('{state}（第 {n} 次）', { state: tr(HEALTH_TEXT[h.status]), n: h.tries }) : tr(HEALTH_TEXT[h.status])) : healthCommand(snap.opts) ? '—' : tr('不检查')}
                    </span>
                    <span className="text-right tabular-nums text-[var(--color-text-muted)]">{res ? fmtMs(res.ms) : ''}</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]" title={firstLine(out)}>{firstLine(out)}</span>
                      {row.rollback && <span className={cn('ml-auto shrink-0 rounded px-1 text-[10px]', STATUS_CLS[row.rollback.status])}>{tr('回滚：{state}', { state: batchStatusText(row.rollback) })}</span>}
                    </span>
                  </div>
                  {expanded === i && (
                    <div className="space-y-1.5 bg-[var(--color-bg-base)] px-2.5 pb-2 pt-1 text-[10.5px] text-[var(--color-text-muted)]">
                      <Out title={tr('命令输出')} text={out || (row.status === 'pending' || row.status === 'running' ? tr('还没有输出') : tr('（无输出）'))} />
                      {h?.result && <Out title={tr('健康检查（第 {n} 次）', { n: h.tries })} text={(h.result.error ? `${h.result.error}\n` : '') + (h.result.output || tr('（无输出）'))} />}
                      {row.rollback?.result && <Out title={tr('回滚输出')} text={(row.rollback.result.error ? `${row.rollback.result.error}\n` : '') + (row.rollback.result.output || tr('（无输出）'))} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
      {confirmRb && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55">
          <div data-rollback-confirm className={cn('w-[480px] rounded-lg border bg-[var(--color-bg-panel)] p-5 shadow-2xl', rbGate.prod.length ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-default)]')}>
            <div className={cn('mb-2 flex items-center gap-2 text-[14px] font-semibold', rbGate.prod.length ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>
              <AlertTriangle className="h-4 w-4" />{tr('对 {n} 台已执行的主机运行回滚命令', { n: executed.length })}
            </div>
            {rbGate.prod.length > 0 && <p className="mb-2 text-[12.5px] text-[var(--color-danger)]">{tr('其中 {n} 台是生产主机：{list}', { n: rbGate.prod.length, list: rbGate.prod.join(tr('list|、')) })}</p>}
            {uncertain.length > 0 && <p data-rollback-uncertain className="mb-2 text-[12.5px] text-[var(--color-warn)]">
              {tr('其中 {n} 台是超时或执行中被中止的：{list}。远端的部署命令可能还在跑，回滚会和它同时进行，建议先到主机上确认。', { n: uncertain.length, list: uncertain.map((i) => snap.items[i].label).join(tr('list|、')) })}
            </p>}
            <div className="mb-2 max-h-28 overflow-y-auto rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[12px] text-[var(--color-text-primary)]">{executed.map((i) => <div key={i}>{label(i)}</div>)}</div>
            <pre className="mb-4 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-base)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">{snap.opts.rollback}</pre>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRb(false)} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
              <button onClick={() => { setConfirmRb(false); void r.rollback(executed) }} className="rounded-md bg-[var(--color-danger)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-on-danger)] hover:opacity-90">{tr('运行回滚')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Out({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-0.5">{title}</div>
      <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--color-border-subtle)] p-2 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{text}</pre>
    </div>
  )
}
