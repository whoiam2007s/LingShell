import { useEffect, useRef, useState } from 'react'
import { ClipboardList, Settings2, ArrowLeft } from 'lucide-react'
import { templateVars, fillTemplate, tr, type PromptTemplate } from '@lingshell/shared'
import { client } from '../../client/index.js'

// 输入框旁的「常用任务」：选模板 → 有占位符先填 → 填进输入框（不自动发送，留给用户确认/补充）
// preset：命令面板选中的模板（n 每次递增，同一模板再选也会触发）→ 无占位符直接填入，有则打开填参数
// hideTrigger：不显示自己的按钮，只经 preset 打开（输入框「+」菜单选了模板后交给这里填参数）
export function TemplatePicker({ disabled, onPick, onManage, preset, hideTrigger }: { disabled?: boolean; onPick: (text: string) => void; onManage?: () => void; preset?: { id: string; n: number }; hideTrigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<PromptTemplate[]>([])
  const [cur, setCur] = useState<PromptTemplate | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    client.templates.list().then(setList).catch(() => {})
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const done = (text: string) => { onPick(text); setOpen(false); setCur(null) }
  const choose = (t: PromptTemplate) => {
    if (!templateVars(t.prompt).length) return done(t.prompt)
    setValues({}); setCur(t)
  }
  const vars = cur ? templateVars(cur.prompt) : []
  useEffect(() => {
    if (!preset || disabled) return
    client.templates.list().then((l) => {
      setList(l)
      const t = l.find((x) => x.id === preset.id)
      if (t) { setOpen(true); choose(t) }
    }).catch(() => {})
  }, [preset?.n])

  return (
    <div ref={ref} className="relative shrink-0">
      {!hideTrigger && <button onClick={() => { setOpen((o) => !o); setCur(null) }} disabled={disabled} title={tr('常用任务')}
        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30">
        <ClipboardList className="h-4 w-4" />
      </button>}
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[300px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl animate-fade-in">
          {cur ? (
            <form className="space-y-2 p-1.5" onSubmit={(e) => { e.preventDefault(); done(fillTemplate(cur.prompt, values)) }}>
              <button type="button" onClick={() => setCur(null)} className="flex items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><ArrowLeft className="h-3 w-3" />{cur.name}</button>
              {vars.map((v, i) => (
                <label key={v} className="block text-[11.5px] text-[var(--color-text-secondary)]">{v}
                  <input autoFocus={i === 0} value={values[v] ?? ''} onChange={(e) => setValues({ ...values, [v]: e.target.value })}
                    className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 text-[12.5px] text-[var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]" />
                </label>
              ))}
              <button type="submit" className="w-full rounded-md bg-[var(--color-accent)] py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]">{tr('填入输入框')}</button>
            </form>
          ) : (
            <>
              <div className="max-h-[260px] overflow-y-auto">
                {list.length === 0 && <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{tr('暂无模板')}</div>}
                {list.map((t) => (
                  <button key={t.id} onClick={() => choose(t)} title={t.prompt}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-hover)]">
                    <span className="text-[12.5px] text-[var(--color-text-primary)]">{t.name}</span>
                    <span className="truncate text-[11px] text-[var(--color-text-muted)]">{t.prompt}</span>
                  </button>
                ))}
              </div>
              {onManage && (
                <button onClick={() => { setOpen(false); onManage() }}
                  className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2.5 pb-1 pt-2 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
                  <Settings2 className="h-3.5 w-3.5" />{tr('管理模板…')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
