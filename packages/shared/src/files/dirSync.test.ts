import { describe, it, expect } from 'vitest'
import {
  parseExcludes, excludeMatcher, compareRel, compareTrees, hashCandidates, rowAction, buildSyncPlan, defaultSelection, planSummary, planTouchesRemote,
  sha256Command, parseSha256Output, SYNC_DEFAULT_EXCLUDES, type SyncEntry, type SyncRow,
} from './dirSync.js'
import { NO_TOOL } from './explorer.js'

const f = (rel: string, size = 1, mtime = 1000): SyncEntry => ({ rel, isDir: false, size, mtime })
const d = (rel: string): SyncEntry => ({ rel, isDir: true, size: 0, mtime: 0 })
const byRel = (rows: SyncRow[]) => Object.fromEntries(rows.map((r) => [r.rel, r]))

describe('排除规则', () => {
  it('解析：逗号 / 换行 / 中文逗号分隔，忽略空和 # 注释', () => {
    expect(parseExcludes(SYNC_DEFAULT_EXCLUDES)).toEqual(['.git', 'node_modules'])
    expect(parseExcludes('a,\n b ，c\n# 注释\n\n')).toEqual(['a', 'b', 'c'])
  })
  it('不含 / 的规则匹配任意一级名字；* ? 不跨 /', () => {
    const m = excludeMatcher(['.git', '*.log', 'cache?'])
    expect(m('.git', true)).toBe(true)
    expect(m('sub/.git', true)).toBe(true)
    expect(m('a.log', false)).toBe(true)
    expect(m('x/y/b.log', false)).toBe(true)
    expect(m('a.log.bak', false)).toBe(false)
    expect(m('cache1', true)).toBe(true)
    expect(m('cache12', true)).toBe(false)
    expect(m('.gitignore', false)).toBe(false)
  })
  it('含 / 的规则从根起匹配；前导 / 等价；** 跨目录；结尾 / 只配目录', () => {
    const m = excludeMatcher(['/build', 'dist/assets', '**/tmp', 'logs/'])
    expect(m('build', true)).toBe(true)
    expect(m('src/build', true)).toBe(false)
    expect(m('dist/assets', true)).toBe(true)
    expect(m('x/dist/assets', true)).toBe(false)
    expect(m('tmp', true)).toBe(true)
    expect(m('a/b/tmp', true)).toBe(true)
    expect(m('logs', true)).toBe(true)
    expect(m('logs', false)).toBe(false)
    expect(m('a/logs', true)).toBe(true)
  })
  it('正则特殊字符按字面；空规则无效', () => {
    const m = excludeMatcher(['a+b(1).txt', '/'])
    expect(m('a+b(1).txt', false)).toBe(true)
    expect(m('aab(1).txt', false)).toBe(false)
    expect(m('x', false)).toBe(false)
  })
})

