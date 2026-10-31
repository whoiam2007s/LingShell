// Git 面板「储藏」页：把当前改动储藏起来（可带未跟踪文件）、列表、看里面的文件和 diff、应用 / 弹出 / 删除
import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Loader2, PackageOpen, Trash2 } from 'lucide-react'
import { cleanGitDiff, groupGitFiles, tr, type GitChangedFile, type GitStash as Stash } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { DiffView } from '../../components/DiffView.js'
import { cn } from '../../lib/cn.js'
import { CODE_CLS, IB, errText, shortDate, type GitCtx } from './gitUi.js'

export function GitStash({ ctx }: { ctx: GitCtx }) {
  const { tid, root, st } = ctx
  const [list, setList] = useState<Stash[]>()
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string>()
  const [files, setFiles] = useState<GitChangedFile[]>()
  const [diff, setDiff] = useState<{ path: string; text?: string; err?: string }>()
  useEffect(() => { setErr(''); setSel(undefined); client.git.stashes(tid, root).then(setList).catch((e) => setErr(errText(e))) }, [tid, root, ctx.version])
  useEffect(() => { setFiles(undefined); setDiff(undefined); if (sel) client.git.stashFiles(tid, root, sel).then(setFiles).catch((e) => setErr(errText(e))) }, [sel, tid, root])
  const showFile = (f: GitChangedFile) => {
    if (!sel) return
    setDiff({ path: f.path })
    client.git.stashDiff(tid, root, sel, f.path, f.code === '?').then((t) => setDiff({ path: f.path, text: f.code === '?' ? t.split('\n').map((l) => `+${l}`).join('\n').replace(/^/, '@@ -0,0 +1 @@\n') : cleanGitDiff(t) }), (e) => setDiff({ path: f.path, err: errText(e) }))
  }
  // 储藏 ref（stash@{n}）会随 pop/drop 移位：执行前按 hash 重新定位，列表过期时宁可不做也不要动错储藏
  const act = (op: 'stashApply' | 'stashPop' | 'stashDrop', s: Stash, opt: Parameters<GitCtx['run']>[1]) => {
    if (ctx.busy) return
    setErr('')
    client.git.stashes(tid, root).then((latest) => {
      const cur = latest.find((x) => x.hash === s.hash)
      if (!cur) { setErr(tr('储藏「{msg}」已经不在列表里（可能被其他操作删除 / 弹出），已取消', { msg: s.message })) ; setList(latest); return }
      setList(latest)
      void ctx.run({ op, ref: cur.ref }, opt)
    }, (e) => setErr(errText(e)))
  }
  const g = groupGitFiles(st.files)
  const dirty = g.staged.length + g.unstaged.length + g.untracked.length > 0
  const push = () => ctx.ask({
    title: tr('储藏当前改动'), ok: tr('储藏'), text: tr('把工作区和暂存区的改动先收起来（工作区变干净），之后可以再应用回来。'),
    fields: [{ key: 'message', label: tr('说明（可空）'), placeholder: tr('如 登录页改了一半') }],
    checks: [{ key: 'untracked', label: tr('包括未跟踪的新文件（{n} 个）', { n: g.untracked.length }), value: g.untracked.length > 0 }],
    onOk: (v, c) => void ctx.run({ op: 'stashPush', untracked: c.untracked, ...(v.message ? { message: v.message } : {}) }, { done: tr('已储藏') }),
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <span className="text-[11px] text-[var(--color-text-muted)]">{tr('储藏可以临时收起改动，切分支 / 拉取后再恢复')}</span>
        <span className="ml-auto" />
        <button data-git-stash-push disabled={!dirty || !!ctx.busy} onClick={push} title={dirty ? tr('储藏当前改动\n把工作区和暂存区的改动先收起来（可含未跟踪文件）') : tr('工作区干净，没有可储藏的改动')} className={cn(IB, 'text-[var(--color-accent)]')}><Archive className="h-3.5 w-3.5" /></button>
      </div>
      {err && <div className="shrink-0 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className={cn('min-h-0 overflow-y-auto py-1', sel ? 'flex-[2]' : 'flex-1')}>
        {!list && !err && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {list && !list.length && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('没有储藏')}</div>}
        {list?.map((s) => (
          <div key={s.ref} data-git-stash={s.ref} onClick={() => setSel(sel === s.ref ? undefined : s.ref)}
            className={cn('group flex cursor-pointer items-center gap-2 px-3 py-1 text-[11.5px] hover:bg-[var(--color-bg-hover)]', sel === s.ref && 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]')}>
            <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">{s.ref}</span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]" title={s.message}>{s.message}</span>
            <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{shortDate(s.date)}</span>
            <button disabled={!!ctx.busy} onClick={(e) => { e.stopPropagation(); act('stashApply', s, { done: tr('已应用（储藏还留着）') }) }} title={tr('应用\n恢复到工作区，储藏保留')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><ArchiveRestore className="h-3.5 w-3.5" /></button>
            <button data-git-stash-pop disabled={!!ctx.busy} onClick={(e) => { e.stopPropagation(); act('stashPop', s, { done: tr('已弹出') }) }} title={tr('弹出\n恢复到工作区并删除这个储藏')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><PackageOpen className="h-3.5 w-3.5" /></button>
            <button disabled={!!ctx.busy} onClick={(e) => { e.stopPropagation(); act('stashDrop', s, { confirm: { title: tr('删除储藏'), danger: true, ok: tr('删除'), text: tr('删除 {ref}「{msg}」？里面的改动会丢掉。', { ref: s.ref, msg: s.message }) }, done: tr('已删除') }) }} title={tr('删除\n丢掉这个储藏（先确认）')} className={cn(IB, 'h-5 w-5 hidden hover:text-[var(--color-danger)] group-hover:flex')}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
      {sel && (
        <div className="flex min-h-0 flex-[3] border-t border-[var(--color-border-default)]">
          <div className="w-2/5 min-w-0 overflow-y-auto border-r border-[var(--color-border-subtle)] px-2 py-1.5">
            {!files ? <div className="text-[11.5px] text-[var(--color-text-muted)]">{tr('读取中…')}</div> : files.map((f) => (
              <button key={f.path} onClick={() => showFile(f)} className={cn('flex w-full items-center gap-1.5 rounded px-1 py-[2px] text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]', diff?.path === f.path && 'bg-[var(--color-bg-raised)]')}>
                <span className={cn('w-3 shrink-0 text-center font-mono font-semibold', CODE_CLS[f.code[0]] ?? '')}>{f.code[0]}</span>
                <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{f.path}</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto px-3 py-1.5">
            {!diff ? <div className="text-[11.5px] text-[var(--color-text-muted)]">{tr('点左边的文件看改动')}</div>
              : diff.err ? <div className="text-[11px] text-[var(--color-danger)]">{diff.err}</div>
              : diff.text === undefined ? <div className="text-[11px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>
              : <DiffView diff={diff.text} maxHeight="max-h-none" legend={diff.path} />}
          </div>
        </div>
      )}
    </div>
  )
}
