import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRepoDir, scanGitRepos, scanRemoteRepos, UP_MAX } from './scanRepos.js'

describe('本地扫描 scanGitRepos', () => {
  const withTree = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'lingshell-scan-'))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const mkRepo = (dir: string) => { mkdirSync(join(dir, '.git'), { recursive: true }) }

  it('认出当前目录、子目录和孙目录里的仓库，跳过 node_modules', () => withTree((root) => {
    // root 自己不是仓库，下面有三个仓库 + 一个假的库包目录（里面也有 .git，应当被跳过）
    mkRepo(join(root, 'a'))
    mkRepo(join(root, 'b', 'inner'))
    mkRepo(join(root, 'node_modules', 'fake-pkg'))
    const { repos } = scanGitRepos(root)
    const rels = repos.map((r) => r.rel).sort()
    expect(rels).toEqual(['a', 'b/inner'])
    expect(repos.every((r) => r.up === 0)).toBe(true)
  }))

  it('当前目录本身是仓库时也要列出来', () => withTree((root) => {
    mkRepo(root)
    const { repos } = scanGitRepos(root)
    expect(repos.some((r) => r.rel === '' && r.up === 0)).toBe(true)
  }))

  it(`向上最多 ${UP_MAX} 级：父目录是仓库时报 up=1，记到 up 就停`, () => withTree((root) => {
    const deep = join(root, 'repo', 'src', 'deep')
    mkdirSync(deep, { recursive: true })
    mkRepo(join(root, 'repo'))          // 第 2 级（deep → src → repo）
    mkRepo(root)                        // 第 3 级：超出 UP_MAX，不该出现
    const { repos } = scanGitRepos(deep)
    const ups = repos.filter((r) => r.up > 0).map((r) => r.up).sort()
    expect(ups).toEqual([2])
  }))

  it('目录不足 2 级也不会报错（到根就停）', () => withTree((root) => {
    expect(() => scanGitRepos(root)).not.toThrow()
  }))

  it('isRepoDir：有 .git 才是仓库', () => withTree((root) => {
    expect(isRepoDir(root)).toBe(false)
    mkRepo(root)
    expect(isRepoDir(root)).toBe(true)
  }))
})

describe('远程扫描 scanRemoteRepos（用假 run 模拟远端输出）', () => {
  it('解析向下找到的 .git，并把上级命中标成 up=1/2', async () => {
    const out = [
      '/home/u/proj/.git',            // 当前目录就是仓库
      '/home/u/proj/sub/.git',        // 子目录仓库
      '1:/home/u',                    // 向上第 1 级
      '2:/home',                      // 向上第 2 级
    ].join('\n')
    const r = await scanRemoteRepos('/home/u/proj', async () => ({ code: 0, output: out }))
    expect(r.repos.map((x) => `${x.up}:${x.path}`)).toEqual([
      '0:/home/u/proj', '0:/home/u/proj/sub', '1:/home/u', '2:/home',
    ])
    expect(r.repos.find((x) => x.up === 0 && x.rel === '')?.name).toBe('proj')
    expect(r.repos.find((x) => x.rel === 'sub')?.path).toBe('/home/u/proj/sub')
  })

  it('远端报错 / 空输出 → 空结果，不抛', async () => {
    expect((await scanRemoteRepos('/x', async () => ({ code: 127, output: '' }))).repos).toEqual([])
    expect((await scanRemoteRepos('/x', async () => { throw new Error('boom') })).repos).toEqual([])
  })

  it('超过上限标 truncated', async () => {
    const out = Array.from({ length: 5 }, (_, i) => `/r/p${i}/.git`).join('\n')
    const r = await scanRemoteRepos('/r', async () => ({ code: 0, output: out }), { max: 2 })
    expect(r.repos).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })
})
