// Git 助手（纯逻辑）：命令构造 + git status --porcelain=v2 -z / diff 输出解析 + 提交说明提示词。
// 只读命令（status / diff）走独立通道（SSH exec channel / 本机 Git Bash 子进程），不在用户终端里刷屏；
// 写操作（暂存 / 取消暂存 / 提交）同样走独立通道，但由用户手动触发、提交前确认，并记入执行记录。
// 路径一律单引号包起来拼进命令；含换行 / NUL 的路径拒绝（git 自己也极少见）。

import { tk, tr } from '../i18n/i18n.js'

export type GitDiffMode = 'staged' | 'work' | 'untracked'
export interface GitFile {
  path: string
  orig?: string        // 重命名 / 复制前的路径
  x: string            // 暂存区状态（. = 无变化；M A D R C T U）
  y: string            // 工作区状态
  conflict: boolean
  untracked: boolean
}
export interface GitStatus {
  root: string
  branch: string       // 分支名；分离头指针时为 (detached)
  detached: boolean
  oid?: string         // 当前提交（空仓库没有）
  upstream?: string
  ahead: number
  behind: number
  merging: boolean     // 正在合并（有 MERGE_HEAD）
  files: GitFile[]
}
export type GitStatusResult = { ok: true; status: GitStatus } | { ok: false; problem: 'nodir' | 'nogit' | 'norepo' | 'error'; message: string }

export const GIT_TIMEOUT_MS = 20_000
export const GIT_DIFF_MAX = 400_000          // diff 最多取这么多字节
export const GIT_PROMPT_DIFF_MAX = 12_000    // 发给模型的 diff 截断长度

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const isGitPath = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !/[\0\r\n]/.test(p)
export const gitQ = (p: string) => { if (!isGitPath(p)) throw new Error(tr('非法的路径：{v}', { v: String(p).slice(0, 80) })); return shQuote(p) }
const q = gitQ
export const gitShQuote = shQuote
export const GIT_MARK = '@@git:'
const M = GIT_MARK
// GIT_LITERAL_PATHSPECS：以 : 开头 / 含 glob 字符的文件名按字面路径处理，避免 restore/clean/add 作用到别的文件。
// 只加在带路径的命令上（全局 export 会让 git stash push -u 漏掉未跟踪文件，实测）
export const GIT_PATH_ENV = 'GIT_LITERAL_PATHSPECS=1'
export const GIT_CMD = `${GIT_PATH_ENV} git -c core.quotePath=false -c color.ui=false`
const GIT = GIT_CMD
// 先进目录；进不去 / 没有 git / 不在仓库里都给出标记，由解析器归类
export const gitEnter = (dir: string) => `cd ${q(dir)} 2>/dev/null || { echo "${M}nodir"; exit 0; }; command -v git >/dev/null 2>&1 || { echo "${M}nogit"; exit 0; }`

/** 状态：仓库根 + 是否合并中 + porcelain v2（-z：路径不转义，靠 NUL 分隔） */
export const gitStatusCommand = (dir: string) => [
  gitEnter(dir),
  `r=$(git rev-parse --show-toplevel 2>&1) || { echo "${M}norepo:$r"; exit 0; }`,
  `echo "${M}root:$r"`,
  `[ -e "$(git rev-parse --git-path MERGE_HEAD)" ] && echo "${M}merging"`,
  `echo "${M}status"`,
  `${GIT} status --porcelain=v2 -b -z --untracked-files=all 2>/dev/null; c=$?`,
  `printf '\\n${M}rc:%s\\n' "$c"`,
].join('; ')

/** 单个文件的 diff：已暂存 / 工作区 / 未跟踪（和空文件比） */
export function gitDiffCommand(root: string, path: string, mode: GitDiffMode): string {
  const p = q(path)
  const cmd = mode === 'staged' ? `${GIT} diff --no-ext-diff --cached -- ${p}`
    : mode === 'work' ? `${GIT} diff --no-ext-diff -- ${p}`
    : `${GIT} diff --no-ext-diff --no-index -- /dev/null ${p}`
  return `${gitEnter(root)}; ${cmd} 2>&1 | head -c ${GIT_DIFF_MAX}`
}

