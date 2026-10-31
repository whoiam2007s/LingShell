import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Cpu, ListTree, MessageSquareQuote, Pause, Play, RefreshCw, X } from 'lucide-react'
import {
  PROC_SIGNALS, PROC_SIGNAL_LABEL, buildProcTree, compareProcs, filterProcs, fmtPct, fmtRss, procQuote, processSupported, redactSecrets, tk, tr,
  type ProcList, type ProcRow, type ProcSignal, type ProcSortKey, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { Select } from '../../../components/ui/Select.js'
import { trx } from '../../../lib/trx.js'

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
const BTN = 'flex items-center gap-1 rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const INTERVALS = [2, 5, 10, 30]
const WIN_SIGNALS: ProcSignal[] = ['TERM', 'KILL']
const WIN_SIGNAL_LABEL: Record<ProcSignal, string> = { TERM: tk('结束（taskkill）'), KILL: tk('强制结束（taskkill /F）'), HUP: 'HUP' }
// 列宽（表头与行共用）；命令列占剩余，完整命令行看选中后的详情 / 悬停提示
const W = { pid: 'w-[42px]', user: 'w-[54px]', cpu: 'w-[36px]', mem: 'w-[36px]', rss: 'w-[46px]', elapsed: 'w-[60px]', stat: 'w-[32px]' }
// 列：[排序键, 表头, 宽度类, 是否右对齐]（表头 tk 标记，显示处 tr）
const COLS: [ProcSortKey, string, string, boolean][] = [
  ['pid', 'PID', W.pid, true], ['user', tk('用户'), W.user, false], ['cpu', 'CPU%', W.cpu, true], ['mem', tk('内存%'), W.mem, true],
  ['rss', 'RSS', W.rss, true], ['elapsed', tk('运行时长'), W.elapsed, true], ['stat', tk('proc|状态'), W.stat, false], ['command', tk('命令'), 'min-w-0 flex-1', false],
]

// 终端工具栏按钮：只给 SSH（非 Windows）终端显示
// 进程管理器：当前 SSH 终端所在主机的进程表（独立 exec channel 跑 ps，不进交互 shell）。
// 点表头排序、按命令 / 用户过滤、自动刷新、树形视图；选中一行可发信号 / 复制命令行 / 问 AI。切终端时由外层 key 重挂载
export function ProcessDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const local = term?.type === 'local'   // 本机视图：本地终端看本机进程（Windows 用 tasklist / taskkill）
  const ok = !!term && (local || processSupported(term.type, term.os))
  const tid = term?.id ?? ''
  const prod = term?.env === 'prod'
  const [list, setList] = useState<ProcList>()
  // 本机 Windows：没有 HUP，结束 = taskkill（强制 = /F）
  const win = list?.local === 'windows'
  const sigLabel = (s: ProcSignal) => tr(win ? WIN_SIGNAL_LABEL[s] : PROC_SIGNAL_LABEL[s])
  const sigCmd = (s: ProcSignal, pid: number) => (win ? `taskkill ${s === 'KILL' ? '/F ' : ''}/PID ${pid}` : `kill -${s} ${pid}`)
  // Windows 没有 CPU%：默认改按内存（RSS）倒序
  useEffect(() => { if (win) setSort((s) => (s.key === 'cpu' ? { key: 'rss', desc: true } : s)) }, [win])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: ProcSortKey; desc: boolean }>({ key: 'cpu', desc: true })
  const [tree, setTree] = useState(false)
  const [paused, setPaused] = useState(false)
  const [every, setEvery] = useState(5)
  const [sel, setSel] = useState<number>()   // 选中的 pid
  const [confirm, setConfirm] = useState<{ row: ProcRow; sig: ProcSignal }>()
  const [typed, setTyped] = useState('')
  const [flash, setFlash] = useState('')

  const inflight = useRef(false)
  const refresh = useCallback(() => {
    if (!ok || inflight.current) return
    inflight.current = true; setLoading(true)
    client.processes.list(tid).then((r) => { setList(r); setErr('') }).catch((e) => setErr(errText(e)))
      .finally(() => { inflight.current = false; setLoading(false) })
  }, [ok, tid])
  useEffect(() => { refresh() }, [refresh])
  // 自动刷新：确认框开着时也暂停，免得列表在眼皮底下变
  const auto = ok && !paused && !confirm
  useEffect(() => {
    if (!auto) return
    const t = setInterval(refresh, every * 1000)
    return () => clearInterval(t)
  }, [auto, every, refresh])

  const cmp = useMemo(() => compareProcs(sort.key, sort.desc), [sort])
  const shown = useMemo(() => {
    const rows = list?.rows ?? []
    return tree ? buildProcTree(rows, cmp, q) : filterProcs(rows, q).sort(cmp).map((row) => ({ row, depth: 0, hasChildren: false }))
  }, [list, tree, cmp, q])
  const selRow = sel === undefined ? undefined : list?.rows.find((r) => r.pid === sel)

  const clickHead = (key: ProcSortKey) => setSort((s) => s.key === key ? { key, desc: !s.desc } : { key, desc: !(key === 'user' || key === 'stat' || key === 'command') })
  const note = (text: string) => { setFlash(text); setTimeout(() => setFlash((f) => (f === text ? '' : f)), 1500) }
  const copy = (r: ProcRow) => navigator.clipboard?.writeText(r.command).then(() => note(tr('已复制命令行')), () => note(tr('复制失败')))
  const askAi = async (r: ProcRow) => {
    const q = procQuote(term?.title ?? '', r)
    // 命令行常含 mysql -p… / Authorization: Bearer …：与其它「问 AI」入口一致，默认先脱敏
    const s = await client.settings.get().catch(() => undefined)
    quoteToChat(s?.system?.aiRedact === false ? q : redactSecrets(q))
    onClose()
  }
  const ask = (row: ProcRow, sig: ProcSignal) => { setTyped(''); setConfirm({ row, sig }) }
  const doSignal = () => {
    const x = confirm
    if (!x) return
    if (prod && typed.trim() !== String(x.row.pid)) return   // 生产主机：要先输入 PID
    setConfirm(undefined)
    client.processes.signal(tid, x.row.pid, x.sig, x.row.command)
      .then(() => note(tr('已向 {pid} 发送 {sig}', { pid: x.row.pid, sig: x.sig })))
      .catch((e) => setErr(tr('向进程 {pid} 发送 {sig} 失败：{msg}', { pid: x.row.pid, sig: x.sig, msg: errText(e) })))
      .finally(() => setTimeout(refresh, 500))   // 留点时间让进程退出再刷
  }

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">{local ? tr('进程 · 本机') : tr('进程')}</span>
      {list && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{list.rows.length}{list.truncated ? '+' : ''}</span>}
      <span className="ml-auto" />
      {ok && <>
        {!win && <button title={tree ? tr('切回列表视图') : tr('树形视图（按父进程）')} onClick={() => setTree((v) => !v)}
          className={`${IB} ${tree ? 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]' : ''}`}><ListTree className="h-3.5 w-3.5" /></button>}
        <button title={paused ? tr('继续自动刷新') : tr('暂停自动刷新')} onClick={() => setPaused((v) => !v)} className={IB}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}</button>
        {/* 头部图标按钮都是 24px，这里跟着压到 h-6 */}
        <Select size="sm" title={tr('自动刷新间隔')} value={String(every)} onValueChange={(v) => setEvery(Number(v))} disabled={paused}
          className="h-6 w-auto shrink-0 text-[11px] text-[var(--color-text-secondary)]"
          options={INTERVALS.map((s) => ({ value: String(s), label: tr('{n} 秒', { n: s }) }))} />
        <button title={tr('刷新')} disabled={loading} onClick={refresh} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
      </>}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )

  if (!ok) return (
    <div className="flex h-full flex-col">{header}
      <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('进程管理支持本地终端（本机）和 SSH 终端（非 Windows 主机）：先切到一个终端再打开。')}</div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('按命令 / 用户 / PID 过滤')}
          className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">
        {COLS.map(([key, label, w, right]) => (
          <button key={key} onClick={() => clickHead(key)} title={tr('按{col}排序', { col: tr(label) })}
            className={`flex items-center gap-0.5 overflow-hidden whitespace-nowrap hover:text-[var(--color-accent)] ${w} ${key === 'command' ? '' : 'shrink-0'} ${right ? 'justify-end' : ''} ${sort.key === key ? 'text-[var(--color-accent)]' : ''}`}>
            {tr(label)}{sort.key === key && (sort.desc ? <ArrowDown className="h-2.5 w-2.5 shrink-0" /> : <ArrowUp className="h-2.5 w-2.5 shrink-0" />)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[10.5px]">
        {!list && <div className="px-3 py-3 font-sans text-[12px] text-[var(--color-text-muted)]">{loading ? tr('读取中…') : ''}</div>}
        {list && shown.length === 0 && <div className="px-3 py-3 font-sans text-[12px] text-[var(--color-text-muted)]">{tr('（没有匹配的进程）')}</div>}
        {shown.map(({ row: r, depth }) => (
          <div key={r.pid} onClick={() => setSel(r.pid === sel ? undefined : r.pid)} title={r.command}
            className={`flex cursor-default items-center gap-1 px-2 py-[3px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] ${r.pid === sel ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]' : ''}`}>
            <span className={`${W.pid} shrink-0 text-right`}>{r.pid}</span>
            <span className={`${W.user} shrink-0 truncate`} title={r.user}>{r.user}</span>
            <span className={`${W.cpu} shrink-0 text-right ${(r.cpu ?? 0) >= 50 ? 'text-[var(--color-danger)]' : ''}`}>{fmtPct(r.cpu)}</span>
            <span className={`${W.mem} shrink-0 text-right`}>{fmtPct(r.mem)}</span>
            <span className={`${W.rss} shrink-0 text-right`}>{fmtRss(r.rss)}</span>
            <span className={`${W.elapsed} shrink-0 truncate text-right`}>{r.etime || '—'}</span>
            <span className={`${W.stat} shrink-0 truncate`}>{r.stat}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]" style={{ paddingLeft: depth * 10 }}>{depth > 0 ? '└ ' : ''}{r.command}</span>
          </div>
        ))}
      </div>
      {selRow && (
        <div className="shrink-0 space-y-1.5 border-t border-[var(--color-border-default)] px-3 py-2">
          <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-1.5 font-mono text-[10.5px] text-[var(--color-text-primary)]">{selRow.command}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--color-text-muted)]">PID {selRow.pid}</span>
            {selRow.pid > 1 && !(win && selRow.pid === 4) && (win ? WIN_SIGNALS : PROC_SIGNALS).map((s) => (
              <button key={s} title={sigCmd(s, selRow.pid)} onClick={() => ask(selRow, s)}
                className={`${BTN} ${s === 'HUP' ? 'text-[var(--color-warn)]' : 'text-[var(--color-danger)]'}`}>{sigLabel(s)}</button>
            ))}
            <button onClick={() => copy(selRow)} className={`${BTN} text-[var(--color-text-secondary)]`}><Copy className="h-3 w-3" />{tr('复制命令行')}</button>
            <button onClick={() => askAi(selRow)} className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('问 AI')}</button>
            {flash && <span className="text-[11px] text-[var(--color-success)]">{flash}</span>}
          </div>
        </div>
      )}
      {!selRow && flash && <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
      <ConfirmDialog open={!!confirm}
        title={confirm ? (prod ? tr('生产主机：{title}', { title: tr('{sig}进程 {pid}', { sig: sigLabel(confirm.sig), pid: confirm.row.pid }) }) : tr('{sig}进程 {pid}', { sig: sigLabel(confirm.sig), pid: confirm.row.pid })) : ''}
        message={confirm ? tr('{prod}确定在{where}执行 {cmd}？操作会记入执行记录。', {
          prod: prod ? tr('这是生产主机！') : '', where: local ? tr('where|本机') : tr('「{title}」上', { title: term?.title ?? '' }), cmd: sigCmd(confirm.sig, confirm.row.pid),
        }) : ''}
        confirmText={confirm ? (win ? sigLabel(confirm.sig) : prod ? tr('生产主机 · {label}', { label: tr('发送 {sig}', { sig: confirm.sig }) }) : tr('发送 {sig}', { sig: confirm.sig })) : ''}
        onConfirm={doSignal} onCancel={() => setConfirm(undefined)}>
        {confirm && (
          <div className="space-y-2">
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] text-[var(--color-text-secondary)]">{confirm.row.user} · {confirm.row.command}</div>
            {prod && <>
              <div className="text-[12px] text-[var(--color-danger)]">{trx('生产主机需要再确认一次：请输入进程号 {pid}', { pid: <b className="font-mono">{confirm.row.pid}</b> })}</div>
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doSignal() }}
                placeholder={String(confirm.row.pid)}
                className={`w-full rounded border bg-[var(--color-bg-raised)] px-2 py-1 font-mono text-[12px] text-[var(--color-text-primary)] outline-none ${typed && typed.trim() !== String(confirm.row.pid) ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-default)]'}`} />
            </>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
