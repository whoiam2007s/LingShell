import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TransferProgressEvent } from '@lingshell/shared'
import { localTreeOps, walkTree, planDelete, deleteTree, createEntry, renameEntry, downloadPlan, type WalkEntry } from './fileOps.js'
import { TransferService } from './transfer.js'
import { registerExplorer } from './explorerIpc.js'

// 临时目录里建：a/x.txt a/b/y.txt a/b/c/ z.txt
function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'lingshell-tree-'))
  mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true })
  writeFileSync(join(d, 'a', 'x.txt'), 'xx')
  writeFileSync(join(d, 'a', 'b', 'y.txt'), 'yyy')
  writeFileSync(join(d, 'z.txt'), 'z')
  return d
}
const ops = localTreeOps()

describe('新建 / 重命名', () => {
  it('新建文件与文件夹；同名已存在报错；非法名拒绝', async () => {
    const d = tree()
    expect(await createEntry(ops, d, 'new.conf', 'file')).toBe(join(d, 'new.conf'))
    expect(readFileSync(join(d, 'new.conf'), 'utf8')).toBe('')
    await createEntry(ops, d, 'sub', 'dir')
    expect(readdirSync(join(d, 'sub'))).toEqual([])
    await expect(createEntry(ops, d, 'z.txt', 'file')).rejects.toThrow(/已存在/)
    await expect(createEntry(ops, d, 'a', 'dir')).rejects.toThrow(/已存在/)
    await expect(createEntry(ops, d, '../evil', 'file')).rejects.toThrow(/不能包含/)
    await expect(createEntry(ops, d, '..', 'dir')).rejects.toThrow()
  })
  it('重命名；目标已存在拒绝且原文件不动', async () => {
    const d = tree()
    expect(await renameEntry(ops, join(d, 'z.txt'), 'w.txt')).toBe(join(d, 'w.txt'))
    expect(readFileSync(join(d, 'w.txt'), 'utf8')).toBe('z')
    await expect(renameEntry(ops, join(d, 'w.txt'), 'a')).rejects.toThrow(/已存在/)
    expect(existsSync(join(d, 'w.txt'))).toBe(true)
    await expect(renameEntry(ops, join(d, 'nope'), 'q')).rejects.toThrow(/不存在/)
  })
  it('远程（posix 规则）允许 Windows 非法字符；本地 Windows 规则拒绝', async () => {
    const d = tree()
    await expect(createEntry({ ...ops, win: true }, d, 'a:b', 'file')).rejects.toThrow(/不能包含/)
    if (process.platform !== 'win32') await createEntry({ ...ops, win: false }, d, 'a:b', 'file')
  })
})

describe('递归计数 / 删除', () => {
  it('计数含目录本身；先序遍历目录在内容前', async () => {
    const d = tree()
    expect(await planDelete(ops, [join(d, 'a'), join(d, 'z.txt')])).toEqual({ files: 3, dirs: 3, over: false })
    const w = await walkTree(ops, join(d, 'a'))
    expect(w.entries[0].rel).toEqual([])
    const iB = w.entries.findIndex((e) => e.rel.join('/') === 'b'), iY = w.entries.findIndex((e) => e.rel.join('/') === 'b/y.txt')
    expect(iB).toBeLessThan(iY)
  })
  it('超上限标 over；远程删除超上限一个都不删', async () => {
    const d = tree()
    expect((await planDelete(ops, [join(d, 'a')], 3)).over).toBe(true)
    await expect(deleteTree(ops, join(d, 'a'), 3)).rejects.toThrow(/超过 3 项/)
    expect(existsSync(join(d, 'a', 'b', 'y.txt'))).toBe(true)
  })
  it('递归删除非空目录，返回计数', async () => {
    const d = tree()
    expect(await deleteTree(ops, join(d, 'a'))).toEqual({ files: 2, dirs: 3, over: false })
    expect(readdirSync(d)).toEqual(['z.txt'])
  })
  it('根与根下一级目录拒绝', async () => {
    await expect(planDelete(ops, [process.platform === 'win32' ? 'C:\\Windows' : '/etc'])).rejects.toThrow(/不允许/)
  })
})

