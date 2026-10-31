import { describe, it, expect } from 'vitest'
import * as zlib from 'node:zlib'

// DshController 依赖的 jsonl 持久化要 zstd（Electron 的 Node 才有），没有就跳过；动态导入，否则加载即报错
const hasZstd = typeof (zlib as Record<string, unknown>).zstdCompressSync === 'function'

const usageEv = (input: number, cacheRead: number, output: number) =>
  ({ type: 'assistant/message', seq: 1, time: 0, data: { usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output } } })

// 不 boot dsh：直接调 track，看 recordUsage 收到什么
describe.skipIf(!hasZstd)('DshController 用量钩子', () => {
  it('实时 usage 事件按会话的 provider/模型记一条；回放不记；巡检会话标 unattended', async () => {
    const { DshController } = await import('./DshController.js')
    const got: unknown[] = []
    const c = new DshController({ recordUsage: (u: unknown) => got.push(u), isUnattended: (id: string) => id === 'insp' } as never) as never as {
      track(id: string, s: unknown, ev: unknown, live: boolean): void
    }
    const live = () => ({ provider: 'qwen', model: 'qwen-plus', window: 131072, ctxTokens: 0, steps: 0, compactions: 0 })
    const s = live()
    c.track('s1', s, usageEv(96, 512, 97), true)
    c.track('s1', s, usageEv(80, 640, 10), false)                       // 重连回放
    c.track('s1', s, { type: 'step/start', seq: 2, time: 0 }, true)     // 非 usage
    c.track('insp', live(), usageEv(1, 2, 3), true)
    expect(got).toEqual([
      { sessionId: 's1', provider: 'qwen', model: 'qwen-plus', input: 96, cacheRead: 512, output: 97 },
      { sessionId: 'insp', provider: 'qwen', model: 'qwen-plus', input: 1, cacheRead: 2, output: 3, unattended: true },
    ])
    expect(s.ctxTokens).toBe(720)   // 回放照样更新上下文水位
  })
})
