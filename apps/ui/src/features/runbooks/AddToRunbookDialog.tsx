import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookPlus, X } from 'lucide-react'
import { appendRunbookStep, tr, type Runbook, type RunbookInput } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { RunbookEditor } from './RunbookEditor.js'
import { Select } from '../../components/ui/Select.js'

// 终端命令点菜单「加入运维手册」：选已有手册（追加到末尾）或新建，下面即是完整编辑器，确认后保存。
// Portal 挂 body：终端区有 overflow-hidden / transform，fixed 会被困住
export function AddToRunbookDialog({ command, onClose }: { command: string; onClose: () => void }) {
  const [list, setList] = useState<Runbook[] | null>(null)
  const [pick, setPick] = useState('')   // '' = 新建
  const [form, setForm] = useState<RunbookInput>(() => appendRunbookStep(undefined, command))
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { client.runbooks.list().then(setList, () => setList([])) }, [])
  const choose = (id: string) => {
    setPick(id)
    const rb = list?.find((r) => r.id === id)
    setForm(appendRunbookStep(rb && { id: rb.id, name: rb.name, description: rb.description, params: rb.params, steps: rb.steps }, command))
  }
  const save = async () => {
    try { await client.runbooks.save(form); setSaved(true); setTimeout(onClose, 900) }
    catch (e) { setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[85vh] w-[640px] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 text-[13px] font-semibold text-[var(--color-text-primary)]">
          <BookPlus className="h-4 w-4 text-[var(--color-accent)]" />{tr('加入运维手册')}
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <span className="shrink-0">{tr('加到')}</span>
            <Select value={pick} onValueChange={choose} disabled={!list}
              options={[{ value: '', label: tr('新建手册') }, ...(list ?? []).map((r) => ({ value: r.id, label: tr('{name}（{n} 步）', { name: r.name, n: r.steps.length }) }))]} />
          </label>
          <RunbookEditor value={form} onChange={setForm} />
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          {err && <span className="text-[12px] text-[var(--color-danger)]">{err}</span>}
          {saved && <span className="text-[12px] text-[var(--color-success)]">{tr('已保存')}</span>}
          <button onClick={save} disabled={!form.name.trim() || saved}
            className="ml-auto rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">{tr('保存')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}
