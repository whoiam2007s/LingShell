import { it, expect, vi } from 'vitest'
import ssh2 from 'ssh2'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy } from '@lingshell/terminal-core'
import type { Watchdog, WatchdogState } from '@lingshell/shared'
import { runBatchHost, type Runner } from './batchExec.js'
import { WatchdogScheduler, WatchdogStore } from './watchdog.js'

// 本机回环假 sshd：exec 收到的脚本按「文件是否存在」开关回结果（同真实脚本 test -e … 的约定）；记录 exec 与连接数。不连任何真实主机
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
function fakeSshd() {
  const st = { exists: false, execs: [] as string[], opened: 0, closed: 0, shell: 0 }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    st.opened++
    c.once('close', () => { st.closed++ })
    c.on('session', (accept) => {
      const session = accept()
      session.on('shell', () => { st.shell++ })
      session.on('exec', (ok, _rej, info) => {
        st.execs.push(info.command)
        const ch = ok()
        if (st.exists) { ch.write('存在\n'); ch.exit(1) } else { ch.write('不存在\n'); ch.exit(0) }
        ch.end()
      })
    })
  })
  return new Promise<{ port: number; st: typeof st; close(): void }>((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, st, close: () => s.close() })))
}

it('看门狗经独立 exec channel 检查：触发 → 通知 + 开一次会话；持续触发不重复；恢复 → 通知；状态落盘', async () => {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  const srv = await fakeSshd()
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  try {
    const store = new WatchdogStore(dir)
    const script = 'test -e /tmp/lingshell-wd && { echo 存在; exit 1; } || { echo 不存在; exit 0; }'
    const w: Watchdog = store.save({ name: 'wd 文件', condition: '/tmp/lingshell-wd 存在就报警', script, targets: ['h1'], intervalMin: 1, threshold: 1, autoSession: true, enabled: true })
    const notify = vi.fn(), openSession = vi.fn(async () => 'sess_wd'), emitted: WatchdogState[] = []
    // 同 ipc.ts：没有在线终端 → 临时连接、跑完即断
    const open = async (): Promise<Runner> => {
      const conn = await connectSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', noHostKeyPrompt: false })
      return { exec: (c, o) => execFull(conn.client, c, o), close: () => conn.close() }
    }
    const sch = new WatchdogScheduler({
      list: () => store.list(), hosts: () => [{ id: 'h1', label: 'web-1' }],
      run: (_hk, s) => runBatchHost(open, s, 5000, new AbortController().signal),
      loadStates: () => store.loadStates(), saveStates: (s) => store.saveStates(s),
      emit: (s) => emitted.push(s), notify, openSession, unitMs: 1000,
    })
    const settle = () => new Promise((r) => setTimeout(r, 300))
    const tickAndWait = async (now: number) => { sch.tick(now); for (let i = 0; i < 20 && emitted.length < want; i++) await settle() }
    let want = 1
    await tickAndWait(1_000_000)
    expect(store.loadStates()[w.id].hosts.h1).toMatchObject({ status: 'ok', value: '不存在' })
    expect(srv.st.execs).toEqual([script])            // 脚本原样经 exec 发出
    expect(srv.st.shell).toBe(0)                      // 不开交互 shell

    // 间隔未到不重复跑
    sch.tick(1_000_500); await settle()
    expect(srv.st.execs).toHaveLength(1)

    srv.st.exists = true; want = 2
    await tickAndWait(1_001_100)
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ id: w.id }), { key: 'h1', label: 'web-1' }, '存在')
    expect(notify).toHaveBeenLastCalledWith('看门狗「wd 文件」触发', 'web-1：存在，已开 AI 排查会话', 'sess_wd')
    expect(store.loadStates()[w.id].hosts.h1).toMatchObject({ status: 'firing', alerted: true, sessionId: 'sess_wd' })

    want = 3
    await tickAndWait(1_002_200)                      // 持续触发：不再通知 / 开会话
    expect(notify).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledTimes(1)

    srv.st.exists = false
    const st = await sch.checkNow(w.id)               // 立即检查
    expect(st.hosts.h1).toMatchObject({ status: 'ok', alerted: false })
    expect(notify).toHaveBeenLastCalledWith('看门狗「wd 文件」已恢复', 'web-1：不存在')
    expect(st.history.map((e) => e.kind)).toEqual(['recover', 'fire'])
    expect(st.history[1]).toMatchObject({ hostKey: 'h1', sessionId: 'sess_wd', value: '存在' })

    await settle()
    expect(srv.st.closed).toBe(srv.st.opened)          // 每次临时连接都断开了
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('保存前只读校验：含写操作的脚本拒绝保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wd-'))
  try {
    const store = new WatchdogStore(dir)
    const base = { name: 'x', condition: 'c', targets: ['local'], intervalMin: 5, threshold: 1, autoSession: true, enabled: true }
    expect(() => store.save({ ...base, script: 'test -e /tmp/a || touch /tmp/a' })).toThrow('拒绝保存')
    expect(() => store.save({ ...base, script: 'df -h / ; exit 0', intervalMin: 3 })).toThrow('间隔')
    expect(store.list()).toHaveLength(0)
    const w = store.save({ ...base, script: 'df -h /' })
    expect(store.save({ ...base, id: w.id, script: 'uptime' })).toMatchObject({ id: w.id, script: 'uptime', createdAt: w.createdAt })
    expect(store.list()).toHaveLength(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
