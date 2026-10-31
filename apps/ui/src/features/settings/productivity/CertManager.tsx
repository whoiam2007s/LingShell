import { useCallback, useEffect, useState } from 'react'
import { FileKey2, Loader2, Play, Plus, Search, Trash2 } from 'lucide-react'
import {
  CERT_LEVEL_LABEL, CHAIN_LABEL, certLevel, certTargetLabel, dateLocale, tr,
  type CertLevel, type CertResult, type CertState, type CertTarget, type HostSummary,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { Select } from '../../../components/ui/Select.js'
import { Input } from '../../../components/ui/Input.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { Section, Row, BTN2, BTN1, ICON_BTN, ICON_DEL, errText } from '../ui.js'
import { trx } from '../../../lib/trx.js'

// 设置 → 定时巡检里的「证书与域名巡检」：按 域名[:端口] 查 HTTPS 证书到期、证书链、域名匹配；每天自动查一次，
// 30 / 14 / 3 天内分别标黄 / 橙 / 红，到期前系统通知 + 群机器人。内网域名可选「从某台主机检查」（经该主机执行 openssl）
export const LEVEL_COLOR: Record<CertLevel, string> = {
  ok: 'var(--color-success)', yellow: 'var(--color-warn)',
  orange: 'color-mix(in srgb, var(--color-warn) 55%, var(--color-danger))', red: 'var(--color-danger)', expired: 'var(--color-danger)', error: 'var(--color-danger)',
}
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const Tag = ({ color, children, title }: { color: string; children: React.ReactNode; title?: string }) => (
  <span title={title} className="shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{children}</span>
)

function daysText(r: CertResult | undefined, lv: CertLevel): string {
  if (!r) return tr('未检查')
  if (lv === 'error') return tr('检查失败')
  if (lv === 'expired') return tr('已过期 {n} 天', { n: -(r.daysLeft ?? 0) })
  return tr('剩 {n} 天', { n: r.daysLeft ?? 0 })
}

export function CertManager() {
  const [st, setSt] = useState<CertState | null>(null)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [spec, setSpec] = useState('')
  const [via, setVia] = useState('local')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)   // 'all' / 目标 id / 'discover'
  const [found, setFound] = useState<{ hostId: string; names: string[]; picked: Set<string>; viaHost: boolean } | null>(null)

  const load = useCallback(() => { client.certs.list().then(setSt).catch((e) => setErr(errText(e))) }, [])
  useEffect(() => { load(); client.hosts.list().then(setHosts).catch(() => {}) }, [load])
  const act = async (key: string, f: () => Promise<CertState>) => {
    setBusy(key); setErr('')
    try { setSt(await f()) } catch (e) { setErr(errText(e)) } finally { setBusy(null) }
  }
  const add = async () => {
    if (!spec.trim()) return
    await act('add', async () => {
      const s = await client.certs.save({ spec: spec.trim(), ...(via !== 'local' ? { via } : {}) })
      const t = s.targets[s.targets.length - 1]
      setSpec('')
      setSt(s)   // 先显示新目标：马上检查如果失败，列表里也能看到它并重试
      return t ? client.certs.check([t.id]) : s
    })
  }
  const discover = async (hostId: string) => {
    setBusy('discover'); setErr(''); setFound(null)
    try { const names = await client.certs.discover(hostId); setFound({ hostId, names, picked: new Set(names), viaHost: false }); if (!names.length) setErr(tr('这台主机的 nginx / apache 配置里没有找到启用了 HTTPS 的域名')) }
    catch (e) { setErr(errText(e)) } finally { setBusy(null) }
  }
  const addFound = async () => {
    if (!found) return
    await act('add', async () => {
      let s = st!
      const ids: string[] = []
      for (const n of found.picked) {
        const before = s.targets.length
        s = await client.certs.save({ spec: n, ...(found.viaHost ? { via: found.hostId } : {}) }).catch(() => s)
        // 新增成功才多出一个（重名等失败保持原状态）；只检查这次新加的，不把全部目标重查一遍
        if (s.targets.length > before) ids.push(s.targets[s.targets.length - 1].id)
      }
      setSt(s)
      if (!ids.length) throw new Error(tr('选中的域名都已在列表里'))
      setFound(null)
      return client.certs.check(ids)
    })
  }

  const hostLabel = (id?: string) => (!id ? tr('本机') : hosts.find((h) => h.id === id)?.label ?? tr('（已删除的主机）'))
  const viaOpts = [{ value: 'local', label: tr('从本机检查') }, ...hosts.map((h) => ({ value: h.id, label: tr('从 {host} 检查', { host: h.label }) }))]
  const cfg = st?.config
  const soon = st ? st.targets.filter((t) => { const lv = certLevel(st.results[t.id], cfg?.warnDays); return lv !== 'ok' }).length : 0

  return (
    <div data-certs><Section title={tr('证书与域名巡检')}
      tip={tr('按域名或 主机:端口 检查 HTTPS 证书：剩余天数、颁发者、证书里的域名（SAN）是否包含这个域名、证书链是否完整（缺中间证书 / 自签名 / 不受信任）、协议版本。默认从本机连；只在内网能访问的域名选「从某台主机检查」（经该主机执行 openssl，只读）。每天自动检查一次（应用开着时）；进入 30 / 14 / 3 天档或已过期、检查失败时弹系统通知，并推送到下方配置的群机器人。')}
      actions={<>
        {soon > 0 && <span data-cert-soon className="text-[11px] text-[var(--color-warn)]">{tr('{n} 项需要关注', { n: soon })}</span>}
        <button data-cert-checkall disabled={!st?.targets.length || !!busy} onClick={() => void act('all', () => client.certs.check())} className={`${BTN2} flex items-center gap-1`}>
          {busy === 'all' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}{tr('立即检查全部')}</button>
      </>}>
      <Row label={tr('添加')} hint={tr('域名[:端口]，端口默认 443')} wide>
        <div className="flex items-center gap-2">
          <Input data-cert-spec value={spec} onChange={(e) => setSpec(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} placeholder={tr('如 example.com、api.x.com:8443')} className="min-w-0 flex-1 font-mono" spellCheck={false} />
          <Select className="w-44" value={via} onValueChange={setVia} options={viaOpts} />
          <button data-cert-add disabled={!spec.trim() || !!busy} onClick={() => void add()} className={BTN1}>{busy === 'add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}{tr('添加并检查')}</button>
        </div>
        {hosts.length > 0 && (
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
            <Search className="h-3.5 w-3.5" />{tr('从主机发现：')}
            <Select size="sm" className="w-48" value="" placeholder={tr('选一台主机…')} onValueChange={(id) => void discover(id)} options={hosts.map((h) => ({ value: h.id, label: h.label }))} disabled={!!busy} />
            {busy === 'discover' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>{tr('读 nginx / apache 配置里开了 HTTPS 的域名')}</span>
          </div>
        )}
        {found && found.names.length > 0 && (
          <div data-cert-found className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2">
            <div className="mb-1 text-[11.5px] text-[var(--color-text-secondary)]">{tr('在 {host} 上找到 {n} 个域名：', { host: hostLabel(found.hostId), n: found.names.length })}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {found.names.map((n) => (
                <label key={n} className="flex cursor-pointer items-center gap-1 font-mono text-[11.5px] text-[var(--color-text-primary)]">
                  <Checkbox checked={found.picked.has(n)} onCheckedChange={() => setFound({ ...found, picked: new Set(found.picked.has(n) ? [...found.picked].filter((x) => x !== n) : [...found.picked, n]) })} />{n}
                </label>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)]"><Checkbox checked={found.viaHost} onCheckedChange={(v) => setFound({ ...found, viaHost: v })} />{tr('从这台主机检查（内网域名）')}</label>
              <button disabled={!found.picked.size || !!busy} onClick={() => void addFound()} className={`${BTN1} ml-auto`}>{tr('添加选中的 {n} 个', { n: found.picked.size })}</button>
              <button onClick={() => setFound(null)} className={BTN2}>{tr('取消')}</button>
            </div>
          </div>
        )}
        {err && <div data-cert-error className="text-[11.5px] text-[var(--color-danger)]">{err}</div>}
      </Row>
      {cfg && <>
        <Row label={tr('每天自动检查')} hint={st?.lastRunAt ? tr('上次全部检查：{time}', { time: fmt(st.lastRunAt) }) : tr('应用开着时每 24 小时查一次')}>
          <Switch checked={cfg.enabled} onCheckedChange={(v) => void act('cfg', () => client.certs.setConfig({ enabled: v }))} />
        </Row>
        <Row label={tr('提前提醒天数')} hint={tr('少于这么多天标黄并提醒；14 / 3 天内标橙 / 红')}>
          <NumberInput className="w-24" value={cfg.warnDays} min={1} max={365} onChange={(n) => void act('cfg', () => client.certs.setConfig({ warnDays: n }))} />
        </Row>
        <Row label={tr('推送到群机器人')} hint={tr('同时发到本页下方「告警推送（群机器人）」里启用的机器人')}>
          <Switch checked={cfg.webhooks} onCheckedChange={(v) => void act('cfg', () => client.certs.setConfig({ webhooks: v }))} />
        </Row>
      </>}
      {st && st.targets.length === 0 && <div className="px-3.5 py-4 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有要检查的域名')}</div>}
      {st && st.targets.length > 0 && (
        <div className="px-1.5 py-1" data-cert-list>
          {st.targets.map((t: CertTarget) => {
            const r = st.results[t.id], lv = certLevel(r, cfg?.warnDays)
            return (
              <div key={t.id} data-cert-row={certTargetLabel(t)} data-level={r ? lv : 'none'} className="group rounded-md px-2 py-1.5 hover:bg-[var(--color-bg-hover)]">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <FileKey2 className="h-3.5 w-3.5 shrink-0" style={{ color: r ? LEVEL_COLOR[lv] : 'var(--color-text-muted)' }} />
                  <span className="min-w-0 truncate font-mono font-medium text-[var(--color-text-primary)]">{certTargetLabel(t)}</span>
                  {t.via && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr('经 {host}', { host: hostLabel(t.via) })}</span>}
                  <Tag color={r ? LEVEL_COLOR[lv] : 'var(--color-text-muted)'} title={r ? tr(CERT_LEVEL_LABEL[lv]) : undefined}>{daysText(r, lv)}</Tag>
                  {r?.ok && r.nameMatch === false && <Tag color="var(--color-danger)" title={tr('证书里的域名：{names}', { names: r.san?.join(tr('、')) || tr('（无）') })}>{tr('域名不匹配')}</Tag>}
                  {r?.ok && r.chain && r.chain !== 'ok' && <Tag color={r.chain === 'expired' || r.chain === 'incomplete' ? 'var(--color-danger)' : 'var(--color-warn)'} title={r.chainError}>{tr(CHAIN_LABEL[r.chain])}</Tag>}
                  <span className="ml-auto" />
                  <button title={tr('检查这一项')} disabled={!!busy} onClick={() => void act(t.id, () => client.certs.check([t.id]))} className={ICON_BTN}>{busy === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}</button>
                  <button title={tr('删除')} onClick={() => void act('del', () => client.certs.delete(t.id))} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
                </div>
                {r && (
                  <div className="mt-0.5 pl-[22px] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    {r.ok ? <>
                      {trx('到期 {date}', { date: <span className="text-[var(--color-text-secondary)]">{r.notAfter?.slice(0, 10)}</span> })}
                      {' · '}{trx('颁发者 {issuer}', { issuer: <span className="text-[var(--color-text-secondary)]">{r.issuer || tr('未知')}</span> })}
                      {r.chain === 'ok' && <> · {tr('证书链{state}', { state: tr(CHAIN_LABEL.ok) })}</>}
                      {r.protocol && <> · {r.protocol}</>}
                      {r.san?.length ? <> · {trx('域名 {names}', { names: <span className="font-mono">{r.san.slice(0, 4).join(', ')}{r.san.length > 4 ? tr(' 等 {n} 个', { n: r.san.length }) : ''}</span> })}</> : null}
                    </> : <span className="text-[var(--color-danger)]">{r.error && tr(r.error)}</span>}
                    <span className="ml-1.5">{tr('· {time} 检查', { time: fmt(r.at) })}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Section></div>
  )
}

/** 仪表盘汇总条上的「N 张证书 30 天内到期」（没有就不显示） */
export function CertSoonBadge() {
  const [st, setSt] = useState<CertState | null>(null)
  useEffect(() => { client.certs.list().then(setSt).catch(() => {}) }, [])
  if (!st) return null
  const lv = st.targets.map((t) => certLevel(st.results[t.id], st.config.warnDays)).filter((l) => l !== 'ok' && l !== 'error')
  if (!lv.length) return null
  const worst: CertLevel = lv.includes('expired') || lv.includes('red') ? 'red' : lv.includes('orange') ? 'orange' : 'yellow'
  return (
    <span data-dash-certs title={tr('证书与域名巡检（设置 → 定时巡检）')} className="rounded px-1.5 py-0.5 text-[12px]" style={{ color: LEVEL_COLOR[worst], background: `color-mix(in srgb, ${LEVEL_COLOR[worst]} 12%, transparent)` }}>
      {tr('{n} 张证书 {days} 天内到期', { n: lv.length, days: st.config.warnDays })}{lv.includes('expired') ? tr('（含已过期）') : ''}
    </span>
  )
}
