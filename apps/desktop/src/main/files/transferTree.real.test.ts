import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { localTreeOps } from './fileOps.js'
import { planUpload, runUpload, cleanupUpload, planDownload, runDownload, uploadConflicts, PART } from './transferTree.js'
import { TransferQueue, fileHistory, type TaskCtx } from './transferQueue.js'

const ops = localTreeOps()
const ctxOf = (ac = new AbortController(), onP?: (b: number) => void): TaskCtx => ({ signal: ac.signal, paused: () => false, progress: (p) => { if (p.bytesDone !== undefined) onP?.(p.bytesDone) } })
const mk = (root: string, files: Record<string, string | Buffer>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c) } }

describe('直传上传', () => {
  let src: string, dst: string
  beforeEach(() => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-up-'))
    src = join(d, 'src'); dst = join(d, 'dst'); mkdirSync(src); mkdirSync(dst)
    mk(src, { 'a.txt': 'aaa', 'dir/b.txt': 'bb', 'dir/sub/c.bin': randomBytes(5000) })
    utimesSync(join(src, 'a.txt'), 1_600_000_000, 1_600_000_000)
    mk(dst, { 'a.txt': 'old', 'dir/keep.txt': 'k' })
  })
  it('同名检查与三种策略', async () => {
    expect(await uploadConflicts(ops, [join(src, 'a.txt'), join(src, 'dir')], dst)).toEqual(['a.txt', 'dir'])
    expect((await planUpload(ops, [join(src, 'a.txt'), join(src, 'dir')], dst, 'skip')).skipped).toBe(2)
    const r = await planUpload(ops, [join(src, 'a.txt')], dst, 'rename')
    expect(r.items[0].remote).toBe(join(dst, 'a (1).txt'))
    mk(dst, { 'x/inner': '1' }); mk(src, { x: 'file' })
    await expect(planUpload(ops, [join(src, 'x')], dst, 'overwrite')).rejects.toThrow('不能用文件覆盖')
  })
  it('覆盖 = 合并；保留修改时间；目录结构完整', async () => {
    const plan = await planUpload(ops, [join(src, 'a.txt'), join(src, 'dir')], dst, 'overwrite')
    await runUpload({ ctx: ctxOf(), limit: () => 0 }, ops, plan)
    expect(readFileSync(join(dst, 'a.txt'), 'utf8')).toBe('aaa')
    expect(Math.floor(statSync(join(dst, 'a.txt')).mtimeMs / 1000)).toBe(1_600_000_000)
    expect(readdirSync(join(dst, 'dir')).sort()).toEqual(['b.txt', 'keep.txt', 'sub'])
    expect(readFileSync(join(dst, 'dir/sub/c.bin'))).toEqual(readFileSync(join(src, 'dir/sub/c.bin')))
    expect(readdirSync(join(dst, 'dir/sub')).some((n) => n.endsWith(PART))).toBe(false)
  })
  it('断点续传：已有半截文件从它的大小接着传；已传完的跳过', async () => {
    const big = randomBytes(300_000); mk(src, { 'big.bin': big })
    writeFileSync(join(dst, 'big.bin' + PART), big.subarray(0, 120_000))
    const plan = await planUpload(ops, [join(src, 'big.bin')], dst, 'skip')
    let maxBytes = 0
    await runUpload({ ctx: ctxOf(undefined, (b) => (maxBytes = Math.max(maxBytes, b))), limit: () => 0 }, ops, plan)
    expect(readFileSync(join(dst, 'big.bin'))).toEqual(big)
    expect(existsSync(join(dst, 'big.bin' + PART))).toBe(false)
    expect(maxBytes).toBe(300_000)
    // 再跑一次：同大小同时间，直接跳过（不重传）
    let first = -1
    await runUpload({ ctx: ctxOf(undefined, (b) => { if (first < 0) first = b }), limit: () => 0 }, ops, plan)
    expect(first).toBe(0)
  })
  it('暂停（中止）后半截文件还在，「继续」从断点传完；放弃会删掉半截文件', async () => {
    const big = randomBytes(400_000); mk(src, { 'p.bin': big })
    const plan = await planUpload(ops, [join(src, 'p.bin')], dst, 'skip')
    const ac = new AbortController()
    // 限速 200KB/s，传 0.6 秒左右中止
    setTimeout(() => ac.abort(), 600)
    await expect(runUpload({ ctx: ctxOf(ac), limit: () => 200_000 }, ops, plan)).rejects.toThrow('已取消')
    const partSize = statSync(join(dst, 'p.bin' + PART)).size
    expect(partSize).toBeGreaterThan(0); expect(partSize).toBeLessThan(400_000)
    await runUpload({ ctx: ctxOf(), limit: () => 0 }, ops, plan)
    expect(readFileSync(join(dst, 'p.bin'))).toEqual(big)
    writeFileSync(join(dst, 'q' + PART), 'x')
    const p2 = await planUpload(ops, [join(src, 'a.txt')], dst, 'rename')
    writeFileSync(p2.items[0].remote + PART, 'half')
    await cleanupUpload(ops, p2)
    expect(existsSync(p2.items[0].remote + PART)).toBe(false)
  })
  it('源文件在暂停后改过：不接着传（会拼出坏文件），报错并删掉半截', async () => {
    const big = randomBytes(200_000); mk(src, { 'changed.bin': big })
    const plan = await planUpload(ops, [join(src, 'changed.bin')], dst, 'skip')
    writeFileSync(join(dst, 'changed.bin' + PART), big.subarray(0, 50_000))
    writeFileSync(join(src, 'changed.bin'), randomBytes(100_000))   // 源文件被改小
    await expect(runUpload({ ctx: ctxOf(), limit: () => 0 }, ops, plan)).rejects.toThrow('源文件已变化')
    expect(existsSync(join(dst, 'changed.bin' + PART))).toBe(false)
  })
  it('限速：200KB 限 100KB/s 至少要 1.5 秒', async () => {
    mk(src, { 'slow.bin': randomBytes(200_000) })
    const plan = await planUpload(ops, [join(src, 'slow.bin')], dst, 'skip')
    const t = Date.now()
    await runUpload({ ctx: ctxOf(), limit: () => 100_000 }, ops, plan)
    expect(Date.now() - t).toBeGreaterThan(1500)
  }, 10_000)
})

