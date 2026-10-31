import { useEffect, useRef, useState } from 'react'
import { BookOpen, Settings2, ArrowLeft } from 'lucide-react'
import { buildRunbookPrompt, runbookMissing, tr, type Runbook, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { inpCls } from './RunbookEditor.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

// 输入框旁的「运维手册」：选手册 → 填参数 + 勾目标终端 → 直接发给 AI 按步骤执行
// preset：命令面板选中的手册（n 每次递增）→ 直接打开它的填参数 / 选终端表单
// hideTrigger：不显示自己的按钮，只经 preset 打开（输入框「+」菜单选了手册后交给这里填参数、选终端）
export function RunbookPicker({ disabled, onRun, onManage, preset, hideTrigger }: { disabled?: boolean; onRun: (prompt: string) => void; onManage?: () => void; preset?: { id: string; n: number }; hideTrigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Runbook[]>([])
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [cur, setCur] = useState<Runbook | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [targets, setTargets] = useState<string[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    client.runbooks.list().then(setList).catch(() => {})
    client.terminal.list().then(setTerms).catch(() => {})
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (r: Runbook, ts = terms) => {
    setValues({}); setCur(r)
    // 只有一个可用终端时默认勾上
    const live = ts.filter((t) => t.status === 'running')
    setTargets(live.length === 1 ? [live[0].id] : [])
  }
  useEffect(() => {
    if (!preset || disabled) return
    Promise.all([client.runbooks.list(), client.terminal.list()]).then(([l, ts]) => {
      const r = l.find((x) => x.id === preset.id)
      if (!r) return
      setList(l); setTerms(ts); setOpen(true); choose(r, ts)
    }).catch(() => {})
  }, [preset?.n])
  const run = () => {
    if (!cur || !targets.length || runbookMissing(cur, values).length) return
    onRun(buildRunbookPrompt(cur, values, terms.filter((t) => targets.includes(t.id) && t.status === 'running')))
    setOpen(false); setCur(null)
  }

  return (
    <div ref={ref} className="relative shrink-0">
      {!hideTrigger && <button onClick={() => { setOpen((o) => !o); setCur(null) }} disabled={disabled} title={tr('运维手册')}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30">
        <BookOpen className="h-4 w-4" />
      </button>}
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[320px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl animate-fade-in">
          {cur ? (
            <form className="space-y-2 p-1.5" onSubmit={(e) => { e.preventDefault(); run() }}>
              <button type="button" onClick={() => setCur(null)} className="flex items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><ArrowLeft className="h-3 w-3" />{cur.name}<span className="text-[var(--color-text-muted)]">{tr('（{n} 步）', { n: cur.steps.length })}</span></button>
              {cur.params.map((p, i) => (
                <label key={p.name} className="block text-[11.5px] text-[var(--color-text-secondary)]">{p.label}
                  <input autoFocus={i === 0} value={values[p.name] ?? ''} placeholder={p.default} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} className={`mt-1 ${inpCls}`} />
                </label>
              ))}
              <div className="text-[11.5px] text-[var(--color-text-secondary)]">{tr('目标终端')}</div>
              {terms.length === 0 && <div className="text-[11px] text-[var(--color-text-muted)]">{tr('没有打开的终端，先在右侧开一个')}</div>}
              <div className="max-h-[140px] space-y-0.5 overflow-y-auto">
                {terms.map((t) => (
                  <label key={t.id} className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-[var(--color-text-primary)] ${t.status === 'running' ? 'cursor-pointer hover:bg-[var(--color-bg-hover)]' : 'opacity-60'}`}>
                    <Checkbox checked={targets.includes(t.id)} disabled={t.status !== 'running'}
                      onCheckedChange={(v) => setTargets(v ? [...targets, t.id] : targets.filter((x) => x !== t.id))} />
                    <span className="truncate">{t.title}</span>
                    {t.detail && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{t.detail}</span>}
                    {t.status !== 'running' && <span className="shrink-0 text-[10.5px] text-[var(--color-danger)]">{tr('已断开')}</span>}
                  </label>
                ))}
              </div>
              {(() => {
                const missing = cur ? runbookMissing(cur, values) : []
                const live = targets.filter((id) => terms.some((t) => t.id === id && t.status === 'running'))
                return <>
                  {missing.length > 0 && <div className="text-[11px] text-[var(--color-warn)]">{tr('还有参数没填：{list}', { list: missing.map((k) => `{{${k}}}`).join(tr('、')) })}</div>}
                  {targets.length > 0 && !live.length && <div className="text-[11px] text-[var(--color-danger)]">{tr('选中的终端都已断开，请换一台在线终端')}</div>}
                  <button type="submit" disabled={!live.length || missing.length > 0} className="w-full rounded-md bg-[var(--color-accent)] py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">{tr('发给 AI 执行')}</button>
                </>
              })()}
            </form>
          ) : (
            <>
              <div className="max-h-[260px] overflow-y-auto">
                {list.length === 0 && <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无手册，可在执行记录里「保存为手册」')}</div>}
                {list.map((r) => (
                  <button key={r.id} onClick={() => choose(r)} title={r.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-hover)]">
                    <span className="text-[12.5px] text-[var(--color-text-primary)]">{r.name}<span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('{n} 步', { n: r.steps.length })}</span></span>
                    {r.description && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{r.description}</span>}
                  </button>
                ))}
              </div>
              {onManage && (
                <button onClick={() => { setOpen(false); onManage() }}
                  className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2.5 pb-1 pt-2 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
                  <Settings2 className="h-3.5 w-3.5" />{tr('管理手册…')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
