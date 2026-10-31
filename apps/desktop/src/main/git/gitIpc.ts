// Git 助手（见 shared/git/gitStatus.ts）：当前终端所在仓库的改动列表 / diff / 暂存 / 提交 / AI 写提交说明。
// 全部走独立通道（SSH = exec channel，本地 = 本机 Git Bash / sh 子进程），不在用户终端里刷屏。
// 暂存 / 取消暂存 / 提交是用户手动操作：界面上点了才做（提交先确认），都记执行记录（git_stage / git_unstage / git_commit）。
import {
  GIT_TIMEOUT_MS, GIT_DIFF_MAX, buildCommitPrompt, gitAuditCommand, gitCommitCommand, gitDecision, gitDiffCommand, gitStageCommand, gitStagedCommand, gitStatusCommand,
  GIT_MARK, GIT_PROBLEM_TEXT, isGitPath, normalizeCommitMsg, parseGitStatus, splitGitRc,
  type GitDiffMode, type GitStatusResult, type TerminalInfo,
  GIT_LOG_PAGE, GIT_OP_LABEL, gitCommitDiffCommand, gitLogCommand, gitNetHint, gitOpCommand, gitOpDecision, gitOpNetwork, gitProgressCommand, gitRefsCommand, gitShowCommand,
  gitStashDiffCommand, gitStashFilesCommand, gitStashListCommand, isCommitId, isRefName, isStashRef, parseGitLog, parseGitProgress, parseGitRefs, parseGitShow, parseGitStashes, parseStashFiles,
  GIT_BLAME_MAX, gitBlameCommand, gitReadFileCommand, parseGitBlame,
  GIT_CHANGELOG_MAX, parseStagedReview, gitRemotesCommand, parseGitRemotes, gitRebasePlanCommand, parseRebasePlan, buildChangelogPrompt, buildStagedReviewPrompt, cleanAiMarkdown, gitChangelogCommand, gitCompareCommand, gitCompareDiffCommand, isCompareRef, parseGitCompare,
  type GitLogQuery, type GitOp, tr,
} from '@lingshell/shared'
import type { ExecFullResult } from '@lingshell/terminal-core'

export type GitRun = (command: string, o: { timeoutMs: number; maxBytes?: number; stdin?: string }) => Promise<ExecFullResult>
export interface GitIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  /** 该终端对应的独立通道（SSH exec / 本机 sh） */
  run(terminalId: string): GitRun
  complete(system: string, user: string, signal: AbortSignal, source: string): Promise<string>
  redact(text: string): string
  audit(terminalId: string, entry: { command: string; decision: string; exitCode?: number }): void
}

const MAX_OUT = 600 * 1024
const pathsOf = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.length || v.length > 2000 || !v.every(isGitPath)) throw new Error(tr('非法的文件列表'))
  return v as string[]
}
const dirOf = (v: unknown) => { if (!isGitPath(v)) throw new Error(tr('非法的目录')); return v }
const fail = (r: ExecFullResult) => (r.stopped === 'timeout' ? tr('执行超时') : '')

export async function gitStatus(run: GitRun, dir: string): Promise<GitStatusResult> {
  const r = await run(gitStatusCommand(dir), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT })
  if (r.stopped) return { ok: false, problem: 'error', message: fail(r) || tr('已中止') }
  return parseGitStatus(r.output)
}

export async function gitDiff(run: GitRun, root: string, path: string, mode: GitDiffMode): Promise<string> {
  const r = await run(gitDiffCommand(root, path, mode), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT })
  const s = splitGitRc(r.output)
  if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
  return r.output
}

/** 写操作：返回退出码与输出（调用方先记执行记录再报错） */
async function write(run: GitRun, cmd: string, stdin?: string): Promise<{ rc?: number; text: string }> {
  const r = await run(cmd, { timeoutMs: 60_000, maxBytes: MAX_OUT, ...(stdin !== undefined ? { stdin } : {}) })
  const s = splitGitRc(r.output)
  if (s.problem) return { rc: 1, text: tr(GIT_PROBLEM_TEXT[s.problem]) }
  return { rc: r.stopped ? undefined : s.rc, text: s.text || fail(r) }
}

