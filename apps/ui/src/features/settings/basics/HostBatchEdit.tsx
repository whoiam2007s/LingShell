import { useEffect, useState } from 'react'
import { Loader2, Undo2, X } from 'lucide-react'
import { HOST_BATCH_LABEL, dateLocale, hostGroupNames, tr, type HostBatchField, type HostBatchItem, type HostBatchPatch, type HostBatchUndoInfo, type HostEnv, type HostSummary } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { HostGroups } from '../../../components/sshParts.js'
import { HelpTip } from '../ui.js'
import { Select } from '../../../components/ui/Select.js'
import { Combobox } from '../../../components/ui/Combobox.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { trx } from '../../../lib/trx.js'

// 设置 → 主机与连接 →「更多 → 批量修改」：勾选主机 + 勾选要改的项 → 预览（每台 旧值→新值）→ 确认执行（先自动备份 hosts.json）。
// 只改地址/端口/用户名/跳板机/分组/分级，不碰凭据；使用凭据的主机用户名不改
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[a-z_]+: /, '')
const BTN = 'flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
const PRIMARY = 'flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const INP = 'h-7 min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-40'
const ERR_BOX = 'rounded-md bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]'

type Field = HostBatchField
// 预览里分级的新值是主进程给的中文（「生产」）；按原文和译文都认，免得主进程那边改成 tr() 后这里认不出
const isProd = (v?: string) => v === '生产' || v === tr('生产')   // i18n-ignore 与 shared/ops/hostBatch.ts ENV_TEXT 的值比较
interface Draft { find: string; replace: string; port: string; username: string; jumpHostId: string; group: string; env: HostEnv | '' }

