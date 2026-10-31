// 逐个文件的直传（不打包）：上传 = 本地 → 远程，下载 = 远程 → 本地（资源管理器多项下载）。
// 先写「名称.lingshell-part」半截文件，传完再改名成正式文件并设回原修改时间；暂停 / 出错时半截文件留着，「继续」从它的大小接着传。
// 传输计划只算一次（重试沿用同一份），所以「保留两者」改出来的名字、下载的落点在续传时不会变。
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, opendir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { TREE_CAP, conflictName, joinPath, type ConflictPolicy } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { walkTree, downloadPlan, type TreeOps, type DownloadItem } from './fileOps.js'
import type { TaskCtx, TransferPatch } from './transferQueue.js'

export const PART = '.lingshell-part'

// 同一目标只能有一个任务在写半截文件：两个并发任务同名会从对方的半截文件「续传」，
// 拼出两台主机 / 两个来源混合的文件还报成功。进程内按半截文件路径占位。
const busyParts = new Set<string>()
const claimPart = (p: string) => {
  if (busyParts.has(p)) throw new Error(tr('同一目标已有传输在进行：{path}', { path: p }))
  busyParts.add(p)
}
const releasePart = (p: string) => { busyParts.delete(p) }

/** 限速：每秒最多 limit() 字节（0 = 不限；每块都重新读，改设置即时生效）。按累计量和已用时间算该等多久 */
export function throttle(limit: () => number, signal?: AbortSignal): Transform {
  let start = 0, sent = 0, lastLimit = 0
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      const l = limit()
      if (!l) { start = 0; cb(null, chunk); return }
      if (!start || l !== lastLimit) { start = Date.now(); sent = 0; lastLimit = l }
      sent += chunk.length
      const wait = (sent / l) * 1000 - (Date.now() - start)
      if (wait <= 5) { cb(null, chunk); return }
      const onAbort = () => { clearTimeout(t); cb(new Error(tr('已取消'))) }
      const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); cb(null, chunk) }, wait)
      signal?.addEventListener('abort', onAbort, { once: true })
    },
  })
}

// 进度统计
function counter(onBytes: (n: number) => void): Transform {
  return new Transform({ transform(chunk: Buffer, _e, cb) { onBytes(chunk.length); cb(null, chunk) } })
}

// ── 上传 ──
export interface UpItem { local: string; remote: string; isDir: boolean; size: number; mtime: number; mode?: number }
export interface UploadPlan { items: UpItem[]; skipped: number }

/** 本地若干项 → 远程目录 dir 下的对照表（目录在其内容之前）。顶层同名按 policy：跳过 / 覆盖（文件夹合并）/ 保留两者（改名） */
export async function planUpload(remote: TreeOps, localPaths: string[], dir: string, policy: ConflictPolicy, cap = TREE_CAP): Promise<UploadPlan> {
  const d = await remote.lstat(dir)
  if (!d?.isDir) throw new Error(tr('目标不是文件夹：{path}', { path: dir }))
  const taken = new Set((await remote.readdir(dir)).map((e) => e.name))
  const items: UpItem[] = []
  let skipped = 0
  for (const lp of localPaths) {
    const s = await lstat(lp)
    let name = basename(lp)
    if (taken.has(name)) {
      if (policy === 'skip') { skipped++; continue }
      if (policy === 'rename') name = conflictName(name, (n) => taken.has(n))
      else {
        const t = await remote.lstat(joinPath(dir, name))
        if (t && t.isDir !== s.isDirectory()) throw new Error(t.isDir ? tr('「{name}」在服务器上是文件夹，不能用文件覆盖', { name }) : tr('「{name}」在服务器上是文件，不能用文件夹覆盖', { name }))
      }
    }
    taken.add(name)
    const walk = async (l: string, r: string): Promise<void> => {
      if (items.length >= cap) throw new Error(tr('超过 {n} 项，已中止上传：{path}（请先打包再传）', { n: cap, path: lp }))
      const st = await lstat(l)
      if (st.isSymbolicLink()) { skipped++; return }   // 不跟随符号链接；但要如实告诉用户跳过了
      if (st.isDirectory()) {
        items.push({ local: l, remote: r, isDir: true, size: 0, mtime: Math.floor(st.mtimeMs / 1000) })
        const dd = await opendir(l)
        for await (const e of dd) await walk(join(l, e.name), joinPath(r, e.name))
      } else items.push({ local: l, remote: r, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), mode: st.mode & 0o7777 })
    }
    await walk(lp, joinPath(dir, name))
  }
  return { items, skipped }
}

