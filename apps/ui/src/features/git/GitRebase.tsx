// 整理提交（交互式变基，同 IDEA 的 Interactively Rebase）：从选中的提交（含）到 HEAD，按从旧到新列出；
// 每个提交选 保留 / 改说明 / 压缩（并入上一个，说明合并）/ 合并丢弃说明（fixup）/ 删除，上下移动调整顺序。
// 压缩组可以给新说明（写在组里最后一个提交上）。执行前列出影响，已推送过的提醒之后要强制推送；有合并提交的范围不支持
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Loader2, Rows3, X } from 'lucide-react'
import { checkRebaseSteps, tk, tr, type RebaseAction, type RebasePlan, type RebaseStep } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Textarea } from '../../components/ui/Input.js'
import { cn } from '../../lib/cn.js'
import { IB, errText, shortDate, type GitCtx } from './gitUi.js'

const ACTIONS: { k: RebaseAction; label: string; tip: string }[] = [
  { k: 'pick', label: tk('keep|保留'), tip: tk('原样保留') },
  { k: 'reword', label: tk('改说明'), tip: tk('保留改动，修改提交说明') },
  { k: 'squash', label: tk('rebase|压缩'), tip: tk('并入上一个保留的提交，说明合在一起（可以改）') },
  { k: 'fixup', label: tk('并入'), tip: tk('并入上一个保留的提交，丢掉自己的说明') },
  { k: 'drop', label: tk('删除'), tip: tk('去掉这个提交和它的改动') },
]
type Row = RebaseStep & { orig: string; author: string; date: string; pushed: boolean }

