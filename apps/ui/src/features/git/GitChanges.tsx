// Git 面板「更改」页：分组的改动列表、diff、暂存 / 取消暂存（单个 / 所选 / 全部）、丢弃改动、文件历史、
// 提交（可修改上次提交、提交并推送）、AI 写提交说明
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EyeOff, ListChecks, GitCommitHorizontal, GitMerge, History, UndoDot, ScrollText, ShieldCheck, Loader2, Minus, Plus, Sparkles, Undo2, X, Upload } from 'lucide-react'
import { cleanGitDiff, gitCodeLabel, groupGitFiles, hunkable, linePatch, splitHunks, tk, tr, type GitDiffMode, type GitFile, type GitHunk } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Textarea } from '../../components/ui/Input.js'
import { DiffView } from '../../components/DiffView.js'
import { cn } from '../../lib/cn.js'
import { CODE_CLS, IB, errText, type GitCtx } from './gitUi.js'

type Group = 'conflict' | 'staged' | 'unstaged' | 'untracked'
// 冲突文件不能直接暂存（会把 <<<<<<< 原样提交）：只能走合并编辑器或终端里显式处理
const GROUPS: { g: Group; title: string; stage: boolean }[] = [
  { g: 'conflict', title: tk('冲突'), stage: false }, { g: 'staged', title: tk('已暂存'), stage: false },
  { g: 'unstaged', title: tk('未暂存'), stage: true }, { g: 'untracked', title: tk('未跟踪'), stage: true },
]
const codeOf = (g: Group, f: GitFile) => (g === 'staged' ? f.x : g === 'untracked' ? '?' : g === 'conflict' ? 'U' : f.y)
const diffMode = (g: Group): GitDiffMode => (g === 'staged' ? 'staged' : g === 'untracked' ? 'untracked' : 'work')

