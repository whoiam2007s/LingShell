// Git 面板（分支 / 历史 / 储藏 / 同步 / 各种写操作）：真实 git，临时目录里的仓库 + 本地裸仓库当 origin。
// 两条通道都跑：本机 sh 子进程，以及回环假 sshd 的 exec channel（stdin 照转：提交说明、附注标签靠它）。不碰真实仓库、不联网
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { type GitCompareResult, type GitRemote, type RebasePlan, linePatch, cleanGitDiff, gitGraph, splitHunks, parseConflicts, mergeResult, isUncommittedHash, type GitBlameLine, type GitCommit, type GitCommitDetail, type GitRef, type GitStash, type GitStatusResult, type GitChangedFile, type TerminalInfo } from '@lingshell/shared'
import { registerGit, type GitRun } from './gitIpc.js'
import { runSh } from '../terminal/index.js'
import { findBash } from '../core/index.js'

const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const dir = mkdtempSync(join(tmpdir(), 'lingshell-gitops-'))
const hooks = join(dir, 'nohooks')
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const cfg = (r: string) => { for (const [k, v] of [['core.fsmonitor', 'false'], ['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.hooksPath', hooks], ['core.autocrlf', 'false'], ['pull.rebase', 'false']]) git(r, 'config', k, v) }
const fwd = (p: string) => p.replace(/\\/g, '/')

let srv: { close(): void } | undefined
let conn: SshConn | undefined
beforeAll(async () => {
  mkdirSync(hooks, { recursive: true })
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        const ch = ok()
        const p = spawn(BASH!, ['-c', info.command])
        p.stdout.pipe(ch, { end: false }); p.stderr.pipe(ch.stderr, { end: false })
        ch.on('data', (d: Buffer) => p.stdin.write(d))
        ch.on('end', () => p.stdin.end())
        p.stdin.on('error', () => {})
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  const port = await new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))
  srv = { close: () => s.close() }
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  conn = await connectSsh({ host: '127.0.0.1', port, username: 'u', password: 'p' })
}, 30_000)
afterAll(() => { conn?.close(); srv?.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Windows 上偶尔还被占用 */ } })

const runners: [string, () => GitRun][] = [
  ['本机 sh', () => (cmd, o) => runSh(cmd, o)],
  ['SSH exec channel', () => (cmd, o) => execFull(conn!.client, cmd, o)],
]

