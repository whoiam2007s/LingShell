// 「批量合规检查」：选分组 / 多台已保存主机 → 并行跑 Linux 基线（只读，并发同跨主机提问）→「主机 × 条目」矩阵，点格子看详情与修复建议，可导出 CSV。
// 自挂载：App 里常驻 <ComplianceBatchModal />，openComplianceBatch(预选主机) 打开。不能点遮罩关闭（按钮 / Esc）
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, ShieldCheck, Loader2, Play, Download, Search } from 'lucide-react'
import {
  COMPLIANCE_SEVERITY_LABEL, complianceCsv, complianceScore, enabledItems, fmtDateTime, groupHosts, tr,
  type ComplianceHostRow, type ComplianceItem, type HostSummary,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Input } from '../../components/ui/Input.js'
import { uiLayerOpen } from '../../components/ui/layer.js'
import { HelpTip } from '../../components/ui/form.js'
import { COMPLIANCE_BATCH_EVENT } from './complianceBus.js'
import { STATUS_STYLE } from './ComplianceTab.js'
import { errText } from './ProfileDiffView.js'

export function ComplianceBatchModal() {
  const [open, setOpen] = useState<{ ids: string[]; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ ids: (e as CustomEvent<string[] | undefined>).detail ?? [], n: (o?.n ?? 0) + 1 }))
    window.addEventListener(COMPLIANCE_BATCH_EVENT, f)
    return () => window.removeEventListener(COMPLIANCE_BATCH_EVENT, f)
  }, [])
  useEffect(() => client.on((ev) => { if (ev.type === 'app:lock' && ev.locked) setOpen(null) }), [])
  if (!open) return null
  return <Body key={open.n} initial={open.ids} onClose={() => setOpen(null)} />
}

const MARK = { pass: '✓', fail: '✗', warn: '!', unknown: '?' } as const

