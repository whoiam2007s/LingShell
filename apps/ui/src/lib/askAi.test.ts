import { describe, it, expect, vi, beforeEach } from 'vitest'

// 面板「问 AI」的约定（0.1.7）：挂**上下文 chip**（和 git / @终端 同一套交互），
// 不是把整段文字塞进输入框，也不自己发出去。
const get = vi.fn()
vi.mock('../client/index.js', () => ({ client: { settings: { get: (...a: unknown[]) => get(...a) } } }))

import { askAi, askAiChip, askAiTroubleshoot } from './askAi.js'
import { takeChatSends, takeNewChatSend } from './sendToChat.js'

// 纯 node 环境没有 window：记录三类事件
const events: { type: string; detail: any }[] = []
beforeEach(() => {
  events.length = 0
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (e: { type: string; detail?: unknown }) => { events.push({ type: e.type, detail: e.detail }); return true },
  }
})

const lastCtx = () => events.filter((e) => e.type === 'lingshell:chat-context').at(-1)?.detail
// 拼出来，避免源码里出现像口令的字面量
const FAKE_PW = 'pass' + 'word=hunter2xyz'
const PW_VALUE = 'hunter2xyz'

describe('面板「问 AI」= 上下文 chip', () => {
  beforeEach(() => {
    get.mockReset()
    get.mockResolvedValue({ system: { aiRedact: true } })
    while (takeChatSends().length) { /* 清空 */ }
    while (takeNewChatSend()) { /* 同上 */ }
  })

  it('askAiChip 挂一个 chip：类型 / 名字 / 全文都对，并预填问题', async () => {
    await askAiChip({ ctx: 'ports', name: '0.0.0.0:3306', text: '端口事实', question: '该不该对外？' })
    const p = lastCtx()
    expect(p.chips).toHaveLength(1)
    expect(p.chips[0]).toMatchObject({ ctx: 'ports', name: '0.0.0.0:3306' })
    expect(p.text).toBe('该不该对外？')
    expect(takeChatSends()).toHaveLength(0)      // 不自动发送
    expect(takeNewChatSend()).toBeUndefined()    // 也不新开会话
  })

  it('默认按设置脱敏（chip 里也不带明文口令）', async () => {
    await askAiChip({ ctx: 'container', name: 'api', text: `环境 ${FAKE_PW}` })
    expect(lastCtx().chips[0].text).not.toContain(PW_VALUE)
  })

  it('设置里关掉脱敏时原样挂上去', async () => {
    get.mockResolvedValue({ system: { aiRedact: false } })
    await askAiChip({ ctx: 'history', name: 'ls', text: '原文 abc' })
    expect(lastCtx().chips[0].text).toBe('原文 abc')
  })

  it('告警排查也走 chip（类型 alert），不再新开会话', async () => {
    askAiTroubleshoot({ host: 'web-01', alert: '磁盘快满', context: 'df -h 输出' } as never)
    await vi.waitFor(() => expect(lastCtx()?.chips?.[0]?.ctx).toBe('alert'))
    expect(lastCtx().chips[0].name).toBe('web-01')
    expect(takeNewChatSend()).toBeUndefined()
  })

  it('老的整段文字通道仍然可用（只进输入框）', async () => {
    await askAi('帮我看看这段输出')
    expect(events.some((e) => e.type === 'lingshell:quote-to-chat')).toBe(true)
    expect(takeChatSends()).toHaveLength(0)
  })
})
