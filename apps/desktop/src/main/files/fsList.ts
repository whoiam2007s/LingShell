// 资源管理器列目录：本地 / 远程都带大小、修改时间、权限；符号链接标出来并解析指向（指向目录的可以展开）。
// 「常用位置」：主目录、根目录、临时目录，Windows 本地再加各个盘符
import { existsSync } from 'node:fs'
import { lstat, readdir, readlink, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { tr, type DirEntry } from '@lingshell/shared'
import { sftpDirEntry } from './fileOps.js'

const S_IFMT = 0o170000, S_IFLNK = 0o120000
const WIN = process.platform === 'win32'

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

export async function listLocal(dir: string): Promise<DirEntry[]> {
  const ents = await readdir(dir, { withFileTypes: true })
  return pool(ents, 32, async (d): Promise<DirEntry> => {
    const path = join(dir, d.name)
    const base: DirEntry = { name: d.name, path, isDir: d.isDirectory() }
    try {
      const l = await lstat(path)
      // Windows 上的权限位没有意义（只有只读 / 可写），不显示，免得误导
      const info: DirEntry = { ...base, size: l.size, mtime: Math.floor(l.mtimeMs / 1000), ...(WIN ? {} : { mode: l.mode & 0o7777 }) }
      if (!l.isSymbolicLink()) return { ...info, isDir: l.isDirectory() }
      const target = await readlink(path).catch(() => undefined)
      try { const t = await stat(path); return { ...info, isLink: true, isDir: t.isDirectory(), ...(target ? { linkTarget: target } : {}) } }
      catch { return { ...info, isLink: true, isDir: false, linkBroken: true, ...(target ? { linkTarget: target } : {}) } }
    } catch { return base }   // 读不到属性（被占用 / 无权限）：只给名字
  })
}

type Sftp = {
  readdir(p: string, cb: (err: Error | undefined, list: Parameters<typeof sftpDirEntry>[1][]) => void): void
  stat(p: string, cb: (err: Error | undefined, st: { isDirectory(): boolean; size: number }) => void): void
  readlink(p: string, cb: (err: Error | undefined, target: string) => void): void
  realpath(p: string, cb: (err: Error | undefined, abs: string) => void): void
}
const cb = <T>(f: (done: (err: Error | undefined, v: T) => void) => void) => new Promise<T>((res, rej) => f((e, v) => (e ? rej(e) : res(v))))

export async function listRemote(sftp: Sftp, dir: string): Promise<DirEntry[]> {
  const list = await cb<Parameters<typeof sftpDirEntry>[1][]>((d) => sftp.readdir(dir, d))
  const ents = list.map((it) => ({ e: sftpDirEntry(dir, it), link: (it.attrs.mode & S_IFMT) === S_IFLNK }))
  // readdir 的属性是链接本身的：再 stat 一次看指向（目录才能展开）、readlink 拿指向的路径
  return pool(ents, 16, async ({ e, link }) => {
    if (!link) return e
    const target = await cb<string>((d) => sftp.readlink(e.path, d)).catch(() => undefined)
    try { const t = await cb<{ isDirectory(): boolean }>((d) => sftp.stat(e.path, d)); return { ...e, isLink: true, isDir: t.isDirectory(), ...(target ? { linkTarget: target } : {}) } }
    catch { return { ...e, isLink: true, isDir: false, linkBroken: true, ...(target ? { linkTarget: target } : {}) } }
  })
}

// windows：Windows 自带 OpenSSH 的 SFTP（主目录形如 /C:/Users/x）——没有 sh，界面据此隐藏只能在 Linux 上用的功能
export interface FsPlaces { home?: string; items: { label: string; path: string }[]; windows?: boolean }
export function localPlaces(): FsPlaces {
  const items = [{ label: tr('主目录'), path: homedir() }]
  if (WIN) for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const p = `${c}:\\`; if (existsSync(p)) items.push({ label: tr('{d}: 盘', { d: c }), path: p }) }
  else items.push({ label: tr('根目录'), path: '/' })
  items.push({ label: tr('临时目录'), path: tmpdir() })
  return { home: homedir(), items }
}
export async function remotePlaces(sftp: Sftp): Promise<FsPlaces> {
  const home = await cb<string>((d) => sftp.realpath('.', d)).catch(() => undefined)
  if (home && /^\/[A-Za-z]:(\/|$)/.test(home)) return { home, windows: true, items: [{ label: tr('主目录'), path: home }, { label: tr('所有盘符'), path: '/' }] }
  return { ...(home ? { home } : {}), items: [...(home ? [{ label: tr('主目录'), path: home }] : []), { label: tr('根目录'), path: '/' }, { label: tr('临时目录'), path: '/tmp' }] }
}
