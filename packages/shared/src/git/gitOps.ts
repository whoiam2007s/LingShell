// Git 面板（纯逻辑）：分支 / 历史（含提交图）/ 储藏的读取命令与解析，以及所有写操作（切换、合并、推送、重置…）的命令构造。
// 同 gitStatus.ts：走独立通道、路径与引用名一律校验后单引号拼接；写操作由界面手动触发（危险的先确认），都记执行记录。
import { GIT_CMD, GIT_MARK, GIT_PATH_ENV, gitEnter, gitQ, gitShQuote } from './gitStatus.js'
import { tk, tr } from '../i18n/i18n.js'

const M = GIT_MARK
const GIT = GIT_CMD
const RS = '\x1e', US = '\x1f'
const rc = `printf '\\n${M}rc:%s\\n' "$?"`
// 网络操作不能卡在输入用户名 / 密码 / 指纹上（独立通道没有终端）：一律不交互，失败了提示去终端里先操作一次
const NET_ENV = `export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"`

// ── 校验 ──
/** 分支 / 标签名：git check-ref-format 的常见规则（不允许空白、..、~^:?*[\、@{、开头 -、结尾 / . .lock） */
export function isRefName(s: unknown): s is string {
  // eslint-disable-next-line no-control-regex -- 就是要拒绝控制字符
  return typeof s === 'string' && s.length > 0 && s.length <= 250 && !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$|\/\./.test(s) && s !== '@'
}
export const isCommitId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{4,64}$/i.test(s)
export const isStashRef = (s: unknown): s is string => typeof s === 'string' && /^stash@\{\d{1,4}\}$/.test(s)
const ref = (s: string) => { if (!isRefName(s)) throw new Error(tr('非法的名称：{v}', { v: String(s).slice(0, 60) })); return gitShQuote(s) }
const cid = (s: string) => { if (!isCommitId(s)) throw new Error(tr('非法的提交号')); return s }
const stash = (s: string) => { if (!isStashRef(s)) throw new Error(tr('非法的储藏')); return gitShQuote(s) }

// ── 分支 / 标签 ──
export interface GitRef { kind: 'local' | 'remote' | 'tag'; name: string; full: string; current: boolean; upstream?: string; ahead: number; behind: number; gone: boolean; oid: string; date: string; subject: string }
export const gitRefsCommand = (root: string) =>
  `${gitEnter(root)}; ${GIT} for-each-ref --sort=-creatordate --format='%(HEAD)${US}%(refname)${US}%(refname:short)${US}%(upstream:short)${US}%(upstream:track,nobracket)${US}%(objectname:short)${US}%(creatordate:iso-strict)${US}%(contents:subject)${RS}' refs/heads refs/remotes refs/tags 2>&1; ${rc}`

export function parseGitRefs(out: string): GitRef[] {
  const refs: GitRef[] = []
  for (const rec of out.split(RS)) {
    const f = rec.replace(/^\s+/, '').split(US)
    if (f.length < 8) continue
    const [head, full, short, upstream, track, oid, date, subject] = f
    if (full.endsWith('/HEAD')) continue   // origin/HEAD 只是个指针
    const kind = full.startsWith('refs/heads/') ? 'local' : full.startsWith('refs/remotes/') ? 'remote' : 'tag'
    const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
    refs.push({ kind, name: short, full, current: head === '*', ...(upstream ? { upstream } : {}), ahead, behind, gone: track === 'gone', oid, date, subject: subject.trim() })
  }
  return refs
}

// ── 历史 ──
export interface GitCommit { hash: string; parents: string[]; author: string; email: string; date: string; refs: string[]; subject: string }
export interface GitLogQuery { all?: boolean; skip?: number; limit?: number; grep?: string; author?: string; path?: string; ref?: string; pickaxe?: string }   // pickaxe：按代码内容搜（git log -S，找加入 / 删除了这段内容的提交）
export const GIT_LOG_PAGE = 200
export function gitLogCommand(root: string, o: GitLogQuery = {}): string {
  const lim = Math.min(Math.max(1, Math.floor(o.limit ?? GIT_LOG_PAGE)), 1000), skip = Math.max(0, Math.floor(o.skip ?? 0))
  const args = [
    `--topo-order -n ${lim} --skip=${skip} --date=iso-strict --decorate=full`,
    `--format='%H${US}%P${US}%an${US}%ae${US}%ad${US}%D${US}%s${RS}'`,
    o.grep ? `-i --grep=${gitShQuote(o.grep.slice(0, 200))}` : '',
    o.author ? `--author=${gitShQuote(o.author.slice(0, 100))}` : '',
    o.pickaxe ? `-S${gitShQuote(o.pickaxe.slice(0, 300))}` : '',
    o.ref ? ref(o.ref) : o.all ? '--branches --remotes --tags HEAD' : '',   // 不用 --all：会把储藏的内部提交也画进图里
    o.path ? `-- ${gitQ(o.path)}` : '',
  ].filter(Boolean).join(' ')
  // 空仓库（还没有提交）git log 报错：当成没有历史
  return `${gitEnter(root)}; git rev-parse -q --verify HEAD >/dev/null 2>&1 || { printf '\\n${M}rc:0\\n'; exit 0; }; ${GIT} log ${args} 2>&1; ${rc}`
}
const shortRef = (r: string) => r.replace(/^HEAD -> refs\/heads\//, 'HEAD -> ').replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '').replace(/^tag: refs\/tags\//, 'tag: ')
export function parseGitLog(out: string): GitCommit[] {
  const res: GitCommit[] = []
  for (const rec of out.split(RS)) {
    const f = rec.replace(/^\s+/, '').split(US)
    if (f.length < 7 || !/^[0-9a-f]{7,64}$/.test(f[0])) continue
    res.push({ hash: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2], email: f[3], date: f[4], refs: f[5] ? f[5].split(', ').map(shortRef).filter((r) => r !== 'refs/stash' && !r.endsWith('/HEAD')) : [], subject: f[6] })
  }
  return res
}

/**
 * 提交图（同 IDEA / VS Code 的 Graph）：按 --topo-order 的顺序给每个提交分配一条竖线（lane）。
 * 每行返回：节点所在列、穿过这一行的线（上半段 from→节点 / 下半段 节点→to），界面画成一小块 SVG。
 * 空出来的列留着复用，不做压缩（线不会左右乱跳）。
 */
export interface GraphLine { from: number; to: number; half: 'top' | 'bottom'; color: number }
export interface GraphRow { col: number; color: number; lines: GraphLine[]; width: number }
export function gitGraph(commits: Pick<GitCommit, 'hash' | 'parents'>[]): GraphRow[] {
  let lanes: (string | null)[] = []
  let colors: number[] = []
  let next = 0
  const rows: GraphRow[] = []
  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) { col = lanes.length; lanes.push(null) } colors[col] = next++ }
    const color = colors[col]
    const lines: GraphLine[] = []
    // 上半段：等这个提交的线都汇到节点，其余的直穿
    lanes.forEach((h, i) => { if (h !== null) lines.push({ from: i, to: h === c.hash ? col : i, half: 'top', color: colors[i] }) })
    const before = lanes.slice()
    lanes = lanes.map((h) => (h === c.hash ? null : h))
    // 父提交：第一个接着本列往下走，其余的已有线就并过去，没有就开新列
    const [p0, ...rest] = c.parents
    lanes[col] = p0 ?? null
    for (const p of rest) {
      if (lanes.includes(p)) continue
      let j = lanes.indexOf(null)
      if (j < 0) { j = lanes.length; lanes.push(null) }
      lanes[j] = p; colors[j] = next++
    }
    // 下半段：从节点出发的（父提交所在列）+ 直穿的
    lanes.forEach((h, i) => {
      if (h === null) return
      const fromNode = c.parents.includes(h) && (i === col || before[i] !== h)
      lines.push({ from: fromNode ? col : i, to: i, half: 'bottom', color: colors[i] })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    colors = colors.slice(0, Math.max(lanes.length, col + 1))
    rows.push({ col, color, lines, width: Math.max(col + 1, before.length, lanes.length) })
  }
  return rows
}