export function GitRebase({ ctx, from, onClose }: { ctx: GitCtx; from: string; onClose: () => void }) {
  const [plan, setPlan] = useState<RebasePlan>()
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  useEffect(() => {
    client.git.rebasePlan(ctx.tid, ctx.root, from).then((p) => {
      setPlan(p)
      setRows(p.commits.map((c) => ({ hash: c.hash, action: 'pick', orig: c.message, author: c.author, date: c.date, pushed: c.pushed })))
    }).catch((e) => setErr(errText(e)))
  }, [ctx.tid, ctx.root, from])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: -1 | 1) => setRows((rs) => { const n = [...rs], j = i + d; if (j < 0 || j >= n.length) return rs; [n[i], n[j]] = [n[j], n[i]]; return n })
  // 每个压缩 / 并入行所在组的最后一行才显示「压缩后的说明」（脚本只用组末尾的说明）
  const groupEnd = (i: number) => { const next = rows.slice(i + 1).find((r) => r.action !== 'drop'); return !next || (next.action !== 'squash' && next.action !== 'fixup') }
  const steps: RebaseStep[] = rows.map((r) => ({ hash: r.hash, action: r.action, ...(r.message?.trim() ? { message: r.message } : {}) }))
  const problem = plan && (plan.merges > 0 ? tr('范围里有 {n} 个合并提交，整理提交不支持合并提交', { n: plan.merges }) : plan.commits.length > 100 ? tr('范围太大（最多 100 个提交），从更近的提交开始') : checkRebaseSteps(steps))
  const changed = rows.some((r, i) => r.action !== 'pick' || r.hash !== plan?.commits[i]?.hash)
  const pushed = rows.filter((r) => r.pushed).length
  const result = useMemo(() => {
    const out: { msg: string; n: number }[] = []
    for (const r of rows) {
      if (r.action === 'drop') continue
      if ((r.action === 'squash' || r.action === 'fixup') && out.length) { const g = out[out.length - 1]; g.n++; if (r.message?.trim()) g.msg = r.message.trim(); else if (r.action === 'squash') g.msg = `${g.msg}\n\n${r.orig}`; continue }
      out.push({ msg: (r.action === 'reword' && r.message?.trim()) || r.orig, n: 1 })
    }
    return out
  }, [rows])
  const run = () => {
    setRunning(true)
    void ctx.run({ op: 'interactiveRebase', from, root: !!plan?.root, steps, ...(plan?.head ? { expectedHead: plan.head } : {}) }, {
      confirm: { title: tr('整理提交'), danger: true, ok: tr('开始整理'), text: tr('把 {n} 个提交整理成 {m} 个。会改写这些提交（提交号都会变）。', { n: rows.length, m: result.length }) + (pushed ? '\n' + tr('其中 {n} 个已经推送过：整理后推送需要「强制推送」，别人可能已经基于它们开发了。', { n: pushed }) : '') + '\n' + tr('有冲突会停在「正在变基」，可以解决后继续或中止。') },
      done: tr('已整理提交'),
    }).then((ok) => { setRunning(false); if (ok) onClose() })
  }

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-rebase className="flex h-[88vh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <Rows3 className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('整理提交')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('交互式变基 · 从 {from} 到 {to}，从旧到新', { from: from.slice(0, 7), to: ctx.st.branch || 'HEAD' })}</span>
          <button onClick={onClose} title={tr('关闭（Esc）')} className={cn(IB, 'ml-auto')}><X className="h-4 w-4" /></button>
        </div>
        {err && <div className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        {!plan && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {plan && (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
              {rows.map((r, i) => {
                const squash = r.action === 'squash' || r.action === 'fixup'
                return (
                  <div key={r.hash} data-rebase-row={r.hash.slice(0, 7)} data-action={r.action}
                    className={cn('rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1.5', r.action === 'drop' && 'opacity-50', squash && 'ml-6 border-dashed')}>
                    <div className="flex items-center gap-1.5">
                      <div className="flex shrink-0 flex-col">
                        <button disabled={i === 0} onClick={() => move(i, -1)} title={tr('上移')} className={cn(IB, 'h-4 w-5')}><ArrowUp className="h-3 w-3" /></button>
                        <button disabled={i === rows.length - 1} onClick={() => move(i, 1)} title={tr('下移')} className={cn(IB, 'h-4 w-5')}><ArrowDown className="h-3 w-3" /></button>
                      </div>
                      <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border-default)] text-[11px]">
                        {ACTIONS.map((a) => (
                          <button key={a.k} data-rebase-action={a.k} onClick={() => set(i, { action: a.k, message: a.k === 'reword' ? r.message ?? r.orig : a.k === 'squash' || a.k === 'fixup' ? r.message : undefined })} title={tr(a.tip)}
                            className={cn('px-2 py-0.5', r.action === a.k ? (a.k === 'drop' ? 'bg-[var(--color-danger)] text-[var(--color-on-danger)]' : 'bg-[var(--color-accent)] text-[var(--color-bg-base)]') : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>{tr(a.label)}</button>
                        ))}
                      </div>
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">{r.hash.slice(0, 7)}</span>
                      <span className={cn('min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-primary)]', r.action === 'drop' && 'line-through')} title={r.orig}>{r.orig.split('\n')[0]}</span>
                      {r.pushed && <span className="shrink-0 text-[10px] text-[var(--color-warn)]" title={tr('这个提交已经推送到上游')}>{tr('已推送')}</span>}
                      <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{r.author} · {shortDate(r.date).slice(0, 8)}</span>
                    </div>
                    {r.action === 'reword' && (
                      <Textarea rows={Math.min(6, Math.max(2, (r.message ?? '').split('\n').length))} value={r.message ?? ''} onChange={(e) => set(i, { message: e.target.value })}
                        placeholder={tr('新的提交说明')} className="mt-1.5 font-mono text-[11.5px]" data-rebase-msg />
                    )}
                    {squash && groupEnd(i) && (
                      <Textarea rows={2} value={r.message ?? ''} onChange={(e) => set(i, { message: e.target.value })}
                        placeholder={r.action === 'squash' ? tr('压缩后的说明（可空：两条说明合在一起）') : tr('合并后的说明（可空：用上一个提交的说明）')} className="mt-1.5 font-mono text-[11.5px]" data-rebase-msg />
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex w-[300px] shrink-0 flex-col border-l border-[var(--color-border-subtle)]">
              <div className="px-3 py-2 text-[11.5px] font-medium text-[var(--color-text-secondary)]">{tr('整理后（{n} 个提交，从旧到新）', { n: result.length })}</div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-2" data-rebase-result>
                {result.map((x, i) => (
                  <div key={i} className="rounded bg-[var(--color-bg-raised)] px-2 py-1 text-[11.5px]">
                    <div className="truncate text-[var(--color-text-primary)]" title={x.msg}>{x.msg.split('\n')[0]}</div>
                    {x.n > 1 && <div className="text-[10.5px] text-[var(--color-text-muted)]">{tr('由 {n} 个提交合成', { n: x.n })}</div>}
                  </div>
                ))}
              </div>
              <div className="space-y-1.5 border-t border-[var(--color-border-subtle)] p-3">
                {problem ? <div className="text-[11.5px] text-[var(--color-danger)]">{problem}</div>
                  : pushed > 0 && <div className="text-[11.5px] text-[var(--color-warn)]">{tr('有 {n} 个提交已推送过，整理后需要强制推送', { n: pushed })}</div>}
                <button data-rebase-run disabled={!!problem || !changed || running || !!ctx.busy} onClick={run}
                  className="flex w-full items-center justify-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2 py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
                  {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('开始整理')}
                </button>
                {!changed && !problem && <div className="text-center text-[11px] text-[var(--color-text-muted)]">{tr('还没做任何调整')}</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  ), document.body)
}
