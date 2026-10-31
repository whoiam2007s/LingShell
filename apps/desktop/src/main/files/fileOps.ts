// AI 文件工具（read_file / write_file）与「还原」的落地层：本地走 fs，SSH 走终端已有连接的 SFTP 会话。
// 文件内容不经交互终端（不回显、不进 shell history、不受 PTY 转义/换行影响）。
//
// 备份位置：统一放「该主机用户家目录/.lingshell/backups/」，文件名 <时间戳>_<原路径拼平>。
// 不放原文件旁边：nginx 的 include sites-enabled/*、cron.d、*.d 目录会把旁边的 .bak 也加载进去。
// 家目录一定可写，且与原文件同主机，还原不需要跨机传输。
import { readFile, writeFile, stat, mkdir, lstat, readdir, rename, unlink, rmdir, utimes } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import {
  ENCODING_LABEL, decodeText, encodeText, isLegacyEncoding, nameError, joinPath, parentPath, baseName, isProtectedDir, conflictName, TREE_CAP, TREE_MAX_DEPTH,
  longnameOwner, archiveKind, archiveName, packCommand, unpackCommand, missingTool, searchCommand, parseSearchOutput, modeOctal, shq, shScript, SEARCH_TIMEOUT_MS,
  type DeletePlan, type DirEntry, type SearchHit, tr,
} from '@lingshell/shared'
import { toNativePath } from './paths.js'

export const MAX_FILE_BYTES = 2 * 1024 * 1024   // 超过的不按文本读写（大日志请用 tail/grep）

export interface FileAccess {
  /** 规范化成本主机上的绝对路径（本地：MSYS /d/x → D:\x、~ → 家目录；远程：~/ → 家目录） */
  resolve(p: string): Promise<string>
  /** 不存在返回 undefined；超过 max（缺省 MAX_FILE_BYTES）抛错 */
  read(p: string, max?: number): Promise<Buffer | undefined>
  write(p: string, data: Buffer, mode?: number): Promise<void>
  mkdirp(dir: string): Promise<void>
  backupDir(): Promise<string>
  /** 删除单个文件（按回合撤销 AI 新建的文件用） */
  remove?(p: string): Promise<void>
  /** 文件内容编码（主机设置；缺省 UTF-8）。只管内容，文件名 ssh2 一律按 UTF-8 解，GBK 文件名会乱码 */
  encoding?: string
}

/** 带错误码的文件操作错误：调用方按 code 判断（不按文案匹配，文案随界面语言变）。
 * too_big = 文件超过大小上限；precheck = 动手前的检查没过（什么都没改）*/
export class FsError extends Error {
  constructor(readonly code: 'too_big' | 'precheck', message: string) { super(message) }
}
export const isFsError = (e: unknown, code: FsError['code']) => e instanceof FsError && e.code === code

export const tooBig = (p: string, size: number, max = MAX_FILE_BYTES) => new FsError('too_big', tr('文件过大（{size}KB > {max}KB），不按文本读写：{path}', { size: Math.round(size / 1024), max: max / 1024, path: p }))

// dataRoot：本机备份放在数据根目录下（跟随 LINGSHELL_DATA_DIR），默认 ~/.lingshell
export function localAccess(dataRoot = `${homedir()}/.lingshell`): FileAccess {
  return {
    async resolve(p) {
      const q = p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : toNativePath(p)
      if (!isAbsolute(q)) throw new Error(tr('需要绝对路径：{path}', { path: p }))
      return q
    },
    async read(p, max = MAX_FILE_BYTES) {
      try {
        const st = await stat(p)
        if (st.size > max) throw tooBig(p, st.size, max)
        return await readFile(p)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw e
      }
    },
    write: (p, data, mode) => writeFile(p, data, mode === undefined ? undefined : { mode }),
    async mkdirp(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }) },
    async backupDir() { return `${dataRoot.replace(/\\/g, '/')}/backups` },
    remove: (p) => unlink(p),
  }
}

// ssh2 的 SFTP 状态码 2 = NO_SUCH_FILE
const noSuchFile = (e: unknown) => (e as { code?: unknown })?.code === 2