function Body({ initial, onClose }: { initial: string[]; onClose: () => void }) {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [picked, setPicked] = useState<string[]>(initial)
  const [items, setItems] = useState<ComplianceItem[]>(() => enabledItems())
  const [rows, setRows] = useState<ComplianceHostRow[] | null>(null)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [cell, setCell] = useState<{ host: string; id: string } | null>(null)
  useEffect(() => {
    client.hosts.list().then(setHosts).catch(() => {})
    client.compliance.config().then((c) => setItems(enabledItems(c.disabled))).catch(() => {})
  }, [])
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || uiLayerOpen()) return
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current && !rootRef.current?.contains(o))) return
      if (cell) { setCell(null); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, cell])

  const ql = q.trim().toLowerCase()
  const groups = useMemo(() => groupHosts(hosts.filter((h) => !ql || [h.label, h.host, h.group].some((x) => x?.toLowerCase().includes(ql)))), [hosts, ql])
  const toggle = (ids: string[], on: boolean) => setPicked((p) => (on ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))))
  const run = () => {
    setRunning(true); setErr(''); setCell(null)
    client.compliance.batch(picked).then(setRows).catch((e) => setErr(errText(e))).finally(() => setRunning(false))
  }
  const exportCsv = () => {
    if (!rows) return
    // 本地时间：早上 8 点前 UTC 还是前一天，文件名会标错日期
    const stamp = fmtDateTime(Date.now()).slice(0, 16).replace(/[: ]/g, '-')
    client.system.saveTextFile(tr('合规检查-{stamp}.csv', { stamp }), complianceCsv(rows, items)).catch((e) => setErr(errText(e)))
  }
  const sel = cell && rows?.find((r) => r.hostId === cell.host)
  const selItem = cell && items.find((i) => i.id === cell.id)
  const selRes = sel?.results.find((x) => x.id === cell?.id)

  return (
    <div ref={rootRef} data-compliance-batch className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex h-[90vh] w-[min(1200px,96vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
          <ShieldCheck className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('批量合规检查')}</span>
          <HelpTip>{tr('对选中的已保存主机并行跑 Linux 基线（每台一次只读脚本，有在线终端的复用它的连接，否则临时连接、跑完即断；不用 sudo、不改任何东西）。 矩阵里 ✓ 通过、✗ 不通过、! 建议、? 无法判断（如需要 root 才能读），点格子看详情和修复建议。条目可在「设置 → 合规基线」里关掉。')}</HelpTip>
          <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">{tr('已选 {n} 台 · {m} 条', { n: picked.length, m: items.length })}</span>
          <button onClick={exportCsv} disabled={!rows?.length} className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"><Download className="h-3.5 w-3.5" />{tr('导出 CSV')}</button>
          <button data-compliance-batch-run onClick={run} disabled={!picked.length || running || !items.length}
            className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{running ? tr('检查中…') : tr('开始检查')}
          </button>
          <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 左：选主机（分组整组勾） */}
          <div className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
            <div className="relative p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <Input size="sm" className="pl-7" value={q} placeholder={tr('搜索主机 / 分组')} aria-label={tr('搜索主机')} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[12px]">
              {!hosts.length && <div className="px-1 py-2 text-[var(--color-text-muted)]">{tr('还没有已保存的主机')}</div>}
              {groups.map((g) => {
                const ids = g.hosts.map((h) => h.id)
                const sel = ids.filter((x) => picked.includes(x)).length
                return (
                  <div key={g.group} className="mb-1">
                    <label className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                      <Checkbox checked={sel === ids.length ? true : sel ? 'indeterminate' : false} disabled={running} onCheckedChange={(v) => toggle(ids, v)} aria-label={tr('整组 {g}', { g: g.group || tr('未分组') })} />{g.group || tr('未分组')}<span className="text-[10.5px] font-normal text-[var(--color-text-muted)]">{g.hosts.length}</span>
                    </label>
                    {g.hosts.map((h) => (
                      <label key={h.id} className="ml-4 flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
                        <Checkbox checked={picked.includes(h.id)} disabled={running} onCheckedChange={(v) => toggle([h.id], v)} aria-label={h.label} /><span className="truncate">{h.label}</span>
                        {h.env === 'prod' && <span className="shrink-0 text-[10px] text-[var(--color-danger)]">{tr('生产')}</span>}
                      </label>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
          {/* 右：矩阵 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {err && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11.5px] text-[var(--color-danger)]">{err}</div>}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {!rows ? <div className="py-10 text-center text-[12px] text-[var(--color-text-muted)]">{running ? tr('正在并行检查（每台最长约 40 秒）…') : !items.length ? tr('所有条目都已在「设置 → 合规基线」里关掉，没有可检查的内容。') : tr('左侧勾选主机（可整组勾），点「开始检查」')}</div> : (
                <table data-compliance-matrix className="border-collapse text-[11.5px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-[var(--color-bg-panel)] px-2 text-left align-bottom font-medium text-[var(--color-text-secondary)]">{tr('主机')}</th>
                      <th className="px-1.5 align-bottom font-medium text-[var(--color-text-secondary)]">{tr('通过率')}</th>
                      {items.map((i) => (
                        <th key={i.id} title={i.advisory ? tr('{title}（严重度 {sev}，建议级）', { title: tr(i.title), sev: tr(COMPLIANCE_SEVERITY_LABEL[i.severity]) }) : tr('{title}（严重度 {sev}）', { title: tr(i.title), sev: tr(COMPLIANCE_SEVERITY_LABEL[i.severity]) })} className="h-36 w-7 px-0.5 align-bottom font-normal text-[var(--color-text-secondary)]">
                          <div className="mx-auto max-h-36 overflow-hidden text-left [writing-mode:vertical-rl]">{tr(i.title)}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const by = new Map(r.results.map((x) => [x.id, x]))
                      const score = complianceScore(r.results)
                      return (
                        <tr key={r.hostId} data-matrix-row={r.label} className="border-t border-[var(--color-border-subtle)]">
                          <td className="sticky left-0 z-10 max-w-[160px] truncate bg-[var(--color-bg-panel)] px-2 py-1 text-[var(--color-text-primary)]" title={r.label}>{r.label}</td>
                          <td className="px-1.5 text-center tabular-nums" style={{ color: score === undefined ? 'var(--color-text-muted)' : score >= 80 ? 'var(--color-success)' : score >= 60 ? 'var(--color-warn)' : 'var(--color-danger)' }}>{r.error ? '—' : score === undefined ? '—' : `${score}%`}</td>
                          {r.error ? <td colSpan={items.length} className="px-2 text-[var(--color-danger)]" title={r.error}>{tr('连接失败：{err}', { err: r.error })}</td> : items.map((i) => {
                            const x = by.get(i.id)
                            const s = x ? STATUS_STYLE[x.status] : undefined
                            const on = cell?.host === r.hostId && cell.id === i.id
                            return (
                              <td key={i.id} className="p-0.5 text-center">
                                <button data-cell={`${r.label}:${i.id}`} data-status={x?.status} onClick={() => setCell(on ? null : { host: r.hostId, id: i.id })} title={x ? `${tr('{title}：{status}', { title: tr(i.title), status: tr(s!.text) })}\n${x.detail}` : ''}
                                  className={cn('h-6 w-6 rounded font-semibold', on && 'ring-1 ring-[var(--color-accent)]')}
                                  style={{ color: s?.color, background: x && x.status !== 'pass' ? `color-mix(in srgb, ${s!.color} 14%, transparent)` : undefined }}>
                                  {x ? MARK[x.status] : ''}
                                </button>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {sel && selItem && selRes && (
              <div className="shrink-0 space-y-1 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px]" data-compliance-detail>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[var(--color-text-primary)]">{sel.label} · {tr(selItem.title)}</span>
                  <span style={{ color: STATUS_STYLE[selRes.status].color }}>{tr(STATUS_STYLE[selRes.status].text)}</span>
                  <button onClick={() => setCell(null)} className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3.5 w-3.5" /></button>
                </div>
                <div className="break-all text-[var(--color-text-secondary)]">{selRes.detail}</div>
                <div className="break-all font-mono text-[11px] text-[var(--color-text-secondary)]"><span className="mr-1.5 font-sans text-[var(--color-text-muted)]">{tr('修复建议')}</span>{tr(selItem.fix)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
