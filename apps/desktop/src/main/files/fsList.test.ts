import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLocal, listRemote, localPlaces, remotePlaces } from './fsList.js'

describe('listLocal：大小 / 修改时间 / 链接', () => {
  it('普通文件、目录、指向目录的链接、坏链接、中文空格文件名', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-ls-'))
    writeFileSync(join(d, '中文 文件.txt'), 'hello')
    utimesSync(join(d, '中文 文件.txt'), 1_700_000_000, 1_700_000_000)
    mkdirSync(join(d, 'sub'))
    // Windows 上普通用户建不了文件符号链接，目录用 junction（不需要管理员）
    symlinkSync(join(d, 'sub'), join(d, 'link-to-sub'), 'junction')
    let fileLink = true
    try { symlinkSync(join(d, 'gone.txt'), join(d, 'broken'), 'file') } catch { fileLink = false }
    const ls = await listLocal(d)
    const by = Object.fromEntries(ls.map((e) => [e.name, e]))
    expect(by['中文 文件.txt']).toMatchObject({ isDir: false, size: 5, mtime: 1_700_000_000 })
    expect(by.sub).toMatchObject({ isDir: true })
    expect(by['link-to-sub']).toMatchObject({ isLink: true, isDir: true })
    expect(by['link-to-sub'].linkTarget).toBeTruthy()
    if (fileLink) expect(by.broken).toMatchObject({ isLink: true, isDir: false, linkBroken: true })
    if (process.platform === 'win32') expect(by.sub.mode).toBeUndefined()   // Windows 不显示权限位
  })
  it('目录不存在 / 不是目录：报错（界面显示原因而不是「空」）', async () => {
    await expect(listLocal(join(tmpdir(), 'lingshell-nope-' + Date.now()))).rejects.toThrow(/ENOENT/)
  })
  it('常用位置：有主目录和临时目录', () => {
    const p = localPlaces()
    expect(p.items.map((x) => x.label)).toEqual(expect.arrayContaining(['主目录', '临时目录']))
    if (process.platform === 'win32') expect(p.items.some((x) => /^[A-Z]: 盘$/.test(x.label))).toBe(true)
  })
})

describe('listRemote：链接解析', () => {
  const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000
  const item = (filename: string, mode: number) => ({ filename, longname: `-rw-r--r-- 1 www www 10 Jan 1 00:00 ${filename}`, attrs: { isDirectory: () => (mode & 0o170000) === S_IFDIR, mode, size: 10, mtime: 1, uid: 0, gid: 0 } })
  const sftp = {
    readdir: (_p: string, cb: (e: Error | undefined, l: ReturnType<typeof item>[]) => void) => cb(undefined, [item('etc', S_IFDIR | 0o755), item('a.txt', S_IFREG | 0o644), item('current', S_IFLNK | 0o777), item('dead', S_IFLNK | 0o777)]),
    stat: (p: string, cb: (e: Error | undefined, s: { isDirectory(): boolean; size: number }) => void) => (p.endsWith('dead') ? cb(new Error('No such file'), undefined as never) : cb(undefined, { isDirectory: () => true, size: 4096 })),
    readlink: (p: string, cb: (e: Error | undefined, t: string) => void) => cb(undefined, p.endsWith('dead') ? '/nowhere' : '/srv/releases/v2'),
    realpath: (_p: string, cb: (e: Error | undefined, t: string) => void) => cb(undefined, '/home/www'),
  }
  it('指向目录的链接可展开；坏链接标出来；普通项不受影响', async () => {
    const ls = await listRemote(sftp, '/srv')
    const by = Object.fromEntries(ls.map((e) => [e.name, e]))
    expect(by.etc).toMatchObject({ isDir: true, path: '/srv/etc', owner: 'www' })
    expect(by.etc.isLink).toBeUndefined()
    expect(by['a.txt']).toMatchObject({ isDir: false, mode: 0o644 })
    expect(by.current).toMatchObject({ isLink: true, isDir: true, linkTarget: '/srv/releases/v2' })
    expect(by.dead).toMatchObject({ isLink: true, isDir: false, linkBroken: true, linkTarget: '/nowhere' })
  })
  it('常用位置：主目录取 realpath(.)', async () => {
    expect(await remotePlaces(sftp)).toEqual({ home: '/home/www', items: [{ label: '主目录', path: '/home/www' }, { label: '根目录', path: '/' }, { label: '临时目录', path: '/tmp' }] })
  })
})
