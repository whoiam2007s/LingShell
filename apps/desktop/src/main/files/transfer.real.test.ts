import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { TransferProgressEvent } from '@lingshell/shared'
import { setHostKeyPolicy } from '@lingshell/terminal-core'
import { TransferService } from './transfer.js'

// 本机回环假 sshd：只读 SFTP（远程 /x 映射到临时目录），READ 故意放慢，便于在传输中途取消。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const { STATUS_CODE } = utils.sftp

let root = '', port = 0, close = () => {}
beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'lingshell-tfd-'))
  fs.writeFileSync(join(root, 'small.txt'), 'hello queue')
  fs.writeFileSync(join(root, 'big.bin'), Buffer.alloc(1024 * 1024, 7))
  const attrs = (st: fs.Stats) => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: 0, mtime: 0 })
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => accept().on('sftp', (ok) => {
      const sftp = ok()
      const fds = new Map<number, number>()
      let next = 0
      const fd = (b: Buffer) => fds.get(b.readUInt32BE(0))!
      sftp.on('OPEN', (reqid, p) => {
        try { const b = Buffer.alloc(4); b.writeUInt32BE(next); fds.set(next++, fs.openSync(join(root, p), 'r')); sftp.handle(reqid, b) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) }
      })
      sftp.on('READ', (reqid, hd, off, len) => setTimeout(() => {
        if (!fds.has(hd.readUInt32BE(0))) return
        const buf = Buffer.alloc(len), n = fs.readSync(fd(hd), buf, 0, len, off)
        if (n) sftp.data(reqid, buf.subarray(0, n)); else sftp.status(reqid, STATUS_CODE.EOF)
      }, 15))
      sftp.on('FSTAT', (reqid, hd) => sftp.attrs(reqid, attrs(fs.fstatSync(fd(hd)))))
      sftp.on('STAT', (reqid, p) => { try { sftp.attrs(reqid, attrs(fs.statSync(join(root, p)))) } catch { sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) } })
      sftp.on('CLOSE', (reqid, hd) => { const f = fds.get(hd.readUInt32BE(0)); if (f !== undefined) fs.closeSync(f); fds.delete(hd.readUInt32BE(0)); sftp.status(reqid, STATUS_CODE.OK) })
    }))
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  port = (s.address() as AddressInfo).port
  close = () => s.close()
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
})
afterAll(() => close())

const opts = () => ({ host: '127.0.0.1', port, username: 'u', password: 'p' })

it('下载排队（并发 1）：第二个先排队，跑完后落地，事件带字节数与本地落点', async () => {
  const dst = fs.mkdtempSync(join(tmpdir(), 'lingshell-tfl-'))
  const evs: TransferProgressEvent[] = []
  const svc = new TransferService((ev) => evs.push(ev), () => 1)
  const a = svc.download(opts(), '/small.txt', dst)
  const b = svc.download(opts(), '/small.txt', dst, 'copy.txt')
  expect(svc.list().map((t) => t.state)).toEqual(['running', 'queued'])
  expect(await a).toBe(join(dst, 'small.txt'))
  expect(await b).toBe(join(dst, 'copy.txt'))
  expect(fs.readFileSync(join(dst, 'copy.txt'), 'utf8')).toBe('hello queue')
  const done = evs.filter((e) => e.state === 'done')
  expect(done.map((e) => e.reveal)).toEqual([{ local: join(dst, 'small.txt') }, { local: join(dst, 'copy.txt') }])
  expect(done[1].bytesDone).toBe(11)
  expect(svc.activeCount()).toBe(0)
}, 20_000)

it('传输中途取消：落到「已取消」，删掉本地半截文件；重试从头传完', async () => {
  const dst = fs.mkdtempSync(join(tmpdir(), 'lingshell-tfl-'))
  const evs: TransferProgressEvent[] = []
  const svc: TransferService = new TransferService((ev) => {
    evs.push(ev)
    if (ev.state === 'running' && (ev.bytesDone ?? 0) > 0 && !evs.some((e) => e.state === 'cancelled')) svc.cancel(ev.taskId)
  })
  await expect(svc.download(opts(), '/big.bin', dst)).rejects.toThrow('已取消')
  const t = svc.list()[0]
  expect(t.state).toBe('cancelled')
  expect(fs.existsSync(join(dst, 'big.bin'))).toBe(false)
  svc.retry(t.taskId)
  await new Promise<void>((r) => { const h = setInterval(() => { if (svc.activeCount() === 0) { clearInterval(h); r() } }, 50) })
  expect(svc.list()[0].state).toBe('done')
  expect(fs.statSync(join(dst, 'big.bin')).size).toBe(1024 * 1024)
}, 30_000)
