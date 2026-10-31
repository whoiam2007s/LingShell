import { describe, it, expect } from 'vitest'
import ssh2 from 'ssh2'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { SshTerminal, setHostKeyPolicy } from '@lingshell/terminal-core'
import type { TerminalInfo } from '@lingshell/shared'
import { terminalToolDefs, JOB_DIR, type TerminalToolDeps } from '@lingshell/dsh-controller/src/terminalTools.js'
import { createSideExec } from './bgJobExec.js'

// 端到端：AI 后台任务的启动 / 查询走旁路通道，交互终端收不到任何输入。
// SSH 用本机回环的假 sshd（exec 交给真 bash 跑，不连任何真实主机）；本地用 bash 子进程
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const bash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => existsSync(p))
  : 'bash'

function fakeSshd() {
  const shellIn: string[] = [], execs: string[] = []
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      const session = accept()
      session.on('pty', (ok) => ok?.())
      session.on('shell', (ok) => { ok().on('data', (d: Buffer) => shellIn.push(d.toString())) })
      session.on('exec', (ok, _rej, info) => {
        execs.push(info.command)
        const ch = ok()
        const p = spawn(bash!, ['-c', info.command], { windowsHide: true })
        p.stdout.on('data', (d) => ch.write(d)); p.stderr.on('data', (d) => ch.stderr.write(d))
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  return new Promise<{ port: number; shellIn: string[]; execs: string[]; close(): void }>((r) =>
    s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, shellIn, execs, close: () => s.close() })))
}

const info = (id: string, type: 'ssh' | 'local', shell?: string): TerminalInfo => ({ id, title: id, type, status: 'running', locked: false, ...(shell ? { shell } : {}) })
const run = (d: TerminalToolDeps, name: string, args: object) => terminalToolDefs(d).find((t) => t.name === name)!.execute(args as never, { agent: { id: 's' } } as never)
const toolDeps = (sideExec: TerminalToolDeps['sideExec'], ids: string[], captured: string[]): TerminalToolDeps => ({
  terminals: {
    list: () => ids.map((id) => ({ id, title: id, type: 'ssh', status: 'running', locked: false })), readSnapshot: () => '',
    execCapture: async (_id, cmd) => { captured.push(cmd); throw new Error('不该进交互终端') },
  },
  resolveHostKey: () => 'h', decide: () => ({ kind: 'allow' }), grant: () => {}, audit: () => {}, execTimeoutMs: () => 20_000, sideExec,
})
async function untilFinished(d: TerminalToolDeps, tid: string, jobId: string) {
  for (let i = 0; i < 40; i++) {
    const st = JSON.parse(await run(d, 'check_background', { terminal_id: tid, job_id: jobId, wait_seconds: 1 }))
    if (st.status !== 'running') return st
  }
  throw new Error('任务没结束')
}

describe.skipIf(!bash)('AI 后台任务走旁路通道（真 bash）', () => {
  it('SSH：独立 exec channel 启动 → running → finished（退出码 + 日志 + 工作目录），交互 shell 一个字都没收到', async () => {
    const db = new Map<string, { keyType: string; fingerprint: string }>()
    setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, k, f) => { db.set(hp, { keyType: k, fingerprint: f }) }, prompt: async () => true })
    const h = await fakeSshd()
    const t = await SshTerminal.connect('t1', { host: '127.0.0.1', port: h.port, username: 'u', password: 'p' })
    const dir = mkdtempSync(join(tmpdir(), 'bgjob-')).replace(/\\/g, '/')
    let jobId = ''
    try {
      const before = h.shellIn.join('')
      const captured: string[] = []
      const side = createSideExec({
        list: () => [info('t1', 'ssh')], knownCwd: () => dir,
        execFull: (_id, c, o) => t.exec(c, o),
      })
      const d = toolDeps(side, ['t1'], captured)
      const go = `${JOB_DIR}/go-${Date.now()}`
      const out = JSON.parse(await run(d, 'start_background', { terminal_id: 't1', command: `pwd; echo "it's ok"; while [ ! -f ${go} ]; do sleep 0.1; done; exit 3` }))
      jobId = out.job_id
      expect(out.pid).toBeGreaterThan(0)
      expect(JSON.parse(await run(d, 'check_background', { terminal_id: 't1', job_id: jobId, wait_seconds: 0 })).status).toBe('running')
      await new Promise<void>((r) => spawn(bash!, ['-c', `touch ${go}`]).on('close', () => r()))
      const st = await untilFinished(d, 't1', jobId)
      expect(st).toMatchObject({ status: 'finished', exit_code: 3 })
      expect(st.tail).toContain("it's ok")
      expect(st.tail.split('\n')[0].toLowerCase()).toContain(dir.split('/').pop()!.toLowerCase())   // 在终端当前目录里跑
      expect(h.execs[0]).toMatch(/^cd '.*bgjob-.*' 2>\/dev\/null; mkdir -p /)
      expect(h.shellIn.join('')).toBe(before)   // 交互 shell 没收到包装命令
      expect(captured).toEqual([])
      expect(t.busy).toBe(false)
      await new Promise<void>((r) => spawn(bash!, ['-c', `rm -f ${go}`]).on('close', () => r()))
    } finally {
      if (jobId) spawn(bash!, ['-c', `rm -f ${JOB_DIR}/${jobId}.*`])
      t.kill(); h.close(); rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('本地：bash 子进程启动 / 查询，任务在终端当前目录里跑；WSL 等其它 shell 返回 undefined（退回终端静默执行）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgjob-local-'))
    let jobId = ''
    try {
      const side = createSideExec({ list: () => [info('l1', 'local'), info('w1', 'local', 'wsl:Ubuntu')], knownCwd: () => dir, execFull: async () => { throw new Error('本地不该走 exec channel') } },
        { file: () => bash!, env: () => process.env })
      expect(await side('w1', 'echo hi', { timeoutMs: 5000 })).toBeUndefined()
      expect(await side('nope', 'echo hi', { timeoutMs: 5000 })).toBeUndefined()
      const captured: string[] = []
      const d = toolDeps(side, ['l1'], captured)
      const out = JSON.parse(await run(d, 'start_background', { terminal_id: 'l1', command: 'pwd; echo local-done' }))
      jobId = out.job_id
      const st = await untilFinished(d, 'l1', jobId)
      expect(st).toMatchObject({ status: 'finished', exit_code: 0 })
      expect(st.tail).toContain('local-done')
      expect(st.tail.toLowerCase()).toContain(dir.split(/[\\/]/).pop()!.toLowerCase())
      expect(captured).toEqual([])
    } finally {
      if (jobId) spawn(bash!, ['-c', `rm -f ${JOB_DIR}/${jobId}.*`])
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('超时与中止：超时带回已有输出（退出码 -1），中止报 aborted', async () => {
    const side = createSideExec({ list: () => [info('l1', 'local')], knownCwd: () => undefined, execFull: async () => { throw new Error('x') } }, { file: () => bash!, env: () => process.env })
    expect(await side('l1', 'echo early; sleep 5', { timeoutMs: 1500 })).toEqual({ output: expect.stringContaining('early'), exitCode: -1 })
    const ac = new AbortController()
    const p = side('l1', 'sleep 5', { timeoutMs: 10_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    await expect(p).rejects.toThrow('aborted')
  }, 20_000)
})