// ── 提交详情 ──
export interface GitChangedFile { code: string; path: string; orig?: string }
export interface GitCommitDetail { hash: string; parents: string[]; author: string; email: string; date: string; committer: string; committerDate: string; refs: string[]; message: string; files: GitChangedFile[] }
export const gitShowCommand = (root: string, hash: string) =>
  `${gitEnter(root)}; ${GIT} show -s --decorate=full --date=iso-strict --format='%H${US}%P${US}%an${US}%ae${US}%ad${US}%cn${US}%cd${US}%D${US}%B${RS}' ${cid(hash)} 2>&1; ${againstParent(hash, '--name-status -z')}; ${rc}`
/** 提交的改动：合并提交对第一个父提交（diff-tree 的 --first-parent 老版本不认），根提交对空树 */
const againstParent = (hash: string, args: string, path = '') =>
  `if git rev-parse -q --verify ${cid(hash)}^2 >/dev/null 2>&1; then ${GIT} diff --no-ext-diff -M ${args} ${cid(hash)}^1 ${cid(hash)}${path}; else ${GIT} diff-tree --no-ext-diff --no-commit-id -r -M --root ${args} ${cid(hash)}${path}; fi 2>&1`
/** name-status -z：状态 \0 路径 [\0 新路径] */
export function parseNameStatusZ(s: string): GitChangedFile[] {
  const parts = s.replace(/^\n+/, '').split('\0')
  const out: GitChangedFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].trim()
    if (!/^[ACDMRTUX]\d*$/.test(code)) continue
    if (code[0] === 'R' || code[0] === 'C') { out.push({ code: code[0], orig: parts[i + 1], path: parts[i + 2] }); i += 2 }
    else { out.push({ code, path: parts[i + 1] }); i += 1 }
  }
  return out.filter((f) => f.path)
}
export function parseGitShow(out: string): GitCommitDetail | undefined {
  const t = out.replace(/\r\n/g, '\n')
  const i = t.indexOf(RS)
  if (i < 0) return undefined
  const f = t.slice(0, i).split(US)
  if (f.length < 9) return undefined
  const ri = t.lastIndexOf(`\n${M}rc:`)
  return {
    hash: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2], email: f[3], date: f[4], committer: f[5], committerDate: f[6],
    refs: f[7] ? f[7].split(', ').map(shortRef) : [], message: f.slice(8).join(US).trim(),
    files: parseNameStatusZ(t.slice(i + 1, ri < 0 ? undefined : ri)),
  }
}
/** 某个提交里某个文件的改动（合并提交对第一个父提交；根提交对空树） */
export const gitCommitDiffCommand = (root: string, hash: string, path: string) =>
  `${gitEnter(root)}; ${againstParent(hash, '-p', ` -- ${gitQ(path)}`)} | head -c 400000`

// ── 储藏 ──
export interface GitStash { ref: string; hash: string; date: string; message: string }
export const gitStashListCommand = (root: string) => `${gitEnter(root)}; ${GIT} stash list --format='%gd${US}%H${US}%cI${US}%gs${RS}' 2>&1; ${rc}`
export function parseGitStashes(out: string): GitStash[] {
  return out.split(RS).flatMap((rec) => {
    const f = rec.replace(/^\s+/, '').split(US)
    return f.length >= 4 && isStashRef(f[0]) ? [{ ref: f[0], hash: f[1], date: f[2], message: f[3] }] : []
  })
}
/** 储藏里改了哪些文件（含未跟踪的：存在第三个父提交里） */
export const gitStashFilesCommand = (root: string, s: string) =>
  // 没有 -u 的储藏没有第三个父提交：rev-parse 失败不能让整条命令以 1 退出（以前这种情况详情页必报错）
  `${gitEnter(root)}; ${GIT} diff --name-status -z -M ${stash(s)}^1 ${stash(s)} 2>&1; echo; echo '${M}untracked'; ${GIT} rev-parse -q --verify ${stash(s)}^3 >/dev/null 2>&1 && ${GIT} ls-tree -r -z --name-only ${stash(s)}^3 2>&1; true; ${rc}`
export function parseStashFiles(out: string): GitChangedFile[] {
  const t = out.replace(/\r\n/g, '\n')
  const u = t.indexOf(`${M}untracked`), ri = t.lastIndexOf(`\n${M}rc:`)
  const tracked = parseNameStatusZ(t.slice(0, u < 0 ? ri : u))
  const untracked = u < 0 ? [] : t.slice(u + M.length + 10, ri < 0 ? undefined : ri).split('\0').map((x) => x.replace(/^\n+/, '')).filter(Boolean).map((path) => ({ code: '?', path }))
  return [...tracked, ...untracked]
}
export const gitStashDiffCommand = (root: string, s: string, path: string, untracked: boolean) =>
  `${gitEnter(root)}; ${untracked ? `${GIT} show --no-ext-diff ${stash(s)}^3 -- ${gitQ(path)}` : `${GIT} diff --no-ext-diff -M ${stash(s)}^1 ${stash(s)} -- ${gitQ(path)}`} 2>&1 | head -c 400000`

