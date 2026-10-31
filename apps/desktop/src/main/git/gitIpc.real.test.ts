import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { cleanGitDiff, type GitStatusResult, type TerminalInfo } from '@lingshell/shared'
import { registerGit, type GitRun } from './gitIpc.js'
import { runSh } from '../terminal/index.js'
import { findBash } from '../core/index.js'

// 真实 git：临时目录里 git init 造出「未跟踪 / 未暂存 / 已暂存 / 冲突」几种状态；两条通道都跑一遍——
// 本机 sh 子进程（runSh），以及本机回环假 sshd 的 exec channel（exec 交给本机 Git Bash，stdin 照转，提交说明靠它传）。不连任何真实主机、不碰真实仓库
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const dir = mkdtempSync(join(tmpdir(), 'lingshell-git-'))
const hooks = join(dir, 'nohooks')
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let repoSeq = 0
function initRepo(name: string): string {
  // 每次调用用独立目录：--retry 重跑时复用同名目录会让 mkdir / git commit 失败
  const r = join(dir, `${name}-${++repoSeq}`)
  mkdirSync(r, { recursive: true })
  git(r, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['core.fsmonitor', 'false'], ['user.name', 'T'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', hooks], ['core.autocrlf', 'false']]) git(r, 'config', k, v)
  writeFileSync(join(r, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(r, 'c.txt'), 'base\n')
  git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'init')
  return r
}

let srv: { port: number; close(): void } | undefined
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
  srv = await new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  conn = await connectSsh({ host: '127.0.0.1', port: srv!.port, username: 'u', password: 'p' })
}, 30_000)
afterAll(() => { conn?.close(); srv?.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* Windows 上子进程刚退出时目录可能还被占用 */ } })

const runners: [string, () => GitRun][] = [
  ['本机 sh', () => (cmd, o) => runSh(cmd, o)],
  ['SSH exec channel', () => (cmd, o) => execFull(conn!.client, cmd, o)],
]