export async function suggestCommitMessage(d: Pick<GitIpcDeps, 'complete' | 'redact'>, run: GitRun, root: string, branch: string, paths?: string[]): Promise<string> {
  const r = await run(gitStagedCommand(root, paths), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT })
  const s = splitGitRc(r.output)
  if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
  const i = r.output.indexOf('@@git:diff')
  const stat = i < 0 ? '' : r.output.slice(0, i), diff = i < 0 ? r.output : r.output.slice(i + 11)
  if (!diff.trim()) throw new Error(tr('还没有已暂存的改动：先勾选文件「暂存」'))
  const p = buildCommitPrompt(d.redact(stat), d.redact(diff), branch)
  const msg = normalizeCommitMsg(await d.complete(p.system, p.user, AbortSignal.timeout(90_000), 'git-commit-message'))
  if (!msg) throw new Error(tr('模型没有给出提交说明'))
  return msg
}

export function registerGit(d: GitIpcDeps): void {
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (t.type === 'ssh' && t.os === 'windows') throw new Error(tr('Git 助手不支持 Windows 的 SSH 主机'))
    return t
  }
  d.handle('git:status', (_e, id, dir) => gitStatus(d.run(target(id).id), dirOf(dir)))
  d.handle('git:diff', (_e, id, root, path, mode) => {
    if (mode !== 'staged' && mode !== 'work' && mode !== 'untracked') throw new Error(tr('非法的 diff 类型'))
    if (!isGitPath(path)) throw new Error(tr('非法的路径'))
    return gitDiff(d.run(target(id).id), dirOf(root), path, mode)
  })
  d.handle('git:stage', async (_e, id, root, paths, stage) => {
    const t = target(id), ps = pathsOf(paths), on = stage === true
    const res = await write(d.run(t.id), gitStageCommand(dirOf(root), ps, on))
    d.audit(t.id, { command: gitAuditCommand(on ? 'stage' : 'unstage', ps), decision: gitDecision(on ? 'stage' : 'unstage'), exitCode: res.rc })
    if (res.rc !== 0) throw new Error(res.text || (on ? tr('暂存失败') : tr('取消暂存失败')))
  })
  d.handle('git:commit', async (_e, id, root, message) => {
    const t = target(id)
    if (typeof message !== 'string' || !message.trim() || message.length > 20_000) throw new Error(tr('提交说明不能为空'))
    const msg = message.replace(/\r\n/g, '\n').trim() + '\n'
    const res = await write(d.run(t.id), gitCommitCommand(dirOf(root)), msg)
    d.audit(t.id, { command: gitAuditCommand('commit', [], msg), decision: gitDecision('commit'), exitCode: res.rc })
    if (res.rc !== 0) throw new Error(res.text || tr('提交失败'))
    return res.text
  })
  // paths：只针对勾选的已暂存文件（不给 = 全部已暂存）
  const optPaths = (v: unknown) => (Array.isArray(v) && v.length ? pathsOf(v) : undefined)
  d.handle('git:suggest', (_e, id, root, branch, paths) => suggestCommitMessage(d, d.run(target(id).id), dirOf(root), typeof branch === 'string' ? branch.slice(0, 200) : '', optPaths(paths)))

  // ── 分支 / 历史 / 储藏（只读）──
  const read = async (id: unknown, cmd: string): Promise<string> => {
    const r = await d.run(target(id).id)(cmd, { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 })
    if (r.stopped) throw new Error(fail(r) || tr('已中止'))
    const s = splitGitRc(r.output)
    if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
    // 没有 rc = 输出超过上限被截断。不能把半份数据当成功（变基计划会因此少列提交）
    if (s.rc === undefined) throw new Error(tr('git 输出超过上限被截断，无法确认结果；请在终端里执行，或减少一次处理的数据量'))
    if (s.rc !== 0) throw new Error(s.text.slice(-1000) || tr('git 执行失败'))
    return r.output
  }
  // diff 类命令末尾直接接 head，没有 rc：至少把超时和截断告诉界面，不把半截 diff 当完整内容
  const diffOut = (r: ExecFullResult): string => {
    if (r.stopped) throw new Error(fail(r) || tr('已中止'))
    return r.output.length >= GIT_DIFF_MAX ? `${r.output}\n${tr('…（diff 超过 {n}KB，已截断）', { n: Math.round(GIT_DIFF_MAX / 1000) })}` : r.output
  }
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  d.handle('git:refs', async (_e, id, root) => parseGitRefs(await read(id, gitRefsCommand(dirOf(root)))))
  d.handle('git:log', async (_e, id, root, q) => {
    const o = (q && typeof q === 'object' ? q : {}) as GitLogQuery
    // 路径不 trim：POSIX 文件名可以以空格开头 / 结尾，trim 后会查到别的文件
    const path = typeof o.path === 'string' ? o.path : undefined
    const refName = str(o.ref)
    if (path !== undefined && !isGitPath(path)) throw new Error(tr('非法的路径'))
    if (refName !== undefined && !isRefName(refName)) throw new Error(tr('非法的分支名'))
    const query: GitLogQuery = { all: o.all === true, skip: Number(o.skip) || 0, limit: Number(o.limit) || GIT_LOG_PAGE, grep: str(o.grep), author: str(o.author, 100), pickaxe: str(o.pickaxe, 300), path, ref: refName }
    return parseGitLog(await read(id, gitLogCommand(dirOf(root), query)))
  })
  d.handle('git:show', async (_e, id, root, hash) => {
    if (!isCommitId(hash)) throw new Error(tr('非法的提交号'))
    const r = parseGitShow(await read(id, gitShowCommand(dirOf(root), hash)))
    if (!r) throw new Error(tr('读不到这个提交'))
    return r
  })
  d.handle('git:commitDiff', async (_e, id, root, hash, path) => {
    if (!isCommitId(hash) || !isGitPath(path)) throw new Error(tr('参数不对'))
    return diffOut(await d.run(target(id).id)(gitCommitDiffCommand(dirOf(root), hash, path), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT }))
  })
  d.handle('git:stashes', async (_e, id, root) => parseGitStashes(await read(id, gitStashListCommand(dirOf(root)))))
  d.handle('git:stashFiles', async (_e, id, root, ref) => { if (!isStashRef(ref)) throw new Error(tr('非法的储藏')); return parseStashFiles(await read(id, gitStashFilesCommand(dirOf(root), ref))) })
  d.handle('git:stashDiff', async (_e, id, root, ref, path, untracked) => {
    if (!isStashRef(ref) || !isGitPath(path)) throw new Error(tr('参数不对'))
    return diffOut(await d.run(target(id).id)(gitStashDiffCommand(dirOf(root), ref, path, untracked === true), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT }))
  })
  d.handle('git:blame', async (_e, id, root, path, rev) => {
    if (!isGitPath(path) || (rev !== undefined && rev !== null && !isCommitId(rev))) throw new Error(tr('参数不对'))
    const r = await d.run(target(id).id)(gitBlameCommand(dirOf(root), path, typeof rev === 'string' ? rev : undefined), { timeoutMs: 60_000, maxBytes: GIT_BLAME_MAX + 4096 })
    if (r.stopped) throw new Error(fail(r) || tr('已中止'))
    const s = splitGitRc(r.output)
    if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
    const lines = parseGitBlame(r.output)
    if (!lines.length) throw new Error(s.text.slice(-500) || tr('没有可追溯的内容（新文件还没提交？）'))
    return lines
  })
  d.handle('git:readFile', async (_e, id, root, path) => {
    if (!isGitPath(path)) throw new Error(tr('非法的路径'))
    const r = await d.run(target(id).id)(gitReadFileCommand(dirOf(root), path), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 3 * 1024 * 1024 + 4096 })
    const s = splitGitRc(r.output)
    if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
    if (s.rc !== 0) throw new Error(s.text.slice(-500) || tr('读不了这个文件'))
    // 标记行：@@git:size:<字节数>\x1f<git blob 哈希>
    const m = new RegExp(`^${GIT_MARK}size:(-?\\d+)\\x1f([0-9a-f-]+)`, 'm').exec(r.output)
    const size = m ? Number(m[1]) : undefined
    const hash = m && /^[0-9a-f]{40,64}$/.test(m[2]) ? m[2] : undefined
    const start = m ? r.output.indexOf('\n', m.index ?? 0) + 1 : 0
    const i = r.output.lastIndexOf(`\n${GIT_MARK}rc:`)
    const text = r.output.slice(start, i < 0 ? undefined : i)   // 不 trim：换行原样
    return {
      text,
      ...(size !== undefined && size >= 0 ? { size } : {}),
      ...(hash ? { hash } : {}),
      truncated: size !== undefined && size > 3 * 1024 * 1024,
      binary: text.includes('\0'),
    }
  })
  d.handle('git:compare', async (_e, id, root, a, b) => {
    if (!isCompareRef(a) || (b !== undefined && b !== null && b !== '' && !isCompareRef(b))) throw new Error(tr('非法的版本'))
    return parseGitCompare(await read(id, gitCompareCommand(dirOf(root), a, b || undefined)))
  })
  d.handle('git:compareDiff', async (_e, id, root, a, b, path) => {
    const bb = typeof b === 'string' && b ? b : undefined
    if (!isCompareRef(a) || (bb !== undefined && !isCompareRef(bb)) || !isGitPath(path)) throw new Error(tr('参数不对'))
    return diffOut(await d.run(target(id).id)(gitCompareDiffCommand(dirOf(root), a, bb, path), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT }))
  })
  // 更新日志：from..to 的提交（脱敏后）交给模型整理
  d.handle('git:changelog', async (_e, id, root, from, to, audience) => {
    const fr = typeof from === 'string' && from ? from : undefined
    if ((fr !== undefined && !isCompareRef(fr)) || !isCompareRef(to)) throw new Error(tr('非法的版本'))
    const out = await read(id, gitChangelogCommand(dirOf(root), fr, to))
    const si = out.indexOf('@@git:stat')
    const commits = out.slice(0, si < 0 ? undefined : si).split('@@git:c ').slice(1).map((c) => c.trim().split('\x1f').map((x) => x.trim().replace(/\n+/g, ' ')).join(' | '))
    if (!commits.length) throw new Error(tr('这个范围里没有提交'))
    const stat = si < 0 ? '' : out.slice(si + 10).replace(/@@git:rc:\d+\s*$/, '').trim()
    const blob = `${commits.join('\n')}\n\n改动统计：${stat}`   // i18n-ignore 发给模型
    const p = buildChangelogPrompt(d.redact(blob), { ...(fr ? { from: fr } : {}), to, audience: audience === 'user' || audience === 'dev' ? audience : 'ops' })
    const md = cleanAiMarkdown(await d.complete(p.system, p.user, AbortSignal.timeout(180_000), 'git-changelog'))
    if (!md) throw new Error(tr('模型没有给出内容'))
    return { markdown: md, commits: commits.length, truncated: commits.length >= GIT_CHANGELOG_MAX || blob.length > 60_000 }
  })
  // 审查已暂存的改动（同 AI 写提交说明：脱敏后发给模型）
  d.handle('git:review', async (_e, id, root, paths) => {
    const r = await d.run(target(id).id)(gitStagedCommand(dirOf(root), optPaths(paths)), { timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_OUT })
    const s = splitGitRc(r.output)
    if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
    const i = r.output.indexOf('@@git:diff')
    const stat = i < 0 ? '' : r.output.slice(0, i), diff = i < 0 ? r.output : r.output.slice(i + 11)
    if (!diff.trim()) throw new Error(tr('还没有已暂存的改动：先暂存要提交的文件'))
    const p = buildStagedReviewPrompt(d.redact(stat), d.redact(diff))
    const raw = await d.complete(p.system, p.user, AbortSignal.timeout(180_000), 'git-review')
    const md = cleanAiMarkdown(raw)
    if (!md) throw new Error(tr('模型没有给出内容'))
    const result = parseStagedReview(raw)
    return { ...(result ? { result } : {}), markdown: md }
  })
  d.handle('git:remotes', async (_e, id, root) => parseGitRemotes(await read(id, gitRemotesCommand(dirOf(root)))))
  d.handle('git:rebasePlan', async (_e, id, root, from) => {
    if (!isCommitId(from)) throw new Error(tr('非法的提交号'))
    const p = parseRebasePlan(await read(id, gitRebasePlanCommand(dirOf(root), from)))
    if (p.notAncestor) throw new Error(tr('这个提交不在当前分支的历史里：只能从当前分支的提交开始整理'))
    if ((p.count ?? p.commits.length) > 100) throw new Error(tr('范围太大（{n} 个提交，最多 100 个），从更近的提交开始', { n: p.count ?? p.commits.length }))
    if (p.count !== undefined && p.commits.length !== p.count) throw new Error(tr('提交列表读取不完整（输出被截断），请从更近的提交开始'))
    return p
  })
  d.handle('git:progress', async (_e, id, root) => parseGitProgress(await read(id, gitProgressCommand(dirOf(root)))))

  // ── 写操作：一律记执行记录；失败带上原文和常见原因提示 ──
  d.handle('git:op', async (_e, id, root, op, message) => {
    const t = target(id)
    const o = op as GitOp
    if (!o || typeof o !== 'object' || !(o.op in GIT_OP_LABEL)) throw new Error(tr('不支持的操作'))
    if (o.op === 'commit' && o.exclude?.length) o.exclude = pathsOf(o.exclude)
    if (o.op === 'discard') { o.paths = o.paths?.length ? pathsOf(o.paths) : []; o.untracked = o.untracked?.length ? pathsOf(o.untracked) : [] }
    if (o.op === 'resolveFile' && o.expectedHash !== undefined && !/^[0-9a-f]{40,64}$/.test(o.expectedHash)) throw new Error(tr('文件版本参数不对'))
    const needMsg = o.op === 'commit' || (o.op === 'createTag' && !!o.message)
    const msg = o.op === 'createTag' ? o.message : message
    if (o.op === 'commit' && (typeof msg !== 'string' || !msg.trim() || msg.length > 20_000)) throw new Error(tr('提交说明不能为空'))
    // 补丁 / 合并结果：内容原样进 stdin（换行风格、末尾换行都不能动）
    const raw = o.op === 'applyPatch' || o.op === 'resolveFile'
    if (raw && (typeof message !== 'string' || message.length > 8 * 1024 * 1024)) throw new Error(tr('内容不对'))
    if (o.op === 'applyPatch' && !String(message).startsWith('diff --git ')) throw new Error(tr('补丁格式不对'))
    const { cmd, audit } = gitOpCommand(dirOf(root), o, typeof msg === 'string' ? msg : undefined)
    const stdin = raw ? message as string : needMsg ? `${String(msg).replace(/\r\n/g, '\n').trim()}\n`
      : o.op === 'ignore' ? `${o.patterns.join('\n')}\n` : undefined
    const res = await d.run(t.id)(cmd, { timeoutMs: gitOpNetwork(o) ? 180_000 : 60_000, maxBytes: MAX_OUT, ...(stdin !== undefined ? { stdin } : {}) })
    const s = splitGitRc(res.output)
    const code = s.problem ? 1 : res.stopped ? undefined : s.rc
    d.audit(t.id, { command: audit, decision: gitOpDecision(o), exitCode: code })
    if (s.problem) throw new Error(tr(GIT_PROBLEM_TEXT[s.problem]))
    if (code === undefined && !res.stopped) {
      // rc 标记被截掉：命令可能已经成功，不能报成失败让用户重试（重试可能产生重复提交 / 推送）
      throw new Error(tr('git 输出超过上限被截断，无法确认操作是否成功：请刷新状态，或在终端里查看后再继续'))
    }
    if (code !== 0) {
      const text = s.text || fail(res) || tr('{op}失败', { op: tr(GIT_OP_LABEL[o.op]) })
      const hint = gitNetHint(text)
      throw new Error(hint ? `${hint}\n\n${text.slice(-1500)}` : text.slice(-2000))
    }
    // 工作区干净时 git stash push 返回 0 + "No local changes to save"，不能显示成已储藏
    if (o.op === 'stashPush' && /No local changes to save/i.test(s.text)) throw new Error(tr('没有可储藏的改动（只有未跟踪文件时要勾选「包括未跟踪的新文件」）'))
    return s.text
  })
}
