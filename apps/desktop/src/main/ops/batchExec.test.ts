import { describe, it, expect, vi } from 'vitest'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'
import { BatchRuns, localRunner, runBatchHost, type Runner } from './batchExec.js'
import { findBash } from '../core/index.js'

// 假执行通道：按给定结果返回；hang = 一直不返回，直到 signal 中止
function fake(res: Partial<ExecFullResult> | 'hang' | Error, closed = { n: 0 }): () => Promise<Runner> {
  return async () => ({
    close: () => { closed.n++ },
    exec: (_c: string, o: ExecFullOpts) => {
      if (res instanceof Error) return Promise.reject(res)
      if (res === 'hang') return new Promise((r) => o.signal?.addEventListener('abort', () => r({ code: null, output: 'part', truncated: false, stopped: 'aborted' })))
      return Promise.resolve({ code: 0, output: '', truncated: false, ...res })
    },
  })
}
const sig = () => new AbortController().signal

describe('runBatchHost', () => {
  it('退出码 0 → 成功，非 0 → 失败；跑完关通道并记录', async () => {
    const closed = { n: 0 }, onExec = vi.fn()
    expect(await runBatchHost(fake({ output: 'hi\n' }, closed), 'echo hi', 1000, sig(), onExec)).toMatchObject({ status: 'ok', exitCode: 0, output: 'hi\n' })
    expect(await runBatchHost(fake({ code: 3, output: 'err' }, closed), 'x', 1000, sig(), onExec)).toMatchObject({ status: 'fail', exitCode: 3 })
    expect(closed.n).toBe(2)
    expect(onExec.mock.calls.map((c) => c[0].status)).toEqual(['ok', 'fail'])
  })
  it('超时带回部分输出，也记录；截断标记透传', async () => {
    const onExec = vi.fn()
    const r = await runBatchHost(fake({ code: null, output: 'half', stopped: 'timeout', truncated: true }), 'x', 1000, sig(), onExec)
    expect(r).toMatchObject({ status: 'timeout', output: 'half', truncated: true })
    expect(r.exitCode).toBeUndefined()
    expect(onExec).toHaveBeenCalledTimes(1)
  })
  it('连不上 / 通道开不出来 → 连接失败，不记录', async () => {
    const onExec = vi.fn()
    expect(await runBatchHost(() => Promise.reject(new Error('认证失败')), 'x', 1000, sig(), onExec)).toMatchObject({ status: 'conn_error', error: '认证失败' })
    expect(await runBatchHost(fake(new Error('terminal_disconnected')), 'x', 1000, sig(), onExec)).toMatchObject({ status: 'conn_error', error: 'terminal_disconnected' })
    expect(onExec).not.toHaveBeenCalled()
  })
  it('连接超时算连接失败；之后才连上的立即断开', async () => {
    let late!: (r: Runner) => void
    const closed = { n: 0 }
    const r = await runBatchHost(() => new Promise<Runner>((res) => { late = res }), 'x', 1000, sig(), undefined, 20)
    expect(r).toMatchObject({ status: 'conn_error', error: '连接超时（0.02s）' })
    late({ exec: () => Promise.reject(new Error('不该执行')), close: () => { closed.n++ } })
    await new Promise((x) => setTimeout(x, 0))
    expect(closed.n).toBe(1)
  })
  it('取消：连接中 → 已取消不记录；执行中 → 已取消带部分输出并记录；先取消的直接已取消', async () => {
    const runs = new BatchRuns(), onExec = vi.fn()
    const connecting = runBatchHost(() => new Promise<Runner>(() => {}), 'x', 1000, runs.signal('r1'), onExec)
    const executing = runBatchHost(fake('hang'), 'x', 1000, runs.signal('r1'), onExec)
    await new Promise((x) => setTimeout(x, 5))
    runs.cancel('r1')
    expect(await connecting).toMatchObject({ status: 'canceled' })
    expect(await executing).toMatchObject({ status: 'canceled', output: 'part' })
    expect(onExec).toHaveBeenCalledTimes(1)
    expect(await runBatchHost(fake({}), 'x', 1000, runs.signal('r1'), onExec)).toMatchObject({ status: 'canceled' })
    expect(runs.signal('r2').aborted).toBe(false)   // 别的批次不受影响
  })
})

// 本机子进程：Windows 没装 Git Bash 时跳过（cmd 语法不同）
const sh = process.platform === 'win32' ? findBash() : '/bin/sh'
describe.skipIf(!sh)('localRunner', () => {
  const run = (cmd: string, o: Partial<ExecFullOpts> = {}) => localRunner(sh).exec(cmd, { timeoutMs: 10_000, ...o })
  it('stdout + stderr 合并，带退出码', async () => {
    const r = await run('echo out; echo err 1>&2; exit 4')
    expect(r.code).toBe(4)
    expect(r.output.replace(/\r/g, '')).toMatch(/out\n[\s\S]*err\n|err\n[\s\S]*out\n/)
  })
  it('超时杀进程，标 timeout', async () => {
    expect(await run('sleep 5', { timeoutMs: 200 })).toMatchObject({ code: null, stopped: 'timeout' })
  }, 10_000)
  it('复合命令（孙进程占着输出管道）超时也能及时返回，不会一直「运行中」', async () => {
    // sleep 是 sh 的子进程、不会被 exec 优化掉；以前只杀外层 sh，close 要等 sleep 自己结束（10 秒）
    const t0 = Date.now()
    const r = await run('sleep 10; echo never', { timeoutMs: 300 })
    expect(r).toMatchObject({ code: null, stopped: 'timeout' })
    expect(r.output).not.toContain('never')
    expect(Date.now() - t0).toBeLessThan(4000)
  }, 15_000)
  it('取消同样杀整棵进程树并及时返回', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = run('echo start; sleep 10; echo never', { signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    const r = await p
    expect(r).toMatchObject({ code: null, stopped: 'aborted' })
    expect(r.output).toContain('start')
    expect(Date.now() - t0).toBeLessThan(4000)
  }, 15_000)
  it('超过上限截断', async () => {
    const r = await run('head -c 5000 /dev/zero | tr "\\0" a', { maxBytes: 1000 })
    expect(r.output.length).toBeLessThanOrEqual(1000)
    expect(r.truncated).toBe(true)
  })
})
