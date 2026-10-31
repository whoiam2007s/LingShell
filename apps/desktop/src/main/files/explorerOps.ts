// 资源管理器第二阶段：复制 / 剪切 / 粘贴、属性（文件夹大小）、校验和、改属主、本地搜索 / 内容搜索。
// 远程一律在服务器上跑命令（cp / mv / find / sha256sum / grep，走该终端的独立 exec channel），不经本机中转；本地用 node fs。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, opendir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  baseName, conflictName, isInside, isProtectedDir, joinPath, missingTool, shScript,
  remotePasteCommand, sizeCommand, parseSizeOutput, checksumCommand, parseChecksum, chownCommand, OWNERS_COMMAND, parseOwners,
  contentSearchCommand, parseContentSearch, SEARCH_LIMIT, SEARCH_MAX_DEPTH, SEARCH_TIMEOUT_MS,
  type ConflictPolicy, type PasteMode, type HashAlgo, type ContentHit, type SearchHit, tr,
} from '@lingshell/shared'
import { ARCHIVE_TIMEOUT_MS, walkTree, type RunCmd, type TreeOps, type ExecResult } from './fileOps.js'

// what：已翻译的操作名（tr('复制') 等）
function check(r: ExecResult, what: string): void {
  if (r.stopped) throw new Error(tr('{what}超时（命令可能仍在服务器上运行）', { what }))
  const tool = missingTool(r.output)
  if (tool) throw new Error(tr('服务器上没有 {tool}，请先安装', { tool }))
  if (r.code !== 0) { const tail = r.output.trim().split('\n').slice(-4).join('\n'); throw new Error(`${tr('{what}失败（退出码 {code}）', { what, code: String(r.code) })}${tail ? `${tr('：')}${tail}` : ''}`) }
}

// ── 粘贴 ──
export interface PastePlan { items: { src: string; name: string; isDir: boolean; conflict: boolean; same: boolean }[] }
/** 粘贴前检查：源都在、不能把文件夹贴进它自己里面、哪些和目标目录里已有的重名（same = 就是它自己，同目录复制） */
export async function pastePlan(ops: TreeOps, srcs: string[], dir: string): Promise<PastePlan> {
  const d = await ops.lstat(dir)
  if (!d?.isDir) throw new Error(tr('目标不是文件夹：{path}', { path: dir }))
  const items: PastePlan['items'] = []
  for (const src of srcs) {
    const s = await ops.lstat(src)
    if (!s) throw new Error(tr('不存在（可能已被移走或删除）：{path}', { path: src }))
    if (s.isDir && !s.isLink && isInside(dir, src)) throw new Error(tr('不能把文件夹粘贴到它自己里面：{name}', { name: baseName(src) }))
    const name = baseName(src), to = joinPath(dir, name)
    items.push({ src, name, isDir: s.isDir && !s.isLink, same: to === src, conflict: to !== src && !!(await ops.lstat(to)) })
  }
  return { items }
}

export interface PasteResult { done: { src: string; to: string }[]; skipped: string[] }
// run：远程在服务器上 cp / mv；tree：只有 SFTP 的服务器逐个文件经 SFTP 做；都没有 = 本地 node fs
type PasteDeps = { ops: TreeOps; run?: RunCmd; tree?: boolean; audit?: (command: string, path: string) => void }
/**
 * 粘贴：同目录复制 = 复制一份（自动改名）；同目录剪切 = 什么也不做。
 * 冲突按 policy：skip 跳过 / overwrite 覆盖（文件夹合并、同名文件覆盖）/ rename 新的改名 a (1).txt
 */
