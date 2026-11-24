// 记忆库梳理：AI 读全部卡片，出「合并 / 更新 / 删除」清单，用户勾选后一次写回。
// 只出清单不动数据（后端 memory:consolidate），应用才落盘（memory:consolidateApply）。
import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { tr, type ConsolidateAction, type ConsolidatePlan, type MemoryCard } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { BTN2 } from '../../components/ui/form.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// 动作类型的中文名（放在函数里调 tr：模块顶层调 tr 会在 import 时求值，那时还没读语言设置）
const kindLabel = (k: ConsolidateAction['kind']): string =>
  k === 'merge' ? tr('合并') : k === 'update' ? tr('改写') : tr('删除')

const KIND_STYLE: Record<ConsolidateAction['kind'], string> = {
  merge: 'bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]',
  update: 'bg-[color:color-mix(in_srgb,var(--color-warn,var(--color-accent))_14%,transparent)] text-[var(--color-text-primary)]',
  drop: 'bg-[color:color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-[var(--color-danger)]',
}

export function ConsolidateDialog({ open, cards, pending, onClose, onApplied }: {
  open: boolean
  cards: MemoryCard[]
  /** 后台已攒好的清单：有就直接用，不再让模型重跑一遍 */
  pending?: { at: string; plan: ConsolidatePlan } | null
  onClose: () => void
  onApplied: () => void
}) {
  const [plan, setPlan] = useState<ConsolidatePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())
  /** 已等待秒数：模型读全部卡片要几秒到几十秒，给个计数才知道没卡死 */
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [loading])

  // 「重试」计数：失败后点重试就 +1，让下面的 effect 重跑一次（不用把请求逻辑再抄一份）
  const [attempt, setAttempt] = useState(0)
  // 关掉弹窗就复位，下次打开重新从「有后台清单先展示」开始
  useEffect(() => { if (!open) setAttempt(0) }, [open])

  // 打开即就绪：有后台清单直接展示，否则让模型读一遍（要几秒到十几秒）；关掉后丢弃结果
  useEffect(() => {
    if (!open) return
    setErr('')
    if (pending && !attempt) {
      setPlan(pending.plan)
      setChecked(new Set(pending.plan.actions.map((_, i) => i)))   // 默认全选，用户自己取消不要的
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true); setPlan(null); setElapsed(0)
    client.memory.consolidate('manual')
      .then((p) => {
        if (!alive) return
        setPlan(p)
        setChecked(new Set(p.actions.map((_, i) => i)))
      })
      .catch((e) => { if (alive) setErr(errText(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, pending, attempt])

  if (!open) return null

  const titleOf = (id: string) => cards.find((c) => c.id === id)?.title ?? id
  const toggle = (i: number) => setChecked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  const picked = plan ? plan.actions.filter((_, i) => checked.has(i)) : []

  const apply = async () => {
    if (!picked.length) return
    setApplying(true); setErr('')
    try {
      await client.memory.consolidateApply(picked)
      onApplied()
      onClose()
    } catch (e) { setErr(errText(e)) } finally { setApplying(false) }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[min(720px,88vh)] w-[min(820px,92vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('记忆库梳理')}</span>
          <button onClick={onClose} title={tr('关闭（Esc）')} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-[12px] text-[var(--color-text-secondary)]">
            {tr('AI 读一遍全部记忆卡，把重复的合并、过时的更新、没用的删掉。清单只是建议——勾选你想采纳的，点「应用」才会改。')}
          </p>
          {loading && <div className="py-10 text-center text-[12px] text-[var(--color-text-muted)]">{tr('AI 正在读全部记忆卡，请稍等…（已等待 {n} 秒）', { n: elapsed })}</div>}
          {err && <div className="rounded border border-[color:color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_8%,transparent)] px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
          {!loading && plan && !plan.actions.length && (
            <div className="py-10 text-center text-[12px] text-[var(--color-text-muted)]">{tr('没发现需要整理的地方：{n} 张卡已经比较整齐了。', { n: plan.before })}</div>
          )}
          {!loading && plan && plan.actions.length > 0 && (
            <div className="space-y-2">
              {plan.actions.map((a, i) => (
                <div key={i} className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
                  checked.has(i) ? 'border-[var(--color-border-default)] bg-[var(--color-bg-base)]' : 'border-[var(--color-border-subtle)] bg-transparent opacity-60')}>
                  <Checkbox checked={checked.has(i)} onCheckedChange={() => toggle(i)} className="mt-0.5" aria-label={tr('选择这一项')} />
                  <div onClick={() => toggle(i)} className="min-w-0 flex-1 cursor-pointer space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10.5px]', KIND_STYLE[a.kind])}>{kindLabel(a.kind)}</span>
                      {a.title && <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-text-primary)]">{tr(a.title)}</span>}
                      <span className="truncate text-[11px] text-[var(--color-text-muted)]">
                        {a.ids.map(titleOf).join(' + ')}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[var(--color-text-secondary)]">{tr(a.reason)}</div>
                    {a.content && (
                      <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg-raised)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{a.content}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          {plan && (
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              {tr('卡片 {n} 张 → 应用全部后约 {m} 张', { n: plan.before, m: plan.after })}
              {picked.length !== plan.actions.length && tr('（已选 {k} 项）', { k: picked.length })}
            </span>
          )}
          {/* 模型没给出可用清单（格式不对 / 超时 / 网络）时给个重试，省得关掉再重开一次 */}
          <div className="ml-auto flex items-center gap-2">
            {err && !loading && !plan && (
              <button onClick={() => setAttempt((n) => n + 1)} className={BTN2}>{tr('重试')}</button>
            )}
            <button onClick={onClose} className={BTN2}>{tr('取消')}</button>
          </div>
          {plan && plan.actions.length > 0 && (
            <button onClick={apply} disabled={applying || !picked.length}
              className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
              {applying ? tr('应用中…') : picked.length ? tr('应用选中的 {k} 项', { k: picked.length }) : tr('应用')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
