import { useCallback, useEffect, useState } from 'react'
import { Bot, KeyRound, X } from 'lucide-react'
import { REVIEW_VERDICT_LABEL, SUDO_LEASE_MINUTES, leaseRemainText, tr, type AiReviewResult, type HostSummary, type SudoLease } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Select } from '../../components/ui/Select.js'

// 安全与流程的小部件：授权卡 / 执行记录里的「AI 复核」徽标、授权卡上的限时提权选项、授权抽屉里的限时提权列表

const TONE: Record<AiReviewResult['verdict'], string> = {
  safe: 'text-[var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_12%,transparent)]',
  risky: 'text-[var(--color-warn)] bg-[color:color-mix(in_srgb,var(--color-warn)_14%,transparent)]',
  block: 'text-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)]',
  unreviewed: 'text-[var(--color-text-muted)] bg-[var(--color-bg-raised)]',
}

/** 「AI 复核：风险 · 理由」 */
export function ReviewBadge({ review, className }: { review: AiReviewResult; className?: string }) {
  return (
    <div data-ai-review={review.verdict} title={`${tr('复核模型：{model}', { model: review.model ?? tr('默认配置') })}\n${review.reason}`}
      className={cn('flex items-start gap-1 rounded px-1.5 py-1 text-[11px] leading-snug', TONE[review.verdict], className)}>
      <Bot className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0"><span className="font-medium">{tr('AI 复核：{verdict}', { verdict: tr(REVIEW_VERDICT_LABEL[review.verdict]) })}</span> · {review.reason}</span>
    </div>
  )
}

/** 授权卡上：「本主机 [15] 分钟内允许提权」（勾上后点允许才生效） */
export function SudoLeasePick({ on, minutes, onChange }: { on: boolean; minutes: number; onChange: (on: boolean, minutes: number) => void }) {
  return (
    <div data-sudo-pick className="mt-2 flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-secondary)]">
      <label className="flex cursor-pointer items-center gap-1.5">
        <Checkbox checked={on} onCheckedChange={(v) => onChange(v, minutes)} />
        <KeyRound className="h-3 w-3 text-[var(--color-warn)]" />{tr('sudo|本主机')}
      </label>
      <Select size="sm" className="w-[92px]" value={String(minutes)} onValueChange={(v) => onChange(true, Number(v))}
        options={SUDO_LEASE_MINUTES.map((m) => ({ value: String(m), label: tr('{n} 分钟', { n: m }) }))} />
      <span title={tr('期间这台主机上需要 sudo / root 的命令不再逐条弹卡（危险命令、命中「总是询问」规则的仍会问）；到期自动收回，也可在会话授权抽屉里立即收回。只在内存里，重启应用即失效')}>{tr('内允许提权')}</span>
    </div>
  )
}

const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** 授权抽屉：本会话的限时提权，剩余时间每秒刷新，可「立即收回」 */
export function SudoLeaseList({ sessionId, hosts }: { sessionId: string; hosts: HostSummary[] }) {
  const [list, setList] = useState<SudoLease[]>([])
  const [now, setNow] = useState(Date.now())
  const refresh = useCallback(() => { client.safety.sudoLeases(sessionId).then(setList).catch(() => setList([])) }, [sessionId])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => client.on((ev) => { if (ev.type === 'safety:changed' && ev.sessionId === sessionId && ev.what === 'sudo') refresh() }), [sessionId, refresh])
  useEffect(() => {
    if (!list.length) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [list.length])
  const live = list.filter((l) => l.until > now)
  if (!live.length) return null
  const label = (k: string) => (k === 'local' ? tr('本地') : hosts.find((h) => h.id === k)?.label ?? k)
  return (
    <div data-sudo-leases className="mt-4 space-y-1.5">
      <div className="text-[12px] font-medium text-[var(--color-text-secondary)]">{tr('限时提权')}</div>
      {live.map((l) => (
        <div key={l.hostKey} className="flex items-center gap-2 rounded-md border border-[color:color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_6%,transparent)] px-2.5 py-1.5">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">{label(l.hostKey)}</span>
          <span className="shrink-0 tabular-nums text-[11px] text-[var(--color-text-muted)]" title={tr('剩余 {time}，到期自动收回', { time: leaseRemainText(l.until, now) })}>{tr('剩 {time}', { time: mmss(l.until - now) })}</span>
          <button onClick={() => client.safety.revokeSudo(sessionId, l.hostKey).then(refresh).catch(() => {})}
            className="flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[10.5px] text-[var(--color-text-muted)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)]">
            <X className="h-3 w-3" />{tr('立即收回')}
          </button>
        </div>
      ))}
    </div>
  )
}
