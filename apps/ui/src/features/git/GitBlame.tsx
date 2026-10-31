// 逐行追溯（git blame）：每行是谁、哪个提交、什么时候改的。同一提交连续的行只在第一行显示提交信息；
// 左边色条越亮越新；点左侧提交信息（提交号 / 作者 / 说明）跳到「历史」页看这个提交。可以看工作区（含未提交的行），也可以看某个历史版本
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, ScrollText, X } from 'lucide-react'
import { isUncommittedHash, tr, type GitBlameLine } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { IB, errText, shortDate, type GitCtx } from './gitUi.js'

const MAX_ROWS = 20_000

export function GitBlame({ ctx, path, rev, onClose, onShowCommit }: { ctx: GitCtx; path: string; rev?: string; onClose: () => void; onShowCommit: (hash: string) => void }) {
  const [lines, setLines] = useState<GitBlameLine[]>()
  const [err, setErr] = useState('')
  const [hover, setHover] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { client.git.blame(ctx.tid, ctx.root, path, rev).then(setLines).catch((e) => setErr(errText(e))) }, [ctx.tid, ctx.root, path, rev])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // 新旧程度：按这个文件里最早 / 最晚的提交时间归一化
  const [tMin, tMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const l of lines ?? []) if (!isUncommittedHash(l.hash)) { if (l.time < lo) lo = l.time; if (l.time > hi) hi = l.time }
    return lo === Infinity ? [0, 0] : [lo, hi]
  }, [lines])
  const authors = useMemo(() => new Set((lines ?? []).filter((l) => !isUncommittedHash(l.hash)).map((l) => l.author)).size, [lines])
  const commits = useMemo(() => new Set((lines ?? []).filter((l) => !isUncommittedHash(l.hash)).map((l) => l.hash)).size, [lines])

  return createPortal((
    <div ref={rootRef} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-blame className="flex h-[88vh] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <ScrollText className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('逐行追溯')}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-[var(--color-text-secondary)]">{path}</span>
          <span className="shrink-0 rounded bg-[var(--color-bg-raised)] px-1.5 font-mono text-[10.5px] text-[var(--color-text-muted)]">{rev ? tr('版本 {rev}', { rev: rev.slice(0, 7) }) : tr('git|工作区')}</span>
          {lines && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{tr('{lines} 行 · {commits} 个提交 · {authors} 位作者', { lines: lines.length, commits, authors })}</span>}
          <button onClick={onClose} title={tr('关闭（Esc）')} className={cn(IB, 'ml-auto')}><X className="h-4 w-4" /></button>
        </div>
        {err && <div className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        {!lines && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {lines && (
          <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px]" data-git-blame-body>
            <table className="min-w-full border-collapse">
              <tbody>
                {lines.slice(0, MAX_ROWS).map((l, i) => {
                  const first = i === 0 || lines[i - 1].hash !== l.hash
                  const unc = isUncommittedHash(l.hash)
                  const age = unc ? 1 : tMax > tMin ? (l.time - tMin) / (tMax - tMin) : 1
                  const hot = hover === l.hash
                  return (
                    <tr key={l.line} data-blame-line={l.line} onMouseEnter={() => setHover(l.hash)} className={cn(first && i > 0 && 'border-t border-[var(--color-border-subtle)]', hot && 'bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)]')}>
                      <td className="w-[3px] p-0" style={{ background: unc ? 'var(--color-warn)' : `color-mix(in srgb, var(--color-accent) ${Math.round(15 + age * 85)}%, transparent)` }} />
                      <td className="w-[260px] max-w-[260px] whitespace-nowrap px-2 align-top text-[10.5px] leading-[18px]" title={unc ? tr('还没提交的改动') : `${l.hash}\n${l.author} · ${shortDate(new Date(l.time).toISOString())}\n${l.summary}`}>
                        {first && (unc ? <span className="text-[var(--color-warn)]">{tr('未提交')}</span> : (
                          <button data-blame-hash={l.hash.slice(0, 7)} onClick={() => onShowCommit(l.hash)} className="group/h flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left">
                            <span className="shrink-0 text-[var(--color-accent)] group-hover/h:underline">{l.hash.slice(0, 7)}</span>
                            <span className="w-14 shrink-0 truncate font-sans text-[var(--color-text-secondary)]">{l.author}</span>
                            <span className="shrink-0 text-[var(--color-text-muted)]">{shortDate(new Date(l.time).toISOString()).slice(0, 8)}</span>
                            <span className="min-w-0 truncate font-sans text-[var(--color-text-muted)] group-hover/h:text-[var(--color-text-primary)]">{l.summary}</span>
                          </button>
                        ))}
                      </td>
                      <td className="select-none border-r border-[var(--color-border-subtle)] px-2 text-right align-top leading-[18px] text-[var(--color-text-muted)]">{l.line}</td>
                      <td className="w-full whitespace-pre px-3 align-top leading-[18px] text-[var(--color-text-primary)]">{l.text || ' '}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {lines.length > MAX_ROWS && <div className="px-3 py-2 font-sans text-[11.5px] text-[var(--color-text-muted)]">{tr('文件太长，只显示前 {n} 行', { n: MAX_ROWS })}</div>}
          </div>
        )}
      </div>
    </div>
  ), document.body)
}
