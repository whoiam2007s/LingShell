import { describe, it, expect } from 'vitest'
import * as zlib from 'node:zlib'

// DshController 依赖的 jsonl 持久化要 zstd（Electron 的 Node 才有），没有就跳过；动态导入，否则加载即报错
const hasZstd = typeof (zlib as Record<string, unknown>).zstdCompressSync === 'function'
const load = () => import('./DshController.js')

// 不 boot dsh：直接往 sessions 里塞假的 Live，只测 LRU 释放挑谁
async function setup(unattended = new Set<string>()) {
  const { DshController } = await load()
  const c = new DshController({ isUnattended: (id: string) => unattended.has(id) } as never) as never as {
    sessions: Map<string, unknown>; pendingAsk: Map<string, { sessionId: string }>; evictIdle(keep: string): Promise<void>
  }
  const disposed: string[] = []
  const add = (id: string, lastUsed: number, turning = false) =>
    c.sessions.set(id, { info: { id }, lastUsed, turning, handle: { dispose: async () => { disposed.push(id) } } })
  return { c, add, disposed }
}

describe.skipIf(!hasZstd)('会话 LRU 释放', () => {
  it('超限时释放最久没用的空闲会话；在跑/待授权/巡检/刚用到的不动', async () => {
    const { MAX_LIVE_SESSIONS } = await load()
    const { c, add, disposed } = await setup(new Set(['insp']))
    add('running', 1, true)       // 最旧但在跑
    add('asking', 2)              // 有待授权
    add('insp', 3)                // 无人值守巡检
    add('old', 4)
    add('mid', 5)
    add('new', 0)                 // 刚 spawn 的（keep），lastUsed 再小也不释放
    c.pendingAsk.set('k', { sessionId: 'asking' })
    expect(c.sessions.size).toBe(MAX_LIVE_SESSIONS + 1)
    await c.evictIdle('new')
    expect(disposed).toEqual(['old'])
    expect(c.sessions.size).toBe(MAX_LIVE_SESSIONS)
  })

  it('全都忙就暂时超限', async () => {
    const { MAX_LIVE_SESSIONS } = await load()
    const { c, add, disposed } = await setup()
    for (let i = 0; i <= MAX_LIVE_SESSIONS; i++) add(`s${i}`, i, true)
    await c.evictIdle('s0')
    expect(disposed).toEqual([])
  })
})
