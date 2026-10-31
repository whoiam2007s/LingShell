// 本地 ↔ 远程目录比较与同步（判定 / 计划规则见 shared/files/dirSync.ts）。
// 比较：两边递归列目录（远程走该终端已有的 SFTP 会话）→ 可选按内容（本地直接算 sha256，远程经独立 exec channel 跑 sha256sum）→ 对齐判定。
// 执行：主进程按保存的比较结果 + 勾选重算计划（渲染层传的只是相对路径的勾选，不在比较结果里的一律忽略），
// 逐个文件走 SFTP 流式传输（不打包、不加密）；先写同目录临时文件再改名，取消 / 失败不留半截、不坏原文件；传完把修改时间设成源文件的。
// 远程有写 / 删就记一条执行记录 dir_sync（一次同步一条，含统计）。
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, mkdir, rename, unlink, utimes, rmdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import {
  SYNC_CAP, SYNC_MAX_DEPTH, SYNC_DECISION, SYNC_DIRECTION_LABEL, HASH_BATCH, excludeMatcher, compareTrees, hashCandidates, buildSyncPlan, planSummary, planTouchesRemote,
  sha256Command, parseSha256Output, missingTool, isProtectedDir,
  type ExcludeMatcher, type SyncEntry, type SyncRow, type SyncDirection, type DirSyncCompareReq, type DirSyncCompareResult, type DirSyncProgress, type DirSyncRunResult,
} from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import type { RunCmd } from './fileOps.js'

export interface ListItem { name: string; isDir: boolean; isLink: boolean; size: number; mtime: number }
export type Lister = (dir: string) => Promise<ListItem[]>

export const localLister: Lister = async (dir) => Promise.all((await readdir(dir)).map(async (name) => {
  const s = await lstat(join(dir, name))
  return { name, isDir: s.isDirectory(), isLink: s.isSymbolicLink(), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) }
}))

type Attrs = { isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtime: number; mode: number }
const cb = <T = void>(f: (done: (e?: Error | null, v?: T) => void) => void) => new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v as T))))

export const sftpLister = (sftp: SFTPWrapper): Lister => async (dir) =>
  (await cb<{ filename: string; attrs: Attrs }[]>((d) => sftp.readdir(dir, d)))
    .map(({ filename, attrs: a }) => ({ name: filename, isDir: a.isDirectory(), isLink: a.isSymbolicLink(), size: a.size, mtime: a.mtime }))

export const remoteJoin = (dir: string, rel: string) => (dir.endsWith('/') ? dir + rel : `${dir}/${rel}`)
const localJoin = (dir: string, rel: string) => join(dir, ...rel.split('/'))

