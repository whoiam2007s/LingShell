import { useEffect, useMemo, useState } from 'react'
import { Loader2, Play, ShieldCheck, ChevronRight, Copy, Check, Layers } from 'lucide-react'
import {
  COMPLIANCE_SEVERITY_LABEL, LINUX_BASELINE, complianceScore, complianceSummary, tk, tr,
  type ComplianceHostRow, type ComplianceResult, type ComplianceStatus, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { HelpTip } from '../../components/ui/form.js'
import { openComplianceBatch } from './complianceBus.js'
import { errText, fmtTime, BTN } from './ProfileDiffView.js'

// 主机体检抽屉的「合规」页：当前终端所在主机跑一次 Linux 基线（只读），按 不通过 → 建议 → 无法判断 → 通过 列出，
// 每条可展开看修复建议（只给命令，不自动修）。结果按主机记在模块里，切页 / 切回来还在
const last = new Map<string, ComplianceHostRow>()
const ORDER: Record<ComplianceStatus, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 }
export const STATUS_STYLE: Record<ComplianceStatus, { text: string; color: string }> = {
  pass: { text: tk('通过'), color: 'var(--color-success)' },
  fail: { text: tk('不通过'), color: 'var(--color-danger)' },
  warn: { text: tk('建议'), color: 'var(--color-warn)' },
  unknown: { text: tk('无法判断'), color: 'var(--color-text-muted)' },
}
export const itemOf = (id: string) => LINUX_BASELINE.find((i) => i.id === id)

export function ComplianceTab({ term, hostKey }: { term: TerminalInfo; hostKey?: string }) {
  const [row, setRow] = useState<ComplianceHostRow | undefined>(() => (hostKey ? last.get(hostKey) : undefined))
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // 设置里关掉的条目：只统计 / 展示启用的（缓存里的旧结果里可能还有已关掉的条目）
  const [disabled, setDisabled] = useState<string[]>([])
  useEffect(() => { client.compliance.config().then((c) => setDisabled(c.disabled)).catch(() => {}) }, [])
  const enabled = useMemo(() => new Set(LINUX_BASELINE.filter((i) => !disabled.includes(i.id)).map((i) => i.id)), [disabled])
  useEffect(() => { if (hostKey) setRow(last.get(hostKey)) }, [hostKey])
  const run = () => {
    setRunning(true); setErr('')
    client.compliance.run(term.id).then((r) => { last.set(r.hostId, r); setRow(r) }).catch((e) => setErr(errText(e))).finally(() => setRunning(false))
  }
  const rs = (row?.results ?? []).filter((r) => enabled.has(r.id)).sort((a, b) => ORDER[a.status] - ORDER[b.status])
  const sum = complianceSummary(rs)
  const score = complianceScore(rs)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-compliance-tab>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="text-[11.5px] text-[var(--color-text-secondary)]">{tr('Linux 基线（{n} 条）', { n: enabled.size })}</span>
        <HelpTip>{tr('只读检查：SSH 配置、空密码、防火墙、自动安全更新、时间同步、UID 0、密码策略、auditd、SELinux / AppArmor、日志轮转、/etc 全局可写、sudo 免密、内核参数等。走单独通道，不用 sudo、不改任何东西；需要 root 才能读的项（如 /etc/shadow）判「无法判断」。修复建议只给命令，不会自动执行。不适用的条目可在「设置 → 合规基线」里关掉。')}</HelpTip>
        <span className="ml-auto" />
        <button onClick={() => openComplianceBatch(hostKey && !hostKey.includes(':') ? [hostKey] : [])} title={tr('对分组 / 多台已保存主机并行跑，出「主机 × 条目」矩阵，可导出 CSV')} className={BTN}><Layers className="h-3 w-3" />{tr('批量合规检查')}</button>
        <button data-compliance-run disabled={running || !enabled.size} onClick={run}
          className="flex shrink-0 items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{running ? tr('检查中…') : tr('开始检查')}
        </button>
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!row ? <div className="py-2 text-[12px] text-[var(--color-text-muted)]">{running ? tr('正在检查（最长约 40 秒）…') : !enabled.size ? tr('所有条目都已在「设置 → 合规基线」里关掉，没有可检查的内容。') : tr('点右上角「开始检查」，对这台主机跑一次基线检查。')}</div> : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]" data-compliance-summary>
              {score !== undefined && <span className="text-[var(--color-text-primary)]">{tr('通过率')} <b style={{ color: score >= 80 ? 'var(--color-success)' : score >= 60 ? 'var(--color-warn)' : 'var(--color-danger)' }}>{score}%</b></span>}
              {(['fail', 'warn', 'unknown', 'pass'] as const).map((s) => <span key={s} style={{ color: STATUS_STYLE[s].color }}>{tr(STATUS_STYLE[s].text)} {sum[s]}</span>)}
              <span className="ml-auto text-[10.5px] text-[var(--color-text-muted)]">{fmtTime(row.at)}</span>
            </div>
            <div className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
              {rs.map((r) => <ResultRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ResultRow({ r, open, onToggle }: { r: ComplianceResult; open: boolean; onToggle: () => void }) {
  const it = itemOf(r.id)
  const [copied, setCopied] = useState(false)
  if (!it) return null
  const st = STATUS_STYLE[r.status]
  return (
    <div data-compliance-item={r.id} data-status={r.status} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
      <button onClick={onToggle} className="flex w-full items-start gap-1.5 px-2 py-1 text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]">
        <ChevronRight className={cn('mt-[2px] h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', open && 'rotate-90')} />
        <span className="w-16 shrink-0 font-medium" style={{ color: st.color }}>{tr(st.text)}</span>
        <span className="min-w-0 flex-1">
          <span className="text-[var(--color-text-primary)]">{tr(it.title)}</span>
          <span className="ml-1.5 text-[10.5px] text-[var(--color-text-muted)]">{tr(COMPLIANCE_SEVERITY_LABEL[it.severity])}{it.advisory ? tr(' · 建议级') : ''}</span>
          <span className="block truncate text-[10.5px] text-[var(--color-text-muted)]" title={r.detail}>{r.detail}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-1 bg-[var(--color-bg-base)] px-2 py-1.5 pl-[22px] text-[11px] text-[var(--color-text-secondary)]">
          <div className="break-all">{r.detail}</div>
          <div className="flex items-start gap-1.5">
            <span className="shrink-0 text-[var(--color-text-muted)]">{tr('修复建议')}</span>
            <span className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-[var(--color-text-primary)]">{tr(it.fix)}</span>
            <button title={tr('复制修复建议（仅供参考，确认后自己执行）')} onClick={() => navigator.clipboard?.writeText(tr(it.fix)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }, () => {})}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">{copied ? <Check className="h-3 w-3 text-[var(--color-success)]" /> : <Copy className="h-3 w-3" />}</button>
          </div>
        </div>
      )}
    </div>
  )
}