describe.each(runners)('Git 面板 · %s', (label, mk) => {
  const audits: { command: string; decision: string; exitCode?: number }[] = []
  const prompts: string[] = []
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  registerGit({
    handle: (ch, fn) => { hs.set(ch, fn) },
    terminal: (id) => (id === 't1' ? ({ id, type: label === '本机 sh' ? 'local' : 'ssh', os: 'linux', title: 'dev' } as TerminalInfo) : undefined),
    run: () => mk(), redact: (t) => t.replace(/SECRET-\w+/g, '***'), audit: (_t, e) => { audits.push(e) },
    complete: async (s, u) => { prompts.push(`${s}\n${u}`); return s.includes('更新日志') ? '```markdown\n## 更新\n- 新功能\n```' : s.includes('审查') ? '可以提交' : '' },
  })
  const call = <T,>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, 't1', ...a)) as Promise<T>
  const op = (root: string, o: Record<string, unknown>, msg?: string) => call<string>('git:op', root, o, msg)

  it('推送 / 分支 / 提交 / 合并 / 历史图 / 标签 / 储藏 / 丢弃 / 重置 / 还原 / 拣选 / 拉取 / 冲突中止', async () => {
    const base = join(dir, `r${label.length}`)
    const origin = `${base}-origin.git`, r = `${base}-work`, other = `${base}-other`
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    writeFileSync(join(r, 'a.txt'), 'one\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'init')
    git(r, 'remote', 'add', 'origin', fwd(origin))
    const root = r

    // 推送：没有上游 → push -u
    await op(root, { op: 'push', branch: 'main', setUpstream: true })
    let refs = await call<GitRef[]>('git:refs', root)
    expect(refs.find((x) => x.kind === 'local' && x.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main', ahead: 0, behind: 0 })
    expect(refs.some((x) => x.kind === 'remote' && x.name === 'origin/main')).toBe(true)

    // 新建并切到 dev，暂存 + 提交（说明走 stdin，带引号 / 换行）
    await op(root, { op: 'createBranch', name: 'feature/dev', checkout: true })
    writeFileSync(join(r, 'b.txt'), 'bee\n')
    await call('git:stage', root, ['b.txt'], true)
    const msg = `feat: it's "b" $HOME\n\n- 第二行`
    await op(root, { op: 'commit', amend: false, push: false, branch: 'feature/dev' }, msg)
    expect(git(r, 'log', '-1', '--format=%B').trim()).toBe(msg)
    // 修改上次提交
    writeFileSync(join(r, 'b.txt'), 'bee2\n'); await call('git:stage', root, ['b.txt'], true)
    await op(root, { op: 'commit', amend: true, push: false, branch: 'feature/dev' }, 'feat: b amended')
    expect(git(r, 'log', '--format=%s').trim().split('\n')).toEqual(['feat: b amended', 'init'])

    // 回 main 提交一个，再合并 dev（--no-ff 出合并提交）
    await op(root, { op: 'checkout', branch: 'main' })
    writeFileSync(join(r, 'a.txt'), 'one\ntwo\n'); await call('git:stage', root, ['a.txt'], true)
    await op(root, { op: 'commit', amend: false, push: false, branch: 'main' }, 'main: two')
    await op(root, { op: 'merge', ref: 'feature/dev', noFf: true })

    // 历史：4 个提交，合并提交两个父；图里合并那行有两条往下的线
    const log = await call<GitCommit[]>('git:log', root, {})
    expect(log.map((c) => c.subject)).toEqual(["Merge branch 'feature/dev'", 'feat: b amended', 'main: two', 'init'].map((s, i) => (i === 0 ? log[0].subject : s)))
    expect(log[0].subject).toMatch(/^Merge branch 'feature\/dev'/)
    expect(log[0].parents).toHaveLength(2)
    expect(log[0].refs).toContain('HEAD -> main')
    const g = gitGraph(log)
    expect(g[0].lines.filter((l) => l.half === 'bottom').length).toBe(2)
    expect(g.at(-1)!.col).toBe(0)
    // 过滤：按说明 / 按文件
    expect((await call<GitCommit[]>('git:log', root, { grep: 'AMENDED' })).map((c) => c.subject)).toEqual(['feat: b amended'])
    expect((await call<GitCommit[]>('git:log', root, { path: 'a.txt' })).map((c) => c.subject)).toEqual(['main: two', 'init'])
    // 提交详情 + 某个文件的改动
    const det = await call<GitCommitDetail>('git:show', root, log[1].hash)
    expect(det).toMatchObject({ message: 'feat: b amended', author: 'T', files: [{ code: 'A', path: 'b.txt' }] })
    expect(cleanGitDiff(await call<string>('git:commitDiff', root, log[1].hash, 'b.txt'))).toContain('+bee2')
    expect((await call<GitCommitDetail>('git:show', root, log[0].hash)).files.map((f) => f.path)).toEqual(['b.txt'])   // 合并提交对第一个父提交
    expect((await call<GitCommitDetail>('git:show', root, log[3].hash)).files.map((f) => f.path)).toEqual(['a.txt'])   // 根提交

    // 标签：附注标签（说明走 stdin）→ 推送
    await op(root, { op: 'createTag', name: 'v1.0', message: '第一版' })
    await op(root, { op: 'pushTag', name: 'v1.0' })
    expect(git(origin, 'tag', '-n')).toContain('v1.0')
    refs = await call<GitRef[]>('git:refs', root)
    expect(refs.find((x) => x.kind === 'tag')).toMatchObject({ name: 'v1.0' })
    expect((await call<GitCommit[]>('git:log', root, {}))[0].refs).toContain('tag: v1.0')

    // 储藏：已跟踪改动 + 未跟踪文件 → 干净 → 列表 / 文件 / diff → 弹出恢复
    writeFileSync(join(r, 'a.txt'), 'one\ntwo\nstash\n'); writeFileSync(join(r, 'new.txt'), 'n\n')
    await op(root, { op: 'stashPush', message: '临时 WIP', untracked: true })
    const st = await call<GitStatusResult>('git:status', root)
    expect(st.ok && st.status.files).toEqual([])
    const stashes = await call<GitStash[]>('git:stashes', root)
    expect(stashes).toHaveLength(1)
    expect(stashes[0]).toMatchObject({ ref: 'stash@{0}' })
    expect(stashes[0].message).toContain('临时 WIP')
    const sf = await call<GitChangedFile[]>('git:stashFiles', root, 'stash@{0}')
    expect(sf).toEqual([{ code: 'M', path: 'a.txt' }, { code: '?', path: 'new.txt' }])
    expect(cleanGitDiff(await call<string>('git:stashDiff', root, 'stash@{0}', 'a.txt', false))).toContain('+stash')
    expect(await call<string>('git:stashDiff', root, 'stash@{0}', 'new.txt', true)).toContain('n')
    await op(root, { op: 'stashPop', ref: 'stash@{0}' })
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toContain('stash')
    expect(await call<GitStash[]>('git:stashes', root)).toEqual([])
    // 不带 -u 的储藏没有第三个父提交：详情也必须能打开（以前 rev-parse 失败导致整条命令 rc=1）
    writeFileSync(join(r, 'a.txt'), 'one\ntwo\nstash-tracked\n')
    await op(root, { op: 'stashPush', message: '仅跟踪文件', untracked: false })
    expect(await call<GitChangedFile[]>('git:stashFiles', root, 'stash@{0}')).toEqual([{ code: 'M', path: 'a.txt' }])
    await op(root, { op: 'stashPop', ref: 'stash@{0}' })

    // 丢弃：已跟踪的还原、未跟踪的删除（只删列出的）
    writeFileSync(join(r, 'keep.txt'), 'k\n')
    await op(root, { op: 'discard', paths: ['a.txt'], untracked: ['new.txt'] })
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(existsSync(join(r, 'new.txt'))).toBe(false)
    expect(existsSync(join(r, 'keep.txt'))).toBe(true)
    rmSync(join(r, 'keep.txt'))

    // 还原 / 拣选 / 重置
    const two = log.find((c) => c.subject === 'main: two')!.hash
    await op(root, { op: 'revert', hash: two })
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\n')
    await op(root, { op: 'cherryPick', hash: two })
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    const head = git(r, 'rev-parse', 'HEAD').trim()
    await op(root, { op: 'reset', hash: log[0].hash, mode: 'hard' })
    expect(git(r, 'rev-parse', 'HEAD').trim()).toBe(log[0].hash)
    expect(head).not.toBe(log[0].hash)

    // 删分支（已合并，-d 就行）、重命名
    await op(root, { op: 'createBranch', name: 'tmp', checkout: false })
    await op(root, { op: 'renameBranch', from: 'tmp', to: 'tmp2' })
    await op(root, { op: 'deleteBranch', name: 'tmp2', force: false })
    await op(root, { op: 'deleteBranch', name: 'feature/dev', force: false })
    expect((await call<GitRef[]>('git:refs', root)).filter((x) => x.kind === 'local').map((x) => x.name)).toEqual(['main'])

    // 推送合并结果；另一个克隆再推一个提交 → 这边推送被拒（提示先拉取）→ 抓取看到落后 → 拉取
    await op(root, { op: 'push', branch: 'main' })
    git(dir, 'clone', '-q', fwd(origin), other); cfg(other)
    writeFileSync(join(other, 'o.txt'), 'o\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'other'); git(other, 'push', '-q')
    writeFileSync(join(r, 'c.txt'), 'c\n'); await call('git:stage', root, ['c.txt'], true)
    await expect(op(root, { op: 'commit', amend: false, push: true, branch: 'main' }, 'local c')).rejects.toThrow('先「拉取」')
    await op(root, { op: 'fetch' })
    expect((await call<GitRef[]>('git:refs', root)).find((x) => x.name === 'main')).toMatchObject({ ahead: 1, behind: 1 })
    await op(root, { op: 'pull' })
    expect(existsSync(join(r, 'o.txt'))).toBe(true)
    await op(root, { op: 'push', branch: 'main' })
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toMatch(/^Merge/)

    // 冲突：正在合并 → 中止
    git(r, 'checkout', '-q', '-b', 'x'); writeFileSync(join(r, 'a.txt'), 'x\n'); git(r, 'commit', '-qam', 'x')
    git(r, 'checkout', '-q', 'main'); writeFileSync(join(r, 'a.txt'), 'y\n'); git(r, 'commit', '-qam', 'y')
    await expect(op(root, { op: 'merge', ref: 'x' })).rejects.toThrow(/CONFLICT|冲突/)
    expect(await call('git:progress', root)).toBe('merge')
    await op(root, { op: 'abort', what: 'merge' })
    expect(await call('git:progress', root)).toBeUndefined()

    // 非法参数：分支名 / 提交号 / 储藏 / 操作
    await expect(op(root, { op: 'checkout', branch: '-x' })).rejects.toThrow('非法')
    await expect(op(root, { op: 'checkout', branch: 'a b' })).rejects.toThrow('非法')
    await expect(op(root, { op: 'reset', hash: 'HEAD;rm -rf /', mode: 'hard' })).rejects.toThrow('非法')
    await expect(op(root, { op: 'stashDrop', ref: 'stash@{0};x' })).rejects.toThrow('非法')
    await expect(op(root, { op: 'rm' })).rejects.toThrow('不支持')

    const ds = audits.map((a) => a.decision)
    for (const k of ['git_push', 'git_createBranch', 'git_commit', 'git_checkout', 'git_merge', 'git_createTag', 'git_pushTag', 'git_stashPush', 'git_stashPop', 'git_discard', 'git_revert', 'git_cherryPick', 'git_reset', 'git_deleteBranch', 'git_fetch', 'git_pull', 'git_abort']) expect(ds).toContain(k)
    expect(audits.find((a) => a.decision === 'git_merge' && a.exitCode !== 0)).toBeTruthy()   // 失败的也记
  }, 120_000)

  it('逐行追溯 / 按块暂存、取消、丢弃（含 CRLF 文件）/ 冲突解析与保存', async () => {
    const r = join(dir, `blk${label.length}`)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    const L = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const save = () => writeFileSync(join(r, 'f.txt'), L.join('\n') + '\n')
    const W = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    save(); writeFileSync(join(r, 'w.txt'), W.join('\r\n') + '\r\n')
    git(r, 'add', '.'); git(r, 'commit', '-qm', 'base')
    L[9] = 'line 10 by lisi'; save()
    git(r, '-c', 'user.name=李四', 'commit', '-qam', 'lisi 改第 10 行')
    // blame：第 10 行是李四，其余是 T；工作区新改的一行是「未提交」
    L[19] = 'line 20 uncommitted'; save()
    const bl = await call<GitBlameLine[]>('git:blame', r, 'f.txt')
    expect(bl).toHaveLength(30)
    expect(bl[9]).toMatchObject({ line: 10, author: '李四', summary: 'lisi 改第 10 行', text: 'line 10 by lisi' })
    expect(bl[0]).toMatchObject({ author: 'T', summary: 'base' })
    expect(isUncommittedHash(bl[19].hash)).toBe(true)
    expect((await call<GitBlameLine[]>('git:blame', r, 'f.txt', git(r, 'rev-parse', 'HEAD~1').trim()))[9].text).toBe('line 10')   // 指定版本

    // 按块：第 1 行和第 20 行各改一处 → 两块；只暂存第二块
    L[0] = 'line 1 changed'; save()
    const h = splitHunks(await call<string>('git:diff', r, 'f.txt', 'work'))
    expect(h.hunks).toHaveLength(2)
    await op(r, { op: 'applyPatch', path: 'f.txt', cached: true, reverse: false }, h.hunks[1].patch)
    expect(git(r, 'diff', '--cached')).toContain('+line 20 uncommitted')
    expect(git(r, 'diff', '--cached')).not.toContain('line 1 changed')
    expect(git(r, 'diff')).toContain('+line 1 changed')
    // 取消暂存这一块
    const sh = splitHunks(await call<string>('git:diff', r, 'f.txt', 'staged'))
    await op(r, { op: 'applyPatch', path: 'f.txt', cached: true, reverse: true }, sh.hunks[0].patch)
    expect(git(r, 'diff', '--cached')).toBe('')
    // 丢弃第一块（工作区）
    const h2 = splitHunks(await call<string>('git:diff', r, 'f.txt', 'work'))
    await op(r, { op: 'applyPatch', path: 'f.txt', cached: false, reverse: true }, h2.hunks[0].patch)
    expect(readFileSync(join(r, 'f.txt'), 'utf8').split('\n')[0]).toBe('line 1')
    expect(readFileSync(join(r, 'f.txt'), 'utf8')).toContain('line 20 uncommitted')
    // CRLF 文件：按块暂存后内容不变形
    const W2 = [...W]; W2[0] = 'A'; W2[9] = 'J'
    writeFileSync(join(r, 'w.txt'), W2.join('\r\n') + '\r\n')
    const hw = splitHunks(await call<string>('git:diff', r, 'w.txt', 'work'))
    expect(hw.hunks).toHaveLength(2)
    await op(r, { op: 'applyPatch', path: 'w.txt', cached: true, reverse: false }, hw.hunks[0].patch)
    const W3 = [...W]; W3[0] = 'A'
    expect(git(r, 'show', ':w.txt')).toBe(W3.join('\r\n') + '\r\n')
    await expect(op(r, { op: 'applyPatch', path: 'w.txt', cached: true, reverse: false }, 'rm -rf /')).rejects.toThrow('补丁格式')
    git(r, 'checkout', '-q', '--', '.'); git(r, 'reset', '-q'); git(r, 'checkout', '-q', '--', '.')

    // 冲突：两边改同一行 → 读文件解析 → 第一个选「传入」、第二个两者都要 → 保存并标记已解决 → 提交完成合并
    L.splice(0, 30, ...Array.from({ length: 30 }, (_, i) => `line ${i + 1}`))
    git(r, 'checkout', '-q', '-b', 'other'); L[0] = 'other 1'; L[29] = 'other 30'; save(); git(r, 'commit', '-qam', 'other')
    git(r, 'checkout', '-q', 'main'); L[0] = 'main 1'; L[29] = 'main 30'; save(); git(r, 'commit', '-qam', 'main')
    try { git(r, 'merge', 'other') } catch { /* 冲突 */ }
    const read = await call<{ text: string; size?: number; hash?: string; truncated: boolean; binary: boolean }>('git:readFile', r, 'f.txt')
    const text = read.text
    expect(read).toMatchObject({ truncated: false, binary: false })
    expect(read.hash).toMatch(/^[0-9a-f]{40,64}$/)
    const chunks = parseConflicts(text)
    const cs = chunks.filter((c) => c.kind === 'conflict')
    expect(cs).toHaveLength(2)
    expect(cs[0]).toMatchObject({ ours: 'main 1\n', theirs: 'other 1\n', oursLabel: 'HEAD', theirsLabel: 'other' })
    expect(mergeResult(chunks, [undefined, undefined])).toBe(text)   // 都不选 = 原样
    // 打开后文件被外部改过：保存必须拒绝，不能覆盖
    const original = readFileSync(join(r, 'f.txt'), 'utf8')
    await expect(op(r, { op: 'resolveFile', path: 'f.txt', add: false, expectedHash: '0'.repeat(40) }, 'changed\n')).rejects.toThrow('已被修改')
    expect(readFileSync(join(r, 'f.txt'), 'utf8')).toBe(original)
    const out = mergeResult(chunks, ['theirs', 'both'])
    await op(r, { op: 'resolveFile', path: 'f.txt', add: true, expectedHash: read.hash }, out)
    expect(readFileSync(join(r, 'f.txt'), 'utf8')).toBe(out)
    expect(out.startsWith('other 1\n')).toBe(true)
    expect(out.endsWith('main 30\nother 30\n')).toBe(true)
    const s = await call<GitStatusResult>('git:status', r)
    expect(s.ok && s.status.files.filter((f) => f.conflict)).toEqual([])
    await op(r, { op: 'commit', amend: false, push: false, branch: 'main' }, 'merge other')
    expect(git(r, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
  }, 120_000)

  it('撤销提交 / 强制推送 / 加入 .gitignore / 恢复文件版本 / 拉取方式 / 比较 / AI 更新日志与审查', async () => {
    const base = join(dir, `x${label.length}`)
    const origin = `${base}-origin.git`, r = `${base}-work`, other = `${base}-other`
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    writeFileSync(join(r, 'a.txt'), 'v1\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'one')
    git(r, 'remote', 'add', 'origin', fwd(origin))
    await op(r, { op: 'push', branch: 'main', setUpstream: true })
    writeFileSync(join(r, 'a.txt'), 'v2\n'); git(r, 'commit', '-qam', 'two')
    // 撤销上次提交：改动回到暂存区
    await op(r, { op: 'undoCommit' })
    expect(git(r, 'log', '--format=%s').trim()).toBe('one')
    expect(git(r, 'diff', '--cached')).toContain('+v2')
    git(r, 'commit', '-qm', 'two'); await op(r, { op: 'push', branch: 'main' })
    // 修改已推送的提交 → 普通推送被拒 → 强制推送（lease）成功
    git(r, 'commit', '-q', '--amend', '-m', 'two amended')
    await expect(op(r, { op: 'push', branch: 'main' })).rejects.toThrow()
    await op(r, { op: 'push', branch: 'main', force: true })
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('two amended')
    // 别人推过之后，lease 保护：没抓取就强推会被拒
    git(dir, 'clone', '-q', fwd(origin), other); cfg(other)
    writeFileSync(join(other, 'o.txt'), 'o\n'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'other'); git(other, 'push', '-q')
    git(r, 'commit', '-q', '--allow-empty', '-m', 'local')
    await expect(op(r, { op: 'push', branch: 'main', force: true })).rejects.toThrow()
    expect(git(origin, 'log', '-1', '--format=%s', 'main').trim()).toBe('other')
    // 拉取方式：分叉时 ff-only 失败，变基成功（历史是线性的）
    await expect(op(r, { op: 'pull', mode: 'ff' })).rejects.toThrow()
    await op(r, { op: 'pull', mode: 'rebase' })
    expect(git(r, 'log', '--format=%s').trim().split('\n')).toEqual(['local', 'other', 'two amended', 'one'])
    expect(git(r, 'log', '--merges', '--format=%s').trim()).toBe('')

    // .gitignore：追加（原文件末尾没换行也不粘行），忽略后不再是未跟踪
    writeFileSync(join(r, '.gitignore'), 'node_modules')
    writeFileSync(join(r, 'debug.log'), 'x'); mkdirSync(join(r, 'tmp')); writeFileSync(join(r, 'tmp', 'a'), 'x')
    await op(r, { op: 'ignore', patterns: ['/debug.log', 'tmp/'] })
    expect(readFileSync(join(r, '.gitignore'), 'utf8')).toBe('node_modules\n/debug.log\ntmp/\n')
    const st = await call<GitStatusResult>('git:status', r)
    expect(st.ok && st.status.files.map((f) => f.path)).toEqual(['.gitignore'])
    await expect(op(r, { op: 'ignore', patterns: ['a\nb'] })).rejects.toThrow('非法')

    // 恢复文件到某个版本
    const one = git(r, 'rev-list', '--max-parents=0', 'HEAD').trim()
    await op(r, { op: 'restoreFile', hash: one, path: 'a.txt' })
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('v1\n')
    git(r, 'checkout', '-q', '--', 'a.txt')

    // 比较：两个版本之间的文件、各自独有的提交、某个文件的 diff；版本与工作区
    const cmp = await call<GitCompareResult>('git:compare', r, one, 'main')
    expect(cmp.files.map((f) => [f.code, f.path])).toEqual([['M', 'a.txt'], ['A', 'o.txt']])
    expect(cmp.onlyA).toEqual([])
    expect(cmp.onlyB.map((c) => c.subject)).toEqual(['local', 'other', 'two amended'])
    expect(cleanGitDiff(await call<string>('git:compareDiff', r, one, 'main', 'a.txt'))).toContain('+v2')
    writeFileSync(join(r, 'a.txt'), 'work\n')
    expect((await call<GitCompareResult>('git:compare', r, 'main')).files.map((f) => f.path)).toContain('a.txt')
    expect(cleanGitDiff(await call<string>('git:compareDiff', r, 'main', '', 'a.txt'))).toContain('+work')
    git(r, 'checkout', '-q', '--', 'a.txt')

    // AI 更新日志：范围内的提交（脱敏）进提示词，回复去掉代码围栏
    git(r, 'tag', 'v1', one)
    git(r, 'commit', '-q', '--allow-empty', '-m', 'feat: 加了 SECRET-abc 配置', '-m', '需要改配置文件')
    const cl = await call<{ markdown: string; commits: number }>('git:changelog', r, 'v1', 'HEAD', 'ops')
    expect(cl).toMatchObject({ markdown: '## 更新\n- 新功能', commits: 4 })
    const clp = prompts.at(-1)!
    expect(clp).toContain('feat: 加了 *** 配置'); expect(clp).not.toContain('SECRET-abc'); expect(clp).toContain('v1 → HEAD'); expect(clp).toContain('运维')
    // 没有 from：统计用空树..to，不能把工作区未提交的改动算进去
    writeFileSync(join(r, 'a.txt'), 'DIRTY-LOCAL\n')
    await call('git:changelog', r, undefined, 'HEAD', 'ops')
    expect(prompts.at(-1)).not.toContain('DIRTY-LOCAL')
    git(r, 'checkout', '-q', '--', 'a.txt')
    await expect(call('git:changelog', r, 'HEAD', 'HEAD', 'ops')).rejects.toThrow('没有提交')
    // AI 审查已暂存的改动
    await expect(call('git:review', r)).rejects.toThrow('还没有已暂存')
    writeFileSync(join(r, 'a.txt'), 'console.log(1) SECRET-xyz\n'); git(r, 'add', 'a.txt')
    expect(await call<{ markdown: string }>('git:review', r)).toEqual({ markdown: '可以提交' })
    expect(prompts.at(-1)).toContain('+console.log(1) ***')
  }, 120_000)

  it('只提交勾选的已暂存文件：其余保持已暂存（按块暂存的部分不丢），空仓库也行', async () => {
    const r = join(dir, `part${label.length}`)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    // 空仓库：a、b 都暂存，只提交 a
    writeFileSync(join(r, 'a.txt'), 'a\n'); writeFileSync(join(r, 'b.txt'), 'b\n'); git(r, 'add', '.')
    await op(r, { op: 'commit', amend: false, push: false, branch: 'main', exclude: ['b.txt'] }, 'only a')
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt')
    expect(git(r, 'diff', '--cached', '--name-only').trim()).toBe('b.txt')
    git(r, 'commit', '-qm', 'b')
    // 三个文件：a 全暂存、b 全暂存、c 只暂存了一块（工作区还有一块没暂存）；只提交 a
    const L = Array.from({ length: 20 }, (_, i) => `c${i}`)
    writeFileSync(join(r, 'c.txt'), L.join('\n') + '\n'); git(r, 'add', 'c.txt'); git(r, 'commit', '-qm', 'c')
    writeFileSync(join(r, 'a.txt'), 'a2\n'); writeFileSync(join(r, 'b.txt'), 'b2\n')
    L[0] = 'c0-staged'; writeFileSync(join(r, 'c.txt'), L.join('\n') + '\n'); git(r, 'add', '.')
    L[19] = 'c19-unstaged'; writeFileSync(join(r, 'c.txt'), L.join('\n') + '\n')
    await op(r, { op: 'commit', amend: false, push: false, branch: 'main', exclude: ['b.txt', 'c.txt'] }, 'only a2')
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt')
    expect(git(r, 'diff', '--cached', '--name-only').trim().split('\n')).toEqual(['b.txt', 'c.txt'])
    expect(git(r, 'diff', '--cached', 'c.txt')).toContain('+c0-staged')
    expect(git(r, 'diff', '--cached', 'c.txt')).not.toContain('c19-unstaged')
    expect(git(r, 'diff', 'c.txt')).toContain('+c19-unstaged')
    expect(readdirSync(join(r, '.git')).some((f) => f.includes('lingshell-partial'))).toBe(false)   // 临时 index 清掉了
    // AI 写说明 / 审查也只看勾选的文件（b、c 都已暂存，只勾 b）
    await call('git:suggest', r, 'main', ['b.txt']).catch(() => {})
    expect(prompts.at(-1)).toContain('+b2'); expect(prompts.at(-1)).not.toContain('c0-staged')
    await call('git:review', r, ['b.txt'])
    expect(prompts.at(-1)).toContain('+b2'); expect(prompts.at(-1)).not.toContain('c0-staged')
    await call('git:review', r)
    expect(prompts.at(-1)).toContain('c0-staged')   // 不给范围 = 全部已暂存
    // 失败（勾的都排除掉了 = 没东西可提交）也不留临时文件
    await expect(op(r, { op: 'commit', amend: false, push: false, branch: 'main', exclude: ['b.txt', 'c.txt'] }, 'x')).rejects.toThrow()
    expect(readdirSync(join(r, '.git')).some((f) => f.includes('lingshell-partial'))).toBe(false)
  }, 120_000)

  it('按代码内容搜历史 / 远程管理 / 多提交拣选与还原 / 交互式变基 / 按行暂存', async () => {
    const base = join(dir, `t2${label.length}`)
    const r = `${base}-work`, o1 = `${base}-o1.git`, o2 = `${base}-o2.git`
    git(dir, 'init', '-q', '--bare', '-b', 'main', o1); git(dir, 'init', '-q', '--bare', '-b', 'main', o2)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    const put = (f: string, t: string, m: string) => { writeFileSync(join(r, f), t); git(r, 'add', '.'); git(r, 'commit', '-qm', m) }
    put('a.txt', 'a\n', 'c0')
    // 按代码内容搜：加入 / 删除 magicToken 的提交
    put('a.txt', 'a\nmagicToken\n', 'add token'); put('b.txt', 'b\n', 'unrelated'); put('a.txt', 'a\n', 'remove token')
    expect((await call<GitCommit[]>('git:log', r, { pickaxe: 'magicToken' })).map((c) => c.subject)).toEqual(['remove token', 'add token'])

    // 远程：添加（地址里的 token 打码）/ 改地址 / 重命名 / 推到指定远程 / 删除
    await op(r, { op: 'remoteAdd', name: 'origin', url: fwd(o1) })
    await op(r, { op: 'remoteAdd', name: 'backup', url: 'https://bob:S3cretTok@example.com/x.git' })
    let rs = await call<GitRemote[]>('git:remotes', r)
    expect(rs.find((x) => x.name === 'backup')?.fetchUrl).toBe('https://bob:***@example.com/x.git')
    expect(audits.map((a) => a.command).join('\n')).not.toContain('S3cretTok')
    await op(r, { op: 'remoteSetUrl', name: 'backup', url: fwd(o2) })
    await op(r, { op: 'remoteRename', from: 'backup', to: 'mirror' })
    await op(r, { op: 'push', branch: 'main', remote: 'mirror' })
    expect(git(o2, 'log', '-1', '--format=%s', 'main').trim()).toBe('remove token')
    expect(git(r, 'rev-parse', '--abbrev-ref', 'main@{u}').trim()).toBe('mirror/main')
    await op(r, { op: 'remoteRemove', name: 'mirror' })
    rs = await call<GitRemote[]>('git:remotes', r)
    expect(rs.map((x) => x.name)).toEqual(['origin'])
    await expect(op(r, { op: 'remoteAdd', name: 'x', url: '--upload-pack=evil' })).rejects.toThrow('非法')

    // 多提交拣选（从旧到新）/ 还原（从新到旧）
    git(r, 'checkout', '-q', '-b', 'feat'); put('f1.txt', '1\n', 'f1'); put('f2.txt', '2\n', 'f2'); git(r, 'checkout', '-q', 'main')
    const [h2, h1] = git(r, 'log', '--format=%H', '-2', 'feat').trim().split('\n')
    await op(r, { op: 'cherryPick', hash: h1, hashes: [h1, h2] })
    expect(git(r, 'log', '--format=%s', '-2').trim().split('\n')).toEqual(['f2', 'f1'])
    const [p2, p1] = git(r, 'log', '--format=%H', '-2').trim().split('\n')
    await op(r, { op: 'revert', hash: p2, hashes: [p2, p1] })
    expect(existsSync(join(r, 'f1.txt'))).toBe(false); expect(existsSync(join(r, 'f2.txt'))).toBe(false)

    // 交互式变基：x5 挪到最前、保留 x1、x2 改说明并把 x3 压进去（新说明带引号换行）、删掉 x4
    put('x1.txt', '1\n', 'x1'); put('x2.txt', '2\n', 'x2'); put('x3.txt', '3\n', 'x3'); put('x4.txt', '4\n', 'x4'); put('x5.txt', '5\n', 'x5')
    const xs = git(r, 'log', '--reverse', '--format=%H', '-5').trim().split('\n')
    const plan = await call<RebasePlan>('git:rebasePlan', r, xs[0])
    expect(plan.commits.map((c) => c.message)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5'])
    expect(plan).toMatchObject({ merges: 0, root: false, count: 5 })
    expect(plan.head).toBe(git(r, 'rev-parse', 'HEAD').trim())
    // 不在当前分支历史里的提交不能作为整理起点（否则会把当前分支搬到无关提交上）
    git(r, 'checkout', '-q', '-b', 'outside', xs[4])
    writeFileSync(join(r, 'outside.txt'), 'o\n'); git(r, 'add', 'outside.txt'); git(r, 'commit', '-qm', 'outside')
    const outsider = git(r, 'rev-parse', 'HEAD').trim()
    git(r, 'checkout', '-q', 'main')
    await expect(call('git:rebasePlan', r, outsider)).rejects.toThrow('不在当前分支的历史里')
    git(r, 'branch', '-D', 'outside')
    // 打开计划后 HEAD 变了：执行必须拒绝，不能把新提交从 todo 里漏掉
    git(r, 'commit', '-q', '--allow-empty', '-m', 'drift')
    await expect(op(r, { op: 'interactiveRebase', from: xs[0], root: false, steps: [{ hash: xs[0], action: 'pick' }], expectedHead: plan.head })).rejects.toThrow('发生了变化')
    git(r, 'reset', '-q', '--hard', plan.head!)
    const msg = 'feat: it\'s "x2+x3" $HOME\n\n- 合并'
    await op(r, { op: 'interactiveRebase', from: xs[0], root: false, steps: [
      { hash: xs[4], action: 'pick' }, { hash: xs[0], action: 'pick' }, { hash: xs[1], action: 'reword', message: 'unused' },
      { hash: xs[2], action: 'squash', message: msg }, { hash: xs[3], action: 'drop' },
    ] })
    expect(git(r, 'log', '--format=%s', '-3').trim().split('\n')).toEqual([msg.split('\n')[0], 'x1', 'x5'])
    expect(git(r, 'log', '-1', '--format=%B').trim()).toBe(msg)
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['x2.txt', 'x3.txt'])
    expect(existsSync(join(r, 'x4.txt'))).toBe(false)
    expect(readdirSync(join(r, '.git')).includes('lingshell-rebase')).toBe(false)
    await expect(op(r, { op: 'interactiveRebase', from: xs[0], root: false, steps: [{ hash: xs[0], action: 'squash' }] })).rejects.toThrow('第一个')
    // 冲突：两个提交改同一行再调换顺序 → 停在变基中 → 中止
    put('y.txt', 'y1\n', 'y1'); put('y.txt', 'y2\n', 'y2')
    const ys = git(r, 'log', '--reverse', '--format=%H', '-2').trim().split('\n')
    await expect(op(r, { op: 'interactiveRebase', from: ys[0], root: false, steps: [{ hash: ys[1], action: 'pick' }, { hash: ys[0], action: 'pick' }] })).rejects.toThrow()
    expect(await call('git:progress', r)).toBe('rebase')
    await op(r, { op: 'abort', what: 'rebase' })
    expect(git(r, 'log', '--format=%s', '-1').trim()).toBe('y2')
    // 从根提交开始的范围
    expect((await call<RebasePlan>('git:rebasePlan', r, git(r, 'rev-list', '--max-parents=0', 'HEAD').trim())).root).toBe(true)

    // 按行暂存：一块里两行新增 + 一行删除，只暂存其中一行新增；再取消暂存；再丢弃一行
    writeFileSync(join(r, 'l.txt'), 'k1\nold\nk2\n'); git(r, 'add', 'l.txt'); git(r, 'commit', '-qm', 'l')
    writeFileSync(join(r, 'l.txt'), 'k1\nnewA\nnewB\nk2\n')
    const hk = splitHunks(await call<string>('git:diff', r, 'l.txt', 'work'))
    const iA = hk.hunks[0].lines.indexOf('+newA')
    await op(r, { op: 'applyPatch', path: 'l.txt', cached: true, reverse: false }, linePatch(hk.fileHeader, hk.hunks[0], new Set([iA]), 'stage'))
    expect(git(r, 'show', ':l.txt')).toBe('k1\nold\nnewA\nk2\n')   // 只多了 newA，old 还在
    const sk = splitHunks(await call<string>('git:diff', r, 'l.txt', 'staged'))
    await op(r, { op: 'applyPatch', path: 'l.txt', cached: true, reverse: true }, linePatch(sk.fileHeader, sk.hunks[0], new Set([sk.hunks[0].lines.indexOf('+newA')]), 'unstage'))
    expect(git(r, 'diff', '--cached')).toBe('')
    const wk = splitHunks(await call<string>('git:diff', r, 'l.txt', 'work'))
    await op(r, { op: 'applyPatch', path: 'l.txt', cached: false, reverse: true }, linePatch(wk.fileHeader, wk.hunks[0], new Set([wk.hunks[0].lines.indexOf('+newB')]), 'discard'))
    expect(readFileSync(join(r, 'l.txt'), 'utf8')).toBe('k1\nnewA\nk2\n')   // newB 丢掉，newA 保留
  }, 120_000)

  it('拣选冲突解决成和当前一样（空提交）：继续给出提示，跳过能结束', async () => {
    const r = join(dir, `skip${label.length}`)
    mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); cfg(r)
    writeFileSync(join(r, 'a.txt'), 'base\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'base')
    git(r, 'checkout', '-q', '-b', 'other'); writeFileSync(join(r, 'a.txt'), 'other\n'); git(r, 'commit', '-qam', 'other')
    git(r, 'checkout', '-q', 'main'); writeFileSync(join(r, 'a.txt'), 'main\n'); git(r, 'commit', '-qam', 'main')
    const h = git(r, 'rev-parse', 'other').trim()
    await expect(op(r, { op: 'cherryPick', hash: h })).rejects.toThrow()
    expect(await call('git:progress', r)).toBe('cherry-pick')
    writeFileSync(join(r, 'a.txt'), 'main\n'); git(r, 'add', 'a.txt')   // 解决成和当前一样
    await expect(op(r, { op: 'continue', what: 'cherry-pick' })).rejects.toThrow('点横幅里的「跳过」')
    await op(r, { op: 'skip', what: 'cherry-pick' })
    expect(await call('git:progress', r)).toBeUndefined()
    expect(git(r, 'log', '-1', '--format=%s').trim()).toBe('main')
  }, 60_000)
})
