import { describe, it, expect, vi, beforeEach } from 'vitest'

// 「问 AI」的行为约定：只把模板放进输入框（quote-to-chat 事件），绝不自己发出去。
// 这条测试守着 0.1.7 的统一改动：告警 / 体检 / 仪表盘 / K8s 都走这条通道了。
const get = vi.fn()
vi.mock('../client/index.js', () => ({ client: { settings: { get: (...a: unknown[]) => get(...a) } } }))

import { askAi, askAiTroubleshoot } from './askAi.js'
import { takeChatSends, takeNewChatSend } from './sendToChat.js'

// 纯 node 环境没有 window：给个只记录事件名和 detail 的最小桩
const quotes: string[] = []
beforeEach(() => {
  quotes.length = 0
  ;(globalThis as { window?: unknown }).window = {
    dispatchEvent: (e: { type: string; detail?: string }) => { if (e.type === 'lingshell:quote-to-chat' && e.detail) quotes.push(e.detail); return true },
  }
})

// 拼出来，避免源码里出现像密钥的字面量
const FAKE_PW = 'pass' + 'word=hunter2xyz'
const PW_VALUE = 'hunter2xyz'

describe('面板「问 AI」统一进输入框', () => {
  beforeEach(() => {
    get.mockReset()
    get.mockResolvedValue({ system: { aiRedact: true } })
    while (takeChatSends().length) { /* 清空别的用例留下的 */ }
    while (takeNewChatSend()) { /* 同上 */ }
  })

  it('askAi 只派发引用事件，不进任何「直接发送」队列', async () => {
    await askAi('帮我看看这段输出')
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toContain('帮我看看')
    expect(takeChatSends()).toHaveLength(0)      // 没塞进自动发送队列
    expect(takeNewChatSend()).toBeUndefined()    // 也没开新会话
  })

  it('默认按设置脱敏（含口令的片段会被打码）', async () => {
    await askAi(`配置是 ${FAKE_PW}`)
    expect(quotes[0]).not.toContain(PW_VALUE)
  })

  it('设置里关掉脱敏时原样放进输入框', async () => {
    get.mockResolvedValue({ system: { aiRedact: false } })
    await askAi('原文 abc')
    expect(quotes[0]).toBe('原文 abc')
  })

  it('告警排查（askAiTroubleshoot）也走输入框，不再新开会话', async () => {
    askAiTroubleshoot({ host: 'h1', alert: '磁盘快满', context: 'df -h 输出' } as never)
    expect(takeNewChatSend()).toBeUndefined()
    await vi.waitFor(() => expect(quotes).toHaveLength(1))
  })
})