export function HostBatchDialog({ hosts, onClose, onDone }: { hosts: HostSummary[]; onClose: () => void; onDone: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [on, setOn] = useState<Set<Field>>(new Set())
  const [d, setD] = useState<Draft>({ find: '', replace: '', port: '22', username: '', jumpHostId: '', group: '', env: '' })
  const [plan, setPlan] = useState<HostBatchItem[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [prodAsk, setProdAsk] = useState(false)
  const reset = () => { setPlan(null); setError('') }
  const toggle = <T,>(set: (f: (s: Set<T>) => Set<T>) => void, v: T) => { set((s) => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n }); reset() }
  const setF = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); reset() }
  const jumps = hosts.filter((h) => hosts.some((x) => x.jumpHostId === h.id))

  const patch = (): HostBatchPatch => ({
    ...(on.has('host') ? { hostFind: d.find, hostReplace: d.replace } : {}),
    ...(on.has('port') ? { port: Number(d.port) } : {}),
    ...(on.has('username') ? { username: d.username } : {}),
    ...(on.has('jumpHostId') ? { jumpHostId: d.jumpHostId } : {}),
    ...(on.has('group') ? { group: d.group } : {}),
    ...(on.has('env') ? { env: d.env } : {}),
  })
  const preview = async () => {
    setBusy(true); setError('')
    try { setPlan(await client.hostBatch.preview([...picked], patch())) }
    catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }
  const changed = plan?.filter((i) => i.changes.length) ?? []
  const toProd = changed.filter((i) => i.changes.some((c) => c.field === 'env' && isProd(c.to)))
  const apply = async () => {
    setProdAsk(false); setBusy(true); setError('')
    try { await client.hostBatch.apply([...picked], patch()); onDone(); onClose() }
    catch (e) { setError(errText(e)) }
    finally { setBusy(false) }
  }

  const row = (f: Field, children: React.ReactNode) => (
    <div className="flex items-center gap-2 text-[12px]">
      <label className="flex w-24 shrink-0 cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]">
        <Checkbox checked={on.has(f)} onCheckedChange={() => toggle(setOn, f)} />{tr(HOST_BATCH_LABEL[f])}
      </label>
      <fieldset disabled={!on.has(f)} className="flex min-w-0 flex-1 items-center gap-1.5">{children}</fieldset>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex max-h-[88vh] w-[600px] flex-col gap-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[14px] font-semibold text-[var(--color-text-primary)]">{tr('批量修改主机')}
            <HelpTip>{tr('勾选要改的项和主机 → 预览（每台 旧值 → 新值）→ 确认修改。修改前自动备份主机配置，可「撤销上次批量修改」。只改地址 / 端口 / 用户名 / 跳板机 / 分组 / 分级，不碰凭据；使用凭据的主机用户名不改')}</HelpTip>
          </span>
          <button onClick={onClose}><X className="h-4 w-4 text-[var(--color-text-muted)]" /></button>
        </div>
        {plan ? (
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto text-[12px]">
            <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">{tr('将修改 {n} 台', { n: changed.length })}<HelpTip>{tr('修改前自动备份主机配置，改错了可在主机列表上方「撤销上次批量修改」')}</HelpTip></div>
            {plan.length === 0 && <div className="text-[var(--color-text-muted)]">{tr('所选主机都无需修改')}</div>}
            {plan.map((it) => (
              <div key={it.id} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1.5">
                <div className="font-medium text-[var(--color-text-primary)]">{it.label}</div>
                {it.changes.map((c) => (
                  <div key={c.field} className="text-[11px] text-[var(--color-text-secondary)]">
                    {trx('{field}：{from} → {to}', {
                      field: tr(HOST_BATCH_LABEL[c.field]),
                      from: <span className="text-[var(--color-text-muted)] line-through">{c.from ? (c.field === 'env' ? tr(c.from) : c.from) : tr('（空）')}</span>,
                      to: <span className={c.field === 'env' && isProd(c.to) ? 'font-medium text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]'}>{c.to ? (c.field === 'env' ? tr(c.to) : c.to) : tr('（空）')}</span>,
                    })}
                  </div>
                ))}
                {it.skipped.map((s, i) => <div key={i} className="text-[11px] text-[var(--color-warn)]">{tr('· 跳过：{reason}', { reason: tr(s) })}</div>)}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="space-y-1.5 rounded-md border border-[var(--color-border-subtle)] p-2.5">
              {row('host', <><input className={INP} value={d.find} onChange={(e) => setF({ find: e.target.value })} placeholder={tr('查找（纯文本，如 10.1.）')} /><span className="text-[var(--color-text-muted)]">→</span><input className={INP} value={d.replace} onChange={(e) => setF({ replace: e.target.value })} placeholder={tr('替换为（如 10.8.）')} /></>)}
              {row('port', <input className={`${INP} max-w-[100px]`} value={d.port} onChange={(e) => setF({ port: e.target.value })} />)}
              {row('username', <><input className={INP} value={d.username} onChange={(e) => setF({ username: e.target.value })} placeholder="root" /><span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('使用凭据的主机跳过')}</span></>)}
              {row('jumpHostId', (
                <Select size="sm" className="flex-1" disabled={!on.has('jumpHostId')} value={d.jumpHostId} onValueChange={(v) => setF({ jumpHostId: v })}>
                  <option value="">{tr('直连（不经跳板）')}</option>
                  {hosts.map((h) => <option key={h.id} value={h.id}>{tr('{id}（{title}）', { id: h.label, title: `${h.username}@${h.host}:${h.port}` })}</option>)}
                </Select>
              ))}
              {row('group', <Combobox size="sm" className="flex-1" disabled={!on.has('group')} value={d.group} onChange={(v) => setF({ group: v })} options={hostGroupNames(hosts)} placeholder={tr('留空 = 清除分组')} />)}
              {row('env', (
                <Select size="sm" className="flex-1" disabled={!on.has('env')} value={d.env} onValueChange={(v) => setF({ env: v as Draft['env'] })}>
                  <option value="">{tr('未标注')}</option><option value="test">{tr('测试')}</option><option value="prod">{tr('生产')}</option>
                </Select>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
              {tr('勾选主机（已选 {n} 台）', { n: picked.size })}
              {jumps.length > 0 && (
                <Select size="sm" value="" placeholder={tr('选中经某跳板机的全部主机…')} className="ml-2 w-auto text-[11px] text-[var(--color-text-secondary)]"
                  onValueChange={(j) => { if (j) { setPicked(new Set(hosts.filter((h) => h.jumpHostId === j).map((h) => h.id))); reset() } }}
                  options={jumps.map((h) => ({ value: h.id, label: tr('经 {host}（{n} 台）', { host: h.label, n: hosts.filter((x) => x.jumpHostId === h.id).length }) }))} />
              )}
              <button onClick={() => { setPicked(picked.size === hosts.length ? new Set() : new Set(hosts.map((h) => h.id))); reset() }} className="ml-auto text-[11px] hover:text-[var(--color-accent)]">{picked.size === hosts.length ? tr('全不选') : tr('全选')}</button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <HostGroups hosts={hosts} render={(h) => (
                <label key={h.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-[var(--color-bg-hover)]">
                  <Checkbox checked={picked.has(h.id)} onCheckedChange={() => toggle(setPicked, h.id)} />
                  <span className="shrink-0 text-[var(--color-text-primary)]">{h.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{h.username}@{h.host}:{h.port}{h.jumpHostId ? ` · ${tr('经 {host}', { host: hosts.find((x) => x.id === h.jumpHostId)?.label ?? '?' })}` : ''}{h.env === 'prod' ? ` · ${tr('生产')}` : ''}</span>
                </label>
              )} />
            </div>
          </>
        )}
        {error && <div className={ERR_BOX}>{error}</div>}
        <div className="flex justify-end gap-2">
          {plan ? <button onClick={reset} className={BTN}>{tr('返回修改')}</button> : <button onClick={onClose} className={BTN}>{tr('取消')}</button>}
          {plan
            ? <button onClick={() => (toProd.length ? setProdAsk(true) : void apply())} disabled={busy || !changed.length} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('确认修改（{n} 台）', { n: changed.length })}</button>
            : <button onClick={preview} disabled={busy || !picked.size || !on.size} className={PRIMARY}>{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{tr('预览修改')}</button>}
        </div>
      </div>
      <ConfirmDialog open={prodAsk} title={tr('标为生产主机')} confirmText={tr('确认修改')}
        message={tr('将把 {hosts} 标为生产：AI 在这些主机上的每条写操作都要你确认，危险命令强制确认。确定继续？', { hosts: toProd.map((i) => i.label).join(tr('、')) })}
        onConfirm={() => void apply()} onCancel={() => setProdAsk(false)} />
    </div>
  )
}

// 主机列表上方：上次批量修改可撤销（只还原那次改过的字段）
export function BatchUndoBar({ version, onDone }: { version: number; onDone: () => void }) {
  const [last, setLast] = useState<HostBatchUndoInfo | null>(null)
  const [ask, setAsk] = useState(false), [error, setError] = useState('')
  useEffect(() => { client.hostBatch.last().then(setLast).catch(() => setLast(null)) }, [version])
  if (!last) return null
  const undo = async () => {
    setAsk(false); setError('')
    try { await client.hostBatch.undo(); setLast(null); onDone() }
    catch (e) { setError(errText(e)) }
  }
  return (
    <div className="flex items-center gap-2 rounded-md bg-[var(--color-bg-base)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]">
      <span className="min-w-0 flex-1 truncate" title={tr('修改前的备份：{path}', { path: last.backup })}>{tr('上次批量修改：{time}，{n} 台', { time: new Date(last.at).toLocaleString(dateLocale()), n: last.count })}</span>
      {error && <span className="text-[var(--color-danger)]">{error}</span>}
      <button onClick={() => setAsk(true)} className="flex shrink-0 items-center gap-1 hover:text-[var(--color-accent)]"><Undo2 className="h-3 w-3" />{tr('撤销上次批量修改')}</button>
      <ConfirmDialog open={ask} title={tr('撤销上次批量修改')} confirmText={tr('batch|撤销')}
        message={tr('把那次改过的 {n} 台主机的地址/端口/用户名/跳板机/分组/分级改回原值（之后做的其它修改保留）。', { n: last.count })}
        onConfirm={() => void undo()} onCancel={() => setAsk(false)} />
    </div>
  )
}
