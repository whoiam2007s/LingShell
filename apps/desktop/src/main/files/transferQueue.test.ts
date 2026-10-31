import { describe, it, expect } from 'vitest'
import type { TransferProgressEvent } from '@lingshell/shared'
import { TransferQueue, clampConcurrency, etaOf, nextSpeed, type TaskCtx } from './transferQueue.js'

// 手动控制结束的任务：run 返回的 Promise 由测试决定何时 resolve / reject
function gate() {
  let resolve!: (v?: unknown) => void, reject!: (e: unknown) => void
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(concurrency = 2, now = () => Date.now()) {
  const evs: TransferProgressEvent[] = []
  const q = new TransferQueue((ev) => evs.push(ev), () => concurrency, now)
  const state = (id: string) => q.list().find((t) => t.taskId === id)?.state
  return { q, evs, state }
}

describe('TransferQueue 调度', () => {
  it('按并发上限执行，其余排队；先来先跑', async () => {
    const { q, state } = setup(2)
    const gs = [gate(), gate(), gate()]
    const ids: string[] = []
    const ps = gs.map((g, i) => q.enqueue({ kind: 'download', files: [`f${i}`], run: () => g.p }, (id) => ids.push(id)))
    expect(ids.map(state)).toEqual(['running', 'running', 'queued'])
    expect(q.activeCount()).toBe(3)
    gs[0].resolve('ok')
    await expect(ps[0]).resolves.toBe('ok')
    expect(ids.map(state)).toEqual(['done', 'running', 'running'])
    gs[1].resolve(); gs[2].resolve()
    await Promise.all(ps)
    expect(q.activeCount()).toBe(0)
  })

  it('取消排队中的：不运行，立即「已取消」；取消进行中的：发中止信号', async () => {
    const { q, state } = setup(1)
    let ran = false, sig: AbortSignal | undefined
    let a = '', b = ''
    const pa = q.enqueue({ kind: 'upload', files: ['a'], run: ({ signal }) => new Promise((_r, rej) => { sig = signal; signal.addEventListener('abort', () => rej(new Error('x'))) }) }, (id) => { a = id })
    const pb = q.enqueue({ kind: 'upload', files: ['b'], run: async () => { ran = true } }, (id) => { b = id })
    q.cancel(b)
    await expect(pb).rejects.toThrow('已取消')
    expect(ran).toBe(false)
    q.cancel(a)
    expect(sig?.aborted).toBe(true)
    await expect(pa).rejects.toThrow('已取消')
    expect([state(a), state(b)]).toEqual(['cancelled', 'cancelled'])
    expect(q.list().find((t) => t.taskId === a)?.error).toBe('已取消')
  })

  it('标了不可取消（远端解压中）的只有 force 才中止', async () => {
    const { q, state } = setup()
    let id = '', sig: AbortSignal | undefined
    const g = gate()
    const p = q.enqueue({ kind: 'upload', files: ['a'], run: (ctx: TaskCtx) => { sig = ctx.signal; ctx.progress({ stage: 'extract', cancellable: false }); return g.p } }, (x) => { id = x })
    q.cancel(id)
    expect(sig?.aborted).toBe(false)
    q.cancelAll(true)
    expect(sig?.aborted).toBe(true)
    g.reject(new Error('closed'))
    await expect(p).rejects.toThrow('已取消')
    expect(state(id)).toBe('cancelled')
  })

  it('失败可重试：按原参数重新排队并跑完；清除已结束只删已结束的', async () => {
    const { q, state, evs } = setup()
    let n = 0, id = ''
    const p = q.enqueue({ kind: 'download', files: ['a'], target: '/dl', reveal: { local: '/dl/a' }, run: async () => { if (++n === 1) throw new Error('网络断了') } }, (x) => { id = x })
    await expect(p).rejects.toThrow('网络断了')
    expect(q.list()[0].error).toBe('网络断了')
    q.retry(id)
    expect(state(id)).not.toBe('error')
    await tick()
    expect(state(id)).toBe('done')
    expect(n).toBe(2)
    const last = evs.at(-1)!
    expect([last.state, last.overallPercent, last.reveal, last.target]).toEqual(['done', 100, { local: '/dl/a' }, '/dl'])
    q.retry(id)   // 已完成的不重试
    expect(state(id)).toBe('done')
    const g = gate()
    q.enqueue({ kind: 'download', files: ['b'], run: () => g.p })
    q.clearFinished()
    expect(q.list().map((t) => t.files[0])).toEqual(['b'])
    g.resolve()
  })

  it('排队顺序：优先传输移到队首、上下移动；进行中的不受影响；事件带队内位置', async () => {
    const { q, state, evs } = setup(1)
    const order: string[] = []
    const gs = [gate(), gate(), gate(), gate()]
    const ids: string[] = []
    const ps = gs.map((g, i) => q.enqueue({ kind: 'upload', files: [`f${i}`], run: () => { order.push(`f${i}`); return g.p } }, (id) => ids.push(id)))
    const pos = (id: string) => q.list().find((t) => t.taskId === id)?.queuePos
    expect(ids.map(pos)).toEqual([undefined, 1, 2, 3])
    q.reorder(ids[3], 'top')                 // f3 优先
    expect(state(ids[0])).toBe('running')    // 进行中的不动
    expect(ids.map(pos)).toEqual([undefined, 2, 3, 1])
    expect(evs.at(-1)?.queuePos).toBeDefined()
    q.reorder(ids[1], 'down'); q.reorder(ids[1], 'down')   // 已在队尾再下移无效
    expect(ids.map(pos)).toEqual([undefined, 3, 2, 1])
    q.reorder(ids[2], 'up')
    q.reorder(ids[0], 'top')                 // 进行中的：无效
    expect(ids.map(pos)).toEqual([undefined, 3, 1, 2])
    for (const i of [0, 2, 3, 1]) { gs[i].resolve(); await ps[i] }
    expect(order).toEqual(['f0', 'f2', 'f3', 'f1'])
    expect(q.list().every((t) => t.queuePos === undefined)).toBe(true)
  })

  it('速度与剩余时间：按时间采样，平滑；只有字节变化时节流事件', async () => {
    let t = 1000
    const { q, evs } = setup(2, () => t)
    let ctx!: TaskCtx
    const g = gate()
    q.enqueue({ kind: 'download', files: ['a'], run: (c) => { ctx = c; return g.p } })
    ctx.progress({ stage: 'transfer', bytesDone: 0, bytesTotal: 10_000 })
    const before = evs.length
    t += 100; ctx.progress({ bytesDone: 500 })   // 100ms 内：不发事件
    expect(evs.length).toBe(before)
    t += 900; ctx.progress({ bytesDone: 1000 })  // 第一次采样只记基线（续传一开始的已有字节不算瞬时速度）
    expect(evs.at(-1)!.speed).toBeUndefined()
    t += 1000; ctx.progress({ bytesDone: 1900 }) // 第二段 1s 传 900：900 B/s，剩余 9 秒
    const e = evs.at(-1)!
    expect(e.speed).toBe(900)
    expect(e.etaSec).toBe(9)
    g.resolve()
    await tick()
    expect(evs.at(-1)!.speed).toBeUndefined()
  })
})

describe('纯函数', () => {
  it('nextSpeed / etaOf / clampConcurrency', () => {
    expect(nextSpeed(undefined, 2000, 1000)).toBe(2000)
    expect(nextSpeed(1000, 2000, 1000)).toBeCloseTo(1300)
    expect(etaOf(50, 100, 10)).toBe(5)
    expect(etaOf(50, undefined, 10)).toBeUndefined()
    expect(etaOf(50, 100, 0)).toBeUndefined()
    expect([clampConcurrency(0), clampConcurrency(9), clampConcurrency(3), clampConcurrency('x')]).toEqual([1, 5, 3, 2])
  })
})