export function sftpAccess(sftp: SFTPWrapper, encoding?: string): FileAccess {
  let home: Promise<string> | undefined
  const homeDir = () => (home ??= new Promise((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(e) : res(p)))))
  return {
    encoding,
    async resolve(p) {
      if (p === '~' || p.startsWith('~/')) return (await homeDir()) + p.slice(1)
      if (!p.startsWith('/')) throw new Error(tr('需要绝对路径：{path}', { path: p }))
      return p
    },
    read: (p, max = MAX_FILE_BYTES) => new Promise((resolve, reject) => {
      sftp.stat(p, (e, st) => {
        if (e) return noSuchFile(e) ? resolve(undefined) : reject(e)
        if (st.size > max) return reject(tooBig(p, st.size, max))
        sftp.readFile(p, (e2, buf) => (e2 ? reject(e2) : resolve(buf)))
      })
    }),
    // 已存在的文件 writeFile 按 O_TRUNC 打开，保留原属主与权限
    write: (p, data, mode) => new Promise((resolve, reject) => {
      sftp.writeFile(p, data, mode === undefined ? {} : { mode }, (e) => (e ? reject(e) : resolve()))
    }),
    // SFTP 的 mkdir 不递归：逐级建，已存在的报错忽略（真建不出来时后面的写会报错）
    async mkdirp(dir) {
      const parts = dir.split('/').filter(Boolean)
      for (let i = 1; i <= parts.length; i++) {
        await new Promise<void>((r) => sftp.mkdir('/' + parts.slice(0, i).join('/'), { mode: 0o700 }, () => r()))
      }
    },
    async backupDir() { return `${await homeDir()}/.lingshell/backups` },
    remove: (p) => new Promise((resolve, reject) => sftp.unlink(p, (e) => (e ? reject(e) : resolve()))),
  }
}

/** 备份文件名：20261009-180512-123_etc_nginx_nginx.conf（时间在前便于按时间排序；路径拼平看得出原文件） */
export function backupName(path: string, now = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  const flat = path.replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+/, '').slice(-120)
  return `${ts}_${flat}`
}

/**
 * 覆盖写 + 先备份原文件（原文件不存在则直接新建、无备份）。备份按字节原样拷，权限 0600（原文件可能含密钥）。
 * 备份失败就不写——宁可改不成，也不能改了回不去。
 */
export async function writeWithBackup(fa: FileAccess, path: string, data: Buffer, now = new Date(), max = MAX_FILE_BYTES): Promise<{ path: string; backupPath?: string }> {
  const old = await fa.read(path, max)   // max：外部编辑器回传允许更大的文件
  const backupPath = old === undefined ? undefined : await backupFile(fa, path, old, now)
  await fa.write(path, data)
  return { path, backupPath }
}

/** 把 path 的内容 data 存进该主机的备份目录，返回备份路径 */
export async function backupFile(fa: FileAccess, path: string, data: Buffer, now = new Date()): Promise<string> {
  const dir = await fa.backupDir()
  await fa.mkdirp(dir)
  const backupPath = `${dir}/${backupName(path, now)}`
  await fa.write(backupPath, data, 0o600)
  return backupPath
}

// ── 用户在资源管理器里手动查看/编辑文件 ──

/** 按文本读：不存在/二进制（含 \0）/非主机编码（解码再编码不等于原字节，保存会损坏）一律拒绝；过大由 fa.read 抛 */
export async function readText(fa: FileAccess, path: string): Promise<string> {
  const buf = await fa.read(path)
  if (buf === undefined) throw new Error(tr('文件不存在：{path}', { path }))
  if (buf.includes(0)) throw new Error(tr('二进制文件，不支持按文本打开：{path}', { path }))
  const text = decodeText(buf, fa.encoding)
  if (!buf.equals(encodeText(text, fa.encoding))) {
    throw new Error(tr('不是 {enc} 编码的文本，编辑保存会损坏内容（可在主机设置里改字符编码）：{path}', { enc: ENCODING_LABEL[isLegacyEncoding(fa.encoding) ? fa.encoding : 'utf8'], path }))
  }
  return text
}