// ── 写操作 ──
export type GitOp =
  | { op: 'fetch' } | { op: 'pull'; rebase?: boolean; mode?: 'merge' | 'rebase' | 'ff' }
  // force：--force-with-lease（远程在你上次抓取之后被别人推过就拒绝，不会盲目覆盖）
  | { op: 'push'; branch: string; setUpstream?: boolean; tags?: boolean; force?: boolean; remote?: string }
  | { op: 'undoCommit' } | { op: 'ignore'; patterns: string[] } | { op: 'restoreFile'; hash: string; path: string }
  | { op: 'checkout'; branch: string } | { op: 'checkoutRemote'; remote: string; local: string } | { op: 'checkoutCommit'; hash: string }
  | { op: 'createBranch'; name: string; from?: string; checkout: boolean } | { op: 'renameBranch'; from: string; to: string }
  | { op: 'deleteBranch'; name: string; force: boolean } | { op: 'deleteRemoteBranch'; remote: string; name: string }
  | { op: 'merge'; ref: string; noFf?: boolean } | { op: 'rebase'; onto: string }
  | { op: 'createTag'; name: string; at?: string; message?: string } | { op: 'deleteTag'; name: string } | { op: 'pushTag'; name: string; remote?: string }
  // hashes：一次拣选 / 还原多个（拣选按从旧到新、还原按从新到旧的顺序给）
  | { op: 'cherryPick'; hash: string; hashes?: string[] } | { op: 'revert'; hash: string; hashes?: string[] }
  | { op: 'remoteAdd'; name: string; url: string } | { op: 'remoteRemove'; name: string } | { op: 'remoteRename'; from: string; to: string } | { op: 'remoteSetUrl'; name: string; url: string }
  // 交互式变基：from = 从这个提交（含）开始整理到 HEAD；steps 按新的顺序给，message 用于改说明 / 压缩后的说明
  // expectedHead：打开整理窗口时的 HEAD，执行前校验没有被外部提交 / 切换分支
  | { op: 'interactiveRebase'; from: string; root: boolean; steps: RebaseStep[]; expectedHead?: string } | { op: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { op: 'discard'; paths: string[]; untracked: string[] }
  | { op: 'stashPush'; message?: string; untracked: boolean } | { op: 'stashApply'; ref: string } | { op: 'stashPop'; ref: string } | { op: 'stashDrop'; ref: string }
  | { op: 'abort'; what: 'merge' | 'rebase' | 'cherry-pick' | 'revert' } | { op: 'continue'; what: 'rebase' | 'cherry-pick' | 'revert' } | { op: 'skip'; what: 'rebase' | 'cherry-pick' | 'revert' }
  // exclude：只提交部分已暂存的文件时，这次不提交的那些（它们留在暂存区，按块暂存的内容也不动）
  | { op: 'commit'; amend: boolean; push: boolean; branch: string; exclude?: string[] }
  // 按块：补丁内容走 stdin。cached = 作用于暂存区；reverse = 反向（取消暂存 / 丢弃）
  | { op: 'applyPatch'; path: string; cached: boolean; reverse: boolean }
  // 合并编辑器保存：文件内容走 stdin 原样写入，add = 同时标记为已解决；
  // expectedHash = 打开时读到的 git blob 哈希，文件被外部改过就拒绝覆盖
  | { op: 'resolveFile'; path: string; add: boolean; expectedHash?: string }

/** 操作的中文名（执行记录、提示用） */
export const GIT_OP_LABEL: Record<GitOp['op'], string> = {
  fetch: tk('抓取'), pull: tk('拉取'), push: tk('推送'), checkout: tk('切换分支'), checkoutRemote: tk('检出远程分支'), checkoutCommit: tk('检出提交'),
  createBranch: tk('新建分支'), renameBranch: tk('重命名分支'), deleteBranch: tk('删除分支'), deleteRemoteBranch: tk('删除远程分支'),
  merge: tk('合并'), rebase: tk('变基'), createTag: tk('新建标签'), deleteTag: tk('删除标签'), pushTag: tk('推送标签'),
  cherryPick: tk('拣选提交'), revert: tk('还原提交'), reset: tk('重置'), discard: tk('丢弃改动'),
  stashPush: tk('储藏'), stashApply: tk('应用储藏'), stashPop: tk('弹出储藏'), stashDrop: tk('删除储藏'), abort: tk('中止'), continue: tk('继续'), skip: tk('跳过当前提交'), commit: tk('提交'),
  applyPatch: tk('按块暂存'), resolveFile: tk('保存合并结果'),
  undoCommit: tk('撤销上次提交'), ignore: tk('加入 .gitignore'), restoreFile: tk('恢复文件版本'),
  remoteAdd: tk('添加远程'), remoteRemove: tk('删除远程'), remoteRename: tk('重命名远程'), remoteSetUrl: tk('修改远程地址'), interactiveRebase: tk('整理提交（交互式变基）'),
}
/** 会改写历史 / 丢数据的：界面二次确认（生产主机再加醒目提示） */
export const gitOpDangerous = (o: GitOp) => o.op === 'discard' || o.op === 'deleteBranch' || o.op === 'deleteRemoteBranch' || o.op === 'stashDrop' || o.op === 'checkoutCommit'
  || (o.op === 'reset' && o.mode === 'hard') || o.op === 'rebase' || (o.op === 'commit' && o.amend) || o.op === 'deleteTag'
  || (o.op === 'applyPatch' && o.reverse && !o.cached) || (o.op === 'push' && !!o.force) || o.op === 'undoCommit' || o.op === 'restoreFile'
export const gitOpNetwork = (o: GitOp) => o.op === 'fetch' || o.op === 'pull' || o.op === 'push' || o.op === 'pushTag' || o.op === 'deleteRemoteBranch' || (o.op === 'commit' && o.push)

const remoteName = (s: string) => { if (!/^[\w.-]{1,100}$/.test(s) || s.startsWith('-')) throw new Error(tr('非法的远程名')); return s }

/** 写操作 → { cmd, audit（执行记录里显示的命令）, stdin? }。commit 的说明从 stdin 进 */
export function gitOpCommand(root: string, o: GitOp, message?: string): { cmd: string; audit: string } {
  let body: string, audit: string
  switch (o.op) {
    case 'fetch': body = audit = 'git fetch --all --prune'; break
    case 'pull': {
      const mode = o.mode ?? (o.rebase ? 'rebase' : undefined)
      body = audit = `git pull${mode === 'rebase' ? ' --rebase' : mode === 'merge' ? ' --no-rebase' : mode === 'ff' ? ' --ff-only' : ''}`
      break
    }
    case 'push': {
      const b = ref(o.branch), f = o.force ? ' --force-with-lease' : ''
      // 没有上游：推到 origin 同名分支并设为上游（同 VS Code 的「发布分支」）
      const rm = remoteName(o.remote ?? 'origin')
      // 指定了远程 / 没有上游：推到该远程同名分支并设为上游（同 VS Code 的「发布分支」）
      body = o.setUpstream || o.remote ? `git push${f} -u ${rm} ${b}` : `git push${f}${o.tags ? ' --follow-tags' : ''}`
      audit = o.setUpstream || o.remote ? `git push${f} -u ${rm} ${o.branch}` : body
      break
    }
    // 撤销上次提交：改动回到暂存区；只有一个提交时删掉 HEAD 引用（回到「还没有提交」）。
    // 浅克隆里 HEAD~1 不存在并不代表只有一个提交，删 HEAD 会把分支变成 unborn，必须拒绝
    case 'undoCommit': body = `if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then echo ${gitShQuote(tr('浅克隆仓库没有完整历史，不能撤销提交（先在终端里 git fetch --unshallow）'))}; exit 1; fi; ` + 'if git rev-parse -q --verify HEAD~1 >/dev/null; then git reset --soft HEAD~1; else git update-ref -d HEAD; fi'; audit = 'git reset --soft HEAD~1'; break
    case 'ignore': {
      if (!Array.isArray(o.patterns) || !o.patterns.length || o.patterns.some((p) => typeof p !== 'string' || !p.trim() || /[\r\n\0]/.test(p) || p.length > 500)) throw new Error(tr('非法的忽略规则'))
      // 规则走 stdin 追加到仓库根的 .gitignore；原文件末尾没换行先补一个
      body = `cd "$(git rev-parse --show-toplevel)" && { [ -s .gitignore ] && [ -n "$(tail -c 1 .gitignore)" ] && echo >> .gitignore; cat >> .gitignore; }`
      audit = `加入 .gitignore：${o.patterns.join('  ')}`.slice(0, 300)   // i18n-ignore 执行记录（存盘）
      break
    }
    case 'restoreFile': body = `${GIT_PATH_ENV} git restore --source=${cid(o.hash)} --worktree -- ${gitQ(o.path)} 2>/dev/null || ${GIT_PATH_ENV} git checkout ${cid(o.hash)} -- ${gitQ(o.path)}`; audit = `git restore --source=${o.hash.slice(0, 10)} -- ${o.path}`; break
    case 'checkout': body = `git switch ${ref(o.branch)} 2>&1 || git checkout ${ref(o.branch)}`; audit = `git switch ${o.branch}`; break
    case 'checkoutRemote': body = `git switch -c ${ref(o.local)} --track ${ref(o.remote)}`; audit = `git switch -c ${o.local} --track ${o.remote}`; break
    case 'checkoutCommit': body = `git checkout --detach ${cid(o.hash)}`; audit = body; break
    case 'createBranch': body = `git ${o.checkout ? 'switch -c' : 'branch'} ${ref(o.name)}${o.from ? ` ${isCommitId(o.from) ? o.from : ref(o.from)}` : ''}`; audit = `git ${o.checkout ? 'switch -c' : 'branch'} ${o.name}${o.from ? ` ${o.from}` : ''}`; break
    case 'renameBranch': body = `git branch -m ${ref(o.from)} ${ref(o.to)}`; audit = `git branch -m ${o.from} ${o.to}`; break
    case 'deleteBranch': body = `git branch ${o.force ? '-D' : '-d'} ${ref(o.name)}`; audit = `git branch ${o.force ? '-D' : '-d'} ${o.name}`; break
    case 'deleteRemoteBranch': body = `git push ${remoteName(o.remote)} --delete ${ref(o.name)}`; audit = `git push ${o.remote} --delete ${o.name}`; break
    case 'merge': body = `git merge --no-edit${o.noFf ? ' --no-ff' : ''} ${ref(o.ref)}`; audit = `git merge${o.noFf ? ' --no-ff' : ''} ${o.ref}`; break
    case 'rebase': body = `git rebase ${ref(o.onto)}`; audit = `git rebase ${o.onto}`; break
    case 'createTag': body = o.message ? `git tag -a ${ref(o.name)} -F -${o.at ? ` ${cid(o.at)}` : ''}` : `git tag ${ref(o.name)}${o.at ? ` ${cid(o.at)}` : ''}`; audit = `git tag ${o.message ? '-a ' : ''}${o.name}${o.at ? ` ${o.at.slice(0, 10)}` : ''}`; break
    case 'deleteTag': body = `git tag -d ${ref(o.name)}`; audit = `git tag -d ${o.name}`; break
    case 'pushTag': body = `git push ${remoteName(o.remote ?? 'origin')} ${gitShQuote(`refs/tags/${o.name}`)}`; ref(o.name); audit = `git push ${o.remote ?? 'origin'} ${o.name}`; break
    case 'cherryPick': { const hs = (o.hashes?.length ? o.hashes : [o.hash]).map(cid); body = `git cherry-pick ${hs.join(' ')}`; audit = `git cherry-pick ${hs.map((h) => h.slice(0, 10)).join(' ')}`; break }
    case 'revert': { const hs = (o.hashes?.length ? o.hashes : [o.hash]).map(cid); body = `git revert --no-edit ${hs.join(' ')}`; audit = `git revert ${hs.map((h) => h.slice(0, 10)).join(' ')}`; break }
    case 'remoteAdd': body = `git remote add ${remoteName(o.name)} ${remoteUrl(o.url)}`; audit = `git remote add ${o.name} ${maskUrl(o.url)}`; break
    case 'remoteRemove': body = `git remote remove ${remoteName(o.name)}`; audit = body; break
    case 'remoteRename': body = `git remote rename ${remoteName(o.from)} ${remoteName(o.to)}`; audit = body; break
    case 'remoteSetUrl': body = `git remote set-url ${remoteName(o.name)} ${remoteUrl(o.url)}`; audit = `git remote set-url ${o.name} ${maskUrl(o.url)}`; break
    case 'interactiveRebase': { body = rebaseScript(o); audit = `git rebase -i ${o.root ? '--root' : `${o.from.slice(0, 10)}^`}（${o.steps.map((x) => `${x.action} ${x.hash.slice(0, 7)}`).join('，')}）`.slice(0, 500); break }   // i18n-ignore 执行记录（存盘）
    case 'reset': body = `git reset --${o.mode === 'soft' || o.mode === 'hard' ? o.mode : 'mixed'} ${cid(o.hash)}`; audit = body; break
    case 'discard': {
      // 已跟踪的还原成暂存区的样子；未跟踪的删掉（只删列出来的文件）
      const parts = [
        o.paths.length ? `${GIT_PATH_ENV} git restore -- ${o.paths.map(gitQ).join(' ')} 2>/dev/null || ${GIT_PATH_ENV} git checkout -- ${o.paths.map(gitQ).join(' ')}` : '',
        o.untracked.length ? `${GIT_PATH_ENV} git clean -f -q -- ${o.untracked.map(gitQ).join(' ')}` : '',
      ].filter(Boolean)
      if (!parts.length) throw new Error(tr('没有选中文件'))
      body = parts.join(' && ')
      const all = [...o.paths, ...o.untracked]
      audit = `git restore / clean -- ${all.slice(0, 5).join(' ')}${all.length > 5 ? ` …（共 ${all.length} 个）` : ''}`   // i18n-ignore 执行记录（存盘）
      break
    }
    case 'stashPush': body = `git stash push${o.untracked ? ' -u' : ''}${o.message ? ` -m ${gitShQuote(o.message.slice(0, 200))}` : ''}`; audit = body; break
    case 'stashApply': body = `git stash apply ${stash(o.ref)}`; audit = `git stash apply ${o.ref}`; break
    case 'stashPop': body = `git stash pop ${stash(o.ref)}`; audit = `git stash pop ${o.ref}`; break
    case 'stashDrop': body = `git stash drop ${stash(o.ref)}`; audit = `git stash drop ${o.ref}`; break
    case 'abort': body = audit = `git ${o.what} --abort`; if (!['merge', 'rebase', 'cherry-pick', 'revert'].includes(o.what)) throw new Error(tr('非法的操作')); break
    case 'skip': body = audit = `git ${o.what} --skip`; if (!['rebase', 'cherry-pick', 'revert'].includes(o.what)) throw new Error(tr('非法的操作')); break
    case 'continue': body = `GIT_EDITOR=true git ${o.what} --continue`; audit = `git ${o.what} --continue`; if (!['rebase', 'cherry-pick', 'revert'].includes(o.what)) throw new Error(tr('非法的操作')); break
    case 'commit': {
      body = `git commit${o.amend ? ' --amend' : ''} -F -`
      if (o.exclude?.length) {
        // 拷一份 index，在拷贝里把不提交的文件退回 HEAD 的样子（空仓库就从拷贝里移除），用它提交；真正的 index 不动，
        // 所以没勾的文件仍是已暂存（含按块暂存的部分），勾了的提交后自然和 HEAD 一致
        const ex = o.exclude.map(gitQ).join(' ')
        body = `idx=$(git rev-parse --git-path index) && tmp="$idx.lingshell-partial" && cp "$idx" "$tmp" && { if git rev-parse -q --verify HEAD >/dev/null; then ${GIT_PATH_ENV} GIT_INDEX_FILE="$tmp" git reset -q -- ${ex}; else ${GIT_PATH_ENV} GIT_INDEX_FILE="$tmp" git rm -r -q --cached -- ${ex}; fi; } && GIT_INDEX_FILE="$tmp" ${body}; r=$?; rm -f "$tmp"; [ $r -eq 0 ]`
      }
      // 有上游就普通推送，没有才发布到 origin。不能写成 `rev-parse && git push || git push -u origin`：
      // push 失败（被拒 / 网络）时也会走 || 分支，把 fork 仓库的推送悄悄改到 origin 并改上游
      if (o.push) body += ` && { if git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then git push; else git push -u origin ${ref(o.branch)}; fi; }`
      audit = `git commit${o.amend ? ' --amend' : ''} -m ${gitShQuote((message ?? '').split('\n')[0].slice(0, 120))}${o.push ? ' && git push' : ''}`
      break
    }
    case 'applyPatch': {
      body = `git apply --recount${o.cached ? ' --cached' : ''}${o.reverse ? ' -R' : ''} --whitespace=nowarn -`   // --recount：按行暂存时块头的行数不准，让 git 自己数
      gitQ(o.path)
      audit = `git apply${o.cached ? ' --cached' : ''}${o.reverse ? ' -R' : ''}（${o.path} 的一块改动）`   // i18n-ignore 执行记录（存盘）
      break
    }
    case 'resolveFile': {
      const p = gitQ(o.path)
      // 读的时候记下 git blob 哈希；外部改过就拒绝，免得把用户后来的修改覆盖掉
      const h = typeof o.expectedHash === 'string' && /^[0-9a-f]{40,64}$/.test(o.expectedHash) ? o.expectedHash : ''
      // 先写同目录临时文件再改名：写到一半失败 / 磁盘满不会留下半截文件
      const write = `tmp="$(dirname ${p})/.lingshell-merge-$$"; { cat > "$tmp" && mv "$tmp" ${p}; } || { rm -f "$tmp"; false; }${o.add ? ` && ${GIT_PATH_ENV} git add -- ${p}` : ''}`
      // 不能用 exit：跳过末尾的 rc 标记后会被当成「输出被截断」
      body = h ? `if [ "$(git hash-object -- ${p} 2>/dev/null)" = '${h}' ]; then ${write}; else echo ${gitShQuote(tr('文件在打开合并编辑器后已被修改，请关闭重开后再保存'))}; false; fi` : write
      audit = `写入合并结果 ${o.path}${o.add ? ' && git add' : ''}`   // i18n-ignore 执行记录（存盘）
      break
    }
    default: throw new Error(tr('不支持的操作'))
  }
  return { cmd: `${gitEnter(root)}; ${gitOpNetwork(o) ? `${NET_ENV}; ` : ''}{ ${body}; } 2>&1; ${rc}`, audit }
}

/** 网络操作失败的常见原因 → 中文提示（独立通道不能交互输入密码） */
export function gitNetHint(text: string): string | undefined {
  if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey|Host key verification failed|could not read Password/i.test(text)) {
    return tr('需要登录凭据：面板里不能输入密码。请先在终端里执行一次 git pull / push 并保存凭据（或配置 SSH 密钥），之后这里就能用了')
  }
  if (/rejected.*\(fetch first\)|non-fast-forward|Updates were rejected/i.test(text)) return tr('远程有你本地没有的提交：先「拉取」再推送')
  if (/nothing to commit|is now empty|--skip to skip|--allow-empty/i.test(text)) return tr('这个提交解决冲突后已经没有任何改动了（和当前分支一样）：点横幅里的「跳过」跳过它继续，或「中止」放弃整个操作')
  if (/no upstream branch|has no upstream/i.test(text)) return tr('当前分支还没有上游：点「推送」会自动推到 origin 并设为上游')
  if (/Could not resolve host|Connection timed out|unable to access/i.test(text)) return tr('连不上远程仓库：检查网络 / 代理')
  return undefined
}