describe('下载路径映射', () => {
  const e = (path: string, rel: string[], isDir = false, isLink = false): WalkEntry => ({ path, rel, isDir, isLink, size: 1 })
  it('保留结构；顶层同名自动改名；多个同名顶层依次改名；跳过符号链接', () => {
    const plan = downloadPlan([
      { path: '/srv/app', entries: [e('/srv/app', [], true), e('/srv/app/conf', ['conf'], true), e('/srv/app/conf/a.yml', ['conf', 'a.yml']), e('/srv/app/ln', ['ln'], false, true)] },
      { path: '/var/log/a.log', entries: [e('/var/log/a.log', [])] },
      { path: '/tmp/a.log', entries: [e('/tmp/a.log', [])] },
    ], '/dl', ['app', 'A.log'], false)
    expect(plan.map((p) => [p.remote, p.local.replace(/\\/g, '/')])).toEqual([
      ['/srv/app', '/dl/app (1)'],
      ['/srv/app/conf', '/dl/app (1)/conf'],
      ['/srv/app/conf/a.yml', '/dl/app (1)/conf/a.yml'],
      ['/var/log/a.log', '/dl/a.log'],          // posix 区分大小写，A.log 不冲突
      ['/tmp/a.log', '/dl/a (1).log'],
    ])
  })
  it('Windows：同名比较忽略大小写，非法字符换成 _', () => {
    const plan = downloadPlan([{ path: '/x/A.log', entries: [e('/x/A.log', [])] }, { path: '/x/d', entries: [e('/x/d', [], true), e('/x/d/a:b?', ['a:b?'])] }], 'C:\\dl', ['a.log'], true)
    expect(plan.map((p) => p.local.replace(/\\/g, '/'))).toEqual(['C:/dl/A (1).log', 'C:/dl/d', 'C:/dl/d/a_b_'])
  })
})

describe('downloadTree（本地 fs 冒充远程）', () => {
  it('整棵树下载到目标目录，已有同名改名，进度带文件计数', async () => {
    const src = tree(), dst = mkdtempSync(join(tmpdir(), 'lingshell-dl-'))
    mkdirSync(join(dst, 'a'))
    const evs: TransferProgressEvent[] = []
    await new TransferService((ev) => evs.push(ev)).downloadTree(ops, [join(src, 'a'), join(src, 'z.txt')], dst)
    expect(readdirSync(dst).sort()).toEqual(['a', 'a (1)', 'z.txt'])
    expect(readFileSync(join(dst, 'a (1)', 'b', 'y.txt'), 'utf8')).toBe('yyy')
    expect(existsSync(join(dst, 'a (1)', 'b', 'c'))).toBe(true)   // 空目录也建
    const last = evs.at(-1)!
    expect(last.stage).toBe('done')
    expect([last.fileDone, last.fileTotal]).toEqual([3, 3])
    expect(evs[0].cancellable).toBe(true)
  })
  it('取消：报「已取消」，不留半截文件', async () => {
    const src = tree(), dst = mkdtempSync(join(tmpdir(), 'lingshell-dl-'))
    const evs: TransferProgressEvent[] = []
    const svc: TransferService = new TransferService((ev) => { evs.push(ev); if (ev.stage === 'transfer') svc.cancel(ev.taskId) })
    await expect(svc.downloadTree(ops, [join(src, 'a')], dst)).rejects.toThrow(/已取消/)
    expect(evs.at(-1)!.stage).toBe('error')
    const files = readdirSync(dst, { recursive: true }).map(String).filter((f) => f.endsWith('.txt'))
    expect(files).toEqual([])
  })
})

