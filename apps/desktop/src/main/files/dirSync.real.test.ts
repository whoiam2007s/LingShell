import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { SFTPWrapper } from 'ssh2'
import { connectSsh, setHostKeyPolicy } from '@lingshell/terminal-core'
import { defaultSelection, NO_TOOL, type SyncRow } from '@lingshell/shared'
import { DirSyncService, auditText, type DirSyncDeps } from './dirSync.js'
import type { RunCmd } from './fileOps.js'

// 本机回环假 sshd + SFTP 子系统（远程路径 /x 映射到临时目录，支持读写 / 改时间），验证目录比较与同步的真实 SFTP 报文往返。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const { OPEN_MODE, STATUS_CODE } = utils.sftp

function fakeSftpd(root: string) {
  const local = (p: string) => join(root, p)
  const attrs = (st: fs.Stats) => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) })
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => accept().on('sftp', (ok) => {
      const sftp = ok()
      const handles = new Map<number, { fd?: number; dir?: string[]; path: string }>()
      let next = 0
      const h = (reqid: number, v: { fd?: number; dir?: string[]; path: string }) => { const b = Buffer.alloc(4); b.writeUInt32BE(next); handles.set(next++, v); sftp.handle(reqid, b) }
      const get = (b: Buffer) => handles.get(b.readUInt32BE(0))!
      const run = (reqid: number, f: () => void) => {
        try { f(); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { sftp.status(reqid, (e as NodeJS.ErrnoException).code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE) }
      }
      const stat = (reqid: number, p: string) => { try { sftp.attrs(reqid, attrs(fs.lstatSync(local(p)))) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) } }
      sftp.on('OPEN', (reqid, p, flags) => {
        const fl = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.EXCL ? 'wx' : 'w') : 'r'
        try { h(reqid, { fd: fs.openSync(local(p), fl), path: p }) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) }
      })
      sftp.on('READ', (reqid, hd, off, len) => {
        const buf = Buffer.alloc(len), n = fs.readSync(get(hd).fd!, buf, 0, len, off)
        if (n) sftp.data(reqid, buf.subarray(0, n)); else sftp.status(reqid, STATUS_CODE.EOF)
      })
      sftp.on('WRITE', (reqid, hd, off, data) => run(reqid, () => { fs.writeSync(get(hd).fd!, data, 0, data.length, off) }))
      sftp.on('FSTAT', (reqid, hd) => sftp.attrs(reqid, attrs(fs.fstatSync(get(hd).fd!))))
      sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
      sftp.on('CLOSE', (reqid, hd) => { const x = get(hd); if (x.fd !== undefined) fs.closeSync(x.fd); handles.delete(hd.readUInt32BE(0)); sftp.status(reqid, STATUS_CODE.OK) })
      sftp.on('OPENDIR', (reqid, p) => { try { h(reqid, { dir: fs.readdirSync(local(p)), path: p }) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) } })
      sftp.on('READDIR', (reqid, hd) => {
        const x = get(hd)
        if (!x.dir!.length) return sftp.status(reqid, STATUS_CODE.EOF)
        sftp.name(reqid, x.dir!.splice(0).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(local(`${x.path}/${n}`))) })))
      })
      sftp.on('LSTAT', stat)
      sftp.on('STAT', stat)
      sftp.on('MKDIR', (reqid, p) => run(reqid, () => fs.mkdirSync(local(p))))
      sftp.on('RMDIR', (reqid, p) => run(reqid, () => fs.rmdirSync(local(p))))
      sftp.on('REMOVE', (reqid, p) => run(reqid, () => fs.unlinkSync(local(p))))
      sftp.on('RENAME', (reqid, a, b) => run(reqid, () => fs.renameSync(local(a), local(b))))
      // utimes = SETSTAT 带 atime/mtime
      sftp.on('SETSTAT', (reqid, p, a) => run(reqid, () => { if (a.mtime !== undefined) fs.utimesSync(local(p), a.atime ?? a.mtime, a.mtime) }))
    }))
  })
  return new Promise<{ port: number; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
}

const T0 = 1_700_000_000
const put = (base: string, rel: string, text: string, mtime = T0) => {
  const p = join(base, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
  fs.utimesSync(p, mtime, mtime)
}
const read = (base: string, rel: string) => fs.readFileSync(join(base, ...rel.split('/')), 'utf8')
const statusOf = (rows: SyncRow[]) => Object.fromEntries(rows.map((r) => [r.rel, r.status]))

// 测试替身：sha256sum 在假远程根上用 node 算（从命令里解出 ./相对路径）
const fakeRun = (root: string, mode: 'ok' | 'missing' = 'ok'): RunCmd => async (cmd) => {
  if (mode === 'missing') return { code: 127, output: `${NO_TOOL}sha256sum\n` }
  const script = cmd.slice(7, -1).replace(/'\\''/g, "'")
  const dir = /^cd '([^']+)'/.exec(script)![1]
  const rels = [...script.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1])
  const output = rels.map((r) => `${createHash('sha256').update(fs.readFileSync(join(root, dir, r))).digest('hex')}  ./${r}`).join('\n')
  return { code: 0, output }
}