/** 仓库正在进行的操作（合并 / 变基 / 拣选 / 还原），界面显示「继续 / 中止」 */
export type GitInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert'
export const gitProgressCommand = (root: string) =>
  `${gitEnter(root)}; for x in MERGE_HEAD:merge rebase-merge:rebase rebase-apply:rebase CHERRY_PICK_HEAD:cherry-pick REVERT_HEAD:revert; do p=$(git rev-parse --git-path "\${x%%:*}"); [ -e "$p" ] && { echo "${M}progress:\${x##*:}"; break; }; done; true; ${rc}`
export function parseGitProgress(out: string): GitInProgress | undefined {
  const m = new RegExp(`${M}progress:([\\w-]+)`).exec(out)
  return m && ['merge', 'rebase', 'cherry-pick', 'revert'].includes(m[1]) ? (m[1] as GitInProgress) : undefined
}

// ── 执行记录 ──
export const gitOpDecision = (o: GitOp) => `git_${o.op}`
export const gitOpAuditLabel = (decision: string): string | undefined => {
  const k = decision.startsWith('git_') ? decision.slice(4) : ''
  return k in GIT_OP_LABEL ? `Git ${tr(GIT_OP_LABEL[k as GitOp['op']])}` : undefined
}

// ── 逐行追溯（blame）──
export interface GitBlameLine { line: number; hash: string; author: string; time: number; summary: string; text: string; boundary: boolean }
export const GIT_BLAME_MAX = 4 * 1024 * 1024
export const gitBlameCommand = (root: string, path: string, rev?: string) =>
  `${gitEnter(root)}; ${GIT} blame --porcelain ${rev ? `${cid(rev)} ` : ''}-- ${gitQ(path)} 2>&1 | head -c ${GIT_BLAME_MAX}; ${rc}`
