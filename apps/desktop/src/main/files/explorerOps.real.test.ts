import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { localTreeOps, type TreeOps, type RunCmd } from './fileOps.js'
import { paste, pastePlan, localStats, remoteStats, localChecksum, remoteChecksum, localSearchNames, localSearchContent, remoteSearchContent, remoteChown, treeStats, treeChecksum, treeSearchNames } from './explorerOps.js'

const mk = (root: string, files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c) } }
const ls = (d: string) => readdirSync(d).sort()

describe('本地粘贴', () => {
  let d: string
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'lingshell-paste-'))
    mk(d, { 'a/x.txt': 'ax', 'a/sub/y.txt': 'ay', 'b/x.txt': 'bx', 'b/keep.txt': 'k', 'c.txt': 'c' })
  })
  const ops = localTreeOps()
  it('计划：冲突、同目录、贴进自己里面', async () => {
    const p = await pastePlan(ops, [join(d, 'a', 'x.txt'), join(d, 'c.txt')], join(d, 'b'))
    expect(p.items.map((i) => [i.name, i.conflict, i.same])).toEqual([['x.txt', true, false], ['c.txt', false, false]])
    await expect(pastePlan(ops, [join(d, 'a')], join(d, 'a', 'sub'))).rejects.toThrow('自己里面')
    await expect(pastePlan(ops, [join(d, 'a')], join(d, 'a'))).rejects.toThrow('自己里面')
    expect((await pastePlan(ops, [join(d, 'c.txt')], d)).items[0].same).toBe(true)
  })
  it('复制：跳过 / 覆盖 / 保留两者', async () => {
    const r1 = await paste({ ops }, [join(d, 'a', 'x.txt')], join(d, 'b'), 'copy', 'skip')
    expect(r1.skipped).toHaveLength(1); expect(readFileSync(join(d, 'b', 'x.txt'), 'utf8')).toBe('bx')
    await paste({ ops }, [join(d, 'a', 'x.txt')], join(d, 'b'), 'copy', 'rename')
    expect(ls(join(d, 'b'))).toEqual(['keep.txt', 'x (1).txt', 'x.txt'])
    await paste({ ops }, [join(d, 'a', 'x.txt')], join(d, 'b'), 'copy', 'overwrite')
    expect(readFileSync(join(d, 'b', 'x.txt'), 'utf8')).toBe('ax')
    expect(existsSync(join(d, 'a', 'x.txt'))).toBe(true)
  })
  it('同目录复制 = 复制一份（自动改名）；同目录剪切什么也不做', async () => {
    const r = await paste({ ops }, [join(d, 'c.txt')], d, 'copy', 'skip')
    expect(r.done[0].to).toBe(join(d, 'c (1).txt'))
    const r2 = await paste({ ops }, [join(d, 'c.txt')], d, 'move', 'overwrite')
    expect(r2.skipped).toEqual([join(d, 'c.txt')]); expect(existsSync(join(d, 'c.txt'))).toBe(true)
  })
  it('移动文件夹：到新位置 / 覆盖 = 合并到同名文件夹（同名文件被替换、其余保留）', async () => {
    mk(d, { 'dst/a/old.txt': 'o', 'dst/a/x.txt': 'old' })
    await paste({ ops }, [join(d, 'a')], join(d, 'dst'), 'move', 'overwrite')
    expect(existsSync(join(d, 'a'))).toBe(false)
    expect(ls(join(d, 'dst', 'a'))).toEqual(['old.txt', 'sub', 'x.txt'])
    expect(readFileSync(join(d, 'dst', 'a', 'x.txt'), 'utf8')).toBe('ax')
    await paste({ ops }, [join(d, 'c.txt')], join(d, 'dst'), 'move', 'skip')
    expect(existsSync(join(d, 'dst', 'c.txt'))).toBe(true); expect(existsSync(join(d, 'c.txt'))).toBe(false)
  })
  it('文件覆盖文件夹（类型不同）拒绝', async () => {
    mk(d, { 'z/x.txt/inner': '1' })
    await expect(paste({ ops }, [join(d, 'a', 'x.txt')], join(d, 'z'), 'copy', 'overwrite')).rejects.toThrow('不能用文件覆盖')
  })
  it('复制保留修改时间', async () => {
    utimesSync(join(d, 'c.txt'), 1_600_000_000, 1_600_000_000)
    await paste({ ops }, [join(d, 'c.txt')], join(d, 'b'), 'copy', 'skip')
    expect(Math.floor(statSync(join(d, 'b', 'c.txt')).mtimeMs / 1000)).toBe(1_600_000_000)
  })
  it('属性统计 / 校验和 / 搜索', async () => {
    expect(await localStats([join(d, 'a'), join(d, 'c.txt')])).toEqual({ dirs: 2, files: 3, bytes: 5 })
    expect(await localChecksum(join(d, 'c.txt'), 'sha256')).toBe('2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6')
    expect(await localChecksum(join(d, 'c.txt'), 'md5')).toBe('4a8a08f09d37b73795649038408b5f33')
    await expect(localChecksum(join(d, 'a'), 'md5')).rejects.toThrow('文件夹')
    expect((await localSearchNames(d, 'X.')).hits.map((h) => h.name).sort()).toEqual(['x.txt', 'x.txt'])
    expect((await localSearchNames(d, '*.TXT')).hits.length).toBe(5)
    mk(d, { 'deep/n.log': 'line1\nERROR here\nERROR again', 'bin.dat': 'ERR\0OR', 'node_modules/m.js': 'ERROR' })
    const c = await localSearchContent(d, 'error')
    expect(c.hits.map((h) => [h.name, h.line, h.text])).toEqual([['n.log', 2, 'ERROR here']])
  })
})

