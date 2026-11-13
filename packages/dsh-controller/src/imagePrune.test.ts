import { describe, it, expect } from 'vitest'
import { offloadMessageImages, pruneOldImages, IMAGE_KEEP_MESSAGES } from './imagePrune.js'

const img = (id: string, offloaded?: boolean) => ({ type: 'image', attachment: { attachmentId: id }, ...(offloaded ? { offloaded: true } : {}) })

/** 假会话：nodes 是 seq 序列，events 按 seq 索引 */
function fakeSession(events: Record<number, any>, nodes: number[]) {
  const appended: { type: string; data: any }[] = []
  return {
    appended,
    session: {
      surface: { nodes },
      eventAt: (seq: number) => events[seq],
      deriveEventMessage: (ev: any) => (ev.type === 'user/message' ? ev.data : ev.data.message),
      append: (type: string, data: unknown) => { appended.push({ type, data }); return {} },
    },
  }
}
const userMsg = (...blocks: any[]) => ({ type: 'user/message', data: { content: blocks } })

describe('imagePrune', () => {
  it('offloadMessageImages：只标记指定下标的图片块，不动原消息', () => {
    const msg = { id: 'm1', content: [{ type: 'text', text: 'hi' }, img('a'), img('b')] }
    const out = offloadMessageImages(msg, [1])
    // 图片下标只数 image 块：a=0、b=1；text 块不占下标
    expect(out.content[2]).toEqual({ ...img('b'), offloaded: true })
    expect(out.content[0]).toBe(msg.content[0])
    expect(out.content[1]).toBe(msg.content[1])
    expect((msg.content[2] as any).offloaded).toBeUndefined()
    expect(out.id).toBe('m1')
  })

  it('offloadMessageImages：已卸载的再卸载 / 下标不存在都报错', () => {
    expect(() => offloadMessageImages({ content: [img('a', true)] }, [0])).toThrow(/already offloaded/)
    expect(() => offloadMessageImages({ content: [img('a')] }, [1])).toThrow(/does not exist/)
  })

  it('pruneOldImages：不超过保留条数时什么都不做', () => {
    const { session, appended } = fakeSession(
      { 1: userMsg(img('a')), 2: userMsg(img('b')), 3: userMsg(img('c')) }, [1, 2, 3],
    )
    expect(pruneOldImages(session as never, IMAGE_KEEP_MESSAGES)).toBe(false)
    expect(appended).toHaveLength(0)
  })

  it('pruneOldImages：超出时卸载最老的，保留最近 N 条', () => {
    const events: Record<number, any> = {
      1: userMsg(img('a')),
      2: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
      3: userMsg(img('b')),
      4: userMsg(img('c')),
      5: userMsg(img('d')),
    }
    const { session, appended } = fakeSession(events, [1, 2, 3, 4, 5])
    expect(pruneOldImages(session as never, 3)).toBe(true)
    expect(appended).toHaveLength(1)
    expect(appended[0]).toEqual({ type: 'image/offload', data: { targets: [{ seq: 1, imageIndexes: [0] }] } })
  })

  it('pruneOldImages：已卸载的图片不计入、纯文本消息不占保留名额', () => {
    const events: Record<number, any> = {
      1: userMsg(img('a', true)),   // 已卸载：不算「含图消息」
      2: userMsg({ type: 'text', text: 'no image' }),
      3: userMsg(img('b')),
      4: userMsg(img('c')),
      5: userMsg(img('d')),
      6: userMsg(img('e')),
    }
    const { session, appended } = fakeSession(events, [1, 2, 3, 4, 5, 6])
    expect(pruneOldImages(session as never, 3)).toBe(true)
    expect(appended[0].data.targets).toEqual([{ seq: 3, imageIndexes: [0] }])
  })

  it('pruneOldImages：一条消息里多张图时下标全部列出', () => {
    const events: Record<number, any> = {
      1: userMsg(img('a'), img('b'), { type: 'text', text: 'x' }, img('c')),
      2: userMsg(img('d')),
      3: userMsg(img('e')),
      4: userMsg(img('f')),
    }
    const { session, appended } = fakeSession(events, [1, 2, 3, 4])
    pruneOldImages(session as never, 3)
    expect(appended[0].data.targets).toEqual([{ seq: 1, imageIndexes: [0, 1, 2] }])
  })
})