let srv: { port: number; close(): void }, conn: Awaited<ReturnType<typeof connectSsh>>, sftp: SFTPWrapper
let remoteBase: string
beforeAll(async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  remoteBase = fs.mkdtempSync(join(tmpdir(), 'lingshell-syncd-'))
  srv = await fakeSftpd(remoteBase)
  conn = await connectSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  sftp = await new Promise<SFTPWrapper>((res, rej) => conn.client.sftp((e, s) => (e ? rej(e) : res(s))))
}, 20000)
afterAll(() => { conn?.close(); srv?.close() })

function setup(name: string) {
  const local = fs.mkdtempSync(join(tmpdir(), 'lingshell-synclocal-'))
  const remote = join(remoteBase, 'srv', name)   // 放在 /srv 下：根下一级目录不允许镜像删除
  fs.mkdirSync(remote, { recursive: true })
  const audits: { command: string; decision: string; filePath: string }[] = []
  const trashed: string[] = []
  const deps = (run: RunCmd = fakeRun(remoteBase)): DirSyncDeps => ({
    sftp: async () => sftp, run: () => run,
    trash: async (p) => { trashed.push(p); fs.rmSync(p) },
    audit: (_t, e) => audits.push(e),
  })
  return { local, remote, remoteRoot: `/srv/${name}`, audits, trashed, deps }
}

it('比较 → 上传 + 镜像删除 → 再比较两边一致；排除规则不碰；记一条 dir_sync', async () => {
  const { local, remote, remoteRoot, audits, deps } = setup('up')
  put(local, 'same.txt', 'same')
  put(remote, 'same.txt', 'same')
  put(local, 'mod.txt', 'new content', T0 + 100)
  put(remote, 'mod.txt', 'old', T0)
  put(local, 'new/sub/n.txt', 'hello')
  put(local, '.git/HEAD', 'x')
  put(remote, '.git/keep', 'remote git')
  put(local, 'node_modules/m.js', 'm')
  put(remote, 'gone.txt', 'bye')
  put(remote, 'rdir/r.txt', 'r')

  const svc = new DirSyncService(deps())
  const req = { terminalId: 't1', localRoot: local, remoteRoot, excludes: ['.git', 'node_modules'], byContent: false }
  const c = await svc.compare('job', req)
  expect(c.remoteRoot).toBe(remoteRoot)
  expect(c.excluded).toBe(3)
  expect(statusOf(c.rows)).toEqual({
    'gone.txt': 'remoteOnly', 'mod.txt': 'diff', new: 'localOnly', 'new/sub': 'localOnly', 'new/sub/n.txt': 'localOnly',
    rdir: 'remoteOnly', 'rdir/r.txt': 'remoteOnly', 'same.txt': 'same',
  })
  expect(c.rows.find((r) => r.rel === 'mod.txt')!.newer).toBe('local')

  const r = await svc.run('job', defaultSelection(c.rows), 'upload', true)
  expect(r).toEqual({ uploaded: 2, downloaded: 0, mkdirs: 2, deletedRemote: 3, deletedLocal: 0, failed: [], cancelled: false })
  expect(read(remote, 'mod.txt')).toBe('new content')
  expect(read(remote, 'new/sub/n.txt')).toBe('hello')
  expect(Math.floor(fs.statSync(join(remote, 'mod.txt')).mtimeMs / 1000)).toBe(T0 + 100)   // 修改时间跟源文件
  expect(fs.existsSync(join(remote, 'gone.txt'))).toBe(false)
  expect(fs.existsSync(join(remote, 'rdir'))).toBe(false)
  expect(read(remote, '.git/keep')).toBe('remote git')            // 排除的不动
  expect(fs.readdirSync(remote).filter((n) => n.includes('lingshell-sync-tmp'))).toEqual([])
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ decision: 'dir_sync', filePath: remoteRoot })
  expect(audits[0].command).toMatch(/上传 2 个文件.*新建 2 个目录.*删除远程 3 项/)

  // 执行后旧结果作废
  await expect(svc.run('job', [], 'upload', false)).rejects.toThrow(/重新比较/)
  const again = await svc.compare('job', req)
  expect(again.rows.every((x) => x.status === 'same')).toBe(true)
}, 20000)