/** 递归遍历（不跟随符号链接，链接本身记一项）。排除的项整棵剪掉；超项数 / 层数直接报错（列表不完整时镜像删除会误删） */
export async function walkSide(list: Lister, root: string, joinFn: (dir: string, rel: string) => string, excluded: ExcludeMatcher,
  opts: { cap?: number; maxDepth?: number; signal?: AbortSignal; onCount?: (n: number) => void } = {}): Promise<{ entries: SyncEntry[]; excluded: number }> {
  const { cap = SYNC_CAP, maxDepth = SYNC_MAX_DEPTH, signal, onCount } = opts
  const entries: SyncEntry[] = []
  let ex = 0
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (signal?.aborted) throw new Error(tr('已取消'))
    const items = await list(rel ? joinFn(root, rel) : root)
    for (const it of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${it.name}` : it.name
      const isDir = it.isDir && !it.isLink
      if (excluded(r, isDir)) { ex++; continue }
      if (entries.length >= cap) throw new Error(tr('超过 {n} 项，请缩小目录范围或添加排除规则', { n: cap }))
      entries.push({ rel: r, isDir, size: isDir ? 0 : it.size, mtime: it.mtime, ...(it.isLink ? { isLink: true } : {}) })
      onCount?.(entries.length)
      if (isDir) {
        if (depth >= maxDepth) throw new Error(tr('目录层级超过 {n} 层（{path}），请缩小目录范围或添加排除规则', { n: maxDepth, path: r }))
        await visit(r, depth + 1)
      }
    }
  }
  await visit('', 0)
  return { entries, excluded: ex }
}

export function localSha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(path).on('error', rej).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex')))
  })
}

/** 远程分批算 sha256；服务器没工具 / 超时只给说明，已算出的照用 */
export async function remoteSha256(run: RunCmd, root: string, rels: string[], signal?: AbortSignal): Promise<{ hashes: Record<string, string>; note?: string }> {
  const hashes: Record<string, string> = {}
  for (let i = 0; i < rels.length; i += HASH_BATCH) {
    if (signal?.aborted) throw new Error(tr('已取消'))
    const r = await run(sha256Command(root, rels.slice(i, i + HASH_BATCH)), 10 * 60_000)
    if (missingTool(r.output)) return { hashes, note: tr('服务器上没有 sha256sum / shasum，已改为按大小和修改时间比较') }
    if (r.stopped) return { hashes, note: tr('远程计算 sha256 超时，未算出的按大小和修改时间比较') }
    Object.assign(hashes, parseSha256Output(r.output))
  }
  const miss = rels.filter((r) => !hashes[r]).length
  return { hashes, note: miss ? tr('{n} 个文件远程没算出 sha256（无读取权限或文件名含特殊字符），按大小和修改时间比较', { n: miss }) : undefined }
}

// SFTP 状态码：2 = 不存在，3 = 无权限
const sftpErr = (e: unknown) => {
  const code = (e as { code?: unknown })?.code
  if (code === 3 || code === 'EACCES' || code === 'EPERM') return tr('没有权限')
  if (code === 2 || code === 'ENOENT') return tr('不存在')
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return tr('目录非空（可能含被排除的项），未删除')
  return e instanceof Error ? e.message : String(e)
}
const sftpStat = (sftp: SFTPWrapper, p: string) => new Promise<Attrs | undefined>((res, rej) =>
  sftp.stat(p, (e, a) => (e ? ((e as { code?: unknown }).code === 2 ? res(undefined) : rej(e)) : res(a))))
const tmpOf = (p: string, sep: string) => { const i = p.lastIndexOf(sep); return `${p.slice(0, i + 1)}.${p.slice(i + 1)}.lingshell-sync-tmp` }

/** 上传一个文件：写临时文件 → 设修改时间 → 覆盖改名（优先 posix-rename 原子替换，不支持就先删再改名）。覆盖时沿用原文件权限 */
export async function putFile(sftp: SFTPWrapper, src: string, dst: string, mtime: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const old = await sftpStat(sftp, dst)
  const tmp = tmpOf(dst, '/')
  try {
    const rs = createReadStream(src).on('data', (c) => onBytes(c.length))
    await pipeline(rs, sftp.createWriteStream(tmp, { mode: old ? old.mode & 0o7777 : 0o644 }), { signal })
    await cb((d) => sftp.utimes(tmp, mtime, mtime, d))
    let posix = true
    try { await cb((d) => sftp.ext_openssh_rename(tmp, dst, d)) } catch (e) {
      if (!/not support/i.test((e as Error).message)) throw e   // 支持但失败（如无权限）：不再删原文件去硬改
      posix = false
    }
    if (!posix) {
      if (old) await cb((d) => sftp.unlink(dst, d))
      await cb((d) => sftp.rename(tmp, dst, d))
    }
  } catch (e) {
    await cb((d) => sftp.unlink(tmp, d)).catch(() => {})
    throw e
  }
}

/** 下载一个文件：写本地临时文件 → 设修改时间 → 改名覆盖 */
export async function getFile(sftp: SFTPWrapper, src: string, dst: string, mtime: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const tmp = tmpOf(dst, dst.includes('\\') ? '\\' : '/')
  try {
    const rs = sftp.createReadStream(src).on('data', (c: Buffer) => onBytes(c.length))
    await pipeline(rs, createWriteStream(tmp), { signal })
    await utimes(tmp, mtime, mtime)
    await rename(tmp, dst)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

export interface DirSyncDeps {
  sftp(terminalId: string): Promise<SFTPWrapper>
  run(terminalId: string): RunCmd                      // 该终端连接上的独立 exec channel
  trash(path: string): Promise<void>                    // 本地删除 = 移到回收站
  audit(terminalId: string, e: { command: string; decision: string; filePath: string }): void
}

interface Job { terminalId: string; localRoot: string; remoteRoot: string; rows: SyncRow[]; progress: DirSyncProgress; abort: AbortController; running: boolean }
const JOBS_MAX = 8
const idle = (): DirSyncProgress => ({ phase: 'scan', doneItems: 0, totalItems: 0, doneBytes: 0, totalBytes: 0 })

export class DirSyncService {
  private jobs = new Map<string, Job>()
  constructor(private d: DirSyncDeps) {}

  progress(id: string): DirSyncProgress | null { return this.jobs.get(id)?.progress ?? null }
  cancel(id: string): void { this.jobs.get(id)?.abort.abort() }

  async compare(id: string, req: DirSyncCompareReq): Promise<DirSyncCompareResult> {
    if (this.jobs.get(id)?.running) throw new Error(tr('正在进行中'))
    if (!isAbsolute(req.localRoot)) throw new Error(tr('本地目录需要绝对路径：{path}', { path: req.localRoot }))
    if (!req.remoteRoot.startsWith('/')) throw new Error(tr('远程目录需要绝对路径：{path}', { path: req.remoteRoot }))
    const localRoot = resolve(req.localRoot)
    const remoteRoot = req.remoteRoot.replace(/\/+$/, '') || '/'
    const job: Job = { terminalId: req.terminalId, localRoot, remoteRoot, rows: [], progress: idle(), abort: new AbortController(), running: true }
    this.jobs.delete(id); this.jobs.set(id, job)
    while (this.jobs.size > JOBS_MAX) this.jobs.delete(this.jobs.keys().next().value!)
    const signal = job.abort.signal
    try {
      if (!(await stat(localRoot).catch(() => undefined))?.isDirectory()) throw new Error(tr('本地目录不存在：{path}', { path: localRoot }))
      const sftp = await this.d.sftp(req.terminalId)
      if (!(await sftpStat(sftp, remoteRoot))?.isDirectory()) throw new Error(tr('远程目录不存在：{path}', { path: remoteRoot }))
      const ex = excludeMatcher(req.excludes)
      let ln = 0, rn = 0
      const count = () => { job.progress.scanned = ln + rn }
      const side = (label: string, p: Promise<{ entries: SyncEntry[]; excluded: number }>) => p.catch((e: Error) => { throw new Error(tr('{side}：{err}', { side: label, err: sftpErr(e) })) })
      const [L, R] = await Promise.all([
        side(tr('本地'), walkSide(localLister, localRoot, localJoin, ex, { signal, onCount: (n) => { ln = n; count() } })),
        side(tr('远程'), walkSide(sftpLister(sftp), remoteRoot, remoteJoin, ex, { signal, onCount: (n) => { rn = n; count() } })),
      ])
      let hashes: { local: Record<string, string>; remote: Record<string, string> } | undefined, hashNote: string | undefined
      const cand = req.byContent ? hashCandidates(L.entries, R.entries) : []
      if (cand.length) {
        job.progress = { ...job.progress, phase: 'hash', totalItems: cand.length }
        const remote = await remoteSha256(this.d.run(req.terminalId), remoteRoot, cand, signal)
        const local: Record<string, string> = {}
        for (const rel of cand) {
          if (signal.aborted) throw new Error(tr('已取消'))
          if (remote.hashes[rel]) local[rel] = await localSha256(localJoin(localRoot, rel)).catch(() => '')
          job.progress.doneItems++
        }
        hashes = { local, remote: remote.hashes }
        hashNote = remote.note
      }
      job.rows = compareTrees(L.entries, R.entries, hashes)
      return { rows: job.rows, localRoot, remoteRoot, excluded: L.excluded + R.excluded, ...(hashNote ? { hashNote } : {}) }
    } finally {
      job.running = false
      job.progress = { ...job.progress, phase: 'done' }
    }
  }

  async run(id: string, selected: string[], dir: SyncDirection, mirror: boolean): Promise<DirSyncRunResult> {
    const job = this.jobs.get(id)
    if (!job || !job.rows.length) throw new Error(tr('比较结果已失效，请重新比较'))
    if (job.running) throw new Error(tr('正在进行中'))
    const plan = buildSyncPlan(job.rows, selected, dir, mirror)
    if (plan.deleteRemote.length && isProtectedDir(job.remoteRoot)) throw new Error(tr('远程根目录或根下一级目录（{path}）不允许镜像删除', { path: job.remoteRoot }))
    if (plan.deleteLocal.length && isProtectedDir(job.localRoot)) throw new Error(tr('本地磁盘根目录或根下一级目录（{path}）不允许镜像删除', { path: job.localRoot }))
    const sum = planSummary(plan)
    job.rows = []                    // 执行后两边都变了：要再同步须重新比较
    job.running = true
    job.abort = new AbortController()
    const signal = job.abort.signal
    const P: DirSyncProgress = job.progress = { phase: 'run', doneItems: 0, totalItems: sum.total, doneBytes: 0, totalBytes: sum.uploadBytes + sum.downloadBytes }
    const res: DirSyncRunResult = { uploaded: 0, downloaded: 0, mkdirs: 0, deletedRemote: 0, deletedLocal: 0, failed: [], cancelled: false }
    const L = (rel: string) => localJoin(job.localRoot, rel), R = (rel: string) => remoteJoin(job.remoteRoot, rel)
    const onBytes = (n: number) => { P.doneBytes += n }
    let remoteTouched = false
    // 逐项执行：单项失败只记下来继续；取消后剩下的不再做
    const step = async (rel: string, remote: boolean, f: () => Promise<void>, ok: () => void) => {
      if (signal.aborted) return
      P.current = rel
      if (remote) remoteTouched = true
      try { await f(); ok() } catch (e) {
        if (!signal.aborted) res.failed.push({ rel, error: sftpErr(e) })
      }
      P.doneItems++
    }
    try {
      const sftp = await this.d.sftp(job.terminalId)
      for (const rel of plan.mkdirRemote) {
        await step(rel, true, async () => {
          await cb((d) => sftp.mkdir(R(rel), d)).catch(async (e) => { if (!(await sftpStat(sftp, R(rel)))?.isDirectory()) throw e })
        }, () => res.mkdirs++)
      }
      for (const rel of plan.mkdirLocal) await step(rel, false, async () => { await mkdir(L(rel), { recursive: true }) }, () => res.mkdirs++)
      for (const f of plan.upload) await step(f.rel, true, () => putFile(sftp, L(f.rel), R(f.rel), f.mtime, onBytes, signal), () => res.uploaded++)
      for (const f of plan.download) await step(f.rel, false, () => getFile(sftp, R(f.rel), L(f.rel), f.mtime, onBytes, signal), () => res.downloaded++)
      // 删除：目录只删空目录（不递归），里面有被排除的项就保留并报出来
      for (const x of plan.deleteRemote) await step(x.rel, true, () => cb((d) => (x.isDir ? sftp.rmdir(R(x.rel), d) : sftp.unlink(R(x.rel), d))), () => res.deletedRemote++)
      for (const x of plan.deleteLocal) await step(x.rel, false, () => (x.isDir ? rmdir(L(x.rel)) : this.d.trash(L(x.rel))), () => res.deletedLocal++)
    } finally {
      res.cancelled = signal.aborted
      job.running = false
      P.phase = 'done'; P.current = undefined
      if (remoteTouched && planTouchesRemote(plan)) this.d.audit(job.terminalId, { command: auditText(job.localRoot, job.remoteRoot, dir, res), decision: SYNC_DECISION, filePath: job.remoteRoot })
    }
    return res
  }
}

// 执行记录原文（存盘，测试按中文断言），不翻译
export function auditText(localRoot: string, remoteRoot: string, dir: SyncDirection, r: DirSyncRunResult): string {
  const parts = [
    r.uploaded && `上传 ${r.uploaded} 个文件`, r.downloaded && `下载 ${r.downloaded} 个文件`, r.mkdirs && `新建 ${r.mkdirs} 个目录`,   // i18n-ignore 执行记录
    r.deletedRemote && `删除远程 ${r.deletedRemote} 项`, r.deletedLocal && `本地 ${r.deletedLocal} 项移到回收站`,   // i18n-ignore 执行记录
  ].filter(Boolean)
  const tail = [r.failed.length && `失败 ${r.failed.length} 项`, r.cancelled && '已取消'].filter(Boolean)   // i18n-ignore 执行记录
  return `目录同步 ${SYNC_DIRECTION_LABEL[dir]}：本地 ${localRoot} ⇄ 远程 ${remoteRoot}；${parts.join('、') || '无变更'}${tail.length ? `；${tail.join('，')}` : ''}`   // i18n-ignore 执行记录
}

// ── IPC：参数一律当不可信 ──
// msg 是 tk() 标过的完整报错，抛出时再翻译
const str = (v: unknown, msg: string): string => { if (typeof v !== 'string' || !v) throw new Error(tr(msg)); return v }

export function registerDirSync(d: DirSyncDeps & { handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void }): DirSyncService {
  const svc = new DirSyncService(d)
  d.handle('dirSync:compare', (_e, id, q) => {
    const r = (q ?? {}) as Record<string, unknown>
    const excludes = Array.isArray(r.excludes) ? r.excludes.filter((x): x is string => typeof x === 'string' && !!x) : []
    return svc.compare(str(id, tk('非法的任务')), {
      terminalId: str(r.terminalId, tk('非法的终端')), localRoot: str(r.localRoot, tk('非法的本地目录')), remoteRoot: str(r.remoteRoot, tk('非法的远程目录')), excludes, byContent: r.byContent === true,
    })
  })
  d.handle('dirSync:run', (_e, id, sel, dir, mirror) => {
    if (!Array.isArray(sel)) throw new Error(tr('非法的勾选列表'))
    if (dir !== 'upload' && dir !== 'download' && dir !== 'both') throw new Error(tr('非法的同步方向'))
    return svc.run(str(id, tk('非法的任务')), sel.filter((x): x is string => typeof x === 'string'), dir, mirror === true)
  })
  d.handle('dirSync:progress', (_e, id) => svc.progress(str(id, tk('非法的任务'))))
  d.handle('dirSync:cancel', (_e, id) => svc.cancel(str(id, tk('非法的任务'))))
  return svc
}
