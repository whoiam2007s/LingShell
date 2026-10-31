import { useState } from 'react'
import { BookPlus, Zap, Check, X, ExternalLink, Trash2, Plus } from 'lucide-react'
import { applyQuickProposal, normalizeQuickProposal, runbookFromProposal, tr, type QuickProposal, type RunbookInput } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { client } from '../../../client/index.js'
import { Input } from '../../../components/ui/Input.js'
import { RunbookEditor } from '../../runbooks/index.js'
import { openRunbookView } from '../../runbooks/index.js'
import { updateQuickCommands } from '../../terminals/index.js'

// AI 提议的快速命令 / 运维手册（工具 propose_quick_commands / propose_runbook）：按工具入参出可编辑预览卡，
// 「保存」才写入（同知识卡）。结果按工具调用 id 记在模块里：切会话会卸载卡片，回来不该又变成待处理
const done = new Map<string, { state: 'saved' | 'ignored'; id?: string }>()
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const BTN1 = 'flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
const BTN2 = 'flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]'

export function ProposalItem({ item }: { item: ConvItem }) {
  const name = item.tool?.name
  const key = item.tool?.toolId ?? item.itemId
  return name === 'propose_runbook' ? <RunbookProposal key={key} id={key} input={item.tool?.input} /> : <QuickProposalCard key={key} id={key} input={item.tool?.input} />
}

function Shell({ icon, title, extra, children }: { icon: React.ReactNode; title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="animate-fade-in px-3 py-1" data-proposal>
      <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)]">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          {icon}
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
          <span className="ml-auto truncate text-[11px] text-[var(--color-text-muted)]">{extra}</span>
        </div>
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">{children}</div>
      </div>
    </div>
  )
}

function Footer({ state, saving, error, onSave, onIgnore, savedText, view, canSave }: {
  state?: { state: 'saved' | 'ignored' }; saving: boolean; error: string; onSave: () => void; onIgnore: () => void; savedText: string; view?: React.ReactNode; canSave: boolean
}) {
  if (state) return (
    <div className="mt-2 flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]">
      {state.state === 'saved' ? <><Check className="h-3.5 w-3.5 text-[var(--color-success)]" />{savedText}{view}</> : <><X className="h-3.5 w-3.5" />{tr('已忽略')}</>}
    </div>
  )
  return (
    <>
      {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{tr('保存失败：{error}', { error })}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button data-proposal-save onClick={onSave} disabled={saving || !canSave} className={BTN1}><Check className="h-3.5 w-3.5" />{tr('保存')}</button>
        <button onClick={onIgnore} className={BTN2}><X className="h-3.5 w-3.5" />{tr('忽略')}</button>
        <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('可先修改再保存')}</span>
      </div>
    </>
  )
}

function RunbookProposal({ id, input }: { id: string; input: unknown }) {
  const [form, setForm] = useState<RunbookInput | string>(() => { try { return runbookFromProposal(input) } catch (e) { return errText(e) } })
  const [state, setState] = useState(done.get(id))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  if (typeof form === 'string') return null   // 入参不合法：工具本身已报错，工具卡上看得到
  const save = async () => {
    setSaving(true); setError('')
    try { const r = await client.runbooks.save(form); const s = { state: 'saved' as const, id: r.id }; done.set(id, s); setState(s) }
    catch (e) { setError(errText(e)) } finally { setSaving(false) }
  }
  const ignore = () => { const s = { state: 'ignored' as const }; done.set(id, s); setState(s) }
  return (
    <Shell icon={<BookPlus className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />} title={tr('AI 建议保存为运维手册')} extra={tr('{n} 步', { n: form.steps.length }) + (form.params.length ? ` · ${tr('{n} 个参数', { n: form.params.length })}` : '')}>
      {state ? <div className="text-[12px] font-medium text-[var(--color-text-primary)]">{form.name}</div> : <RunbookEditor value={form} onChange={setForm} />}
      <Footer state={state} saving={saving} error={error} onSave={save} onIgnore={ignore} canSave={!!form.name.trim()} savedText={tr('已保存到运维手册')}
        view={state?.id && <button onClick={() => openRunbookView(state.id)} className="ml-2 flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"><ExternalLink className="h-3 w-3" />{tr('打开手册视图')}</button>} />
    </Shell>
  )
}

function QuickProposalCard({ id, input }: { id: string; input: unknown }) {
  const [p, setP] = useState<QuickProposal | string>(() => { try { return normalizeQuickProposal(input) } catch (e) { return errText(e) } })
  const [state, setState] = useState(done.get(id))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  if (typeof p === 'string') return null
  const setCmd = (i: number, patch: Partial<QuickProposal['commands'][number]>) => setP({ ...p, commands: p.commands.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const save = async () => {
    setSaving(true); setError('')
    try {
      const clean = normalizeQuickProposal({ set_name: p.setName, commands: p.commands.map((c) => ({ name: c.label, command: c.command, description: c.description })) })
      await updateQuickCommands((d) => applyQuickProposal(d, clean).data)
      const s = { state: 'saved' as const }; done.set(id, s); setState(s)
    } catch (e) { setError(errText(e)) } finally { setSaving(false) }
  }
  const ignore = () => { const s = { state: 'ignored' as const }; done.set(id, s); setState(s) }
  return (
    <Shell icon={<Zap className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />} title={tr('AI 建议保存为快速命令')} extra={tr('cmd|{n} 条', { n: p.commands.length })}>
      {state ? (
        <div className="text-[12px] text-[var(--color-text-primary)]">{p.setName}<span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{p.commands.map((c) => c.label).join(tr('、'))}</span></div>
      ) : (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">{tr('命令组')}
            <Input size="sm" className="flex-1" value={p.setName} aria-label={tr('命令组名')} onChange={(e) => setP({ ...p, setName: e.target.value })} />
          </label>
          {p.commands.map((c, i) => (
            <div key={i} className="space-y-1 rounded-md border border-[var(--color-border-subtle)] p-1.5">
              <div className="flex items-center gap-1.5">
                <Input size="sm" className="w-36 shrink-0" value={c.label} placeholder={tr('名称')} aria-label={tr('名称')} onChange={(e) => setCmd(i, { label: e.target.value })} />
                <Input size="sm" className="min-w-0 flex-1 font-mono" value={c.command} placeholder={tr('命令')} aria-label={tr('命令')} onChange={(e) => setCmd(i, { command: e.target.value })} />
                <button onClick={() => setP({ ...p, commands: p.commands.filter((_, j) => j !== i) })} disabled={p.commands.length <= 1} title={tr('删除这条')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] disabled:opacity-30"><Trash2 className="h-3 w-3" /></button>
              </div>
              <Input size="sm" value={c.description ?? ''} placeholder={tr('说明（可选，悬停按钮时显示）')} aria-label={tr('说明')} onChange={(e) => setCmd(i, { description: e.target.value })} />
            </div>
          ))}
          <button onClick={() => setP({ ...p, commands: [...p.commands, { label: '', command: '' }] })} className="flex items-center gap-1 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><Plus className="h-3 w-3" />{tr('添加一条')}</button>
          <div className="text-[11px] text-[var(--color-text-muted)]">{tr('保存后在终端底部「快速命令」里；同名命令组已有时追加进去（相同命令不重复）')}</div>
        </div>
      )}
      <Footer state={state} saving={saving} error={error} onSave={save} onIgnore={ignore} savedText={tr('已保存到快速命令（终端底部）')}
        canSave={!!p.setName.trim() && p.commands.every((c) => c.label.trim() && c.command.trim())} />
    </Shell>
  )
}