it('下载：远程较新的覆盖本地并保留修改时间；镜像删除本地多余的进回收站；只下载不记执行记录', async () => {
  const { local, remote, remoteRoot, audits, trashed, deps } = setup('down')
  put(local, 'conf.ini', 'a=1', T0)
  put(remote, 'conf.ini', 'a=2', T0 + 50)
  put(remote, 'd/x.bin', 'xx')
  put(local, 'extra.txt', 'e')
  const svc = new DirSyncService(deps())
  const c = await svc.compare('j2', { terminalId: 't1', localRoot: local, remoteRoot, excludes: [], byContent: false })
  const r = await svc.run('j2', defaultSelection(c.rows), 'download', true)
  expect(r).toMatchObject({ downloaded: 2, mkdirs: 1, deletedLocal: 1, failed: [] })
  expect(read(local, 'conf.ini')).toBe('a=2')
  expect(Math.floor(fs.statSync(join(local, 'conf.ini')).mtimeMs / 1000)).toBe(T0 + 50)
  expect(read(local, 'd/x.bin')).toBe('xx')
  expect(trashed).toEqual([join(local, 'extra.txt')])
  expect(audits).toEqual([])
}, 20000)

it('按内容比较：大小和时间都相同但内容不同 → 不同；服务器没有 sha256sum 时退回并提示', async () => {
  const { local, remote, remoteRoot, deps } = setup('hash')
  put(local, 'a.txt', 'AAAA')
  put(remote, 'a.txt', 'BBBB')
  put(local, 'b.txt', 'same', T0)
  put(remote, 'b.txt', 'same', T0 + 99)
  const req = { terminalId: 't1', localRoot: local, remoteRoot, excludes: [], byContent: true }
  const c = await new DirSyncService(deps()).compare('h', req)
  expect(c.rows.find((r) => r.rel === 'a.txt')).toMatchObject({ status: 'diff', byHash: true })
  expect(c.rows.find((r) => r.rel === 'b.txt')).toMatchObject({ status: 'same', byHash: true })
  expect(c.hashNote).toBeUndefined()

  const c2 = await new DirSyncService(deps(fakeRun(remoteBase, 'missing'))).compare('h', req)
  expect(c2.hashNote).toMatch(/没有 sha256sum/)
  expect(c2.rows.find((r) => r.rel === 'a.txt')!.status).toBe('same')    // 退回按大小 + 时间
  expect(c2.rows.find((r) => r.rel === 'b.txt')!.status).toBe('diff')
}, 20000)

it('双向：各取较新；取消后不再执行；目录不存在 / 超上限报错', async () => {
  const { local, remote, remoteRoot, deps } = setup('both')
  put(local, 'l.txt', 'local newer', T0 + 10)
  put(remote, 'l.txt', 'remote', T0)
  put(local, 'r.txt', 'local', T0)
  put(remote, 'r.txt', 'remote newer', T0 + 10)
  const svc = new DirSyncService(deps())
  const req = { terminalId: 't1', localRoot: local, remoteRoot, excludes: [], byContent: false }
  let c = await svc.compare('b', req)
  // 取消：run 拿到 SFTP 之前就中止，一项都不做
  const p = svc.run('b', defaultSelection(c.rows), 'both', false)
  svc.cancel('b')
  expect(await p).toMatchObject({ uploaded: 0, downloaded: 0, cancelled: true })
  c = await svc.compare('b', req)
  expect(await svc.run('b', defaultSelection(c.rows), 'both', false)).toMatchObject({ uploaded: 1, downloaded: 1, failed: [] })
  expect(read(remote, 'l.txt')).toBe('local newer')
  expect(read(local, 'r.txt')).toBe('remote newer')
  expect(svc.progress('b')).toMatchObject({ phase: 'done', doneItems: 2, totalItems: 2 })

  await expect(svc.compare('x', { ...req, remoteRoot: '/nope' })).rejects.toThrow(/远程目录不存在/)
  await expect(svc.compare('x', { ...req, localRoot: 'rel/path' })).rejects.toThrow(/绝对路径/)
  for (let i = 0; i < 5; i++) put(local, `many/f${i}`, 'x')
  const { walkSide, localLister } = await import('./dirSync.js')
  await expect(walkSide(localLister, local, (d, r) => join(d, r), () => false, { cap: 3 })).rejects.toThrow(/超过 3 项/)
}, 20000)

it('执行记录文案', () => {
  expect(auditText('C:\\w', '/srv', 'upload', { uploaded: 1, downloaded: 0, mkdirs: 0, deletedRemote: 2, deletedLocal: 0, failed: [{ rel: 'a', error: 'x' }], cancelled: true }))
    .toBe('目录同步 本地 → 远程（上传）：本地 C:\\w ⇄ 远程 /srv；上传 1 个文件、删除远程 2 项；失败 1 项，已取消')
})