/** 已存在的远程同名项（上传前问用户怎么办） */
export async function uploadConflicts(remote: TreeOps, localPaths: string[], dir: string): Promise<string[]> {
  const taken = new Set((await remote.readdir(dir)).map((e) => e.name))
  return localPaths.map((p) => basename(p)).filter((n) => taken.has(n))
}

type Run = { ctx: TaskCtx; limit: () => number }
/** 按计划逐个传；已经传完的（同大小同修改时间）跳过；有半截文件就接着传 */
export async function runUpload({ ctx, limit }: Run, remote: TreeOps, plan: UploadPlan): Promise<void> {
  const files = plan.items.filter((i) => !i.isDir)
  const total = files.reduce((s, f) => s + f.size, 0)
  let got = 0, fileDone = 0
  const report = (p: TransferPatch = {}) => {
    const pct = total ? (got / total) * 100 : files.length ? (fileDone / files.length) * 100 : 100
    ctx.progress({ stage: 'transfer', stagePercent: pct, overallPercent: Math.round(pct), bytesDone: got, bytesTotal: total, fileDone, fileTotal: files.length, cancellable: true, skipped: plan.skipped || undefined, ...p })
  }
  report()
  for (const it of plan.items) {
    if (ctx.signal.aborted) throw new Error(tr('已取消'))
    if (it.isDir) { const s = await remote.lstat(it.remote); if (!s) await remote.mkdir(it.remote); else if (!s.isDir) throw new Error(tr('服务器上已有同名文件：{path}', { path: it.remote })); continue }
    const done = await remote.lstat(it.remote)
    if (done && !done.isDir && done.size === it.size && done.mtime === it.mtime) { got += it.size; fileDone++; report(); continue }
    const part = it.remote + PART
    claimPart(part)
    try {
      // 暂停 / 失败后源文件可能被改过：半截文件的前缀就不是这份文件的了，从它续传会拼出坏文件
      const cur = await lstat(it.local).catch(() => undefined)
      if (!cur || !cur.isFile() || cur.size !== it.size || Math.floor(cur.mtimeMs / 1000) !== it.mtime) {
        await remote.unlink(part).catch(() => {})
        throw new Error(tr('源文件已变化，请重新上传：{path}', { path: it.local }))
      }
      const p = await remote.lstat(part)
      const start = p && !p.isDir && p.size <= it.size ? p.size : 0
      if (p && !start) await remote.unlink(part).catch(() => {})
      got += start
      try {
        await pipeline(createReadStream(it.local, start ? { start } : undefined), throttle(limit, ctx.signal), counter((n) => { got += n; report() }), remote.createWriteStream(part, start, it.mode), { signal: ctx.signal })
      } catch (e) { throw ctx.signal.aborted ? new Error(tr('已取消')) : e }
      await remote.replace(part, it.remote)
      if (it.mode) await remote.chmod(it.remote, it.mode).catch(() => {})   // 保留可执行位（续传的 part 也补上）
      await remote.setMtime(it.remote, it.mtime).catch(() => {})   // 有的服务器不让改时间：不算失败
      fileDone++
      report()
    } finally { releasePart(part) }
  }
}

/** 放弃：删掉计划里每个文件的半截文件 */
export async function cleanupUpload(remote: TreeOps, plan: UploadPlan): Promise<void> {
  for (const it of plan.items) if (!it.isDir) await remote.unlink(it.remote + PART).catch(() => {})
}