/** 已暂存改动：统计 + 全文（AI 写提交说明用） */
export const gitStagedCommand = (root: string, paths?: string[]) => {
  const ps = paths?.length ? ` -- ${paths.map(q).join(' ')}` : ''   // 只看勾选的已暂存文件
  return `${gitEnter(root)}; ${GIT} diff --no-ext-diff --cached --stat${ps} 2>&1 | tail -n 60; echo "${M}diff"; ${GIT} diff --no-ext-diff --cached${ps} 2>&1 | head -c ${GIT_DIFF_MAX}`
}

/** 暂存 / 取消暂存。取消暂存：有 HEAD 用 restore --staged（老 git 退回 reset），空仓库（还没有提交）用 rm --cached */
export function gitStageCommand(root: string, paths: string[], stage: boolean): string {
  if (!paths.length) throw new Error(tr('没有选中文件'))
  const ps = paths.map(q).join(' ')
  const body = stage ? `${GIT_PATH_ENV} git add -A -- ${ps}`
    : `if git rev-parse -q --verify HEAD >/dev/null; then ${GIT_PATH_ENV} git restore --staged -- ${ps} 2>/dev/null || ${GIT_PATH_ENV} git reset -q -- ${ps}; else ${GIT_PATH_ENV} git rm -r -q --cached -- ${ps}; fi`
  return `${gitEnter(root)}; ${body} 2>&1; printf '\\n${M}rc:%s\\n' "$?"`
}

/** 提交：说明从 stdin 读（不进命令行，引号 / 换行都不用转义） */
export const gitCommitCommand = (root: string) => `${gitEnter(root)}; git commit -F - 2>&1; printf '\\n${M}rc:%s\\n' "$?"`

/** 写操作 / diff 的输出：拆出退出码与「进不去目录 / 没有 git」标记 */
export function splitGitRc(out: string): { rc?: number; text: string; problem?: 'nodir' | 'nogit' } {
  const t = out.replace(/\r/g, '')
  if (t.startsWith(`${M}nodir`)) return { text: '', problem: 'nodir' }
  if (t.startsWith(`${M}nogit`)) return { text: '', problem: 'nogit' }
  const i = t.lastIndexOf(`${M}rc:`)
  if (i < 0) return { text: t.trim() }
  const rc = Number.parseInt(t.slice(i + M.length + 3), 10)
  return { rc: Number.isFinite(rc) ? rc : undefined, text: t.slice(0, i).trim() }
}

export const GIT_PROBLEM_TEXT = {
  nodir: tk('目录不存在或进不去'),
  nogit: tk('找不到 git 命令（该主机没有安装 Git）'),
  norepo: tk('这个目录不在 Git 仓库里'),
  error: tk('git status 执行失败'),
} as const

