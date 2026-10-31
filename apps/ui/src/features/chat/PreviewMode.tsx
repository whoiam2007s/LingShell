import { useEffect, useState } from 'react'
import { FlaskConical, ListChecks, Play, ShieldAlert, X } from 'lucide-react'
import { previewPlanOf, codeBlockSteps, previewRunMessage, tr, type HostSummary, type PreviewPlan } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'
import { client } from '../../client/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { cn } from '../../lib/cn.js'
import type { Turn } from './groupTurns.js'

// 预演模式（只说不做）：会话级开关（输入框「+」菜单），开着时 AI 的写操作被拦、只出方案；
// 回复末尾的「方案步骤」卡片可勾选，「执行选中步骤」→ 关闭预演 + 勾选的步骤记为已批准计划 + 发消息让 AI 执行

/** 当前会话的预演开关（主进程内存里的状态，切会话 / 事件时重取） */
export function usePreview(sessionId: string) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(false)   // 切会话先收起：晚到的上一个会话结果不能显示成「预演中」（这是写安全开关，不能显示错）
    if (!sessionId) return
    let alive = true
    const load = () => client.safety.preview(sessionId).then((v) => { if (alive) setOn(v) }, () => { if (alive) setOn(false) })
    load()
    const off = client.on((ev) => { if (ev.type === 'safety:changed' && ev.sessionId === sessionId && ev.what === 'preview') void load() })
    return () => { alive = false; off() }
  }, [sessionId])
  const set = (v: boolean) => { setOn(v); client.safety.setPreview(sessionId, v).catch(() => setOn(!v)) }
  return { on, set }
}

/** 输入框上方的提示条 */
export function PreviewBanner({ onOff }: { onOff: () => void }) {
  return (
    <div data-preview-banner className="mb-1.5 flex items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-2 py-1 text-[11.5px] text-[var(--color-text-secondary)]">
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="min-w-0 flex-1 truncate">{trx('{mode}：AI 只排查和出方案，不执行任何写操作', { mode: <span className="font-medium text-[var(--color-accent)]">{tr('预演模式')}</span> })}</span>
      <button onClick={onOff} title={tr('关闭预演模式')} className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
    </div>
  )
}

/**
 * 本轮的预演方案：AI 调了 propose_plan（预演结果）→ 用它；预演开着却没调 → 兜底取回复里 bash 代码块的命令（没有终端，执行时照常授权）
 */
export function previewPlanOfTurn(turn: Turn, previewOn: boolean): PreviewPlan | undefined {
  for (const it of [...turn.steps].reverse()) {
    if (it.kind === 'tool_call' && it.tool?.name === 'propose_plan') { const p = previewPlanOf(it.tool.output); if (p) return p }
  }
  if (!previewOn) return undefined
  const cmds = codeBlockSteps(turn.final.filter((x) => x.kind === 'agent_message').map((x) => x.text).join('\n'))
  return cmds.length ? { title: tr('回复里的命令'), steps: cmds.map((command) => ({ terminal_id: '', command })) } : undefined
}

/** 回复末尾的「方案步骤」：勾选 → 执行选中步骤 */
export function PreviewPlanCard({ sessionId, plan, busy, onSend }: { sessionId: string; plan: PreviewPlan; busy: boolean; onSend: (text: string) => boolean }) {
  const [picked, setPicked] = useState<boolean[]>(() => plan.steps.map(() => true))
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [done, setDone] = useState<number>()
  const [err, setErr] = useState('')
  useEffect(() => { client.hosts.list().then(setHosts).catch(() => {}) }, [])
  const host = (k?: string) => (!k ? '' : k === 'local' ? tr('本地') : hosts.find((h) => h.id === k)?.label ?? k)
  const chosen = plan.steps.filter((_, i) => picked[i])
  const run = async () => {
    if (!chosen.length || busy) return
    setErr('')
    try {
      // 先关预演、把带终端的步骤记为已批准计划，再发消息（下一轮里逐字一致的命令免逐条授权）
      await client.safety.approvePlan(sessionId, chosen.filter((s) => s.terminal_id).map(({ terminal_id, command, purpose, path }) => ({ terminal_id, command, purpose, path })))
      const steps = chosen.map((s) => ({ ...s, terminal_id: s.terminal_id || undefined }))
      if (onSend(previewRunMessage(plan.title, steps))) setDone(chosen.length)
    } catch (e) { setErr(String((e as Error)?.message ?? e)) }
  }
  return (
    <div data-preview-plan className="px-3 py-1">
      <div className="overflow-hidden rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[var(--color-bg-raised)]">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text-primary)]" title={plan.title}>{tr('方案步骤：{title}', { title: plan.title })}</span>
          <span className="shrink-0 rounded bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">{tr('预演 · 未执行')}</span>
        </div>
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
          <ol className="space-y-1">
            {plan.steps.map((s, i) => (
              <li key={i} className={cn('flex items-start gap-2 rounded border px-2 py-1.5', s.dangerous ? 'border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)]' : 'border-[var(--color-border-subtle)]')}>
                <Checkbox className="mt-0.5" checked={picked[i]} disabled={done !== undefined} onCheckedChange={(v) => setPicked((p) => p.map((x, j) => (j === i ? v : x)))} aria-label={tr('第 {n} 步', { n: i + 1 })} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                    <span className="tabular-nums">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={s.purpose}>{s.purpose || (s.path ? tr('写文件') : tr('命令'))}</span>
                    {s.dangerous && <span className="flex shrink-0 items-center gap-0.5 text-[var(--color-danger)]"><ShieldAlert className="h-3 w-3" />{tr('危险')}</span>}
                    {host(s.hostKey) && <code className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1 text-[10px]">{host(s.hostKey)}</code>}
                  </div>
                  <pre className={cn('mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]', s.dangerous ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>{s.path ? tr('写入 {path}', { path: s.path }) : `$ ${s.command}`}</pre>
                </div>
              </li>
            ))}
          </ol>
          {err && <div className="mt-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
          {done !== undefined ? (
            <div className="mt-2 text-[12px] text-[var(--color-success)]">{tr('已关闭预演，交给 AI 执行选中的 {n} 步', { n: done })}</div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button data-preview-run onClick={() => void run()} disabled={!chosen.length || busy}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
                <Play className="h-3.5 w-3.5" />{tr('执行选中步骤（{n}）', { n: chosen.length })}
              </button>
              <span className="min-w-0 text-[11px] leading-snug text-[var(--color-text-muted)]">
                {plan.steps.some((s) => s.terminal_id) ? tr('关闭预演，选中步骤作为已批准计划执行（免逐条授权）') : tr('关闭预演，这些命令没有指定终端，执行时照常授权')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
