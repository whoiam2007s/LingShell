import { it, expect } from 'vitest'
import ssh2 from 'ssh2'
import type { AddressInfo } from 'node:net'
import type { ServerChannel } from 'ssh2'
import { setHostKeyPolicy } from './sshConnect.js'
import { TerminalManager } from './TerminalManager.js'
import { PROMPT_NEWLINE_SETUP } from './promptNewline.js'

// 本机回环的假 sshd 模拟「装了 tmux 的服务器」：按 exec 命令返回 tmux 的应答，交互通道记录收到的输入。
// 不连任何真实主机；服务器上也不真跑 tmux —— 测的是命令构造、状态机、接回/关闭决策
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const N = 'lingshell-0123abcd'

function trustAll() {
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
}

// 对哨兵命令回一段（tmux 重绘风格的）输出
function answerSentinel(st: ServerChannel, d: string, body: string, tmuxish: boolean) {
  const m = /__CW_START_([0-9a-f]+)__/.exec(d)
  if (!m) return
  const id = m[1]
  st.write(tmuxish
    ? `\x1b[?25l$ ${d.trim()}\x1b(B\x1b[m\x1b[K\r\n__CW_START_${id}__\x1b[K\r\n${body}\x1b(B\x1b[m\r\n__CW_END_${id}__0__\x1b[K\r\n$ \x1b[?25h`
    : `__CW_START_${id}__\r\n${body}\r\n__CW_END_${id}__0__\r\n$ `)
}

function fakeServer(o: { tmux: boolean }) {
  const st = { exists: false, panes: 'bash\n', execs: [] as string[], attaches: 0, shells: 0, typed: [] as string[], conns: [] as { end(): void }[] }
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    st.conns.push(c)
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      let pty = false
      session.on('pty', (ok) => { pty = true; ok?.() })
      session.on('window-change', (ok) => ok?.())
      session.on('shell', (ok) => {
        st.shells++
        const ch = ok()
        ch.on('data', (d: Buffer) => { st.typed.push(d.toString()); answerSentinel(ch, d.toString(), 'Linux', false) })
      })
      session.on('exec', (ok, _rej, info) => {
        const cmd = info.command
        st.execs.push(cmd)
        const ch = ok()
        if (cmd.startsWith('tmux -u attach-session')) {   // 交互通道：保持打开
          expect(pty).toBe(true)
          st.attaches++
          ch.on('data', (d: Buffer) => { st.typed.push(d.toString()); answerSentinel(ch, d.toString(), 'hi', true) })
          return
        }
        let out = ''
        if (cmd.includes('command -v tmux')) out = o.tmux ? `tmux 3.3a\n${st.exists ? '@@exists\n' : ''}Linux\n` : '@@notmux\nLinux\n'
        else if (cmd.startsWith('tmux new-session -d')) { st.exists = true; out = '@@ok\n' }
        else if (cmd.startsWith('tmux list-panes')) out = st.panes
        else if (cmd.startsWith('tmux kill-session')) st.exists = false
        else if (cmd.startsWith('tmux display-message')) out = '/srv/app\n'
        else if (cmd.includes('list-sessions')) out = `${N}|1700000000|1|bash\nlingshell-ffffffff|1700000100|0|rsync\nmine|1|0|vim\n`
        ch.write(out); ch.exit(0); ch.end()
      })
    })
  })
  return new Promise<typeof st & { port: number; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r(Object.assign(st, { port: (s.address() as AddressInfo).port, close: () => s.close() }))))
}

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('until timeout'); await new Promise((r) => setTimeout(r, 20)) } }

