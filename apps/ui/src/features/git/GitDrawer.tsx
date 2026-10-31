import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToDot, ArrowUp, Bot, CloudDownload, Crosshair, FolderOpen, GitBranch, Loader2, RefreshCw, Upload, X } from 'lucide-react'
import { GIT_OP_LABEL, gitConflictPrompt, gitOpNetwork, groupGitFiles, tk, tr, type GitInProgress, type GitOp, type GitStatusResult, type TerminalInfo } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Input } from '../../components/ui/Input.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { getTermCwd } from '../../lib/termCwd.js'
import { cn } from '../../lib/cn.js'
import { BTN, GitDialog, IB, RowMenu, errText, type DialogSpec, type GitCtx } from './gitUi.js'
import { GitChanges } from './GitChanges.js'
import { GitBranches } from './GitBranches.js'
import { GitHistory, type HistoryFilter } from './GitHistory.js'
import { GitStash } from './GitStash.js'
import { GitBlame } from './GitBlame.js'
import { GitMerge } from './GitMerge.js'
import { GitCompare } from './GitCompare.js'
import { GitChangelog, GitReview } from './GitAi.js'
import { GitRebase } from './GitRebase.js'

type Tab = 'changes' | 'branches' | 'history' | 'stash'
const PROGRESS_LABEL: Record<GitInProgress, string> = { merge: tk('正在合并'), rebase: tk('正在变基'), 'cherry-pick': tk('正在拣选'), revert: tk('正在还原') }
// 中止确认用的动作名（中文 = PROGRESS_LABEL 去掉「正在」）
const PROGRESS_NOUN: Record<GitInProgress, string> = { merge: tk('op|合并'), rebase: tk('op|变基'), 'cherry-pick': tk('op|拣选'), revert: tk('op|还原') }