/** 打开后磁盘上被改过（内容与打开时 base 不同）就拒绝，避免覆盖别人的改动 */
export async function assertUnchanged(fa: FileAccess, path: string, base: string): Promise<void> {
  if ((await readText(fa, path)) !== base) throw new Error(tr('文件在打开后已被其他程序修改，请关闭后重新打开再编辑'))
}

/** 手动编辑保存：先查并发修改，再按 writeWithBackup 备份后覆盖 */
export async function saveText(fa: FileAccess, path: string, base: string, next: string) {
  await assertUnchanged(fa, path, base)
  return writeWithBackup(fa, path, Buffer.from(encodeText(next, fa.encoding)))
}

// ── 资源管理器的新建 / 重命名 / 递归删除 / 目录下载：本地 fs 与 SFTP 同一套接口 ──

export interface TreeStat { isDir: boolean; isLink: boolean; size: number; mtime?: number; mode?: number }   // mtime：秒；mode：权限位（传输时保留可执行位）
export interface TreeOps {
  win: boolean                                    // 本地 Windows：名称按 Windows 规则校验
  lstat(p: string): Promise<TreeStat | undefined> // 不存在返回 undefined；不跟随符号链接
  readdir(p: string): Promise<(TreeStat & { name: string })[]>
  mkdir(p: string): Promise<void>
  createFile(p: string): Promise<void>            // 独占新建（已存在报错，绝不覆盖）
  rename(from: string, to: string): Promise<void>
  replace(from: string, to: string): Promise<void> // 改名并覆盖已有的 to（传输收尾：半截文件 → 正式文件）
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
  createReadStream(p: string, start?: number): Readable
  createWriteStream(p: string, start?: number, mode?: number): Writable   // start > 0：从该位置接着写（断点续传），否则新建 / 截断；mode 只新建时生效
  setMtime(p: string, sec: number): Promise<void>
  chmod(p: string, mode: number): Promise<void>   // 本地 Windows 不支持（资源管理器只对远程开放）
}

const enoent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'

export function localTreeOps(): TreeOps {
  const st = (s: import('node:fs').Stats): TreeStat => ({ isDir: s.isDirectory(), isLink: s.isSymbolicLink(), size: s.size, mtime: Math.floor(s.mtimeMs / 1000), mode: s.mode & 0o7777 })
  return {
    win: process.platform === 'win32',
    lstat: (p) => lstat(p).then(st, (e) => { if (enoent(e)) return undefined; throw e }),
    // 本地只在删除前计数时用到，不逐个 stat（node_modules 这类目录太多），size 记 0
    readdir: async (p) => (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isDir: d.isDirectory(), isLink: d.isSymbolicLink(), size: 0 })),
    mkdir: (p) => mkdir(p),
    createFile: (p) => writeFile(p, '', { flag: 'wx' }),
    rename: (a, b) => rename(a, b),
    replace: (a, b) => rename(a, b),   // node 的 rename 会覆盖已有文件（Windows 上也是）
    unlink: (p) => unlink(p),
    rmdir: (p) => rmdir(p),
    createReadStream: (p, start) => createReadStream(p, start ? { start } : undefined),
    createWriteStream: (p, start, mode) => createWriteStream(p, start ? { flags: 'r+', start } : { ...(mode ? { mode } : {}) }),
    setMtime: (p, sec) => utimes(p, sec, sec),
    chmod: async () => { throw new Error(tr('本地文件不支持修改权限')) },
  }
}