describe('下载续传', () => {
  it('计划只算一次：续传时落点不变；保留修改时间；半截文件接着传', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-down-'))
    const remote = join(d, 'remote'), local = join(d, 'local')
    mkdirSync(local)
    const big = randomBytes(250_000)
    mk(remote, { 'logs/a.log': big, 'logs/b.log': 'bb' })
    utimesSync(join(remote, 'logs/a.log'), 1_650_000_000, 1_650_000_000)
    mk(local, { logs: 'existing file named logs' })   // 顶层同名 → 落到 logs (1)
    // 当远程用：readdir 像 SFTP 一样带大小和修改时间（本地 readdir 为了快不逐个 stat）
    const rops = { ...ops, readdir: async (p: string) => Promise.all(readdirSync(p).map(async (name) => ({ name, ...(await ops.lstat(join(p, name)))! }))) }
    const plan = await planDownload(rops, [join(remote, 'logs')], local)
    expect(plan.items.find((i) => i.remote.endsWith('a.log'))?.size).toBe(250_000)
    expect(plan.items[0].local).toBe(join(local, 'logs (1)'))
    mkdirSync(join(local, 'logs (1)'))
    writeFileSync(join(local, 'logs (1)', 'a.log' + PART), big.subarray(0, 100_000))
    await runDownload({ ctx: ctxOf(), limit: () => 0 }, rops, plan)
    expect(readFileSync(join(local, 'logs (1)', 'a.log'))).toEqual(big)
    expect(Math.floor(statSync(join(local, 'logs (1)', 'a.log')).mtimeMs / 1000)).toBe(1_650_000_000)
    // 再跑一遍（如「继续」被多点了一次）：都已传完，不报错、不改名
    await runDownload({ ctx: ctxOf(), limit: () => 0 }, rops, plan)
    expect(readdirSync(local).sort()).toEqual(['logs', 'logs (1)'])
  })

  it('远程文件在暂停后改过：不接着传，报错并删掉半截', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-downchg-'))
    const remote = join(d, 'r.txt'), local = join(d, 'local')
    mkdirSync(local)
    writeFileSync(remote, 'aaaaa')
    const plan = await planDownload(ops, [remote], local)
    const target = plan.items[0].local
    writeFileSync(target + PART, 'aa')   // 已传了一半
    writeFileSync(remote, 'bb')          // 远程被改
    await expect(runDownload({ ctx: ctxOf(), limit: () => 0 }, ops, plan)).rejects.toThrow('远程文件已变化')
    expect(existsSync(target + PART)).toBe(false)
  })
})

describe('队列：暂停 / 放弃 / 历史', () => {
  it('暂停 → 已暂停（可继续）；继续从断点；放弃调用清理并移出；历史重启后只读', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-q-'))
    const evs: { state: string; paused?: boolean; restored?: boolean }[] = []
    const hist = fileHistory(join(d, 'h.json'))
    const q = new TransferQueue((e) => evs.push(e), () => 2, Date.now, hist)
    let runs = 0, cleaned = 0
    let id = ''
    const p = q.enqueue({ kind: 'upload', files: ['a'], resumable: true, cleanup: async () => { cleaned++ },
      run: (ctx) => new Promise((res, rej) => { runs++; if (runs > 1) return res(undefined); ctx.signal.addEventListener('abort', () => rej(new Error('已取消'))) }) }, (x) => (id = x))
    p.catch(() => {})
    q.pause(id)
    await new Promise((r) => setTimeout(r, 20))
    expect(q.list()[0]).toMatchObject({ state: 'cancelled', paused: true, error: '已暂停' })
    q.clearFinished()
    expect(q.list()).toHaveLength(1)   // 已暂停的不被「清除已完成」清掉
    q.retry(id)
    await new Promise((r) => setTimeout(r, 20))
    expect(q.list()[0]).toMatchObject({ state: 'done' })
    expect(q.list()[0].paused).toBeFalsy()
    // 历史：新队列读回来是只读的
    const q2 = new TransferQueue(() => {}, () => 2, Date.now, hist)
    expect(q2.list()[0]).toMatchObject({ state: 'done', restored: true })
    q2.retry(q2.list()[0].taskId)
    expect(q2.list()[0].state).toBe('done')
    // 放弃
    let id2 = ''
    q.enqueue({ kind: 'upload', files: ['b'], resumable: true, cleanup: async () => { cleaned++ }, run: () => Promise.reject(new Error('断了')) }, (x) => (id2 = x)).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    await q.discard(id2)
    expect(cleaned).toBe(1)
    expect(q.list().some((e) => e.taskId === id2)).toBe(false)
  })
})