it('保持会话：新建 tmux 会话 → exec+pty 接入；断线重连接回同一会话；AI 哨兵在 tmux 里照常；pwd 问 tmux', async () => {
  trustAll()
  const srv = await fakeServer({ tmux: true })
  const statuses: string[] = []
  const mgr = new TerminalManager({ statusEmit: (_id, s) => statuses.push(s) })
  const info = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: N })
  expect(info.tmux).toBe(N)
  expect(info.os).toBe('linux')
  expect(info.notice).toBeUndefined()
  expect(srv.shells).toBe(0)
  expect(srv.attaches).toBe(1)
  // 建会话：提示符设置作为 send-keys -l 的字面量打进去（不走哨兵，所以交互通道上什么都没打）
  const create = srv.execs.find((c) => c.startsWith('tmux new-session -d'))!
  expect(create).toContain(`allow-passthrough on`)
  expect(create).toContain(`send-keys -t ${N} -l ' ${PROMPT_NEWLINE_SETUP.replace(/'/g, `'\\''`)}; clear'`)
  expect(srv.typed).toEqual([])

  // AI 命令：tmux 里原始输出照常转给 UI（不另行回显），哨兵照样解析
  const seen: string[] = []
  mgr.onData(info.id, (d) => seen.push(d))
  const r = await mgr.execCapture(info.id, 'echo hi')
  expect(r).toEqual({ output: 'hi', exitCode: 0 })
  expect(seen.join('')).toContain('__CW_END_')
  expect(seen.join('')).not.toContain('\x1b[36m')
  expect(await mgr.pwd(info.id)).toBe('/srv/app')
  expect(srv.typed).toHaveLength(1)   // 只有 AI 那一条，pwd 没往 shell 里打

  // 服务器侧断开 → disconnected；重连 → 探测到会话已在，直接接回，不再建会话、不打设置
  srv.conns.forEach((c) => c.end())
  await until(() => statuses.includes('disconnected'))
  await mgr.reconnect(info.id)
  expect(statuses).toEqual(['disconnected', 'running'])
  expect(srv.attaches).toBe(2)
  expect(srv.execs.filter((c) => c.startsWith('tmux new-session')).length).toBe(1)
  expect(srv.typed).toHaveLength(1)
  expect(mgr.list()[0].tmux).toBe(N)

  // 保留会话列表：只要 lingshell- 前缀，且去掉本应用已打开的
  expect((await mgr.tmuxSessions(info.id)).map((s) => s.name)).toEqual(['lingshell-ffffffff'])

  // 关标签：后台有任务 → 缺省不结束会话；空闲 → kill-session
  srv.panes = 'bash\nrsync\n'
  expect(await mgr.tmuxJobs(info.id)).toEqual(['rsync'])
  const dup = await mgr.duplicate(info.id)   // 复制会话用新的 tmux 会话
  expect(dup.tmux).toMatch(/^lingshell-[0-9a-f]{8}$/)
  expect(dup.tmux).not.toBe(N)
  await mgr.close(info.id)
  expect(srv.execs.some((c) => c === `tmux kill-session -t ${N}`)).toBe(false)
  srv.panes = 'bash\n'
  await mgr.close(dup.id)
  expect(srv.execs).toContain(`tmux kill-session -t ${dup.tmux}`)
  srv.close()
}, 30000)

it('关标签三种方式：kill 强制结束 / keep 留在服务器', async () => {
  trustAll()
  const srv = await fakeServer({ tmux: true })
  const mgr = new TerminalManager()
  srv.panes = 'vim\n'
  const a = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: N })
  await mgr.close(a.id, 'kill')
  expect(srv.execs).toContain(`tmux kill-session -t ${N}`)
  const n = srv.execs.length
  const b = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: 'lingshell-11112222' })
  const before = srv.execs.length
  await mgr.close(b.id, 'keep')
  expect(srv.execs.length).toBe(before)   // keep：不发任何 tmux 命令
  expect(before).toBeGreaterThan(n)
  srv.close()
}, 30000)

it('登录命令：tmux 只在新建会话时发，接回不发', async () => {
  trustAll()
  const srv = await fakeServer({ tmux: true })
  const mgr = new TerminalManager()
  const info = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: N, loginCommands: 'cd /app\n\nsource env.sh  \n' })
  await until(() => srv.typed.length > 0)
  expect(srv.typed).toEqual(['cd /app\rsource env.sh\r'])
  // 再开一个终端接回同一会话（会话已存在）→ 不再发
  const again = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: N, loginCommands: 'cd /app' })
  await new Promise((r) => setTimeout(r, 200))
  expect(srv.typed).toHaveLength(1)
  await mgr.close(info.id, 'keep'); await mgr.close(again.id, 'keep')
  srv.close()
}, 30000)

it('登录命令：普通 shell 在提示符设置之后发，断线重连后再发；不进命令历史', async () => {
  trustAll()
  const srv = await fakeServer({ tmux: false })
  const cmds: string[] = []
  const statuses: string[] = []
  const mgr = new TerminalManager({ commandEmit: (c) => cmds.push(c), statusEmit: (_id, s) => statuses.push(s) })
  const info = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', loginCommands: 'cd /app' })
  await until(() => srv.typed.includes('cd /app\r'))
  expect(srv.typed[0]).toContain('__lingshell_nl')   // 先是提示符设置
  expect(srv.typed.indexOf('cd /app\r')).toBe(1)
  srv.conns.forEach((c) => c.end())
  await until(() => statuses.includes('disconnected'))
  await mgr.reconnect(info.id)
  await until(() => srv.typed.filter((t) => t === 'cd /app\r').length === 2)
  expect(cmds).toEqual([])
  await mgr.close(info.id)
  srv.close()
}, 30000)

it('服务器没装 tmux：退回普通 shell + 一次性提示，提示符设置照旧走哨兵', async () => {
  trustAll()
  const srv = await fakeServer({ tmux: false })
  const mgr = new TerminalManager()
  const info = await mgr.createSsh({ host: '127.0.0.1', port: srv.port, username: 'u', password: 'p', tmux: N })
  expect(info.tmux).toBeUndefined()
  expect(info.notice).toBe('服务器未安装 tmux，已用普通会话')
  expect(info.os).toBe('linux')
  expect(srv.shells).toBe(1)
  expect(srv.attaches).toBe(0)
  expect(srv.typed.join('')).toContain('__lingshell_nl')
  expect(await mgr.tmuxJobs(info.id)).toEqual([])
  await mgr.close(info.id)
  expect(srv.execs.some((c) => c.includes('kill-session'))).toBe(false)
  srv.close()
}, 30000)