/** 解析 gitStatusCommand 的输出 */
export function parseGitStatus(out: string): GitStatusResult {
  const text = out.replace(/\r\n/g, '\n')
  const line = (tag: string) => { const m = new RegExp(`^${M}${tag}(.*)$`, 'm').exec(text); return m ? m[1] : undefined }
  if (line('nodir') !== undefined) return { ok: false, problem: 'nodir', message: tr(GIT_PROBLEM_TEXT.nodir) }
  if (line('nogit') !== undefined) return { ok: false, problem: 'nogit', message: tr(GIT_PROBLEM_TEXT.nogit) }
  const nr = line('norepo:')
  // 把 git 自己的原因带出来：safe.directory / dubious ownership / 权限不足不能都显示成「不在仓库里」
  if (nr !== undefined) return { ok: false, problem: 'norepo', message: nr.trim() ? tr(GIT_PROBLEM_TEXT.norepo) + tr('（{v}）', { v: nr.trim().slice(0, 300) }) : tr(GIT_PROBLEM_TEXT.norepo) }
  const root = line('root:')
  const si = text.indexOf(`${M}status\n`)
  const ri = text.lastIndexOf(`\n${M}rc:`)
  if (root === undefined || si < 0) return { ok: false, problem: 'error', message: text.trim().slice(0, 500) || tr(GIT_PROBLEM_TEXT.error) }
  // 没有 rc = 输出超过通道上限被截断（rc 标记在最后）；明确提示，不显示成「执行失败」
  if (ri < si) return { ok: false, problem: 'error', message: tr('git status 输出超过上限被截断：仓库里可能有大目录没加 .gitignore，或在很大的仓库里；在终端里执行 git status 查看，或把生成目录加入 .gitignore') }
  const rc = Number.parseInt(text.slice(ri + M.length + 4), 10)
  if (rc !== 0) return { ok: false, problem: 'error', message: tr(GIT_PROBLEM_TEXT.error) }
  const st: GitStatus = { root: root.trim(), branch: '', detached: false, ahead: 0, behind: 0, merging: line('merging') !== undefined, files: [] }
  const recs = text.slice(si + M.length + 7, ri).split('\0')
  // 前 n 个字段按空格切，剩下整段是路径（路径里可以有空格）
  const fields = (r: string, n: number) => {
    const parts: string[] = []
    let rest = r
    for (let k = 0; k < n; k++) { const j = rest.indexOf(' '); if (j < 0) return null; parts.push(rest.slice(0, j)); rest = rest.slice(j + 1) }
    parts.push(rest)
    return parts
  }
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i].replace(/^\n+/, '')
    if (!r) continue
    if (r.startsWith('# ')) {
      const [k, ...v] = r.slice(2).split(' ')
      const val = v.join(' ')
      if (k === 'branch.oid') st.oid = val === '(initial)' ? undefined : val
      else if (k === 'branch.head') { st.detached = val === '(detached)'; st.branch = val }
      else if (k === 'branch.upstream') st.upstream = val
      else if (k === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(val); if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]) } }
      continue
    }
    const kind = r[0]
    if (kind === '?') { st.files.push({ path: r.slice(2), x: '?', y: '?', conflict: false, untracked: true }); continue }
    if (kind === '1') { const f = fields(r, 8); if (f) st.files.push({ path: f[8], x: f[1][0], y: f[1][1], conflict: false, untracked: false }); continue }
    if (kind === '2') { const f = fields(r, 9); if (f) st.files.push({ path: f[9], orig: recs[++i], x: f[1][0], y: f[1][1], conflict: false, untracked: false }); continue }
    if (kind === 'u') { const f = fields(r, 10); if (f) st.files.push({ path: f[10], x: f[1][0], y: f[1][1], conflict: true, untracked: false }) }
    // '!'（忽略的文件）不展示
  }
  return { ok: true, status: st }
}

/** 列表分组：冲突 / 已暂存 / 未暂存 / 未跟踪（同一个文件可以既在已暂存又在未暂存） */
export function groupGitFiles(files: GitFile[]): { conflict: GitFile[]; staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[] } {
  return {
    conflict: files.filter((f) => f.conflict),
    staged: files.filter((f) => !f.conflict && !f.untracked && f.x !== '.'),
    unstaged: files.filter((f) => !f.conflict && !f.untracked && f.y !== '.'),
    untracked: files.filter((f) => f.untracked),
  }
}

const CODE_LABEL: Record<string, string> = { M: tk('gst|修改'), A: tk('gst|新增'), D: tk('gst|删除'), R: tk('gst|重命名'), C: tk('gst|复制'), T: tk('类型变化'), U: tk('冲突'), '?': tk('未跟踪') }
export const gitCodeLabel = (c: string) => (CODE_LABEL[c] ? tr(CODE_LABEL[c]) : c)

/** git diff 输出 → 只留 hunk（去掉 diff --git / index / --- +++ 等头，DiffView 直接画）；二进制文件给提示 */
export function cleanGitDiff(text: string): string {
  const out: string[] = []
  let inHunk = false, combined = false
  for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
    if (l.startsWith('diff --git ') || l.startsWith('diff --cc ') || l.startsWith('diff --combined ')) { inHunk = false; continue }
    if (/^@@@? /.test(l)) {
      inHunk = true; combined = l.startsWith('@@@')
      out.push(combined ? l.replace(/^@@@ -(\d+)(?:,\d+)? -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@@.*/, '@@ -$1 +$2 @@') : l)
      continue
    }
    if (!inHunk) { if (/^Binary files /.test(l)) out.push(tr('（二进制文件，不显示内容差异）')); continue }
    // 合并冲突的 combined diff：每行前两列是两边的标记，压成一列（任一边 + 算新增，否则任一边 - 算删除）
    if (combined && l && !l.startsWith('\\')) { const p = l.slice(0, 2); out.push(`${p.includes('+') ? '+' : p.includes('-') ? '-' : ' '}${l.slice(2)}`); continue }
    out.push(l)
  }
  return out.join('\n').replace(/\n+$/, '')
}

