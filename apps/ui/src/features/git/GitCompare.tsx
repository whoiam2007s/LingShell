// 比较两个版本（分支 / 标签 / 提交），或某个版本和工作区：左边是改了哪些文件 + 两边各自独有的提交，右边是选中文件的 diff。
// 可以交换两边；点独有的提交跳到「历史」页
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, GitCompareArrows, Loader2, X } from 'lucide-react'
import { cleanGitDiff, tr, type GitCompareResult } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { DiffView } from '../../components/DiffView.js'
import { cn } from '../../lib/cn.js'
import { CODE_CLS, IB, errText, shortDate, type GitCtx } from './gitUi.js'

const label = (r?: string) => (!r ? tr('git|工作区') : /^[0-9a-f]{7,64}$/i.test(r) ? r.slice(0, 7) : r)

export function GitCompare({ ctx, a: a0, b: b0, path: p0, onClose, onShowCommit }: { ctx: GitCtx; a: string; b?: string; path?: string; onClose: () => void; onShowCommit: (hash: string) => void }) {
  const [ab, setAb] = useState<{ a: string; b?: string }>({ a: a0, b: b0 })
  const [res, setRes] = useState<GitCompareResult>()
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'files' | 'commits'>('files')
  const [file, setFile] = useState<{ path: string; text?: string; err?: string }>()
  useEffect(() => {
    setRes(undefined); setErr('')
    client.git.compare(ctx.tid, ctx.root, ab.a, ab.b).then((r) => { setRes(r); const p = p0 && r.files.some((f) => f.path === p0) ? p0 : r.files[0]?.path; if (p) show(p) }).catch((e) => setErr(errText(e)))
  }, [ab.a, ab.b])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const show = (path: string) => {
    setFile({ path })
    client.git.compareDiff(ctx.tid, ctx.root, ab.a, ab.b, path).then((t) => setFile({ path, text: cleanGitDiff(t) }), (e) => setFile({ path, err: errText(e) }))
  }
  const swap = () => { if (ab.b) setAb({ a: ab.b, b: ab.a }) }

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-compare className="flex h-[88vh] w-[min(1300px,95vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <GitCompareArrows className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('比较')}</span>
          <span className="rounded bg-[var(--color-bg-raised)] px-1.5 font-mono text-[11.5px] text-[var(--color-text-secondary)]" title={ab.a}>{label(ab.a)}</span>
          <button onClick={swap} disabled={!ab.b} title={ab.b ? tr('交换两边') : tr('和工作区比较时不能交换')} className={cn(IB, 'h-5 w-5')}><ArrowLeftRight className="h-3.5 w-3.5" /></button>
          <span className="rounded bg-[var(--color-bg-raised)] px-1.5 font-mono text-[11.5px] text-[var(--color-text-secondary)]" title={ab.b ?? tr('工作区（含未提交的改动）')}>{label(ab.b)}</span>
          {res && <span className="text-[11px] text-[var(--color-text-muted)]">{ab.b
            ? tr('{n} 个文件不同 · 左边独有 {a} 个提交 · 右边独有 {b} 个', { n: res.files.length, a: res.onlyA.length, b: res.onlyB.length })
            : tr('{n} 个文件不同', { n: res.files.length })}</span>}
          <button onClick={onClose} title={tr('关闭（Esc）')} className={cn(IB, 'ml-auto')}><X className="h-4 w-4" /></button>
        </div>
        {err && <div className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        {!res && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('比较中…')}</div>}
        {res && (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[340px] shrink-0 flex-col border-r border-[var(--color-border-subtle)]">
              {ab.b && (
                <div className="flex shrink-0 border-b border-[var(--color-border-subtle)] px-2">
                  {([['files', tr('文件 {n}', { n: res.files.length })], ['commits', tr('提交 {n}', { n: res.onlyA.length + res.onlyB.length })]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-2.5 py-1.5 text-[11.5px]', tab === k ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)]')}>{l}</button>
                  ))}
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {tab === 'files' || !ab.b ? (
                  res.files.length === 0 ? <div className="p-2 text-[12px] text-[var(--color-text-muted)]">{tr('两边内容完全一样')}</div> : res.files.map((f) => (
                    <button key={f.path} data-git-compare-file={f.path} onClick={() => show(f.path)} title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                      className={cn('flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]', file?.path === f.path && 'bg-[var(--color-bg-raised)]')}>
                      <span className={cn('w-3 shrink-0 text-center font-mono font-semibold', CODE_CLS[f.code[0]] ?? '')}>{f.code[0]}</span>
                      <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{f.path}</span>
                    </button>
                  ))
                ) : (
                  ([['onlyA', label(ab.a), res.onlyA], ['onlyB', label(ab.b), res.onlyB]] as const).map(([k, t, cs]) => (
                    <div key={k} className="mb-2">
                      <div className="px-1.5 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('只在 {ref}（{n}）', { ref: t, n: cs.length })}</div>
                      {cs.length === 0 && <div className="px-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('没有')}</div>}
                      {cs.map((c) => (
                        <button key={c.hash} onClick={() => { onClose(); onShowCommit(c.hash) }} title={tr('在「历史」页查看')}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]">
                          <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-accent)]">{c.hash.slice(0, 7)}</span>
                          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{c.subject}</span>
                          <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{c.author} · {shortDate(c.date).slice(0, 8)}</span>
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto p-3">
              {!file ? <div className="text-[12px] text-[var(--color-text-muted)]">{tr('点左边的文件看差异')}</div>
                : file.err ? <div className="text-[12px] text-[var(--color-danger)]">{file.err}</div>
                : file.text === undefined ? <div className="text-[12px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>
                : file.text ? <DiffView diff={file.text} maxHeight="max-h-none" legend={tr('{path}：红色＝{a}，绿色＝{b}', { path: file.path, a: label(ab.a), b: label(ab.b) })} />
                : <div className="text-[12px] text-[var(--color-text-muted)]">{tr('（没有内容差异）')}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  ), document.body)
}