describe('registerExplorer 执行记录', () => {
  function setup(trash: string[] = [], out = '') {
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const audits: { terminalId: string; decision: string; command: string }[] = []
    const execs: string[] = [], chmods: [string, number][] = []
    registerExplorer({
      handle: (ch, fn) => h.set(ch, fn),
      ops: async () => ({ ...ops, chmod: async (p, m) => { chmods.push([p, m]) } }),
      exec: async (_tid, cmd) => { execs.push(cmd); return { code: 0, output: out } },
      trash: async (p) => { trash.push(p) },
      audit: (terminalId, e) => audits.push({ terminalId, ...e }),
      transfer: { downloadTree: async () => {}, cancel: () => {} },
    })
    const call = (ch: string, ...a: unknown[]) => Promise.resolve(h.get(ch)!(null, ...a))
    return { call, audits, trash, execs, chmods }
  }
  it('改权限 / 压缩 / 解压记执行记录；搜索不记；本地范围拒绝', async () => {
    const d = tree()
    const { call, audits, execs, chmods } = setup([], 'd /srv/app\n/srv/app/a.log\n')
    const t = { terminalId: 't1' }
    await call('fs:chmod', t, [join(d, 'z.txt'), join(d, 'a')], 0o640, false)
    expect(chmods).toEqual([[join(d, 'z.txt'), 0o640], [join(d, 'a'), 0o640]])
    await call('fs:chmod', t, ['/srv/app'], 0o755, true)
    expect(execs.at(-1)).toContain('chmod -R 755')
    await expect(call('fs:chmod', t, ['/etc'], 0o755, true)).rejects.toThrow(/不允许递归/)
    await expect(call('fs:chmod', t, ['/srv/app'], 0o17777, false)).rejects.toThrow(/非法/)
    expect(await call('fs:pack', t, [join(d, 'z.txt')])).toBe(join(d, 'z.txt.tar.gz'))
    expect(await call('fs:unpack', t, '/srv/a.tgz')).toBe('/srv')
    expect(await call('fs:search', t, '/srv', 'app')).toMatchObject({ hits: [{ path: '/srv/app', isDir: true }, { path: '/srv/app/a.log', isDir: false }], truncated: false })
    expect(audits.map((a) => a.decision)).toEqual(['file_chmod', 'file_chmod', 'file_chmod', 'file_archive', 'file_extract'])
    await expect(call('fs:pack', t, [join(d, 'z.txt'), join(d, 'a', 'x.txt')])).rejects.toThrow(/同一目录/)
    await expect(call('fs:unpack', t, '/srv/a.rar')).rejects.toThrow(/只支持/)
    // 本地也能按名称搜（node 遍历），且不记执行记录
    expect((await call('fs:search', 'local', d, 'z.txt') as { hits: { name: string }[] }).hits.map((h) => h.name)).toContain('z.txt')
    expect(audits).toHaveLength(5)
    await expect(call('fs:chmod', 'local', ['/a'], 0o644, false)).rejects.toThrow(/远程/)
  })
  it('服务器缺 unzip：提示安装，不记执行记录', async () => {
    const { call, audits } = setup([], '__LINGSHELL_NO_TOOL__:unzip\n')
    await expect(call('fs:unpack', { terminalId: 't1' }, '/srv/a.zip')).rejects.toThrow(/没有 unzip.*安装/)
    expect(audits).toEqual([])
  })
  it('远程删除/重命名记 file_delete / file_rename；本地删除进回收站且不记', async () => {
    const d = tree()
    const { call, audits, trash } = setup()
    await call('fs:rename', { terminalId: 't1' }, join(d, 'z.txt'), 'w.txt')
    await call('fs:remove', { terminalId: 't1' }, join(d, 'a'))
    expect(audits.map((a) => [a.terminalId, a.decision])).toEqual([['t1', 'file_rename'], ['t1', 'file_delete']])
    expect(audits[1].command).toContain('2 个文件、3 个文件夹')
    expect(existsSync(join(d, 'a'))).toBe(false)
    await call('fs:remove', 'local', join(d, 'w.txt'))
    await call('fs:rename', 'local', join(d, 'w.txt'), 'v.txt')
    expect(trash).toEqual([join(d, 'w.txt')])
    expect(audits).toHaveLength(2)
  })
  it('参数校验', async () => {
    const { call } = setup()
    await expect(call('fs:remove', { x: 1 }, '/a')).rejects.toThrow(/范围/)
    await expect(call('fs:deletePlan', 'local', [])).rejects.toThrow(/路径列表/)
    await expect(call('transfer:downloadMany', 'local', ['/a'], '/b')).rejects.toThrow(/远程/)
  })
})
