import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { hostGroupNames, quickScopeLabel, tr, type HostSummary } from '@lingshell/shared'
import { Checkbox } from '../../../components/ui/Checkbox.js'

// 快速命令 / 命令组的「只在这些主机 / 分组显示」（多选，都不勾 = 全部主机）。本地终端算「本机」
export function QuickScopePicker({ value, onChange, hosts }: { value?: string[]; onChange: (v: string[] | undefined) => void; hosts: HostSummary[] }) {
  const [open, setOpen] = useState(() => !!value?.length)
  const cur = value ?? []
  const toggle = (k: string, on: boolean) => { const next = on ? [...cur, k] : cur.filter((x) => x !== k); onChange(next.length ? next : undefined) }
  const row = (k: string, label: string, sub?: string) => (
    <label key={k} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--color-bg-hover)]">
      <Checkbox checked={cur.includes(k)} onCheckedChange={(v) => toggle(k, v)} aria-label={label} />
      <span className="truncate text-[var(--color-text-primary)]">{label}</span>
      {sub && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{sub}</span>}
    </label>
  )
  const groups = hostGroupNames(hosts)
  return (
    <div data-quick-scope>
      <button type="button" onClick={() => setOpen(!open)} className="flex max-w-full items-center gap-0.5 hover:text-[var(--color-text-primary)]" title={tr('只在这些主机 / 分组的终端上显示；都不勾 = 全部主机')}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="shrink-0">{tr('显示范围：')}</span><span className="truncate text-[var(--color-text-primary)]">{quickScopeLabel(value, hosts)}</span>
      </button>
      {open && (
        <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-1">
          {row('local', tr('qc|本机'), tr('本地终端'))}
          {groups.length > 0 && <div className="px-1 pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('分组')}</div>}
          {groups.map((g) => row(`group:${g}`, g))}
          {hosts.length > 0 && <div className="px-1 pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('主机')}</div>}
          {hosts.map((h) => row(`host:${h.id}`, h.label, h.group))}
        </div>
      )}
    </div>
  )
}
