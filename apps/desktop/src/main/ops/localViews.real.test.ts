import { it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import type { DockerListResult, ProcList, TerminalInfo } from '@lingshell/shared'
import { createLocalViews } from './localViews.js'
import { registerDocker } from './docker.js'
import { registerProcesses } from './processes.js'
import { registerPorts } from './portsIpc.js'

// 本机视图：本机起一个 Node 监听随机端口（子进程），核对端口 / 进程能列出来、结束进程后端口消失；
// 容器：本机装没装 Docker 都能跑（没装的走「未安装」分支，装了的只要求能列出来）
const kids: ChildProcess[] = []
afterAll(() => { for (const k of kids) try { k.kill() } catch { /* 已退出 */ } })

function listener(): Promise<{ pid: number; port: number }> {
  const p = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  kids.push(p)
  return new Promise((resolve, reject) => {
    p.stdout!.once('data', (d: Buffer) => resolve({ pid: p.pid!, port: Number(String(d).trim()) }))
    p.once('error', reject)
  })
}

const views = createLocalViews()
const terms: Record<string, TerminalInfo> = { loc: { id: 'loc', type: 'local', title: '本地终端' } as TerminalInfo }
const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
const audits: { command: string; decision: string; exitCode?: number }[] = []
const handle = (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { hs.set(ch, fn) }
const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a)) as Promise<T>
const deny = () => { throw new Error('不该走 SSH') }
registerProcesses({ handle, terminal: (id) => terms[id], exec: deny, audit: (_t, e) => { audits.push(e) }, local: views })
registerPorts({ handle, terminal: (id) => terms[id], exec: deny, sshOpts: deny, hostKey: (id) => id, forwards: { start: deny, stop: () => {}, list: () => [] }, localPorts: () => views.ports() })
registerDocker({ handle, terminal: (id) => terms[id], exec: deny, localExec: views.exec, audit: () => {}, openTerminal: async () => {} })

it('本机监听端口：列出子进程的端口和进程名；结束进程后端口消失，记执行记录', async () => {
  const { pid, port } = await listener()
  const l = await call<{ rows: { port: number; pid?: number; process?: string }[]; local?: string }>('ports:list', 'loc')
  expect(l.local).toBe(process.platform === 'win32' ? 'windows' : 'unix')
  const row = l.rows.find((r) => r.port === port)
  expect(row?.pid).toBe(pid)
  if (process.platform === 'win32') expect(row?.process?.toLowerCase()).toMatch(/node|electron/)

  const ps = await call<ProcList>('processes:list', 'loc')
  expect(ps.rows.some((r) => r.pid === pid)).toBe(true)

  await call('processes:signal', 'loc', pid, 'KILL', 'node.exe（监听 x）')
  expect(audits.at(-1)).toMatchObject({ decision: 'process_kill', exitCode: 0 })
  if (process.platform === 'win32') expect(audits.at(-1)!.command).toMatch(/^taskkill \/F \/PID \d+/)
  await new Promise((r) => setTimeout(r, 500))
  const after = await call<{ rows: { port: number }[] }>('ports:list', 'loc')
  expect(after.rows.some((r) => r.port === port)).toBe(false)
}, 60_000)

it('不能结束灵壳自己；Windows 没有 HUP；非法 pid 拒绝', async () => {
  await expect(call('processes:signal', 'loc', process.pid, 'KILL', '')).rejects.toThrow('灵壳')
  if (process.platform === 'win32') await expect(call('processes:signal', 'loc', 99999, 'HUP', '')).rejects.toThrow('HUP')
  await expect(call('processes:signal', 'loc', 1, 'KILL', '')).rejects.toThrow('非法')
})

it('本机 Docker：没装给出「本机没有安装 Docker」，装了能列出来', async () => {
  const r = await call<DockerListResult>('docker:list', 'loc', 'sudo')
  expect(r.mode).toBe('docker')   // 本机不走 sudo
  if (r.problem) expect(['missing', 'daemon']).toContain(r.problem)
  else expect(Array.isArray(r.containers)).toBe(true)
  if (r.problem === 'missing') await expect(call('docker:composeList', 'loc', 'docker')).rejects.toThrow('本机没有安装 Docker')
}, 60_000)