export async function paste(d: PasteDeps, srcs: string[], dir: string, mode: PasteMode, policy: ConflictPolicy): Promise<PasteResult> {
  const plan = await pastePlan(d.ops, srcs, dir)
  const taken = new Set((await d.ops.readdir(dir)).map((e) => (d.ops.win ? e.name.toLowerCase() : e.name)))
  const has = (n: string) => taken.has(d.ops.win ? n.toLowerCase() : n)
  const res: PasteResult = { done: [], skipped: [] }
  for (const it of plan.items) {
    if (it.same && mode === 'move') { res.skipped.push(it.src); continue }
    if (mode === 'move' && it.isDir && isProtectedDir(it.src)) throw new Error(tr('根目录或根下一级目录不允许移动：{path}', { path: it.src }))
    let name = it.name, merge = false
    if (it.same) name = conflictName(it.name, has)
    else if (it.conflict) {
      if (policy === 'skip') { res.skipped.push(it.src); continue }
      if (policy === 'rename') name = conflictName(it.name, has)
      else {
        const t = await d.ops.lstat(joinPath(dir, it.name))
        if (t && t.isDir !== it.isDir) throw new Error(t.isDir ? tr('「{name}」在目标里是文件夹，不能用文件覆盖', { name: it.name }) : tr('「{name}」在目标里是文件，不能用文件夹覆盖', { name: it.name }))
        merge = it.isDir
      }
    }
    const to = joinPath(dir, name)
    taken.add(d.ops.win ? name.toLowerCase() : name)
    const note = `${mode === 'copy' ? '复制' : '移动'} ${it.src} → ${to}${merge ? '（合并到已有文件夹）' : it.conflict && policy === 'overwrite' ? '（覆盖）' : ''}`   // i18n-ignore 执行记录
    if (d.run) {
      check(await d.run(remotePasteCommand(it.src, to, mode, merge), ARCHIVE_TIMEOUT_MS), mode === 'copy' ? tr('复制') : tr('移动'))
      d.audit?.(note, to)
    } else if (d.tree) { await treePasteOne(d.ops, it.src, to, mode, merge); d.audit?.(note, to) }
    else await localPaste(it.src, to, mode, it.conflict && policy === 'overwrite')
    res.done.push({ src: it.src, to })
  }
  return res
}

async function localPaste(src: string, to: string, mode: PasteMode, overwrite: boolean): Promise<void> {
  const copy = () => cp(src, to, { recursive: true, force: overwrite, errorOnExist: !overwrite, preserveTimestamps: true, verbatimSymlinks: true })
  if (mode === 'copy') return copy()
  const s = await lstat(src)
  const target = await lstat(to).catch(() => undefined)
  if (!target || (!s.isDirectory() && overwrite)) {
    try { await rename(src, to); return } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e }   // 跨盘：复制后删
  }
  await copy()
  await rm(src, { recursive: true, force: true })
}

// ── 只有 SFTP、没有 sh 的服务器（Windows 自带的 OpenSSH）：复制 / 移动 / 统计 / 校验和 / 按名称搜索都经 SFTP 做 ──
export const WIN_SFTP = /^\/[A-Za-z]:(\/|$)/   // Windows OpenSSH 的 SFTP 路径：/C:/Users/x
/** what：已翻译的操作名 */
export const winUnsupported = (what: string) => new Error(tr('这台是 Windows 服务器（没有 sh），不支持{what}', { what }))

