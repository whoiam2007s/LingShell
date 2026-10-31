import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningItem } from './ReasoningItem.js'
import type { ConvItem } from '../useConversation.js'

const base: ConvItem = { itemId: 'blk_1_1_0', kind: 'agent_reasoning', status: 'completed', text: '先看 nginx 日志' }
// 标题行的纯文本（去标签、合并空白）
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const render = (item: ConvItem, streaming = false, live = false) => renderToStaticMarkup(<ReasoningItem item={item} streaming={streaming} live={live} />)

describe('ReasoningItem 标题行：思考过程 · 时长 · 字数', () => {
  it('有开始结束：「思考过程 · 2.3秒 · 11 字」+ hover 精确时刻', () => {
    const at = new Date(2026, 9, 14, 15, 30, 0, 250).getTime()
    const html = render({ ...base, at, doneAt: at + 2_350 })
    expect(textOf(html)).toMatch(/^思考过程 · 2\.3秒 · 11 字/)
    expect(html).toContain('title="开始 15:30:00.2 → 结束 15:30:02.6"')
  })
  it('旧会话没有时间：只显示字数；千分位', () => {
    const html = render({ ...base, text: 'x'.repeat(1234) })
    expect(html).not.toContain('data-reasoning-duration')
    expect(textOf(html)).toMatch(/^思考过程 · 1,234 字/)
  })
  it('输出中（本轮进行中）：「正在思考…」+ 实时计时；本轮已结束的未完成块不计时', () => {
    const at = Date.now() - 3_000
    const live = textOf(render({ ...base, status: 'in_progress', at }, true, true))
    expect(live).toMatch(/^正在思考… · 3\.\d秒 · 11 字/)
    expect(render({ ...base, status: 'in_progress', at }, true, false)).not.toContain('data-reasoning-duration')
  })
  it('还没内容不显示字数', () => {
    expect(render({ ...base, status: 'in_progress', text: '' }, true, true)).not.toContain('data-reasoning-chars')
  })
  it('结束后仍为空的思考块不渲染；输出中的空块照常显示「正在思考…」', () => {
    expect(render({ ...base, text: '' }, false, false)).toBe('')
    expect(render({ ...base, text: '  \n' }, false, false)).toBe('')
    expect(textOf(render({ ...base, status: 'in_progress', text: '', at: Date.now() }, true, true))).toMatch(/^正在思考…/)
  })
})
