// @vitest-environment jsdom
// 「资源管理器 → 添加到对话」的订阅链路。
// 回归背景：订阅曾经持着首次渲染时的处理函数，那时会话还在异步恢复（sessionId 为空），
// addPaths 末尾的防串会话守卫会把结果丢掉 —— 按钮点了毫无反应，且没有任何报错。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// client 是模块单例（createClient()），这里整体替换掉，只留附件相关方法
const kinds = vi.fn(async (ps: string[]) => ps.map(() => 'file'))
vi.mock('../../client/index.js', () => ({
  client: {
    attachments: {
      kinds: (ps: string[]) => kinds(ps),
      imageFile: vi.fn(),
      pickFiles: vi.fn(async () => []),
      pickDirs: vi.fn(async () => []),
      pickImages: vi.fn(async () => []),
      clipboardPaths: vi.fn(async () => []),
    },
    settings: { get: vi.fn(async () => ({})) },
  },
}))

const { useAttachments } = await import('./useAttachments.js')
const { attachPathsToChat } = await import('../../lib/localPaths.js')

describe('「添加到对话」订阅', () => {
  beforeEach(() => { kinds.mockClear() })

  it('会话异步恢复（先空、后由 s1）之后点「添加到对话」，附件要落到草稿里', async () => {
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useAttachments(false, sid),
      { initialProps: { sid: '' } },        // 首帧：会话还没恢复
    )
    rerender({ sid: 's1' })                 // 会话恢复
    expect(result.current.items).toHaveLength(0)

    await act(async () => { attachPathsToChat(['/tmp/a.txt']) })

    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.items[0]).toMatchObject({ kind: 'file', name: 'a.txt' })
    expect(kinds).toHaveBeenCalledWith(['/tmp/a.txt'])
  })

  it('文件还在读的时候切了会话：结果不落到新会话的草稿里', async () => {
    let release: (v: string[]) => void = () => {}
    kinds.mockImplementationOnce(() => new Promise<string[]>((r) => { release = r }))
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useAttachments(false, sid),
      { initialProps: { sid: 's1' } },
    )

    await act(async () => { attachPathsToChat(['/tmp/b.txt']) })   // kinds 挂住
    rerender({ sid: 's2' })                                       // 期间切了会话
    await act(async () => { release(['file']); await Promise.resolve() })

    await waitFor(() => expect(result.current.items).toHaveLength(0))
  })

  it('同一路径重复添加只留一个', async () => {
    const { result } = renderHook(() => useAttachments(false, 's1'))
    await act(async () => { attachPathsToChat(['/tmp/c.txt']) })
    await act(async () => { attachPathsToChat(['/tmp/c.txt']) })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
  })
})