/** 经 SFTP 复制一项（文件夹递归）：文件流经本机中转；merge = 合并进已有同名文件夹（同名文件覆盖） */
async function treeCopy(ops: TreeOps, src: string, to: string): Promise<void> {
  const w = await walkTree(ops, src)
  if (w.over) throw new Error(tr('超过上限，已中止：{path}', { path: src }))
  for (const e of w.entries) {
    if (e.isLink) continue
    const dst = e.rel.reduce((p, n) => joinPath(p, n), to)
    if (e.isDir) { if (!(await ops.lstat(dst))) await ops.mkdir(dst); continue }
    await pipeline(ops.createReadStream(e.path), ops.createWriteStream(dst))
    if (e.mtime) await ops.setMtime(dst, e.mtime).catch(() => {})
  }
}
async function treeRemove(ops: TreeOps, p: string): Promise<void> {
  const w = await walkTree(ops, p)
  for (const e of w.entries.reverse()) await (e.isDir && !e.isLink ? ops.rmdir(e.path) : ops.unlink(e.path))
}
export async function treePasteOne(ops: TreeOps, src: string, to: string, mode: PasteMode, merge: boolean): Promise<void> {
  if (mode === 'copy') return treeCopy(ops, src, to)
  if (!merge) { if (await ops.lstat(to)) await ops.replace(src, to); else await ops.rename(src, to); return }
  await treeCopy(ops, src, to)
  await treeRemove(ops, src)
}
export async function treeStats(ops: TreeOps, paths: string[]): Promise<DirStats> {
  const st: DirStats = { dirs: 0, files: 0, bytes: 0 }
  for (const p of paths) {
    const w = await walkTree(ops, p, STATS_CAP)
    for (const e of w.entries) { if (e.isDir && !e.isLink) st.dirs++; else { st.files++; st.bytes += e.size } }
    if (w.over) return { ...st, partial: true }
  }
  return st
}
export async function treeChecksum(ops: TreeOps, p: string, algo: HashAlgo): Promise<string> {
  const s = await ops.lstat(p)
  if (!s) throw new Error(tr('不存在：{path}', { path: p }))
  if (s.isDir) throw new Error(tr('文件夹没有校验和'))
  const h = createHash(algo)
  for await (const chunk of ops.createReadStream(p)) h.update(chunk as Buffer)
  return h.digest('hex')
}
export async function treeSearchNames(ops: TreeOps, root: string, query: string): Promise<Found> {
  const q = query.trim()
  if (!q) throw new Error(tr('请输入要搜索的名称'))
  const re = /[*?]/.test(q) ? new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : undefined
  const hit = (n: string) => (re ? re.test(n) : n.toLowerCase().includes(q.toLowerCase()))
  const hits: SearchHit[] = []
  const until = Date.now() + SEARCH_TIMEOUT_MS
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > SEARCH_MAX_DEPTH) return true
    const list = await ops.readdir(dir).catch(() => [])
    for (const e of list) {
      const p = joinPath(dir, e.name)
      if (hit(e.name)) { hits.push({ name: e.name, path: p, isDir: e.isDir }); if (hits.length > SEARCH_LIMIT) return false }
    }
    for (const e of list) { if (Date.now() > until) return false; if (e.isDir && !e.isLink && !SKIP_DIRS.has(e.name) && !(await walk(joinPath(dir, e.name), depth + 1))) return false }
    return true
  }
  await walk(root, 1)
  return { hits: hits.slice(0, SEARCH_LIMIT), truncated: hits.length > SEARCH_LIMIT, timedOut: Date.now() > until }
}

// ── 属性：文件夹数 / 文件数 / 总大小 ──
export interface DirStats { dirs: number; files: number; bytes: number; partial?: boolean }
const STATS_CAP = 300_000, STATS_MS = 30_000
export async function remoteStats(run: RunCmd, paths: string[]): Promise<DirStats> {
  const r = await run(sizeCommand(paths), STATS_MS)
  const s = parseSizeOutput(r.output)
  if (!s) { check(r, tr('统计大小')); throw new Error(tr('统计大小失败：服务器输出无法解析')) }
  return r.stopped ? { ...s, partial: true } : s
}
/** 本地：逐层 opendir + lstat；超过上限或超时返回已统计的部分（partial） */
export async function localStats(paths: string[], cap = STATS_CAP, ms = STATS_MS): Promise<DirStats> {
  const st: DirStats = { dirs: 0, files: 0, bytes: 0 }
  const until = Date.now() + ms
  const stack = [...paths]
  while (stack.length) {
    if (st.dirs + st.files >= cap || Date.now() > until) return { ...st, partial: true }
    const p = stack.pop()!
    const s = await lstat(p).catch(() => undefined)
    if (!s) continue
    if (s.isDirectory()) {
      st.dirs++
      const d = await opendir(p).catch(() => undefined)
      if (d) for await (const e of d) stack.push(join(p, e.name))
    } else { st.files++; st.bytes += s.size }
  }
  return st
}