// ── AI 写提交说明（一次性模型调用）──
export function buildCommitPrompt(stat: string, diff: string, branch: string): { system: string; user: string } {
  const d = diff.length > GIT_PROMPT_DIFF_MAX ? `${diff.slice(0, GIT_PROMPT_DIFF_MAX)}\n…（diff 过长，后面省略 ${diff.length - GIT_PROMPT_DIFF_MAX} 字）` : diff   // i18n-ignore 提示词
  return {
    system: [
      '你是资深工程师，根据已暂存的 git diff 写一条提交说明。',   // i18n-ignore 提示词
      '格式：第一行是摘要（不超过 72 个字符，用 conventional commit 前缀如 feat: / fix: / refactor: / docs: / chore:），',   // i18n-ignore 提示词
      '如有必要空一行后用 1–5 条「- 」开头的要点说明改了什么、为什么。说明的语言跟随代码注释和已有习惯，拿不准用中文。',   // i18n-ignore 提示词
      '只输出提交说明本身，不要代码块、不要引号、不要任何解释。',   // i18n-ignore 提示词
    ].join(''),
    user: `分支：${branch || '（未知）'}\n\n改动统计：\n${stat.trim() || '（无）'}\n\ndiff：\n${d}`,   // i18n-ignore 提示词
  }
}

/** 模型回复 → 提交说明：去掉思考块、代码块围栏、首尾引号与多余空行 */
export function normalizeCommitMsg(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/\r/g, '').trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s)
  if (fence) s = fence[1].trim()
  s = s.replace(/^["'“”「]+|["'“”」]+$/g, '').trim()
  return s.replace(/\n{3,}/g, '\n\n')
}

/** 「让 AI 解决冲突」发到对话的文字（AI 用现有的读写文件 / 授权流程处理） */
export function gitConflictPrompt(o: { terminalTitle: string; root: string; branch: string; files: string[] }): string {
  return [
    tr('终端「{term}」所在仓库 `{root}`（分支 {branch}）有合并冲突，冲突文件：', { term: o.terminalTitle, root: o.root, branch: o.branch || tr('frag|未知') }),
    ...o.files.map((f) => `- \`${f}\``),
    '',
    tr('请逐个读这些文件，理解两边（<<<<<<< / ======= / >>>>>>> 之间）的改动意图后合并成正确的内容，写回文件并去掉冲突标记；'),
    tr('拿不准取舍的地方先说明再问我。改完后在该终端执行 `git add <文件>` 标记已解决，不要执行 git commit / push。'),
  ].join('\n')
}

// ── 执行记录 ──
export type GitAuditAction = 'stage' | 'unstage' | 'commit'
export const gitDecision = (a: GitAuditAction) => `git_${a}`
const GIT_AUDIT_LABEL: Record<string, string> = { git_stage: tk('Git 暂存'), git_unstage: tk('Git 取消暂存'), git_commit: tk('Git 提交') }
export const gitAuditLabel = (decision: string): string | undefined => (GIT_AUDIT_LABEL[decision] ? tr(GIT_AUDIT_LABEL[decision]) : undefined)
/** 执行记录里的命令文本：路径太多只列前几个 */
export function gitAuditCommand(a: GitAuditAction, paths: string[], message = ''): string {
  if (a === 'commit') return `git commit -m ${shQuote(message.split('\n')[0].slice(0, 120))}`
  const shown = paths.slice(0, 5).map(shQuote).join(' ') + (paths.length > 5 ? ` …（共 ${paths.length} 个）` : '')   // i18n-ignore 执行记录（存盘）
  return a === 'stage' ? `git add -A -- ${shown}` : `git restore --staged -- ${shown}`
}