export function sftpTreeOps(sftp: SFTPWrapper): TreeOps {
  const cb = <T = void>(f: (done: (e?: Error | null, v?: T) => void) => void) =>
    new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v as T))))
  type Attrs = { isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtime: number; mode?: number }
  const st = (a: Attrs): TreeStat => ({ isDir: a.isDirectory(), isLink: a.isSymbolicLink(), size: a.size, mtime: a.mtime, mode: a.mode === undefined ? undefined : a.mode & 0o7777 })
  const ops: TreeOps = {
    win: false,
    lstat: (p) => new Promise((res, rej) => sftp.lstat(p, (e, a) => (e ? (noSuchFile(e) ? res(undefined) : rej(e)) : res(st(a))))),
    readdir: async (p) => (await cb<{ filename: string; attrs: Attrs }[]>((d) => sftp.readdir(p, d))).map((it) => ({ name: it.filename, ...st(it.attrs) })),
    mkdir: (p) => cb((d) => sftp.mkdir(p, d)),
    createFile: async (p) => { const h = await cb<Buffer>((d) => sftp.open(p, 'wx', d)); await cb((d) => sftp.close(h, d)) },
    rename: (a, b) => cb((d) => sftp.rename(a, b, d)),
    // 优先 OpenSSH 的 posix-rename 扩展（原子覆盖）；服务器不支持就先删目标再改名
    replace: async (a, b) => {
      try { await cb((d) => sftp.ext_openssh_rename(a, b, d)); return } catch { /* 不支持该扩展 */ }
      await ops.unlink(b).catch((e) => { if (!noSuchFile(e as Error)) throw e })
      await ops.rename(a, b)
    },
    unlink: (p) => cb((d) => sftp.unlink(p, d)),
    rmdir: (p) => cb((d) => sftp.rmdir(p, d)),
    createReadStream: (p, start) => sftp.createReadStream(p, start ? { start } : undefined),
    createWriteStream: (p, start, mode) => sftp.createWriteStream(p, start ? { flags: 'r+', start } : { flags: 'w', ...(mode ? { mode } : {}) }),
    setMtime: (p, sec) => cb((d) => sftp.utimes(p, sec, sec, d)),
    chmod: (p, mode) => cb((d) => sftp.chmod(p, mode, d)),
  }
  return ops
}

type SftpItem = { filename: string; longname: string; attrs: { isDirectory(): boolean; mode: number; size: number; mtime: number; uid: number; gid: number } }
/** SFTP readdir 一项 → 资源管理器条目（带权限/属主/大小/修改时间） */
export function sftpDirEntry(dir: string, it: SftpItem): DirEntry {
  const o = longnameOwner(it.longname)
  return {
    name: it.filename, path: (dir.endsWith('/') ? dir : dir + '/') + it.filename, isDir: it.attrs.isDirectory(),
    mode: it.attrs.mode & 0o7777, size: it.attrs.size, mtime: it.attrs.mtime,
    owner: o?.owner ?? String(it.attrs.uid), group: o?.group ?? String(it.attrs.gid),
  }
}

export interface WalkEntry extends TreeStat { path: string; rel: string[] }

/**
 * 先序遍历（目录在其内容之前）：不跟随符号链接（链接当文件，删只删链接本身，避免环/删到树外）。
 * 超过 cap 项或深度超限就停，返回 over=true，由调用方决定拒绝还是照做。
 */
export async function walkTree(ops: TreeOps, root: string, cap = TREE_CAP, maxDepth = TREE_MAX_DEPTH): Promise<{ entries: WalkEntry[]; over: boolean }> {
  const top = await ops.lstat(root)
  if (!top) throw new FsError('precheck', tr('不存在：{path}', { path: root }))
  const entries: WalkEntry[] = []
  const visit = async (path: string, rel: string[], s: TreeStat): Promise<boolean> => {
    if (entries.length >= cap || rel.length > maxDepth) return false
    entries.push({ path, rel, ...s })
    if (!s.isDir || s.isLink) return true
    for (const c of await ops.readdir(path)) {
      if (!(await visit(joinPath(path, c.name), [...rel, c.name], c))) return false
    }
    return true
  }
  const ok = await visit(root, [], top)
  return { entries, over: !ok }
}

