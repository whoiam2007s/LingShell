import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CalendarClock, EyeOff, Eye, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import {
  CRON_OP_LABEL, cronNextRun, cronSourceLabel, dangerCheck, describeCalendar, describeCron, describeMonotonic, fmtHostTime, fmtIn, isCronExpr, portsSupported, tr,
  type CronEntry, type CronList, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ConfirmDialog } from '../common/index.js'
import { Input, Textarea } from '../../components/ui/Input.js'
import { HelpTip } from '../../components/ui/form.js'
import { BTN, DANGER_BOX, DrawerHeader, IB, MUTED, PRIMARY, Unsupported, errText } from './common.js'

type Ask = { op: 'delete' | 'disable' | 'enable'; e: CronEntry } | { op: 'add'; schedule: string; command: string; note: string }
// 操作名（显示时 tr）；完成提示单独成句，英文语序不同
const OP_TEXT = CRON_OP_LABEL
const doneText = (op: Ask['op']) => (op === 'delete' ? tr('已删除') : op === 'disable' ? tr('已注释（停用）') : op === 'enable' ? tr('已恢复') : tr('已新增'))

// 定时任务：当前 SSH 终端所在主机（Linux）的 crontab（当前用户 / root / /etc/crontab / cron.d）+ systemd timer，翻成人话、算下次运行时间。
// 只能改当前用户自己的 crontab：新建（可用 AI 把一句话写成任务）、注释 / 恢复、删除；都先确认（生产主机标红），写前备份原 crontab，记执行记录
export function CronDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && portsSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const prod = term?.env === 'prod'
  const [list, setList] = useState<CronList>()
  const [fetchedAt, setFetchedAt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [flash, setFlash] = useState('')
  const [ask, setAsk] = useState<Ask>()
  const [busy, setBusy] = useState(false)
  const [newOpen, setNewOpen] = useState(false)

  // 请求序号：写入后立刻刷新时，上一次刷新可能还在路上；旧响应不能盖掉新结果（也不能把这次刷新吞掉）
  const seq = useRef(0)
  const refresh = useCallback(() => {
    if (!ok) return
    const n = ++seq.current
    setLoading(true)
    client.cron.list(tid).then((r) => { if (n !== seq.current) return; setList(r); setFetchedAt(Date.now()); setErr('') })
      .catch((e) => { if (n === seq.current) setErr(errText(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [ok, tid])
  useEffect(() => { refresh() }, [refresh])
  // 确认框开着时 Esc 只关确认框（不关抽屉 / 新建框）
  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setAsk(undefined) } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ask])

  const now = list ? list.now + Math.floor((Date.now() - fetchedAt) / 1000) : 0
  const groups = useMemo(() => {
    const m = new Map<string, CronEntry[]>()
    for (const e of list?.entries ?? []) m.set(e.source, [...(m.get(e.source) ?? []), e])
    if (list?.userCrontab === undefined && !m.has('user')) m.set('user', [])
    const rank = (s: string) => (s === 'user' ? 0 : s === 'root' ? 1 : s === '/etc/crontab' ? 2 : 3)   // 我的 → root → /etc/crontab → cron.d
    return [...m.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  }, [list])

  const note = (t: string) => { setFlash(t); setTimeout(() => setFlash((f) => (f === t ? '' : f)), 6000) }
  const doIt = () => {
    const a = ask
    if (!a) return
    setAsk(undefined); setBusy(true); setErr('')
    const job = a.op === 'add' ? client.cron.add(tid, { schedule: a.schedule, command: a.command, note: a.note })
      : a.op === 'delete' ? client.cron.remove(tid, a.e.line, a.e.raw)
        : client.cron.toggle(tid, a.e.line, a.e.raw, a.op === 'disable')
    job.then((r) => { note(`${doneText(a.op)}${r.backup ? tr('；原 crontab 备份在 {path}', { path: r.backup }) : ''}`); if (a.op === 'add') setNewOpen(false) })
      .catch((e) => setErr(tr('{op}失败：{err}', { op: tr(OP_TEXT[a.op]), err: errText(e) })))
      .finally(() => { setBusy(false); refresh() })
  }

  const header = (
    <DrawerHeader icon={<CalendarClock className="h-3.5 w-3.5" />} title={tr('定时任务')} loading={loading} onRefresh={ok ? refresh : undefined} onClose={onClose}
      extra={ok && list ? <>
        <span className={`text-[10.5px] ${MUTED}`}>{tr('{n} 条 · {m} 个 timer', { n: list.entries.length, m: list.timers.length })}</span>
        <button data-cron-new onClick={() => setNewOpen(true)} title={tr('新建一条当前用户的定时任务（可用 AI 生成）')} className={`${BTN} text-[var(--color-accent)]`}><Plus className="h-3 w-3" />{tr('新建')}</button>
      </> : undefined} />
  )
  if (!ok) return <div className="flex h-full flex-col">{header}<Unsupported what={tr('定时任务视图')} /></div>

  const row = (e: CronEntry) => {
    const editable = e.source === 'user'
    const next = e.disabled ? undefined : cronNextRun(e.schedule, now, list!.tzOffsetMin)
    return (
      <div key={`${e.source}:${e.line}`} data-cron-line={e.line} className={`group border-b border-[var(--color-border-subtle)] px-3 py-1.5 hover:bg-[var(--color-bg-hover)] ${e.disabled ? 'opacity-55' : ''}`}>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]" title={e.schedule}>{e.disabled && <span className="mr-1 rounded bg-[var(--color-bg-raised)] px-1 text-[10px] font-normal text-[var(--color-text-muted)]">{tr('已注释')}</span>}{describeCron(e.schedule)}</span>
          {next !== undefined && <span className={`shrink-0 text-[10.5px] ${MUTED}`} title={tr('下次运行（主机本地时间）')}>{tr('下次 {at} · {in}', { at: fmtHostTime(next, list!.tzOffsetMin, now), in: fmtIn(next, now) })}</span>}
          {editable && (
            <span className="flex shrink-0 items-center gap-0.5">
              <button title={e.disabled ? tr('恢复（去掉行首 #）') : tr('注释掉（停用但保留）')} disabled={busy} onClick={() => setAsk({ op: e.disabled ? 'enable' : 'disable', e })} className={IB}>{e.disabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
              <button title={tr('删除这条任务')} disabled={busy} onClick={() => setAsk({ op: 'delete', e })} className={`${IB} hover:text-[var(--color-danger)]`}><Trash2 className="h-3.5 w-3.5" /></button>
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px]">
          <span className="shrink-0 text-[var(--color-accent)]">{e.schedule}</span>
          {e.user && <span className={`shrink-0 ${MUTED}`}>{tr('以 {user} 运行', { user: e.user })}</span>}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={e.command}>{e.command}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col" data-cron-drawer>
      {header}
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {flash && <div data-cron-flash className="shrink-0 break-all border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!list && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('读取中…') : ''}</div>}
        {list && groups.map(([src, es]) => (
          <div key={src}>
            <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-1 text-[11px] font-medium text-[var(--color-text-secondary)]">
              {cronSourceLabel(src, list.user)}
              <span className={`font-normal ${MUTED}`}>{src === 'user' ? tr('（可编辑）') : tr('（只读）')}</span>
              {src !== 'user' && <HelpTip>{tr('系统文件和 root 的 crontab 这里只读；要改请在终端里用 sudo 编辑。')}</HelpTip>}
            </div>
            {es.length ? es.map(row) : <div className={`px-3 py-2 text-[11.5px] ${MUTED}`}>{src === 'user' && list.userCrontab === undefined ? tr('当前用户还没有 crontab，点右上「新建」添加第一条。') : tr('（没有任务）')}</div>}
          </div>
        ))}
        {list?.rootDenied && <div className={`border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] ${MUTED}`}>{tr('读不到 root 的 crontab：需要 root 或免密 sudo。')}</div>}
        {list && (
          <div>
            <div className="sticky top-0 z-[1] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-3 py-1 text-[11px] font-medium text-[var(--color-text-secondary)]">{tr('systemd 定时器（timer）')}<span className={`font-normal ${MUTED}`}>{tr('（只读）')}</span></div>
            {list.noTimers && <div className={`px-3 py-2 text-[11.5px] ${MUTED}`}>{tr('这台主机没有 systemctl。')}</div>}
            {!list.noTimers && !list.timers.length && <div className={`px-3 py-2 text-[11.5px] ${MUTED}`}>{tr('（没有 timer）')}</div>}
            {list.timers.map((t) => (
              <div key={t.unit} data-timer={t.unit} className="border-b border-[var(--color-border-subtle)] px-3 py-1.5 hover:bg-[var(--color-bg-hover)]">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text-primary)]" title={[t.calendar, t.monotonic].filter(Boolean).join('\n')}>
                    {t.calendar ? describeCalendar(t.calendar) : t.monotonic ? describeMonotonic(t.monotonic) : t.unit}
                  </span>
                  <span className={`shrink-0 text-[10.5px] ${MUTED}`} title={`${tr('下次：{t}', { t: t.next ?? '—' })}\n${tr('上次：{t}', { t: t.last ?? '—' })}`}>{t.next ? `${tr('下次 {t}', { t: t.next.replace(/^\w{3} \d{4}-/, '').replace(/:\d\d( \S+)?$/, '') })}${t.left ? tr(' · {t}后', { t: t.left.replace(/ left$/, '') }) : ''}` : tr('未排期')}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px]">
                  <span className="shrink-0 text-[var(--color-accent)]">{t.unit}</span>
                  <span className={MUTED}>→</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">{t.activates}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {newOpen && list && <CronNewDialog termId={tid} user={list.user} now={now} tz={list.tzOffsetMin} busy={busy} paused={!!ask}
        onCancel={() => setNewOpen(false)} onSubmit={(g) => setAsk({ op: 'add', ...g })} />}
      <ConfirmDialog open={!!ask}
        title={ask ? `${prod ? tr('生产主机：') : ''}${tr('{op}定时任务', { op: tr(OP_TEXT[ask.op]) })}` : ''}
        message={ask ? tr('将修改「{host}」上 {user} 的 crontab。写入前先把原 crontab 备份到 ~/.lingshell/backups，操作记入执行记录。', { host: term?.title ?? '', user: list?.user || tr('当前用户') }) : ''}
        confirmText={ask ? `${prod ? tr('生产主机 · ') : ''}${tr(OP_TEXT[ask.op])}` : ''}
        onConfirm={doIt} onCancel={() => setAsk(undefined)}>
        {ask && (
          <div className="space-y-2" data-cron-confirm>
            {prod && <div className={`flex items-center gap-1.5 ${DANGER_BOX}`}><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('这是生产主机！定时任务会在无人值守时自动运行，请确认命令无误。')}</div>}
            <div className="rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11.5px] text-[var(--color-text-primary)] break-all">{ask.op === 'add' ? `${ask.schedule} ${ask.command}` : ask.e.raw}</div>
            <div className="text-[11.5px] text-[var(--color-text-secondary)]">{describeCron(ask.op === 'add' ? ask.schedule : ask.e.schedule)}</div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}

// 新建：一句话 →「AI 生成」得到表达式 + 命令 + 说明（也可直接手填），下方实时预览人话和下次运行时间；提交后由外层再确认一次
function CronNewDialog({ termId, user, now, tz, busy, paused, onCancel, onSubmit }: {
  termId: string; user: string; now: number; tz: number; busy: boolean; paused: boolean
  onCancel: () => void; onSubmit: (g: { schedule: string; command: string; note: string }) => void
}) {
  const [desc, setDesc] = useState('')
  const [schedule, setSchedule] = useState('')
  const [command, setCommand] = useState('')
  const [noteText, setNoteText] = useState('')
  const [gen, setGen] = useState(false)
  const [err, setErr] = useState('')
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  useEffect(() => {
    // 输入法组字时按 Esc 是取消候选，不能把整个新建框关掉、把已填内容丢掉
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !pausedRef.current) { e.preventDefault(); e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const generate = () => {
    if (!desc.trim() || gen) return
    setGen(true); setErr('')
    client.cron.generate(termId, desc).then((g) => { setSchedule(g.schedule); setCommand(g.command); setNoteText(g.explain) })
      .catch((e) => setErr(errText(e))).finally(() => setGen(false))
  }
  const valid = isCronExpr(schedule)
  const next = valid ? cronNextRun(schedule, now, tz) : undefined
  const danger = command.trim() && dangerCheck(command) === 'dangerous'
  const can = valid && !!command.trim() && !/[\r\n]/.test(command) && !busy

  return createPortal((
    <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-cron-new-dialog className="w-[560px] max-w-[94vw] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <CalendarClock className="h-4 w-4 text-[var(--color-accent)]" />{tr('新建定时任务')}
          <span className={`text-[11px] font-normal ${MUTED}`}>{tr('（写入 {user} 的 crontab）', { user: user || tr('当前用户') })}</span>
          <button onClick={onCancel} title={tr('关闭（Esc）')} className={`${IB} ml-auto`}><X className="h-3.5 w-3.5" /></button>
        </div>
        <div className="space-y-1">
          <div className="text-[11.5px] text-[var(--color-text-secondary)]">{tr('用一句话描述要定时做什么')}</div>
          <Textarea data-cron-desc rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tr('如：每天凌晨 3 点清理 /tmp 下 7 天前的文件')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate() } }} />
          <div className="flex items-center gap-2">
            <button data-cron-gen onClick={generate} disabled={!desc.trim() || gen} className={PRIMARY}>{gen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{tr('AI 生成')}</button>
            <span className={`text-[10.5px] ${MUTED}`}>{tr('Ctrl+Enter 生成 · 生成后可再改；也可以直接在下面手填')}</span>
          </div>
          {err && <div className="whitespace-pre-wrap text-[11.5px] text-[var(--color-danger)]">{err}</div>}
        </div>
        <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1.5 text-[11.5px]">
          <span className="text-[var(--color-text-secondary)]">{tr('时间')}</span>
          <Input data-cron-schedule size="sm" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={tr('分 时 日 月 周，如 0 3 * * *，或 @daily')} className="font-mono" />
          <span className="text-[var(--color-text-secondary)]">{tr('命令')}</span>
          <Input data-cron-command size="sm" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={tr('一行命令，建议写绝对路径')} className="font-mono" />
          <span className="text-[var(--color-text-secondary)]">{tr('说明')}</span>
          <Input size="sm" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder={tr('可选：写成任务上方的一行 # 注释')} />
        </div>
        <div data-cron-preview className="mt-3 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-2 text-[12px]">
          {!schedule.trim() ? <span className={MUTED}>{tr('填好时间后这里显示人话和下次运行时间')}</span>
            : !valid ? <span className="text-[var(--color-danger)]">{tr('时间表达式不合法（要 5 段：分 时 日 月 周，或 @daily 等）')}</span>
              : <>
                <span className="font-medium text-[var(--color-text-primary)]">{describeCron(schedule)}</span>
                <span className={`ml-2 text-[11px] ${MUTED}`}>{next !== undefined ? tr('下次 {at}（{in}，主机时间）', { at: fmtHostTime(next, tz, now), in: fmtIn(next, now) }) : tr('开机时运行')}</span>
              </>}
        </div>
        {danger && <div className={`mt-2 flex items-center gap-1.5 ${DANGER_BOX}`}><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('命令里有危险操作（如 rm -rf、mkfs），请逐字确认。')}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button data-cron-submit disabled={!can} onClick={() => onSubmit({ schedule: schedule.trim(), command: command.trim(), note: noteText.trim() })}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">{tr('添加到 crontab…')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}
