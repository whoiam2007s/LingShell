import { useEffect, useState } from 'react'
import { MessageCircleQuestion, Clock, Check, SkipForward } from 'lucide-react'
import type { ConvItem } from '../useConversation.js'
import { client } from '../../../client/index.js'
import { Radio } from '../../../components/ui/Radio.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { Input } from '../../../components/ui/Input.js'
import { cn } from '../../../lib/cn.js'
import { tr } from '@lingshell/shared'

// AI 提问卡（ask_user）：单选 / 多选 +「其他」输入框，「提交」把选择作为工具结果回给 AI；「跳过」= 用户未回答。
// 超时、停止本轮也按未回答收卡（主进程发 ask:resolved）。答完 / 跳过 / 超时后收成一行（问题 + 结果），不再整张占位
const OTHER = '\u0000other'

export function AskRequestItem({ item }: { item: ConvItem }) {
  const a = item.ask
  if (!a) return null
  return <AskCard ask={a} />
}

function AskCard({ ask: a }: { ask: NonNullable<ConvItem['ask']> }) {
  const [sel, setSel] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [sent, setSent] = useState(false)
  const [remain, setRemain] = useState(Math.ceil(a.deadlineMs / 1000))
  const resolved = a.result
  useEffect(() => {
    if (resolved) return
    const t = setInterval(() => setRemain((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [resolved])

  if (resolved) {
    const picked = [...(a.answer?.selected ?? []), ...(a.answer?.other ? [tr('其他：{text}', { text: a.answer.other })] : [])].join(tr('、'))
    return (
      <div data-ask-card={a.askId} data-ask-resolved={resolved} className="px-3 py-0.5">
        <div title={a.question} className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11.5px] text-[var(--color-text-muted)]">
          <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{a.question}</span>
          {resolved === 'answered'
            ? <span className="flex shrink-0 items-center gap-1 text-[var(--color-success)]"><Check className="h-3.5 w-3.5" />{tr('已选：{picked}', { picked })}</span>
            : <span className="shrink-0">{resolved === 'timeout' ? tr('已超时，未回答') : tr('已跳过')}</span>}
        </div>
      </div>
    )
  }
  const pick = (label: string) => setSel((cur) => a.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label])
  const otherOn = sel.includes(OTHER)
  const chosen = sel.filter((x) => x !== OTHER)
  const canSubmit = chosen.length > 0 || (otherOn && !!other.trim())
  const submit = () => {
    if (!canSubmit || sent) return
    setSent(true)
    void client.chatPlus.answerAsk(a.askId, { selected: chosen, ...(otherOn && other.trim() ? { other: other.trim() } : {}) }).catch(() => setSent(false))
  }
  const skip = () => { setSent(true); void client.chatPlus.answerAsk(a.askId, null).catch(() => setSent(false)) }
  const mark = (on: boolean, label: string) => a.multiSelect
    ? <Checkbox checked={on} onCheckedChange={() => pick(label)} disabled={!!resolved || sent} />
    : <Radio checked={on} onSelect={() => pick(label)} disabled={!!resolved || sent} />

  return (
    <div data-ask-card={a.askId} className="animate-fade-in px-3 py-1">
      <div className="overflow-hidden rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-bg-raised)]">
        <div className="flex items-start gap-2 px-2.5 py-2">
          <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-[var(--color-text-primary)]">{a.question}</span>
          <span className="shrink-0 rounded bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{a.multiSelect ? tr('可多选') : tr('单选')}</span>
        </div>
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
          <div className="space-y-1">
            {a.options.map((o) => {
              const on = resolved ? !!a.answer?.selected.includes(o.label) : sel.includes(o.label)
              return (
                <label key={o.label} data-ask-option={o.label}
                  className={cn('flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 transition-colors',
                    on ? 'border-[color:color-mix(in_srgb,var(--color-accent)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-hover)]',
                    (resolved || sent) && 'cursor-default')}>
                  <span className="mt-0.5">{mark(on, o.label)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-[var(--color-text-primary)]">{o.label}</span>
                    {o.description && <span className="block text-[11px] leading-snug text-[var(--color-text-muted)]">{o.description}</span>}
                  </span>
                </label>
              )
            })}
            {a.allowOther && !resolved && (
              <div className={cn('flex items-center gap-2 rounded border px-2 py-1.5', otherOn ? 'border-[color:color-mix(in_srgb,var(--color-accent)_55%,transparent)]' : 'border-[var(--color-border-subtle)]')}>
                {mark(otherOn, OTHER)}
                <Input size="sm" value={other} disabled={sent} placeholder={tr('其他：自己写（回车提交）')} data-ask-other
                  onChange={(e) => { setOther(e.target.value); if (e.target.value.trim() && !otherOn) pick(OTHER) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
              </div>
            )}
          </div>
          {!resolved ? (
            <div className="mt-2 flex items-center gap-2">
              <button onClick={submit} disabled={!canSubmit || sent} data-ask-submit
                className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-50">
                <Check className="h-3.5 w-3.5" />{tr('ask|提交')}
              </button>
              <button onClick={skip} disabled={sent} title={tr('不回答：AI 不会替你做决定、也不会执行命令，只说明还需要你决定什么')}
                className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
                <SkipForward className="h-3.5 w-3.5" />{tr('跳过')}
              </button>
              <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><Clock className="h-3 w-3" />{tr('{time} 后按未回答处理', { time: `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` })}</span>
            </div>
          ) : (
            <div className="mt-2 text-[11.5px]">
              {resolved === 'answered' && <span className="flex items-center gap-1 text-[var(--color-success)]"><Check className="h-3.5 w-3.5" />{tr('已回答')}{a.answer?.other ? tr('（其他：{text}）', { text: a.answer.other }) : ''}</span>}
              {resolved === 'skipped' && <span className="text-[var(--color-text-muted)]">{tr('未回答（已跳过或本轮已停止）')}</span>}
              {resolved === 'timeout' && <span className="flex items-center gap-1 text-[var(--color-text-muted)]"><Clock className="h-3.5 w-3.5" />{tr('已超时，按未回答处理')}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