// ── 下载 ──
export interface DownloadPlan { items: (DownloadItem & { mtime?: number })[]; skipped: number }
/** 远程若干项 → 本地目录的计划（沿用 downloadPlan：顶层同名自动改名、不覆盖本地文件）。再带上修改时间 */
export async function planDownload(remote: TreeOps, roots: string[], localDir: string): Promise<DownloadPlan> {
  const trees = []
  for (const r of roots) {
    const w = await walkTree(remote, r)
    if (w.over) throw new Error(tr('超过 {n} 项，已中止下载：{path}', { n: TREE_CAP, path: r }))
    trees.push({ path: r, entries: w.entries })
  }
  const all = trees.flatMap((t) => t.entries)
  const mt = new Map(all.map((e) => [e.path, e.mtime] as const))
  // 本地已有的半截文件不算占用名字（续传时它们是自己的）
  const taken = (await readdir(localDir)).filter((n) => !n.endsWith(PART))
  return {
    items: downloadPlan(trees, localDir, taken, process.platform === 'win32').map((i) => ({ ...i, mtime: mt.get(i.remote) })),
    skipped: all.filter((e) => e.isLink).length,
  }
}

export async function runDownload({ ctx, limit }: Run, remote: TreeOps, plan: DownloadPlan): Promise<void> {
  const files = plan.items.filter((p) => !p.isDir)
  const total = files.reduce((s, f) => s + f.size, 0)
  let got = 0, fileDone = 0
  const report = () => {
    const pct = total ? (got / total) * 100 : files.length ? (fileDone / files.length) * 100 : 100
    ctx.progress({ stage: 'transfer', stagePercent: pct, overallPercent: Math.round(pct), bytesDone: got, bytesTotal: total, fileDone, fileTotal: files.length, cancellable: true, skipped: plan.skipped || undefined })
  }
  report()
  for (const it of plan.items) {
    if (ctx.signal.aborted) throw new Error(tr('已取消'))
    if (it.isDir) { await mkdir(it.local, { recursive: true }); continue }
    await mkdir(dirname(it.local), { recursive: true })
    const done = await stat(it.local).catch(() => undefined)
    if (done) {
      // 续传时：上次已经传完的跳过；不是自己传的同名文件（计划之后才出现的）不覆盖
      if (done.size === it.size && (!it.mtime || Math.floor(done.mtimeMs / 1000) === it.mtime)) { got += it.size; fileDone++; report(); continue }
      throw new Error(tr('本地已有同名文件，未覆盖：{path}', { path: it.local }))
    }
    const part = it.local + PART
    claimPart(part)
    try {
      // 远程文件在暂停 / 失败后被改过：本地半截文件的前缀作废，续传会拼出坏文件。
      // 计划里大小 / 时间都缺（个别 fs 的 readdir 不带属性）时无法判断，按原样继续
      const cur = await remote.lstat(it.remote)
      const known = it.size > 0 || it.mtime !== undefined
      if (!cur || cur.isDir || (known && (cur.size !== it.size || (it.mtime !== undefined && cur.mtime !== it.mtime)))) {
        await unlink(part).catch(() => {})
        throw new Error(tr('远程文件已变化，请重新下载：{path}', { path: it.remote }))
      }
      const p = await stat(part).catch(() => undefined)
      const start = p && p.size <= it.size ? p.size : 0
      got += start
      try {
        await pipeline(remote.createReadStream(it.remote, start), throttle(limit, ctx.signal), counter((n) => { got += n; report() }), createWriteStream(part, start ? { flags: 'r+', start } : { ...(it.mode ? { mode: it.mode } : {}) }), { signal: ctx.signal })
      } catch (e) { throw ctx.signal.aborted ? new Error(tr('已取消')) : e }
      await rename(part, it.local)
      if (it.mode) await chmod(it.local, it.mode).catch(() => {})   // 保留可执行位
      if (it.mtime) await utimes(it.local, it.mtime, it.mtime).catch(() => {})
      fileDone++
      report()
    } finally { releasePart(part) }
  }
}

export async function cleanupDownload(plan: DownloadPlan | DownloadItem[]): Promise<void> {
  for (const it of (Array.isArray(plan) ? plan : plan.items)) if (!it.isDir) await unlink(it.local + PART).catch(() => {})
}