describe('只有 SFTP 的服务器（Windows OpenSSH）：经 TreeOps 复制 / 移动 / 统计 / 校验和 / 搜索', () => {
  it('树复制保留修改时间、合并移动、统计、校验和、按名称搜索', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lingshell-tree-'))
    mk(d, { 'a/x.txt': 'ax', 'a/sub/y.txt': 'yy', 'b/a/old.txt': 'o', 'c.txt': 'c' })
    utimesSync(join(d, 'a', 'x.txt'), 1_600_000_000, 1_600_000_000)
    const ops = localTreeOps()
    // localTreeOps 的 readdir 不带大小：当「SFTP」用时补上（SFTP 的 readdir 本来就带）
    const sops = { ...ops, readdir: async (p: string) => Promise.all(readdirSync(p).map(async (name) => ({ name, ...(await ops.lstat(join(p, name)))! }))) }
    const r = await paste({ ops: sops, tree: true }, [join(d, 'a')], join(d, 'b'), 'copy', 'rename')
    expect(r.done[0].to).toBe(join(d, 'b', 'a (1)'))
    expect(readFileSync(join(d, 'b', 'a (1)', 'sub', 'y.txt'), 'utf8')).toBe('yy')
    expect(Math.floor(statSync(join(d, 'b', 'a (1)', 'x.txt')).mtimeMs / 1000)).toBe(1_600_000_000)
    await paste({ ops: sops, tree: true }, [join(d, 'a')], join(d, 'b'), 'move', 'overwrite')
    expect(existsSync(join(d, 'a'))).toBe(false)
    expect(ls(join(d, 'b', 'a'))).toEqual(['old.txt', 'sub', 'x.txt'])
    expect(await treeStats(sops, [join(d, 'b', 'a'), join(d, 'c.txt')])).toEqual({ dirs: 2, files: 4, bytes: 6 })
    expect(await treeChecksum(sops, join(d, 'c.txt'), 'md5')).toBe('4a8a08f09d37b73795649038408b5f33')
    expect((await treeSearchNames(sops, d, '*.TXT')).hits.length).toBe(6)
  })
})

// 「远程」：命令真在 Git Bash 里跑；远程路径用 /d/... 风格，TreeOps 把它映射回本地
const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
const run: RunCmd = (command, ms) => new Promise((res) => {
  const p = spawn(bash, ['-c', command], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  let out = ''
  p.stdout.on('data', (x) => (out += x)); p.stderr.on('data', (x) => (out += x))
  const t = setTimeout(() => { p.kill(); res({ code: null, output: out, stopped: 'timeout' }) }, ms)
  p.on('close', (code) => { clearTimeout(t); res({ code, output: out }) })
})
const toWin = (p: string) => p.replace(/^\/([a-z])(\/|$)/i, (_m, d: string) => `${d.toUpperCase()}:/`)
const toPosix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
const posixOps = (): TreeOps => { const o = localTreeOps(); return { ...o, win: false, lstat: (p) => o.lstat(toWin(p)), readdir: (p) => o.readdir(toWin(p)) } }

describe.runIf(process.platform === 'win32' && existsSync(bash))('远程命令（Git Bash 真跑）', () => {
  let d: string, D: string
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), 'lingshell-rpaste-'))
    D = toPosix(d)
    mk(d, { "it's/x.txt": 'ax', "it's/sub/y.txt": 'ay', 'b/x.txt': 'bx', 'c.txt': 'c', 'logs/app.log': 'ok\nFATAL: disk\n' })
  })
  it('复制 / 移动 / 合并，路径带单引号和空格', async () => {
    const audits: string[] = []
    const dd = { ops: posixOps(), run, audit: (c: string) => audits.push(c) }
    await paste(dd, [`${D}/it's/x.txt`], `${D}/b`, 'copy', 'rename')
    expect(ls(join(d, 'b'))).toEqual(['x (1).txt', 'x.txt'])
    mk(d, { 'b/it\'s/old.txt': 'o' })
    await paste(dd, [`${D}/it's`], `${D}/b`, 'move', 'overwrite')
    expect(existsSync(join(d, "it's"))).toBe(false)
    expect(ls(join(d, 'b', "it's"))).toEqual(['old.txt', 'sub', 'x.txt'])
    expect(audits).toHaveLength(2)
    expect(audits[1]).toContain('合并')
  })
  it('统计 / 校验和 / 内容搜索 / 改属主命令能跑', async () => {
    expect(await remoteStats(run, [`${D}/it's`, `${D}/c.txt`])).toEqual({ dirs: 2, files: 3, bytes: 5 })
    expect(await remoteChecksum(run, `${D}/c.txt`, 'sha256')).toBe('2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6')
    const c = await remoteSearchContent(run, D, 'fatal')
    expect(c.hits.map((h) => [h.name, h.line, h.text])).toEqual([['app.log', 2, 'FATAL: disk']])
    // 回归：不区分大小写 + 字面量（点号不能当正则）。-i 与 -F 同用在本机 GNU grep 3.0 会 abort，结果恒空
    mk(d, { 'logs/meta.log': 'alphaXbeta regex\nalpha.beta literal\n' })
    const lit = await remoteSearchContent(run, D, 'ALPHA.BETA')
    expect(lit.hits.map((h) => [h.name, h.line, h.text])).toEqual([['meta.log', 2, 'alpha.beta literal']])
    await expect(remoteChown(run, ['/etc'], 'root', '', true)).rejects.toThrow('不允许')
  })
})
