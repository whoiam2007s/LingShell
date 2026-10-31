import { useEffect, useState, useCallback } from 'react'
import { CalendarClock, Pencil, Trash2, Plus, Play } from 'lucide-react'
import { templateVars, tr, tk, dateLocale, type InspectionSchedule, type InspectionRun, type InspectionStatus, type HostSummary, type PromptTemplate, type ScheduleInput, type WebhookSummary, type NotifyOn } from '@lingshell/shared'
import { WebhookManager } from './WebhookManager.js'
import { WatchdogManager } from './WatchdogManager.js'
import { CertManager } from './CertManager.js'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { Sel } from '../../../components/ui/form.js'
import { Page, Section, Row, SaveBar, INPUT, taCls, BTN1, ICON_BTN, ICON_DEL, LIST, ITEM, Toolbar, EmptyState, BackLink, errText } from '../ui.js'

const STATUS: Record<InspectionStatus, { text: string; color: string }> = {
  running: { text: tk('运行中'), color: 'var(--color-accent)' },
  normal: { text: tk('正常'), color: 'var(--color-success)' },
  abnormal: { text: tk('异常'), color: 'var(--color-danger)' },
  unknown: { text: tk('无结论'), color: 'var(--color-warn)' },
  failed: { text: tk('失败'), color: 'var(--color-danger)' },
  timeout: { text: tk('超时'), color: 'var(--color-warn)' },
}
const Badge = ({ s }: { s: InspectionStatus }) => (
  <span className="shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium" style={{ color: STATUS[s].color, background: `color-mix(in srgb, ${STATUS[s].color} 15%, transparent)` }}>{tr(STATUS[s].text)}</span>
)
const fmt = (iso: string) => new Date(iso).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const empty: ScheduleInput = { name: '', prompt: '', targets: [], when: { kind: 'daily', time: '09:00' }, enabled: true }
const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-[12px] transition-colors ${on ? 'border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-text-primary)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`

const pageTip = () => tr('巡检只在本应用运行时执行；应用关闭期间错过的，下次启动后只补跑一次。每次巡检新建一个会话，在后台终端里运行（不占用你的终端标签），AI 只能对所选目标执行白名单内的只读命令，修改类命令自动拒绝、不会弹授权。结果为异常、失败或超时时弹系统通知，并推送到配置的群机器人。')
/** 巡检内容里的主机占位符（模板语法，不翻译） */
const HOST_VAR = '{{主机}}'   // i18n-ignore 模板占位符

// 设置弹窗内的「定时巡检」页：计划增删改/启停/立即运行 + 最近运行记录（点开对应会话）+ 告警推送（群机器人）。
export function ScheduleManager({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [list, setList] = useState<InspectionSchedule[] | null>(null)
  const [runs, setRuns] = useState<InspectionRun[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [form, setForm] = useState<ScheduleInput | null>(null)
  const [delTarget, setDelTarget] = useState<InspectionSchedule | null>(null)
  const [err, setErr] = useState('')
  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([])
  const loadWebhooks = useCallback(() => { client.webhooks.list().then(setWebhooks).catch(() => {}) }, [])

  const refresh = useCallback(() => {
    client.schedules.list().then(setList).catch(() => setList([]))
    client.schedules.listRuns().then(setRuns).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    client.hosts.list().then(setHosts).catch(() => {})
    client.templates.list().then(setTemplates).catch(() => {})
    loadWebhooks()
    return client.on((ev) => { if (ev.type === 'inspection:run') refresh() })
  }, [refresh, loadWebhooks])

  const label = (k: string) => k === 'local' ? tr('本地') : hosts.find((h) => h.id === k)?.label ?? tr('（已删除的主机）')
  const whenText = (s: ScheduleInput) => s.when.kind === 'daily' ? tr('每天 {time}', { time: s.when.time }) : tr('每 {n} 小时', { n: s.when.hours })

  const save = async (input: ScheduleInput) => {
    const known = new Set(['local', ...hosts.map((h) => h.id)])
    const dead = input.targets.filter((k) => !known.has(k))
    if (dead.length) { setErr(tr('目标里有已删除的主机，请取消勾选后再保存')); return }   // 否则每次巡检都会连不上并反复通知
    try { await client.schedules.save(input); setForm(null); setErr(''); refresh() }
    catch (e) { setErr(errText(e)) }
  }
  const runNow = (id: string) => { client.schedules.runNow(id).then(refresh).catch((e) => setErr(errText(e))) }
  const doDelete = () => { if (delTarget) client.schedules.delete(delTarget.id).then(refresh); setDelTarget(null) }
  const create = () => { setForm({ ...empty }); setErr('') }

  if (form) {
    const leftover = templateVars(form.prompt).filter((v) => v !== '主机')   // i18n-ignore 模板变量名
    const toggle = (k: string) => setForm({ ...form, targets: form.targets.includes(k) ? form.targets.filter((x) => x !== k) : [...form.targets, k] })
    // 推送目标：undefined = 所有启用的；点具体机器人切到显式列表；[] = 不推送
    const nw = form.notifyWebhooks
    const toggleWh = (id: string) => { const cur = nw ?? []; setForm({ ...form, notifyWebhooks: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }) }
    return (
      <Page>
        <BackLink onClick={() => { setForm(null); setErr('') }}>{tr('返回巡检列表')}</BackLink>
        <Section title={form.id ? tr('编辑巡检') : tr('新建巡检')}>
          <Row label={tr('field|名称')}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('如：每日磁盘巡检')} className={`w-72 ${INPUT}`} /></Row>
          <Row label={tr('巡检内容')} hint={tr('让 AI 检查什么')} wide tip={tr('{v} 会替换为目标主机名；其它占位符巡检时没人填，要先改成实际值。可从常用任务模板填入。', { v: HOST_VAR })}>
            <div className="w-56">
              <Sel value="" onChange={(id) => { const t = templates.find((x) => x.id === id); if (t) setForm({ ...form, prompt: t.prompt, name: form.name || t.name }) }}>
                <option value="">{tr('从模板填入…')}</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Sel>
            </div>
            <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={4} className={taCls} placeholder={tr('如：检查 {v} 的磁盘和内存', { v: HOST_VAR })} />
            {leftover.length > 0 && <div className="text-[11px] text-[var(--color-warn)]">{tr('请把 {vars} 改成实际值', { vars: leftover.map((v) => `{{${v}}}`).join(tr('list|、')) })}</div>}
          </Row>
          <Row label={tr('目标主机')} hint={tr('可多选')} wide>
            <div className="flex flex-wrap gap-1.5">
              {[{ id: 'local', label: tr('本地') }, ...hosts.map((h) => ({ id: h.id, label: h.label })),
                // 已删除的主机也要出 chip，否则编辑时取消不掉它，计划永远修不好
                ...form.targets.filter((k) => k !== 'local' && !hosts.some((h) => h.id === k)).map((id) => ({ id, label: tr('（已删除的主机）') })),
              ].map((h) => (
                <button key={h.id} onClick={() => toggle(h.id)} className={chip(form.targets.includes(h.id))} title={h.id}>{h.label}</button>
              ))}
            </div>
          </Row>
        </Section>
        <Section title={tr('时间')}>
          <Row label={tr('频率')}>
            <div className="w-28">
              <Sel value={form.when.kind} onChange={(k) => setForm({ ...form, when: k === 'daily' ? { kind: 'daily', time: '09:00' } : { kind: 'interval', hours: 6 } })}>
                <option value="daily">{tr('每天')}</option>
                <option value="interval">{tr('每隔')}</option>
              </Sel>
            </div>
            {form.when.kind === 'daily'
              ? <input type="time" value={form.when.time} onChange={(e) => setForm({ ...form, when: { kind: 'daily', time: e.target.value } })} className={`[color-scheme:dark] ${INPUT}`} />
              : <><NumberInput className="w-24" value={form.when.hours} min={1} max={168} onChange={(n) => setForm({ ...form, when: { kind: 'interval', hours: n } })} /><span className="text-[12px] text-[var(--color-text-secondary)]">{tr('unit|小时')}</span></>}
          </Row>
          <Row label={tr('启用')} hint={tr('停用后保留配置，不再按时运行')}><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /></Row>
        </Section>
        {webhooks.length > 0 && (
          <Section title={tr('告警推送')} tip={tr('推送失败只在运行记录里标注，不影响巡检。机器人在本页下方「告警推送（群机器人）」里配置。')}>
            <Row label={tr('推送到')} wide>
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => setForm({ ...form, notifyWebhooks: undefined })} className={chip(!nw)}>{tr('全部启用的机器人')}</button>
                {webhooks.map((w) => <button key={w.id} onClick={() => toggleWh(w.id)} className={chip(!!nw?.includes(w.id))}>{w.name}{w.enabled ? '' : tr('（已停用）')}</button>)}
                {nw?.length === 0 && <span className="text-[11px] text-[var(--color-text-muted)]">{tr('不推送')}</span>}
              </div>
            </Row>
            <Row label={tr('推送时机')}>
              <div className="w-48">
                <Sel value={form.notifyOn ?? 'problem'} onChange={(v) => setForm({ ...form, notifyOn: v as NotifyOn })}>
                  <option value="problem">{tr('仅异常 / 失败 / 超时时')}</option>
                  <option value="always">{tr('每次运行')}</option>
                </Sel>
              </div>
            </Row>
          </Section>
        )}
        <SaveBar onSave={() => save(form)} disabled={!form.name.trim() || !form.prompt.trim() || !form.targets.length || leftover.length > 0} msg={err ? { ok: false, text: err } : null} />
      </Page>
    )
  }

  const lastRun = (id: string) => runs.find((r) => r.scheduleId === id)
  const newBtn = <button onClick={create} className={BTN1}><Plus className="h-3.5 w-3.5" />{tr('新建巡检')}</button>
  return (
    <Page>
      <Toolbar hint={tr('按计划让 AI 在后台只读检查主机')} tip={pageTip()}>{newBtn}</Toolbar>
      {!list ? null : list.length === 0 ? <EmptyState text={tr('暂无巡检计划')} action={newBtn} /> : (
        <div className={LIST}>
          {list.map((s) => {
            const lr = lastRun(s.id)
            return (
              <div key={s.id} className={ITEM}>
                <CalendarClock className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{s.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{whenText(s)} · {s.targets.map(label).join(tr('list|、'))}</span>
                {lr && <Badge s={lr.status} />}
                <Switch checked={s.enabled} onCheckedChange={(v) => save({ ...s, enabled: v })} title={s.enabled ? tr('已启用') : tr('已停用')} />
                <button onClick={() => runNow(s.id)} title={tr('立即运行')} className={ICON_BTN}><Play className="h-3 w-3" /></button>
                <button onClick={() => { setForm({ id: s.id, name: s.name, prompt: s.prompt, targets: s.targets, when: s.when, enabled: s.enabled, notifyWebhooks: s.notifyWebhooks, notifyOn: s.notifyOn }); setErr('') }} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
                <button onClick={() => setDelTarget(s)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
              </div>
            )
          })}
        </div>
      )}
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}

      <Section title={tr('最近运行')} tip={tr('点一条打开对应的巡检会话。最多显示最近 30 条。')}>
        {runs.length === 0 ? (
          <div className="px-3.5 py-4 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有运行记录')}</div>
        ) : (
          <div className="max-h-72 overflow-y-auto px-1.5 py-1">
            {runs.slice(0, 30).map((r) => (
              <button key={r.id} disabled={!r.sessionId} onClick={() => r.sessionId && onOpenSession?.(r.sessionId)} title={r.sessionId ? tr('打开巡检会话') : undefined}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors enabled:hover:bg-[var(--color-bg-hover)]">
                <span className="shrink-0 tabular-nums text-[11px] text-[var(--color-text-muted)]">{fmt(r.at)}</span>
                <span className="shrink-0 text-[var(--color-text-primary)]">{r.scheduleName}</span>
                <Badge s={r.status} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{r.error ?? r.summary.split('\n').filter(Boolean).slice(-2).join(' ')}</span>
                {r.alertError && <span className="shrink-0 text-[10.5px] text-[var(--color-warn)]" title={r.alertError}>{tr('推送失败')}</span>}
              </button>
            ))}
          </div>
        )}
      </Section>

      <WatchdogManager onOpenSession={onOpenSession} />
      <CertManager />
      <WebhookManager onChanged={loadWebhooks} />
      <ConfirmDialog open={!!delTarget} title={tr('删除巡检')} message={tr('确定删除巡检 {name}？已有运行记录和会话保留。', { name: delTarget?.name ?? '' })} onConfirm={doDelete} onCancel={() => setDelTarget(null)} />
    </Page>
  )
}