/** 多个选中项合计（目录本身也算一个文件夹） */
export async function planDelete(ops: TreeOps, paths: string[], cap = TREE_CAP): Promise<DeletePlan> {
  const plan: DeletePlan = { files: 0, dirs: 0, over: false }
  for (const p of paths) {
    await assertDeletable(ops, p)
    const w = await walkTree(ops, p, cap - plan.files - plan.dirs)
    for (const e of w.entries) { if (e.isDir && !e.isLink) plan.dirs++; else plan.files++ }
    if (w.over) return { ...plan, over: true }
  }
  return plan
}

export const assertDeletable = async (ops: TreeOps, p: string) => {
  const s = await ops.lstat(p)
  if (!s) throw new FsError('precheck', tr('不存在：{path}', { path: p }))
  if (s.isDir && isProtectedDir(p)) throw new FsError('precheck', tr('根目录或根下一级目录不允许在这里删除/重命名：{path}', { path: p }))
}

/** 远程递归删除：先完整遍历，超上限一个都不删；再倒序（内容先于目录）逐个删 */
export async function deleteTree(ops: TreeOps, p: string, cap = TREE_CAP): Promise<DeletePlan> {
  await assertDeletable(ops, p)
  const w = await walkTree(ops, p, cap)
  if (w.over) throw new FsError('precheck', tr('超过 {n} 项，已中止、未删除任何内容；请在终端里用命令处理：{path}', { n: cap, path: p }))
  const plan: DeletePlan = { files: 0, dirs: 0, over: false }
  for (const e of w.entries.reverse()) {
    if (e.isDir && !e.isLink) { await ops.rmdir(e.path); plan.dirs++ } else { await ops.unlink(e.path); plan.files++ }
  }
  return plan
}

/** 新建文件/文件夹：名称校验 + 已存在报错；返回新路径 */
export async function createEntry(ops: TreeOps, dir: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  const err = nameError(name, ops.win)
  if (err) throw new Error(err)
  const p = joinPath(dir, name)
  if (await ops.lstat(p)) throw new Error(tr('已存在同名项：{name}', { name }))
  await (kind === 'dir' ? ops.mkdir(p) : ops.createFile(p))
  return p
}

/** 同目录内改名：名称校验 + 目标已存在拒绝（不覆盖）；返回新路径 */
export async function renameEntry(ops: TreeOps, path: string, name: string): Promise<string> {
  const err = nameError(name, ops.win)
  if (err) throw new Error(err)
  await assertDeletable(ops, path)
  const to = joinPath(parentPath(path), name)
  if (to === path) return path
  if (await ops.lstat(to)) throw new Error(tr('已存在同名项：{name}', { name }))
  await ops.rename(path, to)
  return to
}

export interface DownloadItem { remote: string; local: string; isDir: boolean; size: number; mode?: number }

/**
 * 远程树 → 本地路径映射：每个选中项落到 localDir 下，顶层与已有文件同名就改名 `a (1).txt`（目录同理，其内部结构不变）。
 * taken = localDir 下已有的名字；win 时比较忽略大小写、名字里 Windows 非法字符换成 _。符号链接跳过（不跟随）。
 */