/** --porcelain：每行一个头「hash 原行 新行 [组行数]」，同一提交第一次出现时跟 author / summary 等，内容行以 TAB 开头 */
export function parseGitBlame(out: string): GitBlameLine[] {
  const info = new Map<string, { author: string; time: number; summary: string; boundary: boolean }>()
  const res: GitBlameLine[] = []
  const lines = out.split('\n')
  let cur: { hash: string; line: number } | undefined
  let meta: { author: string; time: number; summary: string; boundary: boolean } | undefined
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '')
    if (cur) {
      if (raw.startsWith('\t')) {
        const m = info.get(cur.hash) ?? meta ?? { author: '', time: 0, summary: '', boundary: false }
        if (!info.has(cur.hash)) info.set(cur.hash, m)
        res.push({ line: cur.line, hash: cur.hash, ...m, text: raw.slice(1).replace(/\r$/, '') })
        cur = undefined; meta = undefined
        continue
      }
      const sp = l.indexOf(' '), k = sp < 0 ? l : l.slice(0, sp), v = sp < 0 ? '' : l.slice(sp + 1)
      meta ??= { ...(info.get(cur.hash) ?? { author: '', time: 0, summary: '', boundary: false }) }
      if (k === 'author') meta.author = v
      else if (k === 'author-time') meta.time = Number(v) * 1000
      else if (k === 'summary') meta.summary = v
      else if (k === 'boundary') meta.boundary = true
      continue
    }
    const h = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(l)
    if (h) cur = { hash: h[1], line: Number(h[2]) }
  }
  return res
}
/** 还没提交的行 blame 出来是全 0 的提交号 */
export const isUncommittedHash = (h: string) => /^0+$/.test(h)

// ── 按块暂存 ──
export interface GitHunk { header: string; lines: string[]; patch: string }
/** 原始 git diff 输出（单个文件）→ 文件头 + 每一块；patch = 文件头 + 这一块，可直接喂给 git apply */
export function splitHunks(raw: string): { fileHeader: string; hunks: GitHunk[] } {
  const ls = raw.split('\n')
  const first = ls.findIndex((l) => l.startsWith('@@'))
  if (first < 0) return { fileHeader: raw, hunks: [] }
  const fileHeader = ls.slice(0, first).join('\n')
  const hunks: GitHunk[] = []
  let cur: string[] | undefined
  const push = () => {
    if (!cur) return
    while (cur.length > 1 && cur[cur.length - 1] === '') cur.pop()   // 输出末尾的空行不是 diff 内容
    hunks.push({ header: cur[0], lines: cur.slice(1), patch: `${fileHeader}\n${cur.join('\n')}\n` })
  }
  for (const l of ls.slice(first)) {
    if (l.startsWith('@@')) { push(); cur = [l] } else if (cur && (l === '' || /^[ +\-\\]/.test(l))) cur.push(l)
  }
  push()
  return { fileHeader, hunks }
}
/** 能按块操作：普通的文本修改（新增 / 删除整个文件、二进制、重命名都不行，用整文件操作） */
export const hunkable = (fileHeader: string) => /^diff --git /m.test(fileHeader) && !/^(new file mode|deleted file mode|rename from|Binary files|similarity index)/m.test(fileHeader)

