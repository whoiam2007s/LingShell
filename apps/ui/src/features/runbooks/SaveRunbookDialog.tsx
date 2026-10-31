import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BookPlus, X, Sparkles } from 'lucide-react'
import { auditToSteps, runbookFromAuditPrompt, tr, type AuditEntry, type RunbookInput } from '@lingshell/shared'
import { sendToChat } from '../../lib/sendToChat.js'
import { client } from '../../client/index.js'
import { RunbookEditor } from './RunbookEditor.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

// 执行记录 →「保存为手册」：先勾要保留的成功命令，再编辑标题/命令/检查↔改动/参数，保存。
// Portal 挂 body：在抽屉里渲染时抽屉的 transform 会把 fixed 困住
export function SaveRunbookDialog({ entries, onClose }: { entries: AuditEntry[]; onClose: () => void }) {
  const [steps] = useState(() => auditToSteps(entries))
  const [picked, setPicked] = useState<boolean[]>(() => steps.map(() => true))
  const [form, setForm] = useState<RunbookInput | null>(null)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const next = () => setForm({ name: '', description: '', params: [], steps: steps.filter((_, i) => picked[i]) })
  const save = async () => {
    if (!form) return
    try { await client.runbooks.save(form); setSaved(true); setTimeout(onClose, 900) }
    catch (e) { setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      {/* 点遮罩不关：编辑到一半误点会丢 */}
      <div className="flex max-h-[85vh] w-[640px] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 text-[13px] font-semibold text-[var(--color-text-primary)]">
          <BookPlus className="h-4 w-4 text-[var(--color-accent)]" />{tr('保存为运维手册')}
          <span className="text-[11.5px] font-normal text-[var(--color-text-muted)]">{form ? tr('编辑步骤与参数') : tr('勾选要保留的命令（仅执行成功的）')}</span>
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {form ? <RunbookEditor value={form} onChange={setForm} /> : steps.length === 0 ? (
            <div className="text-[12px] text-[var(--color-text-muted)]">{tr('本会话还没有执行成功的命令')}</div>
          ) : (
            <div className="space-y-1">
              {steps.map((s, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-[var(--color-bg-hover)]">
                  <Checkbox checked={picked[i]} onCheckedChange={(v) => setPicked(picked.map((p, j) => (j === i ? v : p)))} className="mt-0.5" />
                  <span className={`shrink-0 rounded px-1 text-[10.5px] ${s.kind === 'change' ? 'bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] text-[var(--color-warn)]' : 'bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]'}`}>{s.kind === 'change' ? tr('runbook|改动') : tr('runbook|检查')}</span>
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11.5px] text-[var(--color-text-secondary)]">{s.command}</pre>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          {err && <span className="text-[12px] text-[var(--color-danger)]">{err}</span>}
          {saved && <span className="text-[12px] text-[var(--color-success)]">{tr('已保存，可在输入框旁「运维手册」运行')}</span>}
          {form && <button onClick={() => setForm(null)} className="ml-auto rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('上一步')}</button>}
          {/* 交给 AI 整理：起标题、提参数、分检查 / 改动，AI 调 propose_runbook 在对话里出可编辑的预览卡 */}
          {!form && <button data-runbook-ai-organize onClick={() => { sendToChat(runbookFromAuditPrompt(steps.filter((_, i) => picked[i]).map((s) => s.command!))); onClose() }} disabled={!picked.some(Boolean)}
            title={tr('把勾选的命令发给 AI，由它起标题、把主机 / 路径等提成参数，在对话里出可编辑的手册预览卡，确认后保存')}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"><Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('让 AI 整理成手册')}</button>}
          <button onClick={form ? save : next} disabled={form ? !form.name.trim() || saved : !picked.some(Boolean)}
            className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
            {form ? tr('保存') : tr('下一步')}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}
