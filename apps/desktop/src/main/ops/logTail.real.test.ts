import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSsh, execStream, setHostKeyPolicy } from '@lingshell/terminal-core'
import { LogTails, type OpenStream } from './logTail.js'
import { logTailCommand } from '@lingshell/shared'

// 本机回环的假 sshd（不连任何真实主机）。exec 两种模式：
// - 'stream'：每 50ms 写一行，记录服务端看到的 channel 关闭
// - 'sh'：把命令交给本机 sh 真跑（验证 tail -F 随通道关闭退出、不留进程），需要本机有 sh + tail
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
type Mode = 'stream' | 'sh'

function fakeSshd(mode: Mode) {
  const st = { execs: [] as string[], chClosed: 0, childExit: [] as (number | null)[], conns: [] as import('ssh2').Connection[] }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    st.conns.push(c)
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      session.on('exec', (ok, _rej, info) => {
        st.execs.push(info.command)
        const ch = ok()
        ch.on('close', () => { st.chClosed++ })
        if (mode === 'stream') {
          let i = 0
          ch.resume()   // 读走 stdin，否则 end / close 事件出不来
          ch.write('首行\r\n半')   // 半行跨 chunk 拼接
          const t = setInterval(() => { try { ch.write(`行 ${++i}\n`) } catch { clearInterval(t) } }, 50)
          ch.on('close', () => clearInterval(t))
          return
        }
        const p = spawn('sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'] })
        p.stdout.on('data', (d) => ch.write(d))
        p.stderr.on('data', (d) => ch.stderr.write(d))
        ch.on('data', (d: Buffer) => p.stdin.write(d))
        ch.on('end', () => p.stdin.end())
        ch.on('close', () => p.stdin.end())   // sshd：通道关闭即关子进程 stdin
        p.on('exit', (code) => { st.childExit.push(code); try { ch.exit(code ?? 0); ch.end() } catch { /* 已关 */ } })
      })
    })
  })
  return new Promise<{ port: number; st: typeof st; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, st, close: () => s.close() })))
}

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(30); return f() }

it('流式输出按行取走，跨 chunk 的半行拼对；stop 后服务端 channel 关闭', async () => {
  trustAll()
  const h = await fakeSshd('stream')
  const conn = await connectSsh({ host: '127.0.0.1', port: h.port, username: 'u', password: 'p' })
  try {
    const open: OpenStream = (_tid, cmd, hd) => execStream(conn.client, cmd, hd)
    const tails = new LogTails(open)
    const id = tails.start('t1', { kind: 'file', path: "/var/log/a b'.log" })
    const got: string[] = []
    expect(await until(() => { got.push(...tails.poll(id).lines); return got.length >= 4 })).toBe(true)
    expect(got.slice(0, 3)).toEqual(['首行', '半行 1', '行 2'])
    expect(h.st.execs[0]).toBe(logTailCommand({ kind: 'file', path: "/var/log/a b'.log" }))
    tails.stop(id)
    expect(await until(() => h.st.chClosed === 1)).toBe(true)
    expect(tails.size).toBe(0)
  } finally { conn.close(); h.close() }
}, 20000)

it('连接断开：通道结束，poll 带 ended 并移除；久未轮询自动关', async () => {
  trustAll()
  const h = await fakeSshd('stream')
  const conn = await connectSsh({ host: '127.0.0.1', port: h.port, username: 'u', password: 'p' })
  try {
    let now = 0
    const tails = new LogTails((_t, cmd, hd) => execStream(conn.client, cmd, hd), () => now)
    const a = tails.start('t1', { kind: 'journal', unit: 'nginx' })
    const b = tails.start('t1', { kind: 'journal' })
    expect(await until(() => h.st.execs.length === 2)).toBe(true)
    now = 31_000; tails.poll(a)   // a 刚取过，b 30 秒没取
    tails.sweep()
    expect(tails.size).toBe(1)
    expect(tails.poll(b).ended).toEqual({})   // 已移除
    expect(await until(() => h.st.chClosed === 1)).toBe(true)
    h.st.conns.forEach((c) => c.end())   // 服务器断开
    expect(await until(() => !!tails.poll(a).ended)).toBe(true)
    expect(tails.size).toBe(0)
  } finally { conn.close(); h.close() }
}, 20000)

it('同一终端最多 4 个；open 同步抛错不登记', () => {
  const tails = new LogTails(() => () => {})
  for (let i = 0; i < 4; i++) tails.start('t', { kind: 'journal' })
  expect(() => tails.start('t', { kind: 'journal' })).toThrow('最多同时查看 4 个')
  tails.start('u', { kind: 'journal' })
  const bad = new LogTails(() => { throw new Error('terminal_disconnected') })
  expect(() => bad.start('t', { kind: 'journal' })).toThrow('terminal_disconnected')
  expect(bad.size).toBe(0)
})

// 真跑 sh：关通道后 tail 进程必须退出（日志安静、没有新写入时也要退）
const hasSh = spawnSync('sh', ['-c', 'command -v tail && command -v cat'], { encoding: 'utf8' }).status === 0
it.skipIf(!hasSh)('真实 tail -F：先出最后几行、追加的行跟上，关通道后远端 tail 退出', async () => {
  trustAll()
  const h = await fakeSshd('sh')
  const dir = mkdtempSync(join(tmpdir(), 'logtail-'))
  const file = join(dir, "app's.log").replace(/\\/g, '/')
  writeFileSync(file, 'old1\nold2\n')
  const conn = await connectSsh({ host: '127.0.0.1', port: h.port, username: 'u', password: 'p' })
  try {
    const tails = new LogTails((_t, cmd, hd) => execStream(conn.client, cmd, hd))
    const id = tails.start('t', { kind: 'file', path: file })
    const got: string[] = []
    expect(await until(() => { got.push(...tails.poll(id).lines); return got.includes('old2') }, 8000)).toBe(true)
    appendFileSync(file, 'new1\n')
    expect(await until(() => { got.push(...tails.poll(id).lines); return got.includes('new1') }, 8000)).toBe(true)
    tails.stop(id)   // 之后不再写文件：tail 只能靠 stdin EOF 的看门狗退出
    expect(await until(() => h.st.childExit.length === 1, 8000)).toBe(true)
  } finally { conn.close(); h.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)