describe('对齐与判定', () => {
  it('compareRel：父目录在内容之前，按段比较', () => {
    expect(['a/b', 'a-b', 'a', 'a/a'].sort(compareRel)).toEqual(['a', 'a/a', 'a/b', 'a-b'])
  })
  it('仅本地 / 仅远程 / 相同 / 不同（大小、时间超过 2 秒），较新方', () => {
    const rows = compareTrees(
      [d('dir'), f('dir/a', 5), f('same', 3, 1000), f('time', 3, 1010), f('size', 3, 1000), f('jitter', 3, 1002), f('lo')],
      [d('dir'), f('dir/a', 5), f('same', 3, 1000), f('time', 3, 1000), f('size', 4, 2000), f('jitter', 3, 1000), d('ro'), f('ro/x')],
    )
    const r = byRel(rows)
    expect(rows.map((x) => x.rel)).toEqual(['dir', 'dir/a', 'jitter', 'lo', 'ro', 'ro/x', 'same', 'size', 'time'])
    expect(r.dir).toMatchObject({ status: 'same', isDir: true })
    expect(r.same.status).toBe('same')
    expect(r.jitter.status).toBe('same')
    expect(r.time).toMatchObject({ status: 'diff', newer: 'local' })
    expect(r.size).toMatchObject({ status: 'diff', newer: 'remote' })
    expect(r.lo).toMatchObject({ status: 'localOnly', local: { size: 1 } })
    expect(r.lo.remote).toBeUndefined()
    expect(r.ro).toMatchObject({ status: 'remoteOnly', isDir: true })
  })
  it('按内容：大小相同按哈希判定（时间不同但内容相同 → 相同；时间相同内容不同 → 不同）', () => {
    const local = [f('a', 3, 1000), f('b', 3, 1000), f('c', 3, 1000), f('d', 9, 1000)]
    const remote = [f('a', 3, 5000), f('b', 3, 1000), f('c', 3, 1000), f('d', 8, 1000)]
    expect(hashCandidates(local, remote)).toEqual(['a', 'b', 'c'])
    const r = byRel(compareTrees(local, remote, { local: { a: 'h1', b: 'h2', c: 'x' }, remote: { a: 'h1', b: 'h3' } }))
    expect(r.a).toMatchObject({ status: 'same', byHash: true })
    expect(r.b).toMatchObject({ status: 'diff', byHash: true })
    expect(r.b.newer).toBeUndefined()
    expect(r.c.status).toBe('same')     // 远程没算出哈希：退回按时间
    expect(r.c.byHash).toBeUndefined()
    expect(r.d.status).toBe('diff')
  })
  it('符号链接、文件对目录 → skip', () => {
    const r = byRel(compareTrees(
      [{ ...f('ln'), isLink: true }, f('x'), d('y'), f('y/in')],
      [f('ln'), d('x'), f('x/in'), f('y')],
    ))
    expect(r.ln.skip).toMatch(/符号链接/)
    expect(r.x).toMatchObject({ status: 'diff', skip: expect.stringMatching(/文件.*目录/) })
    expect(r.y.skip).toBeTruthy()
    expect(hashCandidates([{ ...f('ln'), isLink: true }], [f('ln')])).toEqual([])
  })
})

