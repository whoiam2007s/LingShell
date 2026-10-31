import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { SFTPWrapper } from 'ssh2'
import { connectSsh, setHostKeyPolicy } from '@lingshell/terminal-core'
import { sftpTreeOps, sftpDirEntry, createEntry, renameEntry, planDelete, deleteTree } from './fileOps.js'
import { TransferService } from './transfer.js'

// 本机回环假 sshd + SFTP 子系统（远程路径 /x 映射到临时目录），验证 sftpTreeOps 的真实 SFTP 报文往返。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const { OPEN_MODE, STATUS_CODE } = utils.sftp

function fakeSftpd(root: string) {
  const local = (p: string) => join(root, p)
  const setstats: [string, number | undefined][] = []
  const attrs = (st: fs.Stats) => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: 0, mtime: 0 })
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
        const fl = (flags & OPEN_MODE.WRITE ? 'w' : 'r') + (flags & OPEN_MODE.EXCL ? 'x' : '')
        try { h(reqid, { fd: fs.openSync(local(p), fl), path: p }) } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
      })
      sftp.on('READ', (reqid, hd, off, len) => {
        const buf = Buffer.alloc(len), n = fs.readSync(get(hd).fd!, buf, 0, len, off)
        if (n) sftp.data(reqid, buf.subarray(0, n)); else sftp.status(reqid, STATUS_CODE.EOF)
      })
      sftp.on('FSTAT', (reqid, hd) => sftp.attrs(reqid, attrs(fs.fstatSync(get(hd).fd!))))
      sftp.on('CLOSE', (reqid, hd) => { const x = get(hd); if (x.fd !== undefined) fs.closeSync(x.fd); handles.delete(hd.readUInt32BE(0)); sftp.status(reqid, STATUS_CODE.OK) })
      sftp.on('OPENDIR', (reqid, p) => { try { h(reqid, { dir: fs.readdirSync(local(p)), path: p }) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) } })
      sftp.on('READDIR', (reqid, hd) => {
        const x = get(hd)
        if (!x.dir!.length) return sftp.status(reqid, STATUS_CODE.EOF)
        const names = x.dir!.splice(0).map((n) => ({ filename: n, longname: n, attrs: attrs(fs.lstatSync(local(`${x.path}/${n}`))) }))
        sftp.name(reqid, names)
      })
      sftp.on('LSTAT', stat)
      sftp.on('STAT', stat)
      sftp.on('MKDIR', (reqid, p) => run(reqid, () => fs.mkdirSync(local(p))))
      sftp.on('RMDIR', (reqid, p) => run(reqid, () => fs.rmdirSync(local(p))))
      sftp.on('REMOVE', (reqid, p) => run(reqid, () => fs.unlinkSync(local(p))))
      sftp.on('RENAME', (reqid, a, b) => run(reqid, () => fs.renameSync(local(a), local(b))))
      // chmod = SETSTAT 带 mode：只记下来（Windows 上 fs.chmod 只管只读位，验证报文即可）
      sftp.on('SETSTAT', (reqid, p, a) => run(reqid, () => { fs.statSync(local(p)); setstats.push([p, a.mode]) }))
    }))
  })
  return new Promise<{ port: number; setstats: typeof setstats; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, setstats, close: () => s.close() })))
}

it('sftpTreeOps：新建/重命名/计数/递归删除/目录下载 走真实 SFTP 报文', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const root = fs.mkdtempSync(join(tmpdir(), 'lingshell-sftpd-'))
  fs.mkdirSync(join(root, 'data', 'app', 'logs'), { recursive: true })
  fs.writeFileSync(join(root, 'data', 'app', 'logs', 'a.log'), 'hello')
  const srv = await fakeSftpd(root)
  const conn = await connectSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p' })
  try {
    const sftp = await new Promise<SFTPWrapper>((res, rej) => conn.client.sftp((e, s) => (e ? rej(e) : res(s))))
    const ops = sftpTreeOps(sftp)
    expect(await ops.lstat('/data/none')).toBeUndefined()
    expect(await createEntry(ops, '/data/app', 'new.conf', 'file')).toBe('/data/app/new.conf')
    await expect(createEntry(ops, '/data/app', 'new.conf', 'file')).rejects.toThrow(/已存在/)
    await createEntry(ops, '/data/app', 'sub', 'dir')
    expect(await renameEntry(ops, '/data/app/new.conf', 'app.conf')).toBe('/data/app/app.conf')
    expect(fs.existsSync(join(root, 'data', 'app', 'app.conf'))).toBe(true)
    expect(await planDelete(ops, ['/data/app'])).toEqual({ files: 2, dirs: 3, over: false })
    await ops.chmod('/data/app/app.conf', 0o640)
    expect(srv.setstats).toEqual([['/data/app/app.conf', 0o640]])
    await expect(ops.chmod('/data/none', 0o640)).rejects.toThrow()
    // 列目录带属性：longname 不是 ls -l 格式时属主回退 uid
    const ents = await new Promise<import('@lingshell/shared').DirEntry[]>((res, rej) => sftp.readdir('/data/app', (e, l) => (e ? rej(e) : res(l.map((it) => sftpDirEntry('/data/app', it))))))
    expect(ents.find((x) => x.name === 'logs')).toMatchObject({ path: '/data/app/logs', isDir: true, owner: '0', group: '0' })
    expect(ents.find((x) => x.name === 'app.conf')).toMatchObject({ isDir: false, size: 0 })

    const dst = fs.mkdtempSync(join(tmpdir(), 'lingshell-sftpdl-'))
    await new TransferService(() => {}).downloadTree(ops, ['/data/app'], dst)
    expect(fs.readFileSync(join(dst, 'app', 'logs', 'a.log'), 'utf8')).toBe('hello')
    expect(fs.existsSync(join(dst, 'app', 'sub'))).toBe(true)

    await expect(deleteTree(ops, '/data')).rejects.toThrow(/不允许/)   // 根下一级
    expect(await deleteTree(ops, '/data/app')).toEqual({ files: 2, dirs: 3, over: false })
    expect(fs.readdirSync(join(root, 'data'))).toEqual([])
  } finally { conn.close(); srv.close() }
}, 20000)