// Git 面板（参照 VS Code / IDEA）：当前终端所在目录的仓库（本地 / SSH 都行）。
// 顶部：分支、领先 / 落后、抓取 / 拉取 / 推送；四页：更改（暂存、丢弃、提交、AI 写说明）/ 分支（含标签）/ 历史（提交图）/ 储藏。
// 读走独立通道（不在终端里刷屏）；写操作都是手动点的，危险的先确认，都记执行记录。切终端时由外层 key 重挂载。
// onWide：历史页需要宽一点，通知外层把抽屉加宽
export function GitDrawer({ term, onClose, onWide }: { term?: TerminalInfo; onClose: () => void; onWide?: (wide: boolean) => void }) {
  const tid = term?.id ?? ''
  const ok = !!term && !(term.type === 'ssh' && term.os === 'windows')
  const [dir, setDir] = useState('')
  const [dirDraft, setDirDraft] = useState('')   // 输入框草稿：回车 / 选择目录才成为当前仓库，操作后的自动刷新不会被没提交的路径带跑
  const [res, setRes] = useState<GitStatusResult>()
  const [progress, setProgress] = useState<GitInProgress>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [flash, setFlash] = useState('')
  const [tab, setTabState] = useState<Tab>('changes')
  const [busy, setBusy] = useState('')
  const [version, setVersion] = useState(0)
  const [dialog, setDialog] = useState<DialogSpec | null>(null)
  const [histFilter, setHistFilter] = useState<HistoryFilter>({})
  const [blame, setBlame] = useState<{ path: string; rev?: string } | null>(null)
  const [merge, setMerge] = useState<string | null>(null)
  const [compare, setCompare] = useState<{ a: string; b?: string; path?: string } | null>(null)
  const [changelog, setChangelog] = useState<{ from?: string } | null>(null)
  const [review, setReview] = useState<{ paths?: string[] } | null>(null)
  const lastErr = useRef('')
  const [rebase, setRebase] = useState<string | null>(null)
  const setTab = (t: Tab) => { setTabState(t); onWide?.(t === 'history') }
  useEffect(() => () => onWide?.(false), [])

  const st = res?.ok ? res.status : undefined
  const inflight = useRef(false), refetch = useRef(false)
  const dirRef = useRef(dir); dirRef.current = dir
  const refresh = useCallback((d = dir) => {
    if (!ok || !d) return
    // 读取中又有刷新请求：记下来，等这次结束再读一次（不能直接丢，否则慢主机上会把操作前的旧状态留在界面）
    if (inflight.current) { refetch.current = true; return }
    inflight.current = true; setLoading(true)
    client.git.status(tid, d).then((r) => {
      setRes(r); setErr('')
      if (r.ok) client.git.progress(tid, r.status.root).then(setProgress).catch(() => setProgress(undefined))
    }).catch((e) => setErr(errText(e)))
      .finally(() => {
        inflight.current = false; setLoading(false)
        if (refetch.current) { refetch.current = false; refresh(dirRef.current) }
      })
  }, [ok, tid, dir])
  // 起始目录：shell 集成报的终端当前目录，没有就问一次 pwd
  const followTerm = useCallback(async () => {
    const d = getTermCwd(tid) || await client.terminal.pwd(tid).catch(() => '') || ''
    if (!d) { setErr(tr('取不到终端当前目录：在下面输入仓库目录后回车')); return }
    setDir(d); setDirDraft(d); refresh(d)
  }, [tid, refresh])
  useEffect(() => { if (ok) void followTerm() }, [ok])

  const note = (t: string) => { setFlash(t); setTimeout(() => setFlash((f) => (f === t ? '' : f)), 3000) }
  // 写操作串行：双击 / 连点不能让两个操作交叉（储藏 ref 会移位，临时 index 也会互相覆盖）
  const opBusy = useRef(false)
  const exec = (o: GitOp, message?: string, done?: string): Promise<boolean> => {
    if (!st) return Promise.resolve(false)
    if (opBusy.current) return Promise.resolve(false)
    opBusy.current = true
    // busy 存 GIT_OP_LABEL 原值（GitChanges 按它判断是不是在提交），显示时再 tr()
    setBusy(GIT_OP_LABEL[o.op]); setErr('')
    const label = tr(GIT_OP_LABEL[o.op])
    return client.git.op(tid, st.root, o, message)
      .then((out) => { note(done ?? tr('{op}完成', { op: label })); if (gitOpNetwork(o) && out.trim()) note(tr('{name}：{desc}', { name: done ?? label, desc: out.trim().split('\n').at(-1) ?? '' })); return true })
      .catch((e) => { lastErr.current = errText(e); setErr(tr('{op}失败：{err}', { op: label, err: lastErr.current })); return false })
      .finally(() => { opBusy.current = false; setBusy(''); refresh(); setVersion((v) => v + 1) })
  }
  const run: GitCtx['run'] = (o, opt = {}) => {
    if (!opt.confirm) return exec(o, opt.message, opt.done)
    const c = opt.confirm
    return new Promise((resolve) => setDialog({ title: c.title, text: c.text, danger: c.danger, ok: c.ok, onOk: () => void exec(o, opt.message, opt.done).then(resolve), onCancel: () => resolve(false) }))
  }
  const ctx: GitCtx | undefined = st && term ? {
    tid, term, root: st.root, st, run, busy, version, ask: setDialog, openBlame: (path, rev) => setBlame({ path, rev }), openMerge: setMerge,
    openCompare: (a, b, path) => setCompare({ a, b, path }), openChangelog: (from) => setChangelog({ from }), openReview: (paths) => setReview({ paths }), openRebase: setRebase,
  } : undefined

  // 推送：没有上游就推到 origin 同名分支并设为上游（先问一下）；被拒（修改过已推送的提交 / 变基后）时提供强制推送
  const forcePush = (branch: string, setUpstream: boolean, confirm = true) => run({ op: 'push', branch, setUpstream, force: true }, {
    confirm: !confirm ? undefined : { title: tr('强制推送'), danger: true, ok: tr('强制推送'), text: tr('用 --force-with-lease 把 {branch} 推上去，覆盖远程上的这个分支。\n只有远程从你上次抓取后没被别人推过时才会成功（否则拒绝，不会覆盖别人的提交）。修改过上次提交或变基之后需要这样推。', { branch }) },
    done: tr('已强制推送'),
  })
  // 主进程把 git 报错换成了友好提示（gitOps.ts，已翻译）：原始英文关键词和当前语言的提示都要认
  const pushRejected = () => /rejected|non-fast-forward|fetch first|stale info|先「拉取」/i.test(lastErr.current) || lastErr.current.includes(tr('远程有你本地没有的提交：先「拉取」再推送'))   // i18n-ignore 匹配报错
  const push = () => {
    if (!st || st.detached) return
    const b = st.branch
    const offer = (ok: boolean) => { if (!ok && pushRejected()) setDialog({ title: tr('推送被拒绝'), ok: tr('强制推送…'), danger: true, text: tr('远程分支有你本地没有的提交（或你改写过已推送的提交）。\n· 想保留远程的提交：先「拉取」再推送\n· 确定要用本地的覆盖远程（比如刚修改过上次提交 / 变基过）：强制推送'), onOk: () => void forcePush(b, !st.upstream, false) }) }
    if (st.upstream) void run({ op: 'push', branch: b }, { done: tr('已推送') }).then(offer)
    else void run({ op: 'push', branch: b, setUpstream: true }, { confirm: { title: tr('发布分支'), ok: tr('推送'), text: tr('{b} 还没有上游分支。推送到 origin/{b} 并设为上游？', { b }) }, done: tr('已发布分支') }).then(offer)
  }
  // 继续：解决冲突后和当前分支一模一样（空提交）时 git 不让继续，直接问要不要跳过这个提交（默认就是它）
  const continueOp = (what: 'rebase' | 'cherry-pick' | 'revert') => void run({ op: 'continue', what }, { done: tr('已继续') }).then((ok) => {
    const empty = /nothing to commit|is now empty|--skip to skip|--allow-empty|已经没有任何改动/i.test(lastErr.current)   // i18n-ignore 匹配报错
      || lastErr.current.includes(tr('这个提交解决冲突后已经没有任何改动了（和当前分支一样）：点横幅里的「跳过」跳过它继续，或「中止」放弃整个操作'))
    if (ok || !empty) return
    setErr('')
    setDialog({ title: tr('这个提交已经没有改动了'), ok: tr('跳过它，继续'), text: tr('解决冲突后的结果和当前分支完全一样，这个提交已经没有任何改动可提交，git 不能「继续」。\n跳过它不会丢东西（它的改动本来就已经不在了），然后接着处理后面的提交。'), onOk: () => void run({ op: 'skip', what }, { done: tr('已跳过并继续') }) })
  })
  const pull = (mode?: 'merge' | 'rebase' | 'ff') => void run({ op: 'pull', ...(mode ? { mode } : {}) }, { done: mode === 'rebase' ? tr('已拉取（变基）') : tr('已拉取') })
  const askAi = () => {
    if (!st) return
    sendToChat(gitConflictPrompt({ terminalTitle: term?.title ?? '', root: st.root, branch: st.branch, files: groupGitFiles(st.files).conflict.map((f) => f.path) }))
    onClose()
  }

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">Git</span>
      {st && <button data-git-branch onClick={() => setTab('branches')} title={st.upstream ? tr('上游：{up}\n点击管理分支', { up: st.upstream }) : tr('没有上游分支\n点击管理分支')} className="min-w-0 truncate rounded bg-[var(--color-bg-raised)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">{st.detached ? tr('分离头指针 {oid}', { oid: st.oid?.slice(0, 7) ?? '' }) : st.branch}</button>}
      {st && (st.ahead > 0 || st.behind > 0) && (
        <span title={tr('领先上游 {a} 个提交，落后 {b} 个', { a: st.ahead, b: st.behind })} className="flex shrink-0 items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]">
          {st.ahead > 0 && <span className="flex items-center"><ArrowUp className="h-3 w-3" />{st.ahead}</span>}
          {st.behind > 0 && <span className="flex items-center"><ArrowDown className="h-3 w-3" />{st.behind}</span>}
        </span>
      )}
      <span className="ml-auto" />
      {busy && <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><Loader2 className="h-3 w-3 animate-spin" />{tr('{op}中…', { op: tr(busy) })}</span>}
      {st && <>
        <button data-git-fetch title={tr('抓取：更新所有远程分支的信息（不改本地分支）')} disabled={!!busy} onClick={() => void run({ op: 'fetch' }, { done: tr('已抓取') })} className={IB}><ArrowDownToDot className="h-3.5 w-3.5" /></button>
        <RowMenu title={st.upstream ? tr('拉取\n从 {up} 拉取，点开选方式', { up: st.upstream }) : tr('当前分支没有上游，不能拉取')} disabled={!!busy || !st.upstream} icon={<CloudDownload className="h-3.5 w-3.5" />} btnClass={IB} items={[
          { label: tr('拉取（按仓库配置）'), onClick: () => pull() },
          { label: tr('拉取并合并（merge）'), onClick: () => pull('merge') },
          { label: tr('拉取并变基（rebase，历史保持一条线）'), onClick: () => pull('rebase') },
          { label: tr('只快进（ff-only，有分叉就不拉）'), onClick: () => pull('ff') },
        ]} />
        <button data-git-push title={st.detached ? tr('分离头指针不能推送') : st.upstream ? tr('推送到 {up}', { up: st.upstream }) : tr('发布分支：推送到 origin 并设为上游')} disabled={!!busy || st.detached} onClick={push} className={IB}><Upload className="h-3.5 w-3.5" /></button>
      </>}
      {ok && <button title={tr('刷新')} disabled={loading} onClick={() => { refresh(); setVersion((v) => v + 1) }} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )
  if (!ok) return (
    <div className="flex h-full flex-col">{header}
      <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('Git 面板支持本地终端和 Linux / macOS 的 SSH 终端：先切到一个终端再打开。')}</div>
    </div>
  )

  const conflicts = st ? st.files.filter((f) => f.conflict).length : 0
  // 进行中操作的当前阶段：没有冲突时，有暂存的改动 = 可以继续；只有未暂存的 = 忘了暂存；什么都没有 = 解决后变成空提交，只能跳过
  const gs = st ? groupGitFiles(st.files) : undefined
  const stage: 'conflict' | 'ready' | 'unstaged' | 'empty' = conflicts ? 'conflict' : !gs ? 'ready' : gs.staged.length ? 'ready' : gs.unstaged.length ? 'unstaged' : 'empty'
  return (
    <div className="flex h-full flex-col" data-git-drawer>
      {header}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <Input size="sm" value={dirDraft} onChange={(e) => setDirDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { setDir(dirDraft); refresh(dirDraft) } }}
          placeholder={tr('仓库目录（回车读取）')} title={tr('仓库里的任意目录；默认取终端当前目录')} className="font-mono text-[11px]" data-git-dir />
        <button title={tr('跟随终端当前目录')} onClick={() => void followTerm()} className={IB}><Crosshair className="h-3.5 w-3.5" /></button>
        {term?.type === 'local' && <button title={tr('选择目录…')} className={IB}
          onClick={() => client.system.pickDirectory().then((d) => { if (d) { setDir(d); setDirDraft(d); refresh(d) } }).catch(() => {})}><FolderOpen className="h-3.5 w-3.5" /></button>}
      </div>
      {st && (
        <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--color-border-subtle)] px-2">
          {([['changes', st.files.length ? tr('更改 {n}', { n: st.files.length }) : tr('更改')], ['branches', tr('分支')], ['history', tr('历史')], ['stash', tr('储藏')]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} data-git-tab={k} onClick={() => setTab(k)} className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-[11.5px]', tab === k ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>{l}</button>
          ))}
          {flash && <span className="ml-auto min-w-0 truncate pr-1 text-[11px] text-[var(--color-success)]" title={flash}>{flash}</span>}
        </div>
      )}
      {err && <div data-git-err className="max-h-32 shrink-0 overflow-y-auto whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {res && !res.ok && <div className="px-3 py-3 text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        <div className="font-medium text-[var(--color-text-secondary)]">{res.message}</div>
        {res.problem === 'norepo' && <div className="mt-1">{tr('换到仓库目录（cd 进去后点「跟随终端当前目录」，或在上面输入路径回车）。')}</div>}
      </div>}
      {!res && loading && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>}
      {st && ctx && <>
        {(progress || conflicts > 0) && (
          <div data-git-progress={progress ?? ''} className="flex shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-1.5 text-[11.5px] text-[var(--color-danger)]">
            <span className="min-w-0 flex-1 truncate" title={conflicts ? tr('在「更改」页点冲突文件打开合并编辑器，逐个解决后「保存并标记已解决」；也可以交给 AI，或中止这次操作') : stage === 'empty' && progress !== 'merge' ? tr('冲突解决后的结果和当前分支完全一样，这个提交没有可提交的改动了；git 要你明确跳过它（不会丢东西）') : ''}>
              {tr('{name}：{desc}', {
                name: progress ? tr(PROGRESS_LABEL[progress]) : tr('有冲突'),
                desc: conflicts ? tr('{n} 个文件冲突', { n: conflicts }) : stage === 'empty' && progress !== 'merge' ? tr('这个提交解决后已经没有改动') : stage === 'unstaged' ? tr('改好的文件还没暂存，先在下面暂存') : progress === 'merge' ? tr('冲突已解决，提交即可完成合并') : tr('冲突已解决，点「继续」'),
              })}
            </span>
            {conflicts > 0 && <button data-git-ai-conflict onClick={askAi} title={tr('把冲突文件交给对话里的 AI 处理（改文件走现有授权确认，可撤销本轮）')} className={cn(BTN, 'text-[var(--color-accent)]')}><Bot className="h-3 w-3" />{tr('让 AI 解决冲突')}</button>}
            {progress && progress !== 'merge' && stage === 'empty' && <button data-git-skip-continue disabled={!!busy} onClick={() => void run({ op: 'skip', what: progress }, { done: tr('已跳过并继续') })} title={tr('跳过并继续\n这个提交已经没有改动，跳过它不会丢东西，接着处理后面的')} className={cn(BTN, 'text-[var(--color-accent)]')}>{tr('跳过并继续')}</button>}
            {progress && progress !== 'merge' && stage === 'ready' && <button disabled={!!busy} onClick={() => continueOp(progress)} className={BTN}>{tr('继续')}</button>}
            {progress && progress !== 'merge' && stage !== 'empty' && <button data-git-skip disabled={!!busy} onClick={() => void run({ op: 'skip', what: progress }, { confirm: { title: tr('跳过当前提交'), danger: true, ok: tr('跳过'), text: tr('不应用正在处理的这个提交（它的改动不会进当前分支），接着处理后面的。适合「解决冲突后已经没有改动」或确定不要这个提交的情况。') }, done: tr('已跳过') })} title={tr('跳过\n不要当前这个提交，接着处理后面的')} className={BTN}>{tr('跳过')}</button>}
            {progress && <button data-git-abort disabled={!!busy} onClick={() => void run({ op: 'abort', what: progress }, { confirm: { title: tr('中止{what}', { what: tr(PROGRESS_NOUN[progress]) }), danger: true, ok: tr('中止'), text: tr('放弃这次{what}，回到开始之前的状态（解决到一半的冲突会丢掉）？', { what: tr(PROGRESS_NOUN[progress]) }) }, done: tr('已中止') })} className={cn(BTN, 'text-[var(--color-danger)]')}>{tr('中止')}</button>}
          </div>
        )}
        {tab === 'changes' && <GitChanges ctx={ctx} refresh={() => refresh()} setErr={setErr} onFileHistory={(path) => { setHistFilter({ path }); setTab('history') }} />}
        {tab === 'branches' && <GitBranches ctx={ctx} onShowLog={(ref) => { setHistFilter({ ref }); setTab('history') }} />}
        {tab === 'history' && <GitHistory ctx={ctx} filter={histFilter} setFilter={setHistFilter} />}
        {tab === 'stash' && <GitStash ctx={ctx} />}
      </>}
      {blame && ctx && <GitBlame ctx={ctx} path={blame.path} rev={blame.rev} onClose={() => setBlame(null)} onShowCommit={(hash) => { setBlame(null); setHistFilter({ select: hash }); setTab('history') }} />}
      {merge && ctx && <GitMerge ctx={ctx} path={merge} onClose={() => setMerge(null)} />}
      {compare && ctx && <GitCompare ctx={ctx} a={compare.a} b={compare.b} path={compare.path} onClose={() => setCompare(null)} onShowCommit={(hash) => { setHistFilter({ select: hash }); setTab('history') }} />}
      {changelog && ctx && <GitChangelog ctx={ctx} from={changelog.from} onClose={() => setChangelog(null)} />}
      {rebase && ctx && <GitRebase ctx={ctx} from={rebase} onClose={() => setRebase(null)} />}
      {review && ctx && <GitReview ctx={ctx} paths={review.paths} onClose={() => setReview(null)} />}
      {dialog && <GitDialog spec={dialog} prod={term?.env === 'prod'} onClose={() => setDialog(null)} onCancel={() => { dialog.onCancel?.(); setDialog(null) }} />}
    </div>
  )
}
