import { useEffect, useState } from 'react'
import { ListChecks, ShieldAlert, ShieldCheck, ShieldX, Clock, Check, X, Trash2 } from 'lucide-react'
import { tr, type HostSummary, type PlanStepView } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { client } from '../../../client/index.js'

// 计划审批卡（propose_plan）：列出全部步骤，用户可删步骤、改命令，再批准或拒绝（可附原因）。
// 批准后计划内命令免逐条授权（本轮有效），危险步骤标红——用户在这里看过就不再二次确认。
export function PlanRequestItem({ item }: { item: ConvItem }) {
  const p = item.plan
  if (!p) return null
  return <PlanCard plan={p} />
}

function PlanCard({ plan: p }: { plan: NonNullable<ConvItem['plan']> }) {
  const resolved = p.result
  const [remain, setRemain] = useState(Math.ceil(p.deadlineMs / 1000))
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [steps, setSteps] = useState<PlanStepView[]>(p.steps)
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState('')
  const [sentNote, setSentNote] = useState<string>()

  useEffect(() => { client.hosts.list().then(setHosts).catch(() => {}) }, [])
  useEffect(() => {
    if (resolved) return
    const t = setInterval(() => setRemain((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [resolved])

  const hostLabel = (k: string) => (k === 'local' ? tr('本地') : hosts.find((h) => h.id === k)?.label ?? k)
  const setCommand = (i: number, command: string) => setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, command } : s)))
  const remove = (i: number) => setSteps((ss) => ss.filter((_, j) => j !== i))
  const valid = steps.filter((s) => s.command.trim())
  const anyDanger = steps.some((s) => s.dangerous)

  const approve = () => {
    if (!valid.length) return
    void client.auth.decide(p.approvalId, {
      decision: 'allow',
      steps: valid.map((s) => ({ terminal_id: s.terminal_id, command: s.command.trim(), purpose: s.purpose, path: s.path })),
    })
  }
  const deny = () => {
    const n = note.trim() || undefined
    setSentNote(n)
    void client.auth.decide(p.approvalId, { decision: 'deny', note: n })
  }

  return (
    <div className="animate-fade-in px-3 py-1">
      <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)]">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-primary)]" title={p.title}>{tr('执行计划：{title}', { title: p.title })}</span>
          <span className="shrink-0 rounded bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 步', { n: steps.length })}</span>
        </div>

        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
          <ol className="space-y-1.5">
            {steps.map((s, i) => (
              <li key={i} className={cn('rounded border px-2 py-1.5', s.dangerous ? 'border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_5%,transparent)]' : 'border-[var(--color-border-subtle)]')}>
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                  <span className="tabular-nums">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={s.purpose}>{s.purpose || tr('（未说明目的）')}</span>
                  {s.dangerous && <span className="flex shrink-0 items-center gap-0.5 text-[var(--color-danger)]"><ShieldAlert className="h-3 w-3" />{tr('危险')}</span>}
                  <code className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1 text-[10px]">{hostLabel(s.hostKey)}</code>
                  {!resolved && (
                    <button onClick={() => remove(i)} title={tr('删除这一步')} className="shrink-0 hover:text-[var(--color-danger)]">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {s.path ? (
                  // 写文件步骤按路径匹配，命令文本只是说明，不给改（改了也不影响执行，反而误导）
                  <div className="mt-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
                    <span className="text-[var(--color-accent)]">{tr('写文件')}</span> {s.path}
                    {s.command && s.command !== `写入 ${s.path}` /* i18n-ignore 主进程生成的写文件步骤说明，比较用 */ && <div className="mt-0.5 text-[var(--color-text-muted)]">{s.command}</div>}
                  </div>
                ) : resolved ? (
                  <pre className={cn('mt-1 whitespace-pre-wrap font-mono text-[11px]', s.dangerous ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]')}>$ {s.command}</pre>
                ) : (
                  <textarea
                    value={s.command}
                    onChange={(e) => setCommand(i, e.target.value)}
                    rows={Math.min(4, s.command.split('\n').length)}
                    className={cn(
                      'mt-1 w-full resize-y rounded border bg-[var(--color-bg-raised)] px-1.5 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]',
                      s.dangerous ? 'border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] text-[var(--color-danger)]' : 'border-transparent text-[var(--color-text-primary)]',
                    )}
                  />
                )}
              </li>
            ))}
          </ol>

          {!resolved ? (
            <>
              <div className="mt-2 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                <Clock className="h-3 w-3" />
                <span>{tr('批准后本轮内这些命令（逐字一致）免逐条授权')}{anyDanger ? tr('，含危险命令请确认') : ''}{tr('；')}{tr('{time} 后自动拒绝', { time: `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` })}</span>
              </div>
              {denying && (
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); deny() } if (e.key === 'Escape') setDenying(false) }}
                  autoFocus
                  placeholder={tr('告诉 AI 为什么拒绝、该怎么改（可选，回车确认）')}
                  className="mt-2 w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={approve}
                  disabled={!valid.length}
                  className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />{tr('批准计划')}
                </button>
                <button
                  onClick={() => (denying ? deny() : setDenying(true))}
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
                >
                  <X className="h-3.5 w-3.5" />{denying ? tr('确认拒绝') : tr('拒绝')}
                </button>
              </div>
            </>
          ) : (
            <div className="mt-2 text-[12px]">
              {resolved === 'allow' && <span className="flex items-center gap-1 text-[var(--color-success)]"><ShieldCheck className="h-3.5 w-3.5" />{tr('已批准计划')}</span>}
              {resolved === 'timeout' && <span className="flex items-center gap-1 text-[var(--color-text-muted)]"><Clock className="h-3.5 w-3.5" />{tr('已超时（自动拒绝）')}</span>}
              {resolved === 'deny' && <span className="flex items-center gap-1 text-[var(--color-danger)]"><ShieldX className="h-3.5 w-3.5" />{tr('已拒绝')}</span>}
              {resolved === 'cancelled' && <span className="flex items-center gap-1 text-[var(--color-text-muted)]"><Clock className="h-3.5 w-3.5" />{tr('本轮已结束，未处理')}</span>}
              {resolved === 'deny' && sentNote && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('原因：{reason}', { reason: sentNote })}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