// ── 校验和 ──
export async function remoteChecksum(run: RunCmd, path: string, algo: HashAlgo): Promise<string> {
  const r = await run(checksumCommand(path, algo), ARCHIVE_TIMEOUT_MS)
  check(r, tr('计算校验和'))
  const h = parseChecksum(r.output)
  if (!h) throw new Error(tr('计算校验和失败：服务器输出无法解析'))
  return h
}
export async function localChecksum(path: string, algo: HashAlgo): Promise<string> {
  if ((await stat(path)).isDirectory()) throw new Error(tr('文件夹没有校验和'))
  const h = createHash(algo)
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

// ── 改属主（远程） ──
export async function remoteOwners(run: RunCmd): Promise<{ users: string[]; groups: string[] }> {
  const r = await run(OWNERS_COMMAND, 15_000)
  return parseOwners(r.output)
}
export async function remoteChown(run: RunCmd, paths: string[], owner: string, group: string, recursive: boolean): Promise<string> {
  if (recursive) for (const p of paths) if (isProtectedDir(p)) throw new Error(tr('根目录或根下一级目录不允许递归修改属主：{path}', { path: p }))
  const command = chownCommand(paths, owner.trim(), group.trim(), recursive)
  check(await run(shScript(`${command} 2>&1`), ARCHIVE_TIMEOUT_MS), tr('修改属主'))
  return command
}

// ── 搜索：名称（本地）/ 内容（本地、远程） ──
const SKIP_DIRS = new Set(['.git', 'node_modules'])
type Found = { hits: SearchHit[]; truncated: boolean; timedOut: boolean }
/** 本地按名称搜索：与远程 find 同样的规则（不区分大小写，有 * ? 时按通配，否则「包含」；最深 6 层、最多 500 条） */
export async function localSearchNames(root: string, query: string): Promise<Found> {
  const q = query.trim()
  if (!q) throw new Error(tr('请输入要搜索的名称'))
  const re = /[*?]/.test(q) ? new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : undefined
  const hit = (n: string) => (re ? re.test(n) : n.toLowerCase().includes(q.toLowerCase()))
  const hits: SearchHit[] = []
  const until = Date.now() + SEARCH_TIMEOUT_MS
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > SEARCH_MAX_DEPTH) return true
    const d = await opendir(dir).catch(() => undefined)
    if (!d) return true
    const subs: string[] = []
    for await (const e of d) {
      const p = join(dir, e.name)
      if (hit(e.name)) { hits.push({ name: e.name, path: p, isDir: e.isDirectory() }); if (hits.length > SEARCH_LIMIT) return false }
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) subs.push(p)
    }
    for (const s of subs) { if (Date.now() > until) return false; if (!(await walk(s, depth + 1))) return false }
    return true
  }
  await walk(root, 1)
  return { hits: hits.slice(0, SEARCH_LIMIT), truncated: hits.length > SEARCH_LIMIT, timedOut: Date.now() > until }
}

type ContentFound = { hits: ContentHit[]; truncated: boolean; timedOut: boolean }
const TEXT_MAX = 2 * 1024 * 1024
export async function remoteSearchContent(run: RunCmd, root: string, query: string): Promise<ContentFound> {
  const q = query.trim()
  if (!q) throw new Error(tr('请输入要搜索的内容'))
  const r = await run(contentSearchCommand(root, q), SEARCH_TIMEOUT_MS)
  return { ...parseContentSearch(r.output), timedOut: r.stopped === 'timeout' }
}
/** 本地内容搜索：跳过 .git / node_modules、超过 2MB 的文件和二进制文件（前 8KB 有 \0）；每个文件取第一处 */
export async function localSearchContent(root: string, query: string): Promise<ContentFound> {
  const q = query.trim().toLowerCase()
  if (!q) throw new Error(tr('请输入要搜索的内容'))
  const hits: ContentHit[] = []
  const until = Date.now() + SEARCH_TIMEOUT_MS
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > SEARCH_MAX_DEPTH + 2) return true
    const d = await opendir(dir).catch(() => undefined)
    if (!d) return true
    for await (const e of d) {
      if (Date.now() > until) return false
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !(await walk(p, depth + 1))) return false; continue }
      if (!e.isFile()) continue
      const s = await stat(p).catch(() => undefined)
      if (!s || s.size > TEXT_MAX || s.size === 0) continue
      const buf = await readFile(p).catch(() => undefined)
      if (!buf || buf.subarray(0, 8192).includes(0)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      const i = lines.findIndex((l) => l.toLowerCase().includes(q))
      if (i >= 0) { hits.push({ path: p, name: baseName(p), line: i + 1, text: lines[i].trim().slice(0, 200) }); if (hits.length > SEARCH_LIMIT) return false }
    }
    return true
  }
  await walk(root, 1)
  return { hits: hits.slice(0, SEARCH_LIMIT), truncated: hits.length > SEARCH_LIMIT, timedOut: Date.now() > until }
}