export function GitChanges({ ctx, refresh, setErr, onFileHistory }: { ctx: GitCtx; refresh: () => void; setErr: (s: string) => void; onFileHistory: (path: string) => void }) {
  const { tid, st, root } = ctx
  const groups = useMemo(() => groupGitFiles(st.files), [st])
  const [sel, setSel] = useState<Set<string>>(new Set())   // `${group}\n${path}`
  const [diff, setDiff] = useState<{ g: Group; path: string; text?: string; raw?: string; err?: string }>()
  const [msg, setMsg] = useState('')
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState<'' | 'stage' | 'suggest'>('')
  const [confirm, setConfirm] = useState<{ push: boolean } | null>(null)

  const key = (g: Group, p: string) => `${g}\n${p}`
  const toggle = (g: Group, p: string) => setSel((s) => { const n = new Set(s), k = key(g, p); if (!n.delete(k)) n.add(k); return n })
  const selIn = (g: Group) => groups[g].filter((f) => sel.has(key(g, f.path))).map((f) => f.path)
  const loadDiff = (g: Group, path: string) => {
    setDiff((d) => (d?.g === g && d.path === path ? d : { g, path }))
    client.git.diff(tid, root, path, diffMode(g)).then((t) => setDiff({ g, path, raw: t, text: cleanGitDiff(t) }), (e) => setDiff({ g, path, err: errText(e) }))
  }
  const showDiff = (g: Group, f: GitFile) => (g === 'conflict' ? ctx.openMerge(f.path) : loadDiff(g, f.path))
  // 写操作之后：正在看的 diff 如果文件还在原来的组里就刷新（按块暂存后接着看剩下的块），否则收起
  const hunks = useMemo(() => (diff?.raw ? splitHunks(diff.raw) : undefined), [diff?.raw])
  const diffRef = useRef(diff)
  diffRef.current = diff
  useEffect(() => {
    setSel(new Set())
    const d = diffRef.current
    if (d && groups[d.g].some((f) => f.path === d.path)) loadDiff(d.g, d.path)
    else setDiff(undefined)
  }, [ctx.version, groups])
  // 按行选择：某一块切到选行模式（key = 块序号 + 块头），选中的行号（块内 lines 的下标）
  const [lineSel, setLineSel] = useState<{ key: string; idx: Set<number> } | null>(null)
  // 切文件 / 切组时清掉按行选择：不同文件可能有完全相同的块头
  useEffect(() => { setLineSel(null) }, [diff?.g, diff?.path])
  const hunkOp = (h: GitHunk, kind: 'stage' | 'unstage' | 'discard', key?: string) => {
    if (!diff || !hunks) return
    const lines = key && lineSel?.key === key && lineSel.idx.size ? lineSel.idx : undefined
    const patch = lines ? linePatch(hunks.fileHeader, h, lines, kind) : h.patch
    if (!patch) return
    const what = lines ? tr('选中的 {n} 行', { n: lines.size }) : tr('这一块')
    const o = { op: 'applyPatch' as const, path: diff.path, cached: kind !== 'discard', reverse: kind !== 'stage' }
    void ctx.run(o, { message: patch, done: kind === 'stage' ? tr('已暂存{what}', { what }) : kind === 'unstage' ? tr('已取消暂存{what}', { what }) : tr('已丢弃{what}', { what }),
      ...(kind === 'discard' ? { confirm: { title: tr('丢弃{what}', { what }), danger: true, ok: tr('git|丢弃'), text: tr('把 {path} 里{what}未暂存的改动（{hunk}）还原掉，不可撤销？', { path: diff.path, what, hunk: h.header.replace(/^(@@[^@]*@@).*/, '$1') }) } } : {}) })
      .then((ok) => { if (ok) setLineSel(null) })
  }
  const stage = (paths: string[], on: boolean) => {
    if (!paths.length) return
    setBusy('stage'); setErr('')
    client.git.stage(tid, root, paths, on).then(() => { setSel(new Set()); setDiff(undefined) })
      .catch((e) => setErr(on ? tr('暂存失败：{err}', { err: errText(e) }) : tr('取消暂存失败：{err}', { err: errText(e) }))).finally(() => { setBusy(''); refresh() })
  }
  // 丢弃：未暂存的还原到暂存区的样子，未跟踪的直接删除——不可撤销，先确认
  const discard = (g: Group, paths: string[]) => {
    if (!paths.length) return
    const untracked = g === 'untracked'
    const list = paths.slice(0, 8).join('\n') + (paths.length > 8 ? '\n' + tr('…共 {n} 个', { n: paths.length }) : '')
    void ctx.run({ op: 'discard', paths: untracked ? [] : paths, untracked: untracked ? paths : [] }, {
      confirm: { title: untracked ? tr('删除未跟踪的文件') : tr('丢弃改动'), danger: true, ok: untracked ? tr('删除') : tr('git|丢弃'), text: untracked
        ? tr('将删除下面 {n} 个文件（还没进过 Git，删了找不回来），不可撤销：\n{list}', { n: paths.length, list })
        : tr('将丢弃下面 {n} 个文件里未暂存的改动（恢复成暂存区 / 上次提交的样子），不可撤销：\n{list}', { n: paths.length, list }) },
      done: untracked ? tr('已删除') : tr('已丢弃改动'),
    })
  }
  // 撤销上次提交：已推送过的要提醒（之后推送需要强制）
  const undoCommit = () => {
    if (!st.oid) return
    const pushed = !!st.upstream && st.ahead === 0
    void client.git.show(tid, root, st.oid).then((d) => d.message.split('\n')[0], () => st.oid!.slice(0, 7)).then((subject) => ctx.run({ op: 'undoCommit' }, {
      confirm: { title: tr('撤销上次提交'), danger: pushed, ok: tr('git|撤销'), text: tr('去掉最近一次提交「{subject}」，它的改动回到「已暂存」，代码不会丢。', { subject }) + (pushed ? '\n' + tr('这个提交已经推送到远程：撤销后再推送需要「强制推送」，别人可能已经基于它开发了。') : '') },
      done: tr('已撤销上次提交，改动在「已暂存」里'),
    }))
  }
  // 加入 .gitignore：这个文件 / 所在目录 / 同扩展名，可多选
  const ignore = (path: string) => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    const ext = /\.([\w-]{1,12})$/.exec(path.slice(path.lastIndexOf('/') + 1))?.[1]
    // 文件名里的 * ? [ ] 是 gitignore 通配符，要转义，否则会忽略到别的文件
    const gi = (s: string) => s.replace(/([\\*?[\]])/g, '\\$1')
    ctx.ask({
      title: tr('加入 .gitignore'), ok: tr('加入'), text: tr('追加到仓库根目录的 .gitignore（没有就新建），之后这些文件不再出现在改动列表里。'),
      checks: [
        { key: 'file', label: tr('只忽略这个文件：/{path}', { path }), value: true },
        ...(dir ? [{ key: 'dir', label: tr('忽略整个目录：/{dir}', { dir }) }] : []),
        ...(ext ? [{ key: 'ext', label: tr('忽略所有 .{ext} 文件：*.{ext}', { ext }) }] : []),
      ],
      onOk: (_v, c) => {
        const ps = [c.file ? `/${gi(path)}` : '', c.dir ? `/${gi(dir)}` : '', c.ext ? `*.${ext}` : ''].filter(Boolean)
        if (ps.length) void ctx.run({ op: 'ignore', patterns: ps }, { done: tr('已加入 .gitignore：{list}', { list: ps.join('  ') }) })
      },
    })
  }
  // 提交范围：「已暂存」里勾了文件就只针对勾选的（提交、AI 写说明、AI 审查一致），没勾 = 全部已暂存
  const pickedStaged = selIn('staged')
  const partial = pickedStaged.length > 0 && pickedStaged.length < groups.staged.length
  const scope = partial ? pickedStaged : undefined
  const scopeHint = partial ? tr('（只针对勾选的 {n} 个已暂存文件）', { n: pickedStaged.length }) : tr('（全部已暂存的文件；在「已暂存」里勾选可以只针对部分文件）')
  const suggest = () => {
    setBusy('suggest'); setErr('')
    client.git.suggest(tid, root, st.branch, scope).then(setMsg).catch((e) => setErr(tr('AI 写提交说明失败：{err}', { err: errText(e) }))).finally(() => setBusy(''))
  }
  // 修改上次提交：带出上次的说明
  const toggleAmend = (v: boolean) => {
    setAmend(v)
    if (v && !msg.trim() && st.oid) client.git.show(tid, root, st.oid).then((d) => setMsg((m) => m || d.message)).catch(() => {})
  }
  const commit = (push: boolean) => {
    setConfirm(null)
    const exclude = partial ? groups.staged.map((f) => f.path).filter((p) => !pickedStaged.includes(p)) : []
    void ctx.run({ op: 'commit', amend, push, branch: st.branch, ...(exclude.length ? { exclude } : {}) }, { message: msg, done: push ? tr('已提交并推送') : amend ? tr('已修改上次提交') : tr('已提交') }).then((ok) => { if (ok) { setMsg(''); setAmend(false) } })
  }

  const staged = partial ? pickedStaged.length : groups.staged.length
  const canCommit = (staged > 0 || amend) && !!msg.trim() && !ctx.busy && !st.detached
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {st.files.length === 0 && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('工作区干净，没有改动。')}</div>}
        {GROUPS.map(({ g, title, stage: on }) => {
          const fs = groups[g]
          if (!fs.length) return null
          const picked = selIn(g), canDiscard = g === 'unstaged' || g === 'untracked'
          return (
            <div key={g} data-git-group={g} className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1 text-[10.5px] font-medium text-[var(--color-text-muted)]">
                <Checkbox checked={picked.length === fs.length ? true : picked.length ? 'indeterminate' : false} aria-label={tr('全选{title}', { title: tr(title) })}
                  onCheckedChange={(v) => setSel((s) => { const n = new Set(s); for (const f of fs) { if (v) n.add(key(g, f.path)); else n.delete(key(g, f.path)) } return n })} />
                <span>{tr('{title}（{n}）', { title: tr(title), n: fs.length })}</span>
                <span className="ml-auto" />
                {picked.length > 0 && <span className="text-[10px] text-[var(--color-accent)]">{tr('已选 {n}', { n: picked.length })}</span>}
                {canDiscard && <button data-git-discard-group={g} disabled={!!busy || !!ctx.busy} onClick={() => discard(g, picked.length ? picked : fs.map((f) => f.path))}
                  title={`${picked.length ? tr('丢弃所选（{n}）', { n: picked.length }) : tr('全部丢弃')}\n${g === 'untracked' ? tr('删除这些未跟踪的文件（先确认）') : tr('还原这些文件未暂存的改动（先确认）')}`} className={cn(IB, 'h-5 w-5 hover:text-[var(--color-danger)]')}>
                  <Undo2 className="h-3.5 w-3.5" />
                </button>}
                {g !== 'conflict' && <button data-git-stage-group={g} disabled={!!busy || !!ctx.busy} onClick={() => stage(picked.length ? picked : fs.map((f) => f.path), on)}
                  title={picked.length ? (on ? tr('暂存所选（{n}）', { n: picked.length }) : tr('取消暂存所选（{n}）', { n: picked.length })) : on ? tr('全部暂存') : tr('全部取消暂存')} className={cn(IB, 'h-5 w-5')}>
                  {on ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                </button>}
              </div>
              {fs.map((f) => {
                const code = codeOf(g, f), active = diff?.g === g && diff.path === f.path
                return (
                  <div key={f.path} data-git-file={f.path} className={cn('group flex items-center gap-1.5 px-3 py-[3px] text-[11.5px] hover:bg-[var(--color-bg-hover)]', active && 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]')}>
                    <Checkbox checked={sel.has(key(g, f.path))} onCheckedChange={() => toggle(g, f.path)} aria-label={f.path} />
                    <span title={gitCodeLabel(code)} className={cn('w-3 shrink-0 text-center font-mono font-semibold', CODE_CLS[code] ?? 'text-[var(--color-text-muted)]')}>{code}</span>
                    <button onClick={() => showDiff(g, f)} title={`${f.orig ? `${f.orig} → ` : ''}${f.path}\n${tr('点击查看改动')}`} className="min-w-0 flex-1 truncate text-left font-mono text-[var(--color-text-primary)]">
                      {f.orig && <span className="text-[var(--color-text-muted)]">{f.orig} → </span>}{f.path}
                    </button>
                    {g === 'conflict' && <button data-git-open-merge onClick={() => ctx.openMerge(f.path)} title={tr('解决冲突\n打开三方合并编辑器，逐个选择采用哪一边')} className={cn(IB, 'h-5 w-5 text-[var(--color-accent)]')}><GitMerge className="h-3.5 w-3.5" /></button>}
                    {!f.untracked && <button onClick={() => onFileHistory(f.path)} title={tr('文件历史')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><History className="h-3 w-3" /></button>}
                    {!f.untracked && f.x !== 'A' && g !== 'conflict' && <button data-git-blame-btn onClick={() => ctx.openBlame(f.path)} title={tr('逐行追溯（谁在什么时候改的每一行）')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><ScrollText className="h-3 w-3" /></button>}
                    {f.untracked && <button data-git-ignore onClick={() => ignore(f.path)} title={tr('加入 .gitignore\n以后不再显示这个文件（可选按目录 / 扩展名）')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><EyeOff className="h-3 w-3" /></button>}
                    {canDiscard && <button disabled={!!ctx.busy} onClick={() => discard(g, [f.path])} title={g === 'untracked' ? tr('删除这个文件') : tr('丢弃改动')} className={cn(IB, 'h-5 w-5 hidden hover:text-[var(--color-danger)] group-hover:flex')}><Undo2 className="h-3 w-3" /></button>}
                    {g !== 'conflict' && <button disabled={!!busy || !!ctx.busy} onClick={() => stage([f.path], on)} title={on ? tr('暂存') : tr('取消暂存')} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}>
                      {on ? <Plus className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                    </button>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      {diff && (
        <div className="shrink-0 border-t border-[var(--color-border-default)] px-3 pb-2 pt-1.5" data-git-diff>
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <span className="min-w-0 flex-1 truncate font-mono" title={diff.path}>{diff.path}<span className="ml-1.5 font-sans">{diff.g === 'staged' ? tr('（已暂存的改动）') : diff.g === 'untracked' ? tr('（新文件）') : tr('（工作区改动）')}</span></span>
            <button title={tr('收起')} onClick={() => setDiff(undefined)} className={cn(IB, 'h-5 w-5')}><X className="h-3 w-3" /></button>
          </div>
          {diff.err ? <div className="py-1 text-[11px] text-[var(--color-danger)]">{diff.err}</div>
            : diff.text === undefined ? <div className="py-1 text-[11px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>
            : diff.text && diff.raw && (diff.g === 'staged' || diff.g === 'unstaged') && hunks && hunkable(hunks.fileHeader) && hunks.hunks.length > 0 ? (
              <div className="max-h-72 space-y-1.5 overflow-y-auto" data-git-hunks>
                {hunks.hunks.map((h, i) => {
                  // key 带上文件 / 组：不同文件的首块头经常一样，只按序号 + header 会把选中行套到另一个文件
                  const key = `${diff.g}\n${diff.path}\n${i}:${h.header}`, sel = lineSel?.key === key ? lineSel.idx : undefined, n = sel?.size ?? 0
                  const what = sel ? (n ? tr('选中的 {n} 行', { n }) : tr('（先点选要操作的行）')) : tr('此块')
                  const toggleLine = (k: number) => setLineSel((ls) => { const idx = new Set(ls?.key === key ? ls.idx : []); if (!idx.delete(k)) idx.add(k); return { key, idx } })
                  return (
                  <div key={key} data-git-hunk={i} className="rounded border border-[var(--color-border-subtle)]">
                    <div className="flex items-center gap-1 bg-[var(--color-bg-raised)] px-1.5 py-0.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--color-text-muted)]" title={h.header}>{tr('第 {i} 块 · {desc}', { i: i + 1, desc: sel ? tr('按行选择：已选 {n} 行', { n }) : h.header.replace(/^@@ [^@]*@@ ?/, '') || h.header.replace(/^(@@[^@]*@@).*/, '$1') })}</span>
                      <button data-git-line-mode onClick={() => setLineSel(sel ? null : { key, idx: new Set() })} title={sel ? tr('退出按行选择') : tr('按行选择\n点选这一块里的某几行，只暂存 / 取消暂存 / 丢弃这几行')} className={cn(IB, 'h-5 w-5', sel && 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]')}><ListChecks className="h-3.5 w-3.5" /></button>
                      {diff.g === 'unstaged' && <button data-git-hunk-discard disabled={!!ctx.busy || (!!sel && !n)} onClick={() => hunkOp(h, 'discard', key)} title={tr('丢弃{what}\n还原未暂存的改动（先确认）', { what })} className={cn(IB, 'h-5 w-5 hover:text-[var(--color-danger)]')}><Undo2 className="h-3.5 w-3.5" /></button>}
                      {diff.g === 'unstaged'
                        ? <button data-git-hunk-stage disabled={!!ctx.busy || (!!sel && !n)} onClick={() => hunkOp(h, 'stage', key)} title={tr('暂存{what}\n只把它加入下次提交', { what })} className={cn(IB, 'h-5 w-5')}><Plus className="h-3.5 w-3.5" /></button>
                        : <button data-git-hunk-unstage disabled={!!ctx.busy || (!!sel && !n)} onClick={() => hunkOp(h, 'unstage', key)} title={tr('取消暂存{what}\n移回未暂存', { what })} className={cn(IB, 'h-5 w-5')}><Minus className="h-3.5 w-3.5" /></button>}
                    </div>
                    {sel ? (
                      <div className="py-0.5 font-mono text-[11px] leading-[17px]" data-git-line-list>
                        {h.lines.map((l, k) => {
                          const t = l[0], pick = t === '+' || t === '-', on = sel.has(k)
                          return (
                            <div key={k} data-git-line={k} data-on={on || undefined} onClick={pick ? () => toggleLine(k) : undefined}
                              className={cn('flex gap-1.5 whitespace-pre-wrap break-all px-1.5', pick && 'cursor-pointer', t === '+' ? 'text-[var(--color-success)]' : t === '-' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
                                pick && (on ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_25%,transparent)]' : t === '+' ? 'bg-[color:color-mix(in_srgb,var(--color-success)_8%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-success)_16%,transparent)]' : 'bg-[color:color-mix(in_srgb,var(--color-danger)_8%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_16%,transparent)]'))}>
                              <span className="w-3 shrink-0 text-center">{pick ? (on ? '☑' : '☐') : ''}</span><span>{l || ' '}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : <DiffView diff={cleanGitDiff(`${h.header}\n${h.lines.join('\n')}`)} maxHeight="max-h-none" />}
                  </div>
                  )
                })}
              </div>
            )
            : diff.text ? <DiffView diff={diff.text} maxHeight="max-h-56" legend={tr('绿色＝新增，红色＝删除')} />
            : <div className="py-1 text-[11px] text-[var(--color-text-muted)]">{tr('（没有内容差异：可能只改了权限，或是空文件）')}</div>}
        </div>
      )}
      <div className="shrink-0 space-y-1.5 border-t border-[var(--color-border-default)] px-3 py-2">
        <Textarea data-git-msg value={msg} onChange={(e) => setMsg(e.target.value)} rows={3}
          placeholder={st.detached ? tr('分离头指针状态下不能提交：先切到一个分支') : staged || amend ? tr('提交说明（可点左下角 ✨ 让 AI 生成后再改）') : tr('先暂存要提交的文件')} className="resize-none font-mono text-[11.5px]" />
        <div className="flex items-center gap-1.5">
          <button data-git-suggest disabled={!staged || !!busy} onClick={suggest} title={tr('AI 写提交说明\n根据已暂存的 diff 生成{scope}，发给模型前脱敏', { scope: scopeHint })} className={cn(IB, 'text-[var(--color-accent)]')}>
            {busy === 'suggest' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          </button>
          <button data-git-review disabled={!staged} onClick={() => ctx.openReview(scope)} title={tr('AI 审查已暂存的改动\n提交前找 bug、误提交的密钥、调试代码、不该提交的文件{scope}', { scope: scopeHint })} className={cn(IB, 'text-[var(--color-accent)]')}><ShieldCheck className="h-3.5 w-3.5" /></button>
          <label title={tr('把这次的改动并进上一个提交（改写历史：上一个提交已经推送过的话，推送时会被拒绝）')} className="flex cursor-pointer items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
            <Checkbox checked={amend} onCheckedChange={toggleAmend} aria-label={tr('修改上次提交')} />{tr('修改上次提交')}
          </label>
          <span className="ml-auto" />
          <button data-git-undo-commit disabled={!st.oid || !!ctx.busy || st.detached} onClick={undoCommit} title={tr('撤销上次提交\n去掉最近一次提交，它的改动回到「已暂存」（不丢代码）')} className={IB}><UndoDot className="h-3.5 w-3.5" /></button>
          <button data-git-commit-push disabled={!canCommit} onClick={() => setConfirm({ push: true })} title={tr('提交并推送\n提交后推送到上游（没有上游就推到 origin 并设为上游）')} className={IB}><Upload className="h-3.5 w-3.5" /></button>
          <button data-git-commit disabled={!canCommit} onClick={() => setConfirm({ push: false })}
            className="flex shrink-0 items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40">
            {ctx.busy === '提交' /* i18n-ignore busy 是 GIT_OP_LABEL 原值（未翻译） */ ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}{amend ? (partial ? tr('修改提交（所选 {n}）', { n: staged }) : tr('修改提交')) : partial ? tr('提交所选（{n}）', { n: staged }) : tr('提交（{n}）', { n: staged })}
          </button>
        </div>
      </div>
      {confirm && <CommitConfirm ctx={ctx} files={partial ? groups.staged.filter((f) => pickedStaged.includes(f.path)) : groups.staged} rest={partial ? groups.staged.length - pickedStaged.length : 0} message={msg} amend={amend} push={confirm.push} onCancel={() => setConfirm(null)} onConfirm={() => commit(confirm.push)} />}
    </>
  )
}

// 提交确认：列出分支、要提交的文件和说明；不点遮罩关闭，Esc / 取消关
function CommitConfirm({ ctx, files, rest, message, amend, push, onCancel, onConfirm }: { ctx: GitCtx; files: GitFile[]; rest: number; message: string; amend: boolean; push: boolean; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const prod = ctx.term.env === 'prod', branch = ctx.st.branch
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-git-confirm className="w-[520px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <GitCommitHorizontal className="h-4.5 w-4.5 text-[var(--color-accent)]" />{amend
            ? (push ? tr('修改上次提交 并推送') : tr('修改上次提交'))
            : (push ? tr('提交到 {branch} 并推送', { branch: branch || tr('当前分支') }) : tr('提交到 {branch}', { branch: branch || tr('当前分支') }))}
        </div>
        <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
          {prod && <b className="text-[var(--color-danger)]">{tr('这是生产主机！')}</b>}{files.length
            ? tr('在「{host}」上执行 {cmd}，提交下面 {n} 个已暂存的文件。', { host: ctx.term.title, cmd: `git commit${amend ? ' --amend' : ''}`, n: files.length })
            : tr('在「{host}」上执行 {cmd}，只改提交说明。', { host: ctx.term.title, cmd: `git commit${amend ? ' --amend' : ''}` })}{rest > 0 && <b className="text-[var(--color-text-primary)]">{tr('只提交勾选的文件，另外 {n} 个已暂存的文件这次不提交，留在暂存区。', { n: rest })}</b>}
          {amend && tr('会改写上一个提交；如果它已经推送过，再推送会被拒绝。')}
          {push ? (ctx.st.upstream ? tr('提交后推送到 {up}。', { up: ctx.st.upstream }) : tr('提交后推送到 origin 并设为上游。')) : tr('只提交到本地仓库，不会推送。')}{tr('操作会记入执行记录。')}
        </p>
        {files.length > 0 && <div className="mb-2 max-h-28 overflow-y-auto rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
          {files.map((f) => <div key={f.path} className="truncate">{f.x} {f.path}</div>)}
        </div>}
        <pre className="mb-4 max-h-36 overflow-y-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11px] text-[var(--color-text-primary)]">{message.trim()}</pre>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button data-git-confirm-ok onClick={onConfirm} className={cn('rounded-md border border-transparent px-4 py-1.5 text-[12.5px] font-medium hover:opacity-90', prod ? 'bg-[var(--color-danger)] text-[var(--color-on-danger)]' : 'bg-[var(--color-accent)] text-[var(--color-bg-base)]')}>{push ? tr('提交并推送') : tr('提交')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}
