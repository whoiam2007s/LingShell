import { useCallback, useEffect, useState } from 'react'
import { Eye, Pencil, Trash2, Plus, Play, Sparkles, Loader2, ChevronRight, MessageSquare } from 'lucide-react'
import {
  hostGroupNames, resolveWatchdogTargets, WATCHDOG_INTERVALS, WATCHDOG_MAX_THRESHOLD, tr, tk, dateLocale,
  type HostSummary, type Watchdog, type WatchdogInput, type WatchdogState, type WatchdogStatus,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { Switch } from '../../../components/ui/Switch.js'
import { NumberInput } from '../../../components/ui/NumberInput.js'
import { Sel } from '../../../components/ui/form.js'
import { Section, Row, INPUT, BTN2, BTN1, ICON_BTN, ICON_DEL, ITEM, taCls, errText } from '../ui.js'
import { cn } from '../../../lib/cn.js'

const STATUS: Record<WatchdogStatus, { text: string; color: string }> = {
  unknown: { text: tk('未检查'), color: 'var(--color-text-muted)' },
  ok: { text: tk('正常'), color: 'var(--color-success)' },
  pending: { text: tk('疑似触发'), color: 'var(--color-warn)' },
  firing: { text: tk('触发'), color: 'var(--color-danger)' },
  error: { text: tk('检查失败'), color: 'var(--color-warn)' },
}
const RANK: WatchdogStatus[] = ['unknown', 'ok', 'pending', 'error', 'firing']
const Badge = ({ s, extra }: { s: WatchdogStatus; extra?: string }) => (
  <span data-wd-status={s} className="shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium" style={{ color: STATUS[s].color, background: `color-mix(in srgb, ${STATUS[s].color} 15%, transparent)` }}>{tr(STATUS[s].text)}{extra}</span>
)
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString(dateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-[12px] transition-colors ${on ? 'border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-text-primary)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`
const empty: WatchdogInput = { name: '', condition: '', script: '', explain: '', targets: [], groups: [], intervalMin: 5, threshold: 1, autoSession: true, enabled: true }
const tip = () => tr('用一句话写报警条件，AI 生成只读检查脚本（可修改，含写操作的不能保存），应用运行期间按间隔在所选主机上后台执行（独立通道，不占用终端）。脚本退出码 0 = 正常、1 = 触发、其他 = 检查失败；连续触发够次数才报警：弹系统通知，可自动开 AI 排查会话（恢复前不重复开），恢复正常也会通知。应用关闭期间不检查。')

// 定时巡检页里的「看门狗」分组：自然语言条件 → 只读检查脚本，后台按间隔检查，触发报警 / 自动排查
export function WatchdogManager({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [list, setList] = useState<Watchdog[]>([])
  const [states, setStates] = useState<Map<string, WatchdogState>>(new Map())
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [form, setForm] = useState<WatchdogInput | null>(null)
  const [del, setDel] = useState<Watchdog | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string>()
  const [checking, setChecking] = useState<string>()
  const [paused, setPaused] = useState(false)   // 全局暂停（托盘 / 悬浮球菜单也能切）

  const refresh = useCallback(() => {
    client.watchdogs.list().then(setList).catch(() => {})
    client.watchdogs.states().then((ss) => setStates(new Map(ss.map((s) => [s.id, s])))).catch(() => {})
  }, [])
  useEffect(() => {
    refresh()
    client.hosts.list().then(setHosts).catch(() => {})
    client.watchdogs.paused().then(setPaused).catch(() => {})
    return client.on((ev) => {
      if (ev.type === 'watchdog:state') setStates((m) => new Map(m).set(ev.state.id, ev.state))
      else if (ev.type === 'watchdog:paused') setPaused(ev.paused)
    })
  }, [refresh])

  const label = (k: string) => (k === 'local' ? tr('host|本机') : hosts.find((h) => h.id === k)?.label ?? tr('（已删除的主机）'))
  const save = async (f: WatchdogInput) => {
    try { await client.watchdogs.save(f); setForm(null); setErr(''); refresh() } catch (e) { setErr(errText(e)) }
  }
  const toggle = (w: Watchdog, enabled: boolean) => { client.watchdogs.save({ ...w, enabled }).then(refresh).catch((e) => setErr(errText(e))) }
  const checkNow = (id: string) => {
    setChecking(id); setOpen(id)
    client.watchdogs.checkNow(id).then((s) => setStates((m) => new Map(m).set(s.id, s))).catch((e) => setErr(errText(e))).finally(() => setChecking(undefined))
  }
  const add = () => { setForm({ ...empty }); setErr('') }
  const addBtn = <>
    {list.length > 0 && <button data-watchdog-pause onClick={() => client.watchdogs.setPaused(!paused).then(setPaused).catch((e) => setErr(errText(e)))} className={BTN2}
      title={paused ? tr('恢复到点自动检查') : tr('暂停全部看门狗的自动检查（「立即检查」照常可用）')}>{paused ? tr('恢复全部') : tr('暂停全部')}</button>}
    <button onClick={add} className={`flex items-center gap-1 ${BTN2}`}><Plus className="h-3.5 w-3.5" />{tr('新建看门狗')}</button>
  </>

  if (form) return <WatchdogForm form={form} setForm={setForm} hosts={hosts} err={err} onCancel={() => { setForm(null); setErr('') }} onSave={save} />

  return (
    <Section title={tr('看门狗')} tip={tip()} actions={addBtn}>
      {paused && list.length > 0 && <div data-watchdog-paused className="border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-3.5 py-2 text-[12px] text-[var(--color-warn)]">{tr('已全部暂停：到点不再自动检查，点「恢复全部」或在托盘菜单里恢复')}</div>}
      {list.length === 0 ? (
        <div className="px-3.5 py-5 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有看门狗。用一句话描述报警条件，如「nginx 每分钟 5xx 超过 10 次」「/data 使用率超过 90%」「mysqld 进程不在」')}</div>
      ) : list.map((w) => {
        const st = states.get(w.id)
        const targets = resolveWatchdogTargets(w, hosts)
        const hs = targets.map((k) => [k, st?.hosts[k]] as const)
        const worst = hs.reduce<WatchdogStatus>((m, [, h]) => (RANK.indexOf(h?.status ?? 'unknown') > RANK.indexOf(m) ? h!.status : m), 'unknown')
        const expanded = open === w.id
        return (
          <div key={w.id} data-watchdog={w.name} className="border-b border-[var(--color-border-subtle)] last:border-b-0">
            <div className={ITEM}>
              <button onClick={() => setOpen(expanded ? undefined : w.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={tr('展开看各主机状态与触发历史')}>
                <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', expanded && 'rotate-90')} />
                <Eye className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span className="shrink-0 font-medium text-[var(--color-text-primary)]">{w.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">
                  {tr('每 {n} 分钟', { n: w.intervalMin })} · {targets.map(label).join(tr('list|、')) || tr('无主机')}{w.threshold > 1 ? ` · ${tr('连续 {n} 次', { n: w.threshold })}` : ''}
                </span>
              </button>
              {w.enabled ? <Badge s={worst} /> : <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr('已停用')}</span>}
              <Switch checked={w.enabled} onCheckedChange={(v) => toggle(w, v)} title={w.enabled ? tr('已启用') : tr('已停用')} />
              <button onClick={() => checkNow(w.id)} disabled={checking === w.id} title={tr('立即检查')} className={ICON_BTN}>
                {checking === w.id ? <Loader2 className="h-3 w-3 animate-spin-slow" /> : <Play className="h-3 w-3" />}
              </button>
              <button onClick={() => { setForm({ ...w }); setErr('') }} title={tr('编辑')} className={ICON_BTN}><Pencil className="h-3 w-3" /></button>
              <button onClick={() => setDel(w)} title={tr('删除')} className={ICON_DEL}><Trash2 className="h-3 w-3" /></button>
            </div>
            {expanded && (
              <div data-watchdog-detail className="space-y-2 px-3.5 pb-3 pl-9 text-[11.5px]">
                <div className="text-[var(--color-text-muted)]">{tr('条件：{s}', { s: w.condition })}{w.explain ? tr('（{s}）', { s: w.explain }) : ''}</div>
                <div className="overflow-hidden rounded border border-[var(--color-border-subtle)]">
                  {hs.map(([k, h]) => (
                    <div key={k} className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-1 last:border-b-0">
                      <span className="w-28 shrink-0 truncate text-[var(--color-text-secondary)]">{label(k)}</span>
                      <Badge s={h?.status ?? 'unknown'} extra={h?.status === 'pending' ? ` ${h.streak}/${w.threshold}` : ''} />
                      <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]" title={h?.value}>{h?.value ?? ''}</code>
                      <span className="shrink-0 tabular-nums text-[10.5px] text-[var(--color-text-muted)]">{fmt(h?.at)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-[var(--color-text-muted)]">{tr('触发历史（最近 20 条）')}</div>
                  {!st?.history.length ? <div className="text-[var(--color-text-muted)]">{tr('暂无')}</div> : (
                    <div className="max-h-48 space-y-0.5 overflow-y-auto">
                      {st.history.map((e, i) => (
                        <div key={`${e.at}-${i}`} className="flex items-center gap-2">
                          <span className="shrink-0 tabular-nums text-[10.5px] text-[var(--color-text-muted)]">{fmt(e.at)}</span>
                          <span className={cn('shrink-0', e.kind === 'fire' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]')}>{e.kind === 'fire' ? tr('触发') : tr('alert|恢复')}</span>
                          <span className="shrink-0 text-[var(--color-text-secondary)]">{label(e.hostKey)}</span>
                          <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-muted)]" title={e.value}>{e.value}</code>
                          {e.sessionId && onOpenSession && (
                            <button onClick={() => onOpenSession(e.sessionId!)} className="flex shrink-0 items-center gap-1 text-[10.5px] text-[var(--color-accent)] hover:underline">
                              <MessageSquare className="h-3 w-3" />{tr('排查会话')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {err && <div className="px-3.5 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
      <ConfirmDialog open={!!del} title={tr('删除看门狗')} message={tr('确定删除看门狗 {name}？状态与触发历史一并删除，已开的排查会话保留。', { name: del?.name ?? '' })}
        onConfirm={() => { if (del) client.watchdogs.delete(del.id).then(refresh); setDel(null) }} onCancel={() => setDel(null)} />
    </Section>
  )
}

function WatchdogForm({ form, setForm, hosts, err, onCancel, onSave }: {
  form: WatchdogInput; setForm: (f: WatchdogInput) => void; hosts: HostSummary[]; err: string
  onCancel: () => void; onSave: (f: WatchdogInput) => void
}) {
  const [gen, setGen] = useState<'idle' | 'busy'>('idle')
  const [genErr, setGenErr] = useState('')
  const [readonly, setReadonly] = useState<boolean>()
  const groups = hostGroupNames(hosts)
  const groupSel = form.groups ?? []
  // 脚本改动后（停顿 400ms）重新做只读校验，结果显示在脚本下方
  useEffect(() => {
    if (!form.script.trim()) { setReadonly(undefined); return }
    const t = setTimeout(() => { client.watchdogs.checkScript(form.script).then(setReadonly).catch(() => setReadonly(undefined)) }, 400)
    return () => clearTimeout(t)
  }, [form.script])
  const generate = () => {
    setGen('busy'); setGenErr('')
    const onlyLocal = form.targets.length === 1 && form.targets[0] === 'local' && !groupSel.length
    const os = onlyLocal && /win/i.test(navigator.platform) ? 'windows' as const : undefined
    client.watchdogs.generate(form.condition, os)
      .then((r) => setForm({ ...form, script: r.script, explain: r.explain, name: form.name.trim() || form.condition.trim().slice(0, 20) }))
      .catch((e) => setGenErr(errText(e))).finally(() => setGen('idle'))
  }
  const toggle = (k: string) => setForm({ ...form, targets: form.targets.includes(k) ? form.targets.filter((x) => x !== k) : [...form.targets, k] })
  const toggleG = (g: string) => setForm({ ...form, groups: groupSel.includes(g) ? groupSel.filter((x) => x !== g) : [...groupSel, g] })
  const can = form.name.trim() && form.condition.trim() && form.script.trim() && (form.targets.length || groupSel.length) && readonly !== false

  return (
    <Section title={form.id ? tr('编辑看门狗') : tr('新建看门狗')} tip={tip()}>
      <Row label={tr('条件')} hint={tr('一句话描述何时报警')} wide>
        <textarea data-wd-condition value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} rows={2} className={taCls}
          placeholder={tr('如：nginx 每分钟 5xx 超过 10 次 / /data 使用率超过 90% / mysqld 进程不在')} />
        <div className="flex items-center gap-2">
          <button data-wd-generate onClick={generate} disabled={!form.condition.trim() || gen === 'busy'} className={`flex items-center gap-1 ${BTN2}`}>
            {gen === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin-slow" /> : <Sparkles className="h-3.5 w-3.5" />}{tr('生成检查脚本')}
          </button>
          {genErr && <span className="min-w-0 truncate text-[11.5px] text-[var(--color-danger)]" title={genErr}>{genErr}</span>}
        </div>
      </Row>
      <Row label={tr('检查脚本')} hint={tr('可修改；只读')} wide tip={tr('约定：输出一行当前值；退出码 0 = 正常，1 = 触发，其他 = 检查失败。含写操作（改文件、重启服务、sudo、写重定向等）或无法确认只读的脚本不能保存。')}>
        {form.explain && <div className="text-[11.5px] text-[var(--color-text-muted)]">{tr('说明：{s}', { s: form.explain })}</div>}
        <textarea data-wd-script value={form.script} onChange={(e) => setForm({ ...form, script: e.target.value })} rows={5} spellCheck={false}
          className={`${taCls} font-mono text-[11.5px]`} placeholder={tr('点「生成检查脚本」，或自己写')} />
        {readonly !== undefined && (
          <div data-wd-readonly={readonly ? 'ok' : 'bad'} className={cn('text-[11px]', readonly ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')}>
            {readonly ? tr('✓ 只读校验通过') : tr('✗ 含写操作或无法确认只读（不允许 sudo、写文件重定向、awk/sed/eval、修改类命令等），不能保存')}
          </div>
        )}
      </Row>
      <Row label={tr('field|名称')}><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('如：/data 磁盘')} className={`w-60 ${INPUT}`} /></Row>
      <Row label={tr('主机')} hint={tr('可多选')} wide>
        <div className="flex flex-wrap gap-1.5">
          {[{ id: 'local', label: tr('host|本机') }, ...hosts].map((h) => <button key={h.id} onClick={() => toggle(h.id)} className={chip(form.targets.includes(h.id))}>{h.label}</button>)}
        </div>
      </Row>
      {groups.length > 0 && (
        <Row label={tr('分组')} hint={tr('组内全部主机')} wide>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => <button key={g} onClick={() => toggleG(g)} className={chip(groupSel.includes(g))}>{g}</button>)}
          </div>
        </Row>
      )}
      <Row label={tr('检查间隔')}>
        <div className="w-32">
          <Sel value={String(form.intervalMin)} onChange={(v) => setForm({ ...form, intervalMin: Number(v) })}>
            {WATCHDOG_INTERVALS.map((m) => <option key={m} value={String(m)}>{tr('每 {n} 分钟', { n: m })}</option>)}
          </Sel>
        </div>
      </Row>
      <Row label={tr('连续触发')} hint={tr('几次才报警')}>
        <NumberInput className="w-24" value={form.threshold} min={1} max={WATCHDOG_MAX_THRESHOLD} onChange={(n) => setForm({ ...form, threshold: n })} />
        <span className="text-[12px] text-[var(--color-text-secondary)]">{tr('unit|次')}</span>
      </Row>
      <Row label={tr('触发时自动开 AI 排查会话')} hint={tr('恢复正常前不重复开')}><Switch checked={form.autoSession} onCheckedChange={(v) => setForm({ ...form, autoSession: v })} /></Row>
      <Row label={tr('启用')}><Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} /></Row>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        {err && <span className="min-w-0 truncate text-[12px] text-[var(--color-danger)]" title={err}>{err}</span>}
        <button onClick={onCancel} className={`ml-auto ${BTN2}`}>{tr('取消')}</button>
        <button data-wd-save onClick={() => onSave(form)} disabled={!can} className={BTN1}>{tr('保存')}</button>
      </div>
    </Section>
  )
}
