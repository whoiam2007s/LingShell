// Git 面板「历史」页：提交图（同 IDEA / VS Code 的 Graph）+ 分支 / 标签标记，按说明 / 作者 / 文件过滤，分页加载；
// 选中提交看详情（说明、作者、改了哪些文件，点文件看 diff），右键菜单：复制哈希、新建分支 / 标签、拣选、还原、重置、检出
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, CopyPlus, FileClock, GitCompareArrows, Loader2, RefreshCw, ScrollText, Search, Undo2, X } from 'lucide-react'
import { cleanGitDiff, gitGraph, tr, type GitCommit, type GitCommitDetail, type GraphRow } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { DiffView } from '../../components/DiffView.js'
import { cn } from '../../lib/cn.js'
import { CODE_CLS, IB, RowMenu, errText, refNameError, shortDate, type GitCtx, type MenuItem } from './gitUi.js'

export interface HistoryFilter { path?: string; ref?: string; select?: string }   // select：打开时选中这个提交（从逐行追溯跳过来）
const PAGE = 200
const ROW = 24, LANE = 12
const COLORS = ['#4f9cf9', '#e5a13b', '#3fb27f', '#d9577a', '#9b7bea', '#2bb3c0', '#c98a4b', '#7f8ea3']

function Graph({ row, width }: { row: GraphRow; width: number }) {
  const x = (c: number) => c * LANE + LANE / 2
  return (
    <svg width={width * LANE} height={ROW} className="shrink-0">
      {row.lines.map((l, i) => (
        <path key={i} d={l.half === 'top' ? `M${x(l.from)} 0 C${x(l.from)} ${ROW / 4} ${x(l.to)} ${ROW / 4} ${x(l.to)} ${ROW / 2}` : `M${x(l.from)} ${ROW / 2} C${x(l.from)} ${(ROW * 3) / 4} ${x(l.to)} ${(ROW * 3) / 4} ${x(l.to)} ${ROW}`}
          stroke={COLORS[l.color % COLORS.length]} strokeWidth={1.6} fill="none" />
      ))}
      <circle cx={x(row.col)} cy={ROW / 2} r={3.5} fill={COLORS[row.color % COLORS.length]} stroke="var(--color-bg-panel)" strokeWidth={1.2} />
    </svg>
  )
}

