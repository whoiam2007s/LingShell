// Git 面板各页共用：样式、执行写操作的上下文、确认 / 输入弹窗、行内「⋯」菜单
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, MoreHorizontal } from 'lucide-react'
import { dateLocale, tr, type GitOp, type GitStatus, type TerminalInfo } from '@lingshell/shared'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Input, Textarea } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { cn } from '../../lib/cn.js'

export const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
export const BTN = 'flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
export const CODE_CLS: Record<string, string> = { M: 'text-[var(--color-warn)]', A: 'text-[var(--color-success)]', D: 'text-[var(--color-danger)]', R: 'text-[var(--color-accent)]', C: 'text-[var(--color-accent)]', U: 'text-[var(--color-danger)]', '?': 'text-[var(--color-text-muted)]' }
export const shortDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(dateLocale(), { hour12: false, year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }

/** 各页拿到的上下文：当前仓库、状态，以及统一的写操作入口（确认、忙碌、报错、刷新都在这里） */
export interface GitCtx {
  tid: string
  term: TerminalInfo
  root: string
  st: GitStatus
  /** 执行写操作。confirm 给了就先弹确认；返回是否成功 */
  run(o: GitOp, opt?: { confirm?: { title: string; text: string; danger?: boolean; ok?: string }; message?: string; done?: string }): Promise<boolean>
  busy: string
  /** 写操作后递增：各页据此重新读取 */
  version: number
  ask(d: DialogSpec): void
  /** 逐行追溯（rev 不给 = 工作区）/ 三方合并编辑器 */
  openBlame(path: string, rev?: string): void
  openMerge(path: string): void
  /** 比较两个版本（b 不给 = 工作区），path：打开后先看这个文件 */
  openCompare(a: string, b?: string, path?: string): void
  openChangelog(from?: string): void
  openReview(paths?: string[]): void
  /** 整理提交（交互式变基）：从这个提交（含）到 HEAD */
  openRebase(from: string): void   // paths：只审查勾选的已暂存文件
}

export interface DialogSpec {
  title: string
  text?: string
  danger?: boolean
  ok?: string
  fields?: { key: string; label: string; value?: string; options?: { value: string; label: string }[]; placeholder?: string; multiline?: boolean; required?: boolean; validate?: (v: string) => string | undefined }[]
  checks?: { key: string; label: string; value?: boolean }[]
  onOk(values: Record<string, string>, checks: Record<string, boolean>): void
  /** 取消 / Esc / 点外面：确认框用它在用户放弃时把等待中的 Promise 结束掉（否则按钮一直转圈） */
  onCancel?(): void
}

export function GitDialog({ spec, prod, onClose, onCancel = onClose }: { spec: DialogSpec; prod: boolean; onClose: () => void; onCancel?: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((spec.fields ?? []).map((f) => [f.key, f.value ?? ''])))
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries((spec.checks ?? []).map((c) => [c.key, !!c.value])))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const errs = (spec.fields ?? []).map((f) => (f.required && !vals[f.key]?.trim() ? tr('必填') : f.validate?.(vals[f.key] ?? '')))
  const bad = errs.some(Boolean)
  const ok = () => { if (!bad) { onClose(); spec.onOk(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim()])), checks) } }
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-dialog className="w-[440px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          {spec.danger && <AlertTriangle className="h-4 w-4 text-[var(--color-danger)]" />}{spec.title}
        </div>
        {(spec.text || (prod && spec.danger)) && <p className="mb-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">{prod && spec.danger && <b className="text-[var(--color-danger)]">{tr('这是生产主机！')}</b>}{spec.text}</p>}
        <div className="space-y-2">
          {(spec.fields ?? []).map((f, i) => (
            <label key={f.key} className="block text-[12px] text-[var(--color-text-secondary)]">
              <span className="mb-1 block">{f.label}{errs[i] && vals[f.key] !== '' && <span className="ml-2 text-[var(--color-danger)]">{errs[i]}</span>}</span>
              {f.options
                ? <Select size="sm" value={vals[f.key]} onValueChange={(v) => setVals({ ...vals, [f.key]: v })} options={f.options} aria-label={f.label} />
                : f.multiline
                ? <Textarea rows={3} value={vals[f.key]} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} className="font-mono text-[12px]" />
                : <Input size="sm" autoFocus={i === 0} value={vals[f.key]} placeholder={f.placeholder} data-git-field={f.key} className="font-mono"
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') ok() }} />}
            </label>
          ))}
          {(spec.checks ?? []).map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
              <Checkbox checked={checks[c.key]} onCheckedChange={(v) => setChecks({ ...checks, [c.key]: v })} />{c.label}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button data-git-dialog-ok disabled={bad} onClick={ok} className={cn('rounded-md border border-transparent px-4 py-1.5 text-[12.5px] font-medium hover:opacity-90 disabled:opacity-40', spec.danger ? 'bg-[var(--color-danger)] text-[var(--color-on-danger)]' : 'bg-[var(--color-accent)] text-[var(--color-bg-base)]')}>{spec.ok ?? tr('确定')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}

export const refNameError = (v: string) => (!v ? undefined : /[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(v) ? tr('名称里不能有空格和 ~ ^ : ? * [ \\ ..，不能以 - / . 开头') : undefined)

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; sep?: boolean }
/** 行内「⋯」菜单：点外面 / Esc 关闭 */
export function RowMenu({ items, title, icon, btnClass, disabled }: { items: MenuItem[]; title?: string; icon?: React.ReactNode; btnClass?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', down); window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button title={title ?? tr('更多操作')} disabled={disabled} onClick={() => setOpen(!open)} className={btnClass ?? cn(IB, 'h-5 w-5')}>{icon ?? <MoreHorizontal className="h-3.5 w-3.5" />}</button>
      {open && (
        <div data-git-menu className="absolute right-0 top-6 z-30 min-w-[150px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] py-1 shadow-xl">
          {items.map((it, i) => it.sep ? <div key={i} className="my-1 border-t border-[var(--color-border-subtle)]" /> : (
            <button key={i} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick() }}
              className={cn('block w-full whitespace-nowrap px-3 py-1 text-left text-[12px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40', it.danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
