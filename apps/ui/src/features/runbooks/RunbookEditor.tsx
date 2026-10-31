import { useState } from 'react'
import { ArrowUp, ArrowDown, Trash2, Plus, Wand2 } from 'lucide-react'
import { suggestParamValues, parameterize, tr, type RunbookInput, type RunbookStep } from '@lingshell/shared'

export const inpCls = 'w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 text-[12.5px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
const iconBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30'
const linkBtn = 'flex items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]'

export const emptyRunbook = (): RunbookInput => ({ name: '', description: '', params: [], steps: [{ title: '', kind: 'check' }] })

// 手册编辑（受控）：名称/说明、参数、步骤（排序/增删/检查↔改动）、把命令里的值一键换成 {{参数}}
export function RunbookEditor({ value, onChange }: { value: RunbookInput; onChange: (v: RunbookInput) => void }) {
  const set = (patch: Partial<RunbookInput>) => onChange({ ...value, ...patch })
  const setStep = (i: number, patch: Partial<RunbookStep>) => set({ steps: value.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const move = (i: number, d: number) => {
    const steps = [...value.steps]
    ;[steps[i], steps[i + d]] = [steps[i + d], steps[i]]
    set({ steps })
  }
  // 参数化：选一个值（建议或手填）+ 起个名 → 全部替换
  const [pv, setPv] = useState<{ value: string; name: string } | null>(null)
  const suggestions = suggestParamValues(value.steps).filter((v) => !value.params.some((p) => p.default === v)).slice(0, 8)
  const applyParam = () => {
    if (!pv?.value || !pv.name.trim()) return
    onChange({ ...value, ...parameterize(value, pv.value, pv.name) })
    setPv(null)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <input value={value.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('手册名称，如：nginx 502 排查')} className={inpCls} />
        <input value={value.description} onChange={(e) => set({ description: e.target.value })} placeholder={tr('说明：什么时候用（可选）')} className={inpCls} />
      </div>

      <section>
        <div className="mb-1 flex items-center gap-3 text-[12px] text-[var(--color-text-secondary)]">
          {tr('runbook|参数')}
          <button onClick={() => set({ params: [...value.params, { name: '', label: '' }] })} className={linkBtn}><Plus className="h-3 w-3" />{tr('添加')}</button>
          <button onClick={() => setPv(pv ? null : { value: '', name: '' })} className={linkBtn}><Wand2 className="h-3 w-3" />{tr('把命令里的值换成参数')}</button>
        </div>
        {pv && (
          <div className="mb-1.5 space-y-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] p-2">
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {suggestions.map((v) => (
                  <button key={v} onClick={() => setPv({ ...pv, value: v })}
                    className={`max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[11px] ${pv.value === v ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_20%,transparent)] text-[var(--color-accent)]' : 'bg-[var(--color-bg-base)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]'}`}>{v}</button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input value={pv.value} onChange={(e) => setPv({ ...pv, value: e.target.value })} placeholder={tr('要替换的值（主机/IP/路径…）')} className={`${inpCls} font-mono`} />
              <input value={pv.name} onChange={(e) => setPv({ ...pv, name: e.target.value })} placeholder={tr('参数名，如 主机')} className={`${inpCls} w-32 shrink-0`}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyParam() }} />
              <button onClick={applyParam} disabled={!pv.value || !pv.name.trim() || /[{}]/.test(pv.name)}
                className="shrink-0 rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 text-[12px] text-[var(--color-bg-base)] disabled:opacity-40">{tr('替换')}</button>
            </div>
          </div>
        )}
        {value.params.length === 0 && !pv && <div className="text-[11px] text-[var(--color-text-muted)]">{tr('命令里写 {ph} 即为参数，运行时填写', { ph: `{{${tr('param|名字')}}}` })}</div>}
        <div className="space-y-1">
          {value.params.map((p, i) => (
            <div key={i} className="flex gap-1.5">
              <input value={p.name} onChange={(e) => set({ params: value.params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder={tr('参数名')} className={`${inpCls} font-mono`} />
              <input value={p.label} onChange={(e) => set({ params: value.params.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder={tr('显示名')} className={inpCls} />
              <input value={p.default ?? ''} onChange={(e) => set({ params: value.params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) })} placeholder={tr('默认值（可选）')} className={inpCls} />
              <button onClick={() => set({ params: value.params.filter((_, j) => j !== i) })} title={tr('删除参数')} className={iconBtn}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center gap-3 text-[12px] text-[var(--color-text-secondary)]">
          {tr('步骤')}
          <button onClick={() => set({ steps: [...value.steps, { title: '', kind: 'check' }] })} className={linkBtn}><Plus className="h-3 w-3" />{tr('添加')}</button>
        </div>
        <div className="space-y-1.5">
          {value.steps.map((s, i) => (
            <div key={i} className="space-y-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-1.5">
              <div className="flex items-center gap-1.5">
                <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-[var(--color-text-muted)]">{i + 1}</span>
                <button onClick={() => setStep(i, { kind: s.kind === 'check' ? 'change' : 'check' })} title={tr('点击切换：检查=直接执行；改动=先经计划批准')}
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] ${s.kind === 'change' ? 'bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] text-[var(--color-warn)]' : 'bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]'}`}>
                  {s.kind === 'change' ? tr('runbook|改动') : tr('runbook|检查')}
                </button>
                <input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} placeholder={tr('步骤标题')} className={inpCls} />
                <button onClick={() => move(i, -1)} disabled={i === 0} title={tr('上移')} className={iconBtn}><ArrowUp className="h-3 w-3" /></button>
                <button onClick={() => move(i, 1)} disabled={i === value.steps.length - 1} title={tr('下移')} className={iconBtn}><ArrowDown className="h-3 w-3" /></button>
                <button onClick={() => set({ steps: value.steps.filter((_, j) => j !== i) })} disabled={value.steps.length <= 1} title={tr('删除步骤')} className={iconBtn}><Trash2 className="h-3 w-3" /></button>
              </div>
              <div className="space-y-1 pl-5">
                <textarea value={s.command ?? ''} onChange={(e) => setStep(i, { command: e.target.value })} rows={1} placeholder={tr('命令（可选，可含 {ph}）', { ph: `{{${tr('param|参数')}}}` })}
                  className={`${inpCls} resize-y font-mono text-[11.5px]`} />
                <input value={s.expect ?? ''} onChange={(e) => setStep(i, { expect: e.target.value })} placeholder={tr('预期结果：成功时应看到什么 / 要检查什么（可选）')} className={inpCls} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