// ── 合并冲突 ──
export type MergeChunk = { kind: 'text'; text: string } | { kind: 'conflict'; ours: string; base?: string; theirs: string; oursLabel: string; theirsLabel: string }
/** 工作区里带冲突标记的文件 → 普通段 + 冲突段（支持 diff3 的 ||||||| 基础版本）；换行风格原样保留 */
export function parseConflicts(text: string): MergeChunk[] {
  const out: MergeChunk[] = []
  const ls = text.split(/(?<=\n)/)   // 保留每行自己的换行符
  let buf = ''
  let c: { ours: string; base?: string; theirs: string; oursLabel: string; theirsLabel: string; part: 'ours' | 'base' | 'theirs' } | undefined
  for (const l of ls) {
    const s = l.replace(/\r?\n$/, '')
    if (!c && s.startsWith('<<<<<<<')) { if (buf) out.push({ kind: 'text', text: buf }); buf = ''; c = { ours: '', theirs: '', oursLabel: s.slice(7).trim(), theirsLabel: '', part: 'ours' }; continue }
    if (c && c.part === 'ours' && s.startsWith('|||||||')) { c.part = 'base'; c.base = ''; continue }
    if (c && c.part !== 'theirs' && s === '=======') { c.part = 'theirs'; continue }
    if (c && c.part === 'theirs' && s.startsWith('>>>>>>>')) { c.theirsLabel = s.slice(7).trim(); const { part: _p, ...x } = c; out.push({ kind: 'conflict', ...x }); c = undefined; continue }
    if (c) c[c.part] = (c[c.part] ?? '') + l
    else buf += l
  }
  if (c) buf += `<<<<<<< ${c.oursLabel}\n${c.ours}${c.base !== undefined ? `|||||||\n${c.base}` : ''}=======\n${c.theirs}`   // 没闭合：原样当普通文本
  if (buf) out.push({ kind: 'text', text: buf })
  return out
}
export type MergeChoice = 'ours' | 'theirs' | 'both' | 'bothReverse' | 'base' | { custom: string }
export function resolveChunk(c: Extract<MergeChunk, { kind: 'conflict' }>, ch: MergeChoice): string {
  if (typeof ch === 'object') return ch.custom
  const nl = (s: string) => (s && !s.endsWith('\n') ? `${s}\n` : s)
  return ch === 'ours' ? c.ours : ch === 'theirs' ? c.theirs : ch === 'base' ? c.base ?? '' : ch === 'both' ? nl(c.ours) + c.theirs : nl(c.theirs) + c.ours
}
/** 按每个冲突的选择拼出结果；没选的冲突保留原来的标记 */
export function mergeResult(chunks: MergeChunk[], choices: (MergeChoice | undefined)[]): string {
  let k = 0
  return chunks.map((c) => {
    if (c.kind === 'text') return c.text
    const ch = choices[k++]
    return ch === undefined ? `<<<<<<< ${c.oursLabel}\n${c.ours}${c.base !== undefined ? `|||||||\n${c.base}` : ''}=======\n${c.theirs}>>>>>>> ${c.theirsLabel}\n` : resolveChunk(c, ch)
  }).join('')
}
// 必须同时有 <<<<<<< 和 >>>>>>>：单独一行 7 个 = 在 Markdown / AsciiDoc 里很常见，不能当成未解决
export const hasConflictMarkers = (s: string) => /^<<<<<<<(?: |$)/m.test(s) && /^>>>>>>>(?: |$)/m.test(s)
/** 读冲突文件（工作区，最多 3MB）；同时给出真实字节数和 blob 哈希，界面据此拒绝保存截断 / 二进制 / 被外部改过的文件 */
export const gitReadFileCommand = (root: string, path: string) => {
  const p = gitQ(path)
  return `${gitEnter(root)}; s=$(wc -c < ${p} 2>/dev/null) || s=-1; h=$(git hash-object -- ${p} 2>/dev/null) || h=-; printf '${M}size:%s${US}%s\\n' "$s" "$h"; head -c 3145728 -- ${p} 2>&1; printf '\\n${M}rc:%s\\n' "$?"`
}

// ── 比较：两个分支 / 标签 / 提交之间，或某个版本和工作区 ──
/** 比较的一端：分支 / 标签名、提交号；b 不给 = 工作区 */
export const isCompareRef = (s: unknown): s is string => isRefName(s) || isCommitId(s)
const cref = (s: string) => { if (!isCompareRef(s)) throw new Error(tr('非法的版本：{v}', { v: String(s).slice(0, 60) })); return gitShQuote(s) }
export interface GitCompareResult { files: GitChangedFile[]; onlyA: GitCommit[]; onlyB: GitCommit[] }
/** 文件差异（a → b，两点）+ 各自独有的提交（最多 200 条）；b 是工作区时没有提交列表 */
export const gitCompareCommand = (root: string, a: string, b?: string) => [
  gitEnter(root),
  `${GIT} diff --no-ext-diff -M --name-status -z ${cref(a)}${b ? ` ${cref(b)}` : ''} 2>&1`,
  `echo; echo '${M}onlyA'`,
  b ? `${GIT} log -n 200 --date=iso-strict --format='%H${US}%P${US}%an${US}%ae${US}%ad${US}%D${US}%s${RS}' ${cref(b)}..${cref(a)} 2>&1` : 'true',
  `echo '${M}onlyB'`,
  b ? `${GIT} log -n 200 --date=iso-strict --format='%H${US}%P${US}%an${US}%ae${US}%ad${US}%D${US}%s${RS}' ${cref(a)}..${cref(b)} 2>&1` : 'true',
  rc,
].join('; ')
export function parseGitCompare(out: string): GitCompareResult {
  const t = out.replace(/\r\n/g, '\n')
  const ia = t.indexOf(`${M}onlyA`), ib = t.indexOf(`${M}onlyB`), ri = t.lastIndexOf(`\n${M}rc:`)
  return {
    files: parseNameStatusZ(t.slice(0, ia < 0 ? undefined : ia)),
    onlyA: ia < 0 ? [] : parseGitLog(t.slice(ia + M.length + 5, ib < 0 ? undefined : ib)),   // 跳过标记本身，否则第一条提交被当成标记行丢掉
    onlyB: ib < 0 ? [] : parseGitLog(t.slice(ib + M.length + 5, ri < 0 ? undefined : ri)),
  }
}
export const gitCompareDiffCommand = (root: string, a: string, b: string | undefined, path: string) =>
  `${gitEnter(root)}; ${GIT} diff --no-ext-diff -M ${cref(a)}${b ? ` ${cref(b)}` : ''} -- ${gitQ(path)} 2>&1 | head -c 400000`

// ── AI：更新日志 / 审查已暂存的改动 ──
export const GIT_CHANGELOG_MAX = 300
/** from..to 之间的提交（不含合并提交）：提交号、作者、说明标题与正文，外加改动统计 */
export const gitChangelogCommand = (root: string, from: string | undefined, to: string) =>
  // 没有 from 时用空树..to：以前写的是 `git diff to`，会把工作区未提交的改动也算进发布统计
  `${gitEnter(root)}; ${GIT} log --no-merges -n ${GIT_CHANGELOG_MAX} --date=short --format='${M}c %h${US}%an${US}%ad${US}%s${US}%b' ${from ? `${cref(from)}..` : ''}${cref(to)} 2>&1; echo '${M}stat'; ${from ? `${GIT} diff --shortstat ${cref(from)} ${cref(to)}` : `${GIT} diff --shortstat $(git hash-object -t tree /dev/null) ${cref(to)}`} 2>&1 | tail -n 3; ${rc}`