export function downloadPlan(trees: { path: string; entries: WalkEntry[] }[], localDir: string, taken: Iterable<string>, win: boolean): DownloadItem[] {
  const key = (n: string) => (win ? n.toLowerCase() : n)
  const used = new Set([...taken].map(key))
  // eslint-disable-next-line no-control-regex
  const safe = (n: string) => (win ? n.replace(/[<>:"|?*\\\x00-\x1f]/g, '_').replace(/[ .]+$/, (m) => '_'.repeat(m.length)) : n)
  const out: DownloadItem[] = []
  for (const t of trees) {
    const top = conflictName(safe(baseName(t.path)), (n) => used.has(key(n)))
    used.add(key(top))
    for (const e of t.entries) {
      if (e.isLink) continue
      out.push({ remote: e.path, local: join(localDir, top, ...e.rel.map(safe)), isDir: e.isDir, size: e.size, ...(e.mode !== undefined ? { mode: e.mode } : {}) })
    }
  }
  return out
}

// ── 远程 chmod / 压缩 / 解压 / 按名称搜索：服务器命令经该终端连接上的独立 exec channel 跑（不往交互终端打字），参数一律 shq 转义 ──

export interface ExecResult { code: number | null; output: string; stopped?: 'timeout' | 'aborted' }
export type RunCmd = (command: string, timeoutMs: number) => Promise<ExecResult>
export const ARCHIVE_TIMEOUT_MS = 10 * 60_000

// what：已翻译的操作名（tr('压缩') 等）。缺工具 = 什么都没做（precheck）
function checkRun(r: ExecResult, what: string): void {
  if (r.stopped) throw new Error(tr('{what}超时（命令可能仍在服务器上运行）', { what }))
  const tool = missingTool(r.output)
  if (tool) throw new FsError('precheck', tr('服务器上没有 {tool}，请先安装（如 apt install {tool} 或 yum install {tool}）', { tool }))
  const tail = r.output.trim().split('\n').slice(-5).join('\n')
  if (r.code !== 0) throw new Error(`${tr('{what}失败（退出码 {code}）', { what, code: String(r.code) })}${tail ? `${tr('：')}${tail}` : ''}`)
}

/** 改权限：单项走 SFTP；递归走 chmod -R（逐个 SFTP 太慢）。根与根下一级目录不许递归。返回记执行记录用的命令 */
export async function chmodEntry(ops: TreeOps, run: RunCmd, path: string, mode: number, recursive: boolean): Promise<string> {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error(tr('非法的权限值'))
  if (!recursive) { await ops.chmod(path, mode); return `chmod ${modeOctal(mode)} ${shq(path)}` }
  if (isProtectedDir(path)) throw new Error(tr('根目录或根下一级目录不允许递归修改权限：{path}', { path }))
  const command = `chmod -R ${modeOctal(mode)} ${shq(path)}`
  checkRun(await run(shScript(command), ARCHIVE_TIMEOUT_MS), tr('修改权限'))
  return command
}

/** 同一目录下的若干项打成 tar.gz 放在该目录：单项叫 <名>.tar.gz，多项叫 <目录名>.tar.gz，重名自动加 (1) */
export async function packEntries(ops: TreeOps, run: RunCmd, paths: string[]): Promise<{ out: string; command: string }> {
  const dir = parentPath(paths[0])
  if (paths.some((p) => parentPath(p) !== dir)) throw new Error(tr('只能把同一目录下的项压缩到一起'))
  const names = paths.map(baseName)
  const taken = new Set((await ops.readdir(dir)).map((e) => e.name))
  const out = joinPath(dir, archiveName(names.length === 1 ? names[0] : baseName(dir) || 'archive', (n) => taken.has(n)))
  const command = packCommand(dir, names, out)
  checkRun(await run(command, ARCHIVE_TIMEOUT_MS), tr('压缩'))
  return { out, command }
}

/** 解压到压缩包所在目录；已存在的同名文件不覆盖 */
export async function unpackEntry(run: RunCmd, path: string): Promise<{ dir: string; command: string }> {
  const kind = archiveKind(baseName(path))
  if (!kind) throw new FsError('precheck', tr('只支持解压 .tar.gz / .tgz / .tar / .zip'))
  const dir = parentPath(path)
  const command = unpackCommand(path, kind, dir)
  try { checkRun(await run(command, ARCHIVE_TIMEOUT_MS), tr('解压')) } catch (e) {
    const m = (e as Error).message
    throw /exists/i.test(m) ? new Error(`${m}\n${tr('（已存在的同名文件没有覆盖，其余已解压）')}`) : e
  }
  return { dir, command }
}

/** root 下按名称递归搜索（深度/条数/超时见 shared SEARCH_*）；超时返回已找到的部分 */
export async function searchNames(run: RunCmd, root: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean; timedOut: boolean }> {
  const q = query.trim()
  if (!q) throw new Error(tr('请输入要搜索的名称'))
  if (q.includes('/')) throw new Error(tr('名称里不能有 /'))
  const r = await run(searchCommand(root, q), SEARCH_TIMEOUT_MS)
  return { ...parseSearchOutput(r.output), timedOut: r.stopped === 'timeout' }
}