function RefBadge({ r }: { r: string }) {
  const head = r.startsWith('HEAD -> '), tag = r.startsWith('tag: '), name = head ? r.slice(8) : tag ? r.slice(5) : r
  const remote = !head && !tag && name.includes('/') && name.split('/')[0] === 'origin'
  return (
    <span className={cn('shrink-0 rounded px-1 font-mono text-[10px] leading-4',
      head ? 'bg-[var(--color-accent)] text-[var(--color-bg-base)]' : tag ? 'bg-[color:color-mix(in_srgb,var(--color-warn)_20%,transparent)] text-[var(--color-warn)]'
        : remote ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]' : 'bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-[var(--color-accent)]')}>
      {tag && '🏷 '}{name}
    </span>
  )
}

export function GitHistory({ ctx, filter, setFilter }: { ctx: GitCtx; filter: HistoryFilter; setFilter: (f: HistoryFilter) => void }) {
  const { tid, root } = ctx
  const [all, setAll] = useState(true)
  const [grep, setGrep] = useState(''), [author, setAuthor] = useState('')
  const [mode, setMode] = useState<'msg' | 'code'>('msg')
  const [applied, setApplied] = useState({ grep: '', pickaxe: '', author: '' })
  const apply = () => setApplied({ grep: mode === 'msg' ? grep.trim() : '', pickaxe: mode === 'code' ? grep.trim() : '', author: author.trim() })
  // 多选（Ctrl / Shift 点击）：一次拣选 / 还原多个提交
  const [picked, setPicked] = useState<string[]>([])
  const [commits, setCommits] = useState<GitCommit[]>()
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string | undefined>(filter.select)
  useEffect(() => { if (filter.select) setSel(filter.select) }, [filter.select])
  const [det, setDet] = useState<GitCommitDetail>()
  const [fileDiff, setFileDiff] = useState<{ path: string; text?: string; err?: string }>()
  const [flash, setFlash] = useState('')

  // 请求序号：快速切过滤 / 连点「再加载」时，迟到的旧响应不能覆盖新列表或重复追加同一页
  const req = useRef(0)
  const load = useCallback((skip: number) => {
    const id = ++req.current
    setLoading(true); setErr('')
    client.git.log(tid, root, { all: all && !filter.ref, skip, limit: PAGE, ...(applied.grep ? { grep: applied.grep } : {}), ...(applied.pickaxe ? { pickaxe: applied.pickaxe } : {}), ...(applied.author ? { author: applied.author } : {}), ...(filter.path ? { path: filter.path } : {}), ...(filter.ref ? { ref: filter.ref } : {}) })
      .then((cs) => { if (id !== req.current) return; setCommits((old) => (skip ? [...(old ?? []), ...cs] : cs)); setMore(cs.length >= PAGE) })
      .catch((e) => { if (id === req.current) setErr(errText(e)) }).finally(() => { if (id === req.current) setLoading(false) })
  }, [tid, root, all, applied, filter])
  useEffect(() => { load(0) }, [load, ctx.version])
  const rows = useMemo(() => gitGraph(commits ?? []), [commits])
  const width = useMemo(() => Math.min(Math.max(1, ...rows.map((r) => r.width)), 12), [rows])

  useEffect(() => {
    setDet(undefined); setFileDiff(undefined)
    if (sel) client.git.show(tid, root, sel).then(setDet).catch((e) => setErr(errText(e)))
  }, [sel, tid, root, ctx.version])
  const showFile = (path: string) => {
    if (!sel) return
    setFileDiff({ path })
    client.git.commitDiff(tid, root, sel, path).then((t) => setFileDiff({ path, text: cleanGitDiff(t) }), (e) => setFileDiff({ path, err: errText(e) }))
  }
  const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => { setFlash(tr('已复制')); setTimeout(() => setFlash(''), 1500) })

  const cur = ctx.st.detached ? '' : ctx.st.branch
  // 列表内容变了（刷新 / 过滤 / 切范围）旧选择就失效：不能对看不见的提交执行批量拣选 / 还原
  useEffect(() => { setPicked([]) }, [ctx.version, applied, filter, all])
  // 普通点击：选中看详情；Ctrl / ⌘ 点击：多选切换；Shift 点击：从上一次多选的那个连选到这里
  const clickRow = (e: React.MouseEvent, hash: string, i: number) => {
    // 同常见列表：Ctrl 点击时，已经选中（正在看详情）的那一行也算进多选
    if (e.ctrlKey || e.metaKey) { setPicked((p) => { const base = !p.length && sel && sel !== hash ? [sel] : p; return base.includes(hash) ? base.filter((x) => x !== hash) : [...base, hash] }); return }
    if (e.shiftKey && commits) {
      const last = picked.length ? commits.findIndex((c) => c.hash === picked[picked.length - 1]) : commits.findIndex((c) => c.hash === sel)
      if (last >= 0) { const [a, b] = last < i ? [last, i] : [i, last]; setPicked(commits.slice(a, b + 1).map((c) => c.hash)); return }
    }
    setPicked([]); setSel(sel === hash ? undefined : hash)
  }
  // 拣选按从旧到新（列表是从新到旧，所以倒过来），还原按从新到旧
  const pickedOrdered = (oldFirst: boolean) => {
    const idx = (h: string) => commits?.findIndex((c) => c.hash === h) ?? -1
    return [...picked].sort((a, b) => (oldFirst ? idx(b) - idx(a) : idx(a) - idx(b)))
  }
  const pickMany = () => { const hs = pickedOrdered(true); void ctx.run({ op: 'cherryPick', hash: hs[0], hashes: hs }, { confirm: { title: tr('拣选 {n} 个提交', { n: hs.length }), ok: tr('拣选'), text: tr('按从旧到新的顺序，把这 {n} 个提交的改动依次加到 {cur} 上。中途有冲突会停下，解决后在横幅里「继续」。', { n: hs.length, cur }) }, done: tr('已拣选 {n} 个提交', { n: hs.length }) }) }
  const revertMany = () => { const hs = pickedOrdered(false); void ctx.run({ op: 'revert', hash: hs[0], hashes: hs }, { confirm: { title: tr('还原 {n} 个提交', { n: hs.length }), ok: tr('git|还原'), text: tr('按从新到旧的顺序，为这 {n} 个提交各新建一个撤销提交（不改写历史）。', { n: hs.length }) }, done: tr('已还原 {n} 个提交', { n: hs.length }) }) }
  const menu = (c: GitCommit): MenuItem[] => {
    const h = c.hash, s = h.slice(0, 7)
    return [
      { label: tr('复制提交号'), onClick: () => copy(h) },
      { label: tr('复制提交说明'), onClick: () => copy(c.subject) },
      { sep: true, label: '', onClick: () => {} },
      { label: tr('与当前（{cur}）比较', { cur: cur || 'HEAD' }), disabled: c.hash === ctx.st.oid, onClick: () => ctx.openCompare(h, 'HEAD') },
      { label: tr('与工作区比较（已跟踪文件的未提交改动）'), onClick: () => ctx.openCompare(h) },
      ...(c.hash === ctx.st.oid && cur ? [{ label: tr('撤销这个提交（改动回到已暂存）…'), onClick: () => void ctx.run({ op: 'undoCommit' }, { confirm: { title: tr('撤销上次提交'), danger: !!ctx.st.upstream && ctx.st.ahead === 0, ok: tr('git|撤销'), text: tr('去掉最近一次提交「{subject}」，改动回到「已暂存」，代码不会丢。', { subject: c.subject }) + (ctx.st.upstream && ctx.st.ahead === 0 ? '\n' + tr('这个提交已经推送过：撤销后再推送需要「强制推送」。') : '') }, done: tr('已撤销上次提交') }) }] : []),
      { sep: true, label: '', onClick: () => {} },
      { label: tr('从这里新建分支…'), onClick: () => ctx.ask({ title: tr('从 {from} 新建分支', { from: s }), ok: tr('新建'), fields: [{ key: 'name', label: tr('名称'), required: true, validate: refNameError }], checks: [{ key: 'checkout', label: tr('新建后切换过去'), value: true }], onOk: (v, k) => void ctx.run({ op: 'createBranch', name: v.name, from: h, checkout: k.checkout }, { done: tr('已新建分支 {name}', { name: v.name }) }) }) },
      { label: tr('在这里打标签…'), onClick: () => ctx.ask({ title: tr('在 {s} 上打标签', { s }), ok: tr('新建'), fields: [{ key: 'name', label: tr('名称'), required: true, validate: refNameError, placeholder: tr('如 v1.2.0') }, { key: 'message', label: tr('说明（可空；填了就是附注标签）'), multiline: true }], onOk: (v) => void ctx.run({ op: 'createTag', name: v.name, at: h, ...(v.message ? { message: v.message } : {}) }, { done: tr('已新建标签 {name}', { name: v.name }) }) }) },
      { sep: true, label: '', onClick: () => {} },
      { label: tr('从这里开始整理提交（压缩 / 调顺序 / 改说明 / 删除）…'), disabled: !cur, onClick: () => ctx.openRebase(h) },
      { label: tr('拣选到当前分支（cherry-pick）'), disabled: !cur, onClick: () => void ctx.run({ op: 'cherryPick', hash: h }, { confirm: { title: tr('拣选提交'), ok: tr('拣选'), text: tr('把 {s}「{subject}」的改动作为新提交加到 {cur} 上？', { s, subject: c.subject, cur }) }, done: tr('已拣选') }) },
      { label: tr('还原这个提交（revert）'), disabled: !cur, onClick: () => void ctx.run({ op: 'revert', hash: h }, { confirm: { title: tr('还原提交'), ok: tr('git|还原'), text: tr('新建一个提交，撤销 {s}「{subject}」的改动（不改写历史）？', { s, subject: c.subject }) }, done: tr('已还原') }) },
      { sep: true, label: '', onClick: () => {} },
      { label: tr('重置 {cur} 到这里（保留改动，已暂存）', { cur: cur || 'HEAD' }), onClick: () => reset(c, 'soft') },
      { label: tr('重置 {cur} 到这里（保留改动，未暂存）', { cur: cur || 'HEAD' }), onClick: () => reset(c, 'mixed') },
      { label: tr('重置 {cur} 到这里（丢弃所有改动）…', { cur: cur || 'HEAD' }), danger: true, onClick: () => reset(c, 'hard') },
      { label: tr('检出这个提交（分离头指针）…'), onClick: () => void ctx.run({ op: 'checkoutCommit', hash: h }, { confirm: { title: tr('检出提交'), danger: true, ok: tr('检出'), text: tr('切到 {s}，进入「分离头指针」状态：在这里提交的东西不属于任何分支，切走后容易丢。只想看代码时用，要改东西请「从这里新建分支」。', { s }) }, done: tr('已检出 {s}', { s }) }) },
    ]
  }
  const reset = (c: GitCommit, mode: 'soft' | 'mixed' | 'hard') => void ctx.run({ op: 'reset', hash: c.hash, mode }, {
    confirm: {
      title: mode === 'hard' ? tr('重置并丢弃改动') : tr('重置'), danger: true, ok: tr('重置'),
      text: tr('把 {cur} 移到 {s}「{subject}」。之后的提交会从分支上拿掉（已推送过的话，推送需要强制）。', { cur: cur || 'HEAD', s: c.hash.slice(0, 7), subject: c.subject }) + '\n' + (mode === 'hard' ? tr('工作区和暂存区里所有没提交的改动都会丢失，不可恢复！') : mode === 'soft' ? tr('这些提交的改动保留为已暂存。') : tr('这些提交的改动保留在工作区（未暂存）。')),
    }, done: tr('已重置'),
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex overflow-hidden rounded border border-[var(--color-border-default)] text-[11px]">
          {([[true, tr('全部分支')], [false, tr('当前分支')]] as const).map(([v, l]) => (
            <button key={String(v)} disabled={!!filter.ref} onClick={() => setAll(v)} className={cn('px-2 py-0.5', all === v && !filter.ref ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]')}>{l}</button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded border border-[var(--color-border-default)] text-[11px]">
          {([['msg', tr('git|说明'), tr('按提交说明搜')], ['code', tr('代码'), tr('按代码内容搜（git log -S）：找加入或删除了这段内容的提交')]] as const).map(([k, l, t]) => (
            <button key={k} data-git-search-mode={k} title={t} onClick={() => { setMode(k); if (grep.trim()) setApplied({ grep: k === 'msg' ? grep.trim() : '', pickaxe: k === 'code' ? grep.trim() : '', author: author.trim() }) }}
              className={cn('px-2 py-0.5', mode === k ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]')}>{l}</button>
          ))}
        </div>
        <div className="relative min-w-[140px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <Input size="sm" className="pl-7" value={grep} placeholder={mode === 'code' ? tr('搜代码内容，如函数名 / 配置项（回车）') : tr('搜提交说明（回车）')} data-git-log-grep onChange={(e) => setGrep(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        </div>
        <Input size="sm" className="w-28" value={author} placeholder={tr('作者（回车）')} onChange={(e) => setAuthor(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        {(filter.path || filter.ref) && !filter.select && (
          <span className="flex min-w-0 items-center gap-1 rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text-secondary)]" data-git-log-filter>
            <span className="truncate">{filter.path ? tr('文件：{path}', { path: filter.path }) : tr('分支：{ref}', { ref: filter.ref ?? '' })}</span>
            <button title={tr('清除')} onClick={() => setFilter({})} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
          </span>
        )}
        {flash && <span className="text-[11px] text-[var(--color-success)]">{flash}</span>}
        <button title={tr('刷新')} onClick={() => load(0)} className={IB}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /></button>
      </div>
      {err && <div className="shrink-0 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {picked.length > 0 ? (
        <div data-git-picked className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-3 py-1 text-[11.5px]">
          <span className="text-[var(--color-text-primary)]">{tr('已选 {n} 个提交', { n: picked.length })}</span>
          <span className="text-[10.5px] text-[var(--color-text-muted)]">{tr('Ctrl 点击增减，Shift 点击连选')}</span>
          <span className="ml-auto" />
          <button data-git-pick-many disabled={!cur || !!ctx.busy} onClick={pickMany} title={tr('拣选到 {cur}\n按从旧到新依次把改动加到当前分支', { cur: cur || tr('当前分支') })} className={IB}><CopyPlus className="h-3.5 w-3.5" /></button>
          <button data-git-revert-many disabled={!cur || !!ctx.busy} onClick={revertMany} title={tr('还原\n为每个提交新建一个撤销提交（不改写历史）')} className={IB}><Undo2 className="h-3.5 w-3.5" /></button>
          <button onClick={() => setPicked([])} title={tr('清除选择')} className={IB}><X className="h-3.5 w-3.5" /></button>
        </div>
      ) : commits && commits.length > 1 && !sel && <div className="shrink-0 px-3 pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('提示：Ctrl / Shift 点击可以多选提交，一次拣选或还原')}</div>}
      <div className={cn('min-h-0 overflow-auto', sel ? 'flex-[3]' : 'flex-1')} data-git-log>
        {!commits && loading && <div className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('读取中…')}</div>}
        {commits && !commits.length && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{applied.grep || applied.pickaxe || applied.author || filter.path ? tr('没有提交（换个过滤条件试试）') : tr('没有提交')}</div>}
        {commits?.map((c, i) => (
          <div key={c.hash} data-git-commit-row={c.hash.slice(0, 7)} onClick={(e) => clickRow(e, c.hash, i)}
            className={cn('group flex h-6 cursor-pointer items-center gap-2 pr-2 text-[11.5px] hover:bg-[var(--color-bg-hover)]', sel === c.hash && 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]', picked.includes(c.hash) && 'bg-[color:color-mix(in_srgb,var(--color-accent)_22%,transparent)] ring-1 ring-inset ring-[var(--color-accent)]')}>
            <span className="pl-1"><Graph row={rows[i]} width={width} /></span>
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {c.refs.map((r) => <RefBadge key={r} r={r} />)}
              <span className={cn('truncate', c.parents.length > 1 ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-primary)]')} title={c.subject}>{c.subject}</span>
            </span>
            <span className="w-14 shrink-0 truncate text-[10.5px] text-[var(--color-text-secondary)]" title={`${c.author} <${c.email}>`}>{c.author}</span>
            <span className="w-[66px] shrink-0 text-[10.5px] tabular-nums text-[var(--color-text-muted)]" title={shortDate(c.date)}>{shortDate(c.date).slice(3)}</span>
            <span className="w-[50px] shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">{c.hash.slice(0, 7)}</span>
            <span className="hidden group-hover:block group-focus-within:block"><RowMenu items={menu(c)} title={tr('提交操作')} /></span>
          </div>
        ))}
        {more && <button onClick={() => load(commits?.length ?? 0)} disabled={loading} className="m-2 text-[11.5px] text-[var(--color-accent)] hover:underline">{loading ? tr('加载中…') : tr('再加载 {n} 条', { n: PAGE })}</button>}
      </div>
      {sel && (
        <div className="flex min-h-0 flex-[2] flex-col border-t border-[var(--color-border-default)]" data-git-commit-detail>
          {!det ? <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">{tr('读取中…')}</div> : (
            <div className="flex min-h-0 flex-1">
              <div className="flex w-1/2 min-w-0 flex-col overflow-y-auto border-r border-[var(--color-border-subtle)] px-3 py-2">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                  <span className="font-mono">{det.hash.slice(0, 10)}</span>
                  <button title={tr('复制提交号')} onClick={() => copy(det.hash)} className={cn(IB, 'h-5 w-5')}><Copy className="h-3 w-3" /></button>
                  <span className="ml-auto truncate">{det.author} · {shortDate(det.date)}</span>
                </div>
                {det.refs.length > 0 && <div className="mb-1 flex flex-wrap gap-1">{det.refs.map((r) => <RefBadge key={r} r={r} />)}</div>}
                <pre className="mb-2 whitespace-pre-wrap break-words font-sans text-[12px] text-[var(--color-text-primary)]">{det.message}</pre>
                {det.parents.length > 1 && <div className="mb-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('合并提交，下面是相对第一个父提交 {p} 的改动', { p: det.parents[0].slice(0, 7) })}</div>}
                <div className="text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('改动的文件（{n}）', { n: det.files.length })}</div>
                {det.files.map((f) => (
                  <div key={f.path} className="group flex items-center">
                    <button data-git-commit-file={f.path} onClick={() => showFile(f.path)} title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                      className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-[2px] text-left text-[11.5px] hover:bg-[var(--color-bg-hover)]', fileDiff?.path === f.path && 'bg-[var(--color-bg-raised)]')}>
                      <span className={cn('w-3 shrink-0 text-center font-mono font-semibold', CODE_CLS[f.code[0]] ?? 'text-[var(--color-text-muted)]')}>{f.code[0]}</span>
                      <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{f.orig && <span className="text-[var(--color-text-muted)]">{f.orig} → </span>}{f.path}</span>
                    </button>
                    <button title={tr('与工作区比较\n这个版本的文件和你现在的文件差在哪')} onClick={() => ctx.openCompare(det.hash, undefined, f.path)} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><GitCompareArrows className="h-3 w-3" /></button>
                    {f.code[0] !== 'D' && <button title={tr('逐行追溯\n看这个版本里每一行是谁改的')} onClick={() => ctx.openBlame(f.path, det.hash)} className={cn(IB, 'h-5 w-5 hidden group-hover:flex')}><ScrollText className="h-3 w-3" /></button>}
                    {f.code[0] !== 'D' && <button data-git-restore-file title={tr('恢复到这个版本\n把工作区里的这个文件改回这个提交时的内容（先确认）')}
                      onClick={() => void ctx.run({ op: 'restoreFile', hash: det.hash, path: f.path }, { confirm: { title: tr('恢复文件版本'), danger: true, ok: tr('恢复'), text: tr('把工作区的 {path} 改成提交 {s}「{subject}」时的内容。\n现在这个文件里没提交的改动会被覆盖；恢复后它会出现在「更改」里，确认没问题再提交。', { path: f.path, s: det.hash.slice(0, 7), subject: det.message.split('\n')[0] }) }, done: tr('已恢复 {path}', { path: f.path }) })}
                      className={cn(IB, 'h-5 w-5 hidden hover:text-[var(--color-danger)] group-hover:flex')}><FileClock className="h-3 w-3" /></button>}
                  </div>
                ))}
              </div>
              <div className="w-1/2 min-w-0 overflow-y-auto px-3 py-2">
                {!fileDiff ? <div className="text-[11.5px] text-[var(--color-text-muted)]">{tr('点左边的文件看改动')}</div>
                  : fileDiff.err ? <div className="text-[11px] text-[var(--color-danger)]">{fileDiff.err}</div>
                  : fileDiff.text === undefined ? <div className="text-[11px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>
                  : fileDiff.text ? <DiffView diff={fileDiff.text} maxHeight="max-h-none" legend={fileDiff.path} />
                  : <div className="text-[11px] text-[var(--color-text-muted)]">{tr('（没有内容差异）')}</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