export function buildChangelogPrompt(log: string, o: { from?: string; to: string; audience: 'ops' | 'user' | 'dev' }): { system: string; user: string } {
  // i18n-ignore-next 提示词
  const who = o.audience === 'ops' ? '运维 / 部署人员：突出要关注的变更（配置、数据库、依赖、接口、停机、回滚注意事项）' : o.audience === 'user' ? '产品 / 最终用户：只讲用户能感知的新功能和修复，不讲内部重构' : '开发团队：按模块列出改动，保留技术细节'
  return {
    system: [
      '你是资深工程师，根据 git 提交记录写一份中文更新日志（发布说明），Markdown 格式。',   // i18n-ignore 提示词
      `读者是${who}。`,   // i18n-ignore 提示词
      '结构：先一两句总结，然后按「新功能 / 改进 / 问题修复 / 其他」分组（没有的组省略），每条一行，合并同一件事的多个提交，提交号放在行尾括号里。',   // i18n-ignore 提示词
      '如果有破坏性变更、需要改配置或执行数据库迁移、需要停机，单独列「升级注意」放在最前面。',   // i18n-ignore 提示词
      '不要编造提交里没有的内容；看不懂的提交照原文简述。只输出 Markdown 正文。',   // i18n-ignore 提示词
    ].join('\n'),
    // i18n-ignore-next 提示词
    user: `版本范围：${o.from ? `${o.from} → ${o.to}` : `截至 ${o.to}`}\n\n提交记录（每条：提交号 | 作者 | 日期 | 标题 | 正文）：\n${log.slice(0, 60_000)}`,
  }
}
export function buildStagedReviewPrompt(stat: string, diff: string): { system: string; user: string } {
  const d = diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n…（diff 过长，后面省略）` : diff   // i18n-ignore 提示词
  return {
    system: [
      '你是严格的代码审查者，审查即将提交的改动（git diff --cached）。只指出真正的问题，不要客套和泛泛的建议。',   // i18n-ignore 提示词
      '重点：明显的 bug / 逻辑错误 / 边界条件、误提交的密码 / 密钥 / 内网地址、遗留的调试代码（console.log、print、debugger、TODO 临时代码）、',   // i18n-ignore 提示词
      '与改动意图不符的文件（如误加的大文件、日志、构建产物）、安全问题（注入、越权）、明显的性能问题。',   // i18n-ignore 提示词
      '只输出一个 JSON 对象（不要代码块、不要其他文字），用中文：',   // i18n-ignore 提示词
      '{"verdict":"ok 或 fix（有高 / 中等级问题就是 fix）","summary":"一句话结论","issues":[{"level":"high|medium|low","file":"文件路径","line":行号或 null,"title":"一句话问题","suggestion":"建议怎么改"}]}',   // i18n-ignore 提示词
      'high = 会出错 / 泄露 / 安全问题；medium = 不该提交但不致命（调试代码、误加文件）；low = 可以改进。没有问题时 issues 为空数组。按严重程度排序。',   // i18n-ignore 提示词
    ].join('\n'),
    user: `改动统计：\n${stat.trim() || '（无）'}\n\ndiff：\n${d}`,   // i18n-ignore 提示词
  }
}
export type ReviewIssueLevel = 'high' | 'medium' | 'low'
export interface GitReviewIssue { level: ReviewIssueLevel; file: string; line?: number; title: string; suggestion: string }
export interface GitReviewResult { verdict: 'ok' | 'fix'; summary: string; issues: GitReviewIssue[] }
/** 模型的审查结果；不是期望的 JSON 时返回 undefined（界面退回按 Markdown 显示原文） */
export function parseStagedReview(raw: string): GitReviewResult | undefined {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```(?:json)?/g, '').trim()
  const i = s.indexOf('{'), j = s.lastIndexOf('}')
  if (i < 0 || j < i) return undefined
  let o: Record<string, unknown>
  try { o = JSON.parse(s.slice(i, j + 1)) } catch { return undefined }
  if (!o || typeof o !== 'object' || !Array.isArray(o.issues)) return undefined
  const lv = (v: unknown): ReviewIssueLevel => (v === 'high' || v === 'low' ? v : 'medium')
  const issues = (o.issues as unknown[]).flatMap((x): GitReviewIssue[] => {
    if (!x || typeof x !== 'object') return []
    const r = x as Record<string, unknown>, title = String(r.title ?? '').trim()
    if (!title) return []
    const line = Number(r.line)
    return [{ level: lv(r.level), file: String(r.file ?? '').trim(), ...(Number.isFinite(line) && line > 0 ? { line } : {}), title, suggestion: String(r.suggestion ?? '').trim() }]
  }).sort((a, b) => ['high', 'medium', 'low'].indexOf(a.level) - ['high', 'medium', 'low'].indexOf(b.level))
  const verdict = o.verdict === 'ok' && !issues.some((x) => x.level !== 'low') ? 'ok' : issues.some((x) => x.level !== 'low') || o.verdict === 'fix' ? 'fix' : 'ok'
  return { verdict, summary: String(o.summary ?? '').trim() || (verdict === 'ok' ? tr('可以提交') : tr('建议修改后再提交')), issues }
}
/** 模型回复去掉思考块和整段代码围栏 */
export const cleanAiMarkdown = (raw: string) => {
  let s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim()
  const f = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(s)
  if (f) s = f[1].trim()
  return s
}

// ── 远程管理 ──
export interface GitRemote { name: string; fetchUrl: string; pushUrl: string }
/** 地址里的密码 / token 打码（https://user:token@host → https://user:***@host），不给界面和执行记录看到 */
export const maskUrl = (u: string) => u.replace(/(\/\/[^/@:\s]+):[^/@\s]+@/, '$1:***@').replace(/(\/\/)([^/@:\s]{20,})@/, '$1***@')
function remoteUrl(u: string): string {
  if (typeof u !== 'string' || !u.trim() || u.length > 1000 || /[\s\0]/.test(u.trim()) || u.trim().startsWith('-')) throw new Error(tr('非法的远程地址'))
  return gitShQuote(u.trim())
}
export const gitRemotesCommand = (root: string) => `${gitEnter(root)}; git remote -v 2>&1; ${rc}`
export function parseGitRemotes(out: string): GitRemote[] {
  const by = new Map<string, GitRemote>()
  for (const l of out.replace(/\r/g, '').split('\n')) {
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(l)
    if (!m) continue
    const r = by.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') r.fetchUrl = maskUrl(m[2]); else r.pushUrl = maskUrl(m[2])
    by.set(m[1], r)
  }
  return [...by.values()]
}

