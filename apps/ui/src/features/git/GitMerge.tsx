// 三方合并编辑器（同 IDEA 的 Merge 窗口思路）：冲突文件按冲突块列出「当前（HEAD）/ 基础 / 传入」三栏，
// 每块选 采用当前 / 采用传入 / 两者都要（两种顺序）/ 手动编辑；下面是合并结果（可以直接改）。
// 保存 = 写回文件；「保存并标记已解决」= 写回 + git add。结果里还有冲突标记时不让标记已解决
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, GitMerge as MergeIcon, Loader2, RotateCcw, X } from 'lucide-react'
import { hasConflictMarkers, mergeResult, parseConflicts, resolveChunk, tk, tr, type MergeChoice, type MergeChunk } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Textarea } from '../../components/ui/Input.js'
import { cn } from '../../lib/cn.js'
import { BTN, IB, errText, type GitCtx } from './gitUi.js'

type Conflict = Extract<MergeChunk, { kind: 'conflict' }>
const CHOICES: { k: Exclude<MergeChoice, { custom: string }>; label: string }[] = [
  { k: 'ours', label: tk('采用当前') }, { k: 'theirs', label: tk('采用传入') }, { k: 'both', label: tk('两者（当前在前）') }, { k: 'bothReverse', label: tk('两者（传入在前）') },
]
const sameChoice = (a?: MergeChoice, b?: MergeChoice) => (typeof a === 'object' || typeof b === 'object' ? false : a === b)