describe.each(runners)('Git 助手 · %s', (label, mk) => {
  function setup() {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audits: { command: string; decision: string; exitCode?: number }[] = []
    const prompts: string[] = []
    registerGit({
      handle: (ch, fn) => { hs.set(ch, fn) },
      terminal: (id) => (id === 't1' ? ({ id, type: label === '本机 sh' ? 'local' : 'ssh', os: 'linux', title: 'dev' } as TerminalInfo) : undefined),
      run: () => mk(),
      complete: async (sys, user) => { prompts.push(`${sys}\n${user}`); return '```\nfeat: 加入 Git 助手\n\n- 支持暂存\n```' },
      redact: (t) => t.replace(/SECRET-\w+/g, '***'),
      audit: (_t, e) => { audits.push(e) },
    })
    const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, 't1', ...a)) as Promise<T>
    return { call, audits, prompts }
  }

  it('改动列表 → diff → 暂存 / 取消暂存 → AI 写提交说明 → 提交，git log 核对', async () => {
    const r = initRepo(`flow-${label.length}`)
    writeFileSync(join(r, 'a.txt'), 'one\nchanged\n')
    mkdirSync(join(r, 'sub dir'))
    writeFileSync(join(r, 'sub dir', '新 文件.txt'), 'hello SECRET-abc\n')
    const { call, audits, prompts } = setup()
    const s1 = await call<GitStatusResult>('git:status', join(r, 'sub dir'))   // 子目录也能定位到仓库根
    if (!s1.ok) throw new Error(s1.message)
    expect(s1.status.branch).toBe('main')
    // Windows 上 tmpdir() 可能是 8.3 短名（ADMINI~1），git 报的是长名，比较前统一走 realpath
    const norm = (p: string) => realpathSync.native(p).replace(/\\/g, '/').toLowerCase()
    expect(norm(s1.status.root)).toBe(norm(r))
    expect(s1.status.files.map((f) => [f.path, f.x, f.y, f.untracked])).toEqual([['a.txt', '.', 'M', false], ['sub dir/新 文件.txt', '?', '?', true]])
    const root = s1.status.root

    const d1 = cleanGitDiff(await call<string>('git:diff', root, 'a.txt', 'work'))
    expect(d1).toContain('-two'); expect(d1).toContain('+changed')
    const d2 = cleanGitDiff(await call<string>('git:diff', root, 'sub dir/新 文件.txt', 'untracked'))
    expect(d2).toContain('+hello SECRET-abc')

    await call('git:stage', root, ['a.txt', 'sub dir/新 文件.txt'], true)
    let s = await call<GitStatusResult>('git:status', root)
    expect(s.ok && s.status.files.map((f) => [f.path, f.x, f.y])).toEqual([['a.txt', 'M', '.'], ['sub dir/新 文件.txt', 'A', '.']])
    await call('git:stage', root, ['sub dir/新 文件.txt'], false)
    s = await call<GitStatusResult>('git:status', root)
    expect(s.ok && s.status.files.map((f) => [f.path, f.x, f.untracked])).toEqual([['a.txt', 'M', false], ['sub dir/新 文件.txt', '?', true]])
    expect(cleanGitDiff(await call<string>('git:diff', root, 'a.txt', 'staged'))).toContain('+changed')

    await call('git:stage', root, ['sub dir/新 文件.txt'], true)
    const msg = await call<string>('git:suggest', root, 'main')
    expect(msg).toBe('feat: 加入 Git 助手\n\n- 支持暂存')
    expect(prompts[0]).toContain('+changed')
    expect(prompts[0]).toContain('hello ***')        // 发给模型前脱敏
    expect(prompts[0]).not.toContain('SECRET-abc')

    const full = `feat: it's "quoted" $HOME \`x\`\n\n- 第二行`
    await call('git:commit', root, full)
    expect(git(r, 'log', '-1', '--format=%B').trim()).toBe(full)
    s = await call<GitStatusResult>('git:status', root)
    expect(s.ok && s.status.files).toEqual([])
    expect(audits.map((a) => [a.decision, a.exitCode])).toEqual([['git_stage', 0], ['git_unstage', 0], ['git_stage', 0], ['git_commit', 0]])
    expect(audits[3].command).toBe(`git commit -m 'feat: it'\\''s "quoted" $HOME \`x\`'`)
    // 没有已暂存的改动时：AI 写说明直接报错，不调模型
    await expect(call('git:suggest', root, 'main')).rejects.toThrow('还没有已暂存的改动')
    // 提交失败（没东西可提交）也记执行记录，带非 0 退出码
    await expect(call('git:commit', root, 'x')).rejects.toThrow()
    expect(audits.at(-1)).toMatchObject({ decision: 'git_commit', exitCode: 1 })
  }, 60_000)

  it('合并冲突：列出冲突文件、合并中标记、冲突 diff 有两边标记', async () => {
    const r = initRepo(`conflict-${label.length}`)
    git(r, 'checkout', '-q', '-b', 'dev'); writeFileSync(join(r, 'c.txt'), 'theirs\n'); git(r, 'commit', '-qam', 'dev')
    git(r, 'checkout', '-q', 'main'); writeFileSync(join(r, 'c.txt'), 'ours\n'); git(r, 'commit', '-qam', 'main')
    try { git(r, 'merge', 'dev') } catch { /* 冲突退出码非 0 */ }
    const { call } = setup()
    const s = await call<GitStatusResult>('git:status', r)
    if (!s.ok) throw new Error(s.message)
    expect(s.status.merging).toBe(true)
    expect(s.status.files.filter((f) => f.conflict).map((f) => f.path)).toEqual(['c.txt'])
    const d = cleanGitDiff(await call<string>('git:diff', s.status.root, 'c.txt', 'work'))
    expect(d).toContain('+<<<<<<< HEAD'); expect(d).toContain('+>>>>>>> dev')
  }, 60_000)

  it('不在仓库 / 目录不存在 / 非法参数', async () => {
    const plain = join(dir, `plain-${label.length}`)
    mkdirSync(plain, { recursive: true })
    const { call } = setup()
    expect(await call<GitStatusResult>('git:status', plain)).toMatchObject({ ok: false, problem: 'norepo' })
    expect(await call<GitStatusResult>('git:status', join(dir, 'nope'))).toMatchObject({ ok: false, problem: 'nodir' })
    await expect(call('git:stage', plain, ['a\nb'], true)).rejects.toThrow('非法')
    await expect(call('git:diff', plain, 'a', 'bad')).rejects.toThrow('非法')
  }, 30_000)
})
