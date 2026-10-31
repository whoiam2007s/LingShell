import { describe, it, expect, beforeEach } from 'vitest'
import { sendToNewChat, takeNewChatSend } from './sendToChat.js'

// 纯 node 环境没有 window：sendToChat 只在派发事件时用到，给个最小桩即可测队列
beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { dispatchEvent: () => true }
})

describe('新会话发送队列', () => {
  it('一个事件取一条：连着排两条，先排的不会丢', () => {
    while (takeNewChatSend()) { /* 清空别的用例可能留下的 */ }
    sendToNewChat('第一条', 'A')
    sendToNewChat('第二条', 'B')
    expect(takeNewChatSend()).toEqual({ text: '第一条', title: 'A' })
    expect(takeNewChatSend()).toEqual({ text: '第二条', title: 'B' })
    expect(takeNewChatSend()).toBeUndefined()
  })
})
