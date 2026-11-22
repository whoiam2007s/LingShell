// @vitest-environment jsdom
// 消息渲染的两个关键形态：宿主注入的后台任务通知必须显示成「系统条目」，不能冒充用户发言；
// 普通用户消息照常是气泡。回归背景：通知是以 user message 注入的，如果不多认一下，
// 用户会在自己的对话里看到一条「自己没说过」的消息。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { MessageItem } from './MessageItem.js'
import type { ConvItem } from '../useConversation.js'

const item = (over: Partial<ConvItem>): ConvItem => ({ kind: 'user_message', text: '', status: 'done', ...over } as ConvItem)

describe('消息条样式', () => {
  it('后台任务完成通知渲染成系统条目', () => {
    const { container } = render(
      <MessageItem item={item({ text: '[后台任务完成] 1 个任务已结束，全部成功。\n- abcd：退出码 0' })} streaming={false} />,
    )
    expect(container.querySelector('[data-system-notice]')).toBeTruthy()
    expect(container.textContent).toContain('后台任务完成')
  })

  it('普通用户消息不套系统条目样式', () => {
    const { container } = render(<MessageItem item={item({ text: '帮我看看磁盘' })} streaming={false} />)
    expect(container.querySelector('[data-system-notice]')).toBeNull()
    expect(container.textContent).toContain('帮我看看磁盘')
  })
})