// ── 交互式变基 ──
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'
export interface RebaseStep { hash: string; action: RebaseAction; message?: string }
export interface RebasePlanCommit { hash: string; author: string; date: string; message: string; pushed: boolean }
export interface RebasePlan {
  commits: RebasePlanCommit[]; merges: number; root: boolean
  head?: string          // 打开计划时的 HEAD：执行前校验，期间新增提交 / 切换分支就拒绝
  count?: number         // 范围内提交总数（输出被截断时 commits.length 会少于它）
  notAncestor?: boolean  // from 不在当前 HEAD 的历史里（历史页可以选中任意分支的提交）
}
export const REBASE_MAX = 100
/** from（含）到 HEAD 的提交，从旧到新；merges = 范围里合并提交的个数（有就不支持）；pushed = 已在上游里 */
export const gitRebasePlanCommand = (root: string, from: string) => {
  const f = cid(from)
  // 非祖先时只输出标记，不做后面的读取（否则 git rebase -i from^ 会把当前分支整体搬到无关提交上）。
  // 用 if/else 而不是 exit：exit 会跳过末尾的 rc 标记
  const body = [
    `echo "${M}head:$(git rev-parse HEAD)"`,
    `if git rev-parse -q --verify ${f}^ >/dev/null 2>&1; then range="${f}^..HEAD"; echo '${M}notroot'; else range="HEAD"; fi`,
    `echo "${M}merges:$(git rev-list --merges $range | wc -l)"`,
    `echo "${M}count:$(git rev-list --count $range)"`,
    `git rev-parse -q --verify '@{u}' >/dev/null 2>&1 && echo "${M}unpushed:$(git rev-list '@{u}..HEAD' | tr '\\n' ' ')"`,
    `echo '${M}log'`,
    `${GIT} log --reverse -n ${REBASE_MAX + 1} --date=iso-strict --format='%H${US}%an${US}%ad${US}%B${RS}' $range 2>&1`,
  ].join('; ')
  return [
    gitEnter(root),
    `if git merge-base --is-ancestor ${f} HEAD 2>/dev/null; then ${body}; else echo '${M}notancestor'; fi`,
    rc,
  ].join('; ')
}
export function parseRebasePlan(out: string): RebasePlan {
  const t = out.replace(/\r\n/g, '\n')
  const merges = Number(new RegExp(`${M}merges:\\s*(\\d+)`).exec(t)?.[1] ?? 0)
  const count = Number(new RegExp(`${M}count:\\s*(\\d+)`).exec(t)?.[1] ?? NaN)
  const head = new RegExp(`${M}head:([0-9a-f]{40,64})`).exec(t)?.[1]
  const un = new RegExp(`${M}unpushed:([^\\n]*)`).exec(t)
  const unpushed = un ? new Set(un[1].trim().split(/\s+/).filter(Boolean)) : undefined
  const li = t.indexOf(`${M}log`), ri = t.lastIndexOf(`\n${M}rc:`)
  const commits = (li < 0 ? '' : t.slice(li + M.length + 3, ri < 0 ? undefined : ri)).split(RS).flatMap((rec) => {
    const f = rec.replace(/^\s+/, '').split(US)
    return f.length >= 4 && /^[0-9a-f]{40,64}$/.test(f[0]) ? [{ hash: f[0], author: f[1], date: f[2], message: f.slice(3).join(US).trim(), pushed: unpushed ? !unpushed.has(f[0]) : false }] : []
  })
  return {
    commits, merges, root: !t.includes(`${M}notroot`),
    ...(head ? { head } : {}), ...(Number.isFinite(count) ? { count } : {}),
    ...(t.includes(`${M}notancestor`) ? { notAncestor: true } : {}),
  }
}
/** 校验步骤：第一步不能是压缩（没有可并入的上一个）；改说明 / 压缩说明不能空 */
export function checkRebaseSteps(steps: RebaseStep[]): string | undefined {
  if (!Array.isArray(steps) || !steps.length || steps.length > REBASE_MAX) return tr('没有要整理的提交')
  const kept = steps.filter((s) => s.action !== 'drop')
  if (!kept.length) return tr('不能把所有提交都删掉')
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') return tr('第一个保留的提交不能是「压缩」：它前面没有可以并入的提交')
  for (const s of steps) {
    if (!isCommitId(s.hash) || !['pick', 'reword', 'squash', 'fixup', 'drop'].includes(s.action)) return tr('步骤不对')
    if (s.action === 'reword' && !s.message?.trim()) return tr('改说明的提交要填新说明')
    if (s.message !== undefined && s.message.length > 20_000) return tr('说明太长')
  }
  return undefined
}
/**
 * 不交互地执行 git rebase -i：待办列表事先写好，GIT_SEQUENCE_EDITOR 用 cp 把它放进去；GIT_EDITOR=true 接受默认说明，
 * 要改的说明写进文件，在对应提交后面插一行 exec git commit --amend -F 文件。压缩组的新说明挂在组里最后一个提交上。
 * 遇到冲突会停下（界面显示「正在变基」，可继续 / 中止）；完成后清掉临时目录
 */
function rebaseScript(o: Extract<GitOp, { op: 'interactiveRebase' }>): string {
  const err = checkRebaseSteps(o.steps)
  if (err) throw new Error(err)
  // 打开计划后 HEAD 被外部移动：todo 只列了旧提交，直接 rebase 等于把新提交丢掉
  const head = o.expectedHead && isCommitId(o.expectedHead) ? o.expectedHead : ''
  const writes: string[] = [], todo: string[] = []
  o.steps.forEach((s, i) => {
    const act = s.action === 'reword' ? 'pick' : s.action
    todo.push(`'${act} ${cid(s.hash)}'`)
    const next = o.steps.slice(i + 1).find((x) => x.action !== 'drop')
    const groupEnd = !next || (next.action !== 'squash' && next.action !== 'fixup')
    const msg = s.message?.trim()
    if (msg && s.action !== 'drop' && (s.action === 'reword' || groupEnd)) {
      writes.push(`printf '%s\\n' ${gitShQuote(msg)} > "$d/m${i}"`)
      // 路径在执行时由 git 自己给（单引号：不在这里展开）；用 $d 的话 Git Bash 下是 /tmp 风格，原生 git 读不了
      todo.push(`'exec git commit --amend --no-verify -q -F "$(git rev-parse --git-dir)/lingshell-rebase/m${i}"'`)
    }
  })
  // 准备（任何一步失败都不执行变基）→ 变基 → 没停在半路就清掉临时目录 → 以变基的结果为准
  const prep = ['d="$(cd "$(git rev-parse --git-dir)" && pwd)/lingshell-rebase"', 'rm -rf "$d"', 'mkdir -p "$d"', ...writes, `printf '%s\\n' ${todo.join(' ')} > "$d/todo"`].join(' && ')
  // 用 if/else 不用 exit：exit 会跳过末尾 rc 标记，主进程会误报「输出被截断」
  const checked = head ? `if [ "$(git rev-parse HEAD)" = '${head}' ]; then ${prep}; else echo ${gitShQuote(tr('当前分支在打开整理窗口后发生了变化（有新提交或被切走），请关闭重新打开'))}; false; fi` : prep
  const rebase = `GIT_SEQUENCE_EDITOR="cp '$d/todo'" GIT_EDITOR=true git rebase -i --autostash ${o.root ? '--root' : `${cid(o.from)}^`}`
  return `${checked} && { ${rebase}; }; r=$?; [ -d "$(git rev-parse --git-path rebase-merge)" ] || rm -rf "$d"; [ $r -eq 0 ]`
}

// ── 按行暂存 ──
/**
 * 一块里只操作选中的行：stage（正向应用到暂存区）时没选的「+」去掉、没选的「-」当成上下文；
 * unstage / discard（反向应用）时没选的「+」当成上下文、没选的「-」去掉。行数交给 git apply --recount 重新数
 */
export function linePatch(fileHeader: string, hunk: GitHunk, selected: Set<number>, mode: 'stage' | 'unstage' | 'discard'): string | undefined {
  const out: string[] = []
  let changed = 0, lastKept = false
  hunk.lines.forEach((l, i) => {
    const t = l[0], body = l.slice(1)
    if (t === '\\') { if (lastKept) out.push(l); return }
    if (t === '+' || t === '-') {
      if (selected.has(i)) { out.push(l); changed++; lastKept = true; return }
      const asContext = mode === 'stage' ? t === '-' : t === '+'
      if (asContext) { out.push(` ${body}`); lastKept = true } else lastKept = false
      return
    }
    out.push(l); lastKept = true
  })
  return changed ? `${fileHeader}\n${hunk.header}\n${out.join('\n')}\n` : undefined
}