export function GitMerge({ ctx, path, onClose }: { ctx: GitCtx; path: string; onClose: () => void }) {
  const [file, setFile] = useState<{ text: string; size?: number; hash?: string; truncated: boolean; binary: boolean }>()
  const [err, setErr] = useState('')
  const [choices, setChoices] = useState<(MergeChoice | undefined)[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [manual, setManual] = useState<string | null>(null)   // 直接改了下面的结果：以它为准
  const [saving, setSaving] = useState(false)
  useEffect(() => { client.git.readFile(ctx.tid, ctx.root, path).then(setFile).catch((e) => setErr(errText(e))) }, [ctx.tid, ctx.root, path])
  const text = file?.text
  const blocked = !!file && (file.truncated || file.binary)
  const blockReason = file?.binary ? tr('这是二进制文件，合并编辑器无法安全写回（会损坏内容）。请在终端里用 git checkout --ours / --theirs 选择一边后 git add。')
    : file?.truncated ? tr('文件超过 3MB（{size}MB），只读取了前 3MB；保存会截断文件。请在终端里用 git checkout --ours / --theirs 选择一边后 git add。', { size: Math.round((file.size ?? 0) / 1024 / 1024 * 10) / 10 }) : ''
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const chunks = useMemo(() => (text === undefined ? [] : parseConflicts(text)), [text])
  const conflicts = useMemo(() => chunks.filter((c): c is Conflict => c.kind === 'conflict'), [chunks])
  const generated = useMemo(() => mergeResult(chunks, choices), [chunks, choices])
  const result = manual ?? generated
  const left = conflicts.length - choices.filter((c) => c !== undefined).length
  const markers = hasConflictMarkers(result)
  const choose = (i: number, c: MergeChoice | undefined) => { setManual(null); setChoices((cs) => { const n = [...cs]; n.length = conflicts.length; n[i] = c; return n }) }
  const all = (c: MergeChoice) => { setManual(null); setChoices(conflicts.map(() => c)) }
  const save = (add: boolean) => {
    if (blocked) return
    setSaving(true)
    void ctx.run({ op: 'resolveFile', path, add, ...(file?.hash ? { expectedHash: file.hash } : {}) }, { message: result, done: add ? tr('已解决 {path}', { path }) : tr('已保存 {path}', { path }) }).then((ok) => { setSaving(false); if (ok) onClose() })
  }
  const label = (s: string, fallback: string) => (s ? tr('{name}（{label}）', { name: fallback, label: s }) : fallback)

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-merge className="flex h-[92vh] w-[min(1400px,96vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <MergeIcon className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('解决冲突')}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-[var(--color-text-secondary)]">{path}</span>
          {text !== undefined && <span data-git-merge-left className={cn('shrink-0 text-[11.5px]', left ? 'text-[var(--color-warn)]' : 'text-[var(--color-success)]')}>{conflicts.length ? (left ? tr('{n} 处冲突，还有 {left} 处没选', { n: conflicts.length, left }) : tr('{n} 处冲突都已选择', { n: conflicts.length })) : tr('没有冲突标记')}</span>}
          <span className="ml-auto" />
          {conflicts.length > 1 && <>
            <button onClick={() => all('ours')} className={BTN}>{tr('全部采用当前')}</button>
            <button onClick={() => all('theirs')} className={BTN}>{tr('全部采用传入')}</button>
          </>}
          <button onClick={onClose} title={tr('关闭（Esc）')} className={IB}><X className="h-4 w-4" /></button>
        </div>
        {err && <div className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        {blocked && <div data-git-merge-blocked className="border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-warn)]">{blockReason}</div>}
        {text === undefined && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {text !== undefined && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-[3] space-y-3 overflow-y-auto p-3">
              {!conflicts.length && <div className="text-[12px] text-[var(--color-text-muted)]">{tr('文件里已经没有冲突标记了。确认内容没问题后点「保存并标记已解决」（等于 git add）。')}</div>}
              {conflicts.map((c, i) => {
                const ch = choices[i], hasBase = c.base !== undefined
                return (
                  <div key={i} data-git-conflict={i} className={cn('rounded-md border', ch === undefined ? 'border-[color:color-mix(in_srgb,var(--color-warn)_60%,transparent)]' : 'border-[var(--color-border-subtle)]')}>
                    <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-2.5 py-1.5">
                      <span className="mr-1 text-[11.5px] font-medium text-[var(--color-text-secondary)]">{tr('冲突 {n}', { n: i + 1 })}</span>
                      {CHOICES.map((x) => (
                        <button key={x.k} data-git-choose={x.k} onClick={() => choose(i, x.k)} className={cn(BTN, sameChoice(ch, x.k) && 'border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]')}>{sameChoice(ch, x.k) && <Check className="h-3 w-3" />}{tr(x.label)}</button>
                      ))}
                      {hasBase && <button onClick={() => choose(i, 'base')} className={cn(BTN, sameChoice(ch, 'base') && 'border-[var(--color-accent)] text-[var(--color-accent)]')}>{tr('采用基础')}</button>}
                      <button onClick={() => { setEditing(i); choose(i, { custom: ch === undefined ? c.ours : resolveChunk(c, ch) }) }} className={cn(BTN, typeof ch === 'object' && 'border-[var(--color-accent)] text-[var(--color-accent)]')}>{tr('手动编辑')}</button>
                      {ch !== undefined && <button title={tr('撤销这个选择')} onClick={() => choose(i, undefined)} className={cn(IB, 'h-5 w-5')}><RotateCcw className="h-3 w-3" /></button>}
                    </div>
                    <div className={cn('grid gap-px bg-[var(--color-border-subtle)]', hasBase ? 'grid-cols-3' : 'grid-cols-2')}>
                      <Side title={label(c.oursLabel, tr('当前'))} text={c.ours} tone="var(--color-accent)" />
                      {hasBase && <Side title={tr('基础（共同祖先）')} text={c.base ?? ''} tone="var(--color-text-muted)" />}
                      <Side title={label(c.theirsLabel, tr('传入'))} text={c.theirs} tone="var(--color-warn)" />
                    </div>
                    {typeof ch === 'object' && editing === i && (
                      <div className="border-t border-[var(--color-border-subtle)] p-2">
                        <Textarea rows={Math.min(12, Math.max(3, ch.custom.split('\n').length))} value={ch.custom} onChange={(e) => choose(i, { custom: e.target.value })} className="font-mono text-[11.5px]" data-git-custom />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex min-h-0 flex-[2] flex-col border-t border-[var(--color-border-default)]">
              <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text-secondary)]">{tr('合并结果')}</span>
                <span>{manual !== null ? tr('已手动修改（上面的选择不再自动套用）') : tr('按上面的选择生成，也可以直接改')}</span>
                {manual !== null && <button onClick={() => setManual(null)} className={BTN}><RotateCcw className="h-3 w-3" />{tr('按选择重新生成')}</button>}
                {markers && <span className="flex items-center gap-1 text-[var(--color-warn)]"><AlertTriangle className="h-3 w-3" />{tr('结果里还有冲突标记')}</span>}
              </div>
              <textarea data-git-merge-result value={result} onChange={(e) => setManual(e.target.value)} spellCheck={false}
                className="min-h-0 flex-1 resize-none border-0 bg-[var(--color-bg-base)] px-3 py-2 font-mono text-[11.5px] leading-[18px] text-[var(--color-text-primary)] outline-none" />
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] px-3 py-2">
                <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">{tr('写回工作区文件；「标记已解决」同时 git add。都记执行记录')}</span>
                <button onClick={onClose} className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
                <button data-git-merge-save disabled={saving || blocked} onClick={() => save(false)} className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">{tr('只保存')}</button>
                <button data-git-merge-resolve disabled={saving || markers || blocked} title={blocked ? blockReason : markers ? tr('结果里还有冲突标记，先选完或手动删掉') : ''} onClick={() => save(true)}
                  className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{tr('保存并标记已解决')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  ), document.body)
}

function Side({ title, text, tone }: { title: string; text: string; tone: string }) {
  return (
    <div className="min-w-0 bg-[var(--color-bg-panel)]">
      <div className="truncate px-2.5 py-1 text-[10.5px] font-medium" style={{ color: tone }}>{title}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre px-2.5 pb-2 font-mono text-[11.5px] leading-[18px] text-[var(--color-text-primary)]">{text.replace(/\r?\n$/, '') || <span className="italic text-[var(--color-text-muted)]">{tr('（空）')}</span>}</pre>
    </div>
  )
}