describe('同步计划', () => {
  const rows = compareTrees(
    [d('new'), d('new/sub'), f('new/sub/a', 10), f('chg', 4, 2000), f('old', 4, 1000), f('both', 2, 1000), f('lonly', 1)],
    [f('chg', 3, 1000), f('old', 4, 3000), f('both', 3, 1000), d('gone'), f('gone/x', 7), f('gone/y', 8), f('ronly', 5)],
  )
  const all = defaultSelection(rows)

  it('默认勾选：所有有差异的', () => {
    expect(all).toEqual(['both', 'chg', 'gone', 'gone/x', 'gone/y', 'lonly', 'new', 'new/sub', 'new/sub/a', 'old', 'ronly'])
  })
  it('上传：仅本地与不同的都上传，补建目录；不镜像时仅远程的不动', () => {
    const p = buildSyncPlan(rows, all, 'upload', false)
    expect(p.mkdirRemote).toEqual(['new', 'new/sub'])
    expect(p.upload.map((x) => x.rel)).toEqual(['both', 'chg', 'lonly', 'new/sub/a', 'old'])
    expect(p.upload.find((x) => x.rel === 'chg')).toEqual({ rel: 'chg', size: 4, mtime: 2000 })
    expect(p.deleteRemote).toEqual([])
    expect(p.download).toEqual([])
    expect(planTouchesRemote(p)).toBe(true)
  })
  it('上传 + 镜像删除：删远程多余的，先内容后目录', () => {
    const p = buildSyncPlan(rows, all, 'upload', true)
    expect(p.deleteRemote).toEqual([{ rel: 'gone/x', isDir: false }, { rel: 'gone/y', isDir: false }, { rel: 'gone', isDir: true }, { rel: 'ronly', isDir: false }])
    expect(p.deleteLocal).toEqual([])
  })
  it('镜像删除的目录下有没勾的项：保留目录，只删勾选的', () => {
    const p = buildSyncPlan(rows, all.filter((r) => r !== 'gone/y'), 'upload', true)
    expect(p.deleteRemote.map((x) => x.rel)).toEqual(['gone/x', 'ronly'])
    expect(p.skipped).toEqual([{ rel: 'gone', reason: expect.stringMatching(/未勾选/) }])
  })
  it('下载 + 镜像删除：对称', () => {
    const p = buildSyncPlan(rows, all, 'download', true)
    expect(p.mkdirLocal).toEqual(['gone'])
    expect(p.download.map((x) => x.rel)).toEqual(['both', 'chg', 'gone/x', 'gone/y', 'old', 'ronly'])
    expect(p.download.find((x) => x.rel === 'old')!.mtime).toBe(3000)
    expect(p.deleteLocal.map((x) => x.rel)).toEqual(['new/sub/a', 'new/sub', 'lonly', 'new'])
    expect(p.upload).toEqual([])
    expect(planTouchesRemote(p)).toBe(false)
  })
  it('双向：较新者覆盖，时间相同内容不同的跳过；镜像删除不生效', () => {
    const p = buildSyncPlan(rows, all, 'both', true)
    expect(p.upload.map((x) => x.rel)).toEqual(['chg', 'lonly', 'new/sub/a'])
    expect(p.download.map((x) => x.rel)).toEqual(['gone/x', 'gone/y', 'old', 'ronly'])
    expect(p.skipped).toEqual([{ rel: 'both', reason: expect.stringMatching(/无法判断/) }])
    expect(p.deleteLocal.length + p.deleteRemote.length).toBe(0)
    expect(planSummary(p)).toMatchObject({ upload: 3, uploadBytes: 4 + 1 + 10, download: 4, downloadBytes: 7 + 8 + 4 + 5, mkdirRemote: 2, mkdirLocal: 1, skipped: 1, total: 10 })
  })
  it('只勾子文件也会补建上级目录；没勾的不进计划', () => {
    const p = buildSyncPlan(rows, ['new/sub/a'], 'upload', false)
    expect(p.mkdirRemote).toEqual(['new', 'new/sub'])
    expect(p.upload.map((x) => x.rel)).toEqual(['new/sub/a'])
  })
  it('skip 行及其下的项跳过', () => {
    const r2 = compareTrees([f('x'), f('ok', 2)], [d('x'), f('x/in'), f('ok', 1)])
    const p = buildSyncPlan(r2, ['x', 'x/in', 'ok'], 'download', false)
    expect(p.download.map((x) => x.rel)).toEqual(['ok'])
    expect(p.skipped.map((x) => x.rel)).toEqual(['x', 'x/in'])
  })
  it('rowAction：相同的不动', () => {
    expect(rowAction({ rel: 'a', isDir: false, status: 'same' }, 'upload', true)).toEqual({ action: 'none' })
    expect(rowAction({ rel: 'a', isDir: false, status: 'localOnly' }, 'download', false)).toEqual({ action: 'none' })
  })
})

describe('远程 sha256', () => {
  it('命令：路径转义、cd 根、sha256sum / shasum 回退、缺工具标记', () => {
    const c = sha256Command("/srv/it's", ['a b', '-x'])
    expect(c.startsWith('sh -c ')).toBe(true)
    expect(c).toContain('sha256sum')
    expect(c).toContain('shasum -a 256')
    expect(c).toContain(NO_TOOL)
    expect(c).toContain("./-x")
    const script = c.slice(7, -1).replace(/'\\''/g, "'")   // 解开 sh -c '…' 一层引号
    expect(script).toContain(`cd '/srv/it'\\''s' || exit 1`)
    expect(script).toContain(`-- './a b' './-x'`)
  })
  it('解析：文本 / 二进制模式行；转义行与杂讯忽略', () => {
    const h = 'a'.repeat(64), k = 'b'.repeat(64)
    const out = `${h}  ./a b\n${k} *./dir/x.bin\r\n\\${h}  ./we\\\\ird\nsha256sum: ./gone: No such file or directory\n`
    expect(parseSha256Output(out)).toEqual({ 'a b': h, 'dir/x.bin': k })
  })
})
