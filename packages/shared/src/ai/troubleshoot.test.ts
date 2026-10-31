import { describe, it, expect } from 'vitest'
import { troubleshootPrompt, troubleshootTitle, TROUBLESHOOT_CONTEXT_MAX } from './troubleshoot.js'

describe('troubleshootPrompt', () => {
  it('「<主机> 出现 <告警>：<上下文>，请排查原因」，带终端 / 主机 id 便于 AI 定位', () => {
    const t = troubleshootPrompt({ host: 'web-1', terminalId: 'term_1', hostId: 'h1', alert: '关键字告警「ERROR」', context: 'line1\nERROR boom' })
    expect(t.split('\n')[0]).toBe('「web-1」（终端 term_1，已保存主机 id：h1）出现 关键字告警「ERROR」：')
    expect(t).toContain('```\nline1\nERROR boom\n```\n请排查原因。')
    expect(t).toContain('先只读排查')
    expect(t).not.toContain('create_terminal')
  })
  it('没有上下文：一句话结尾；只有主机 id 时提示用 create_terminal 连上去', () => {
    const t = troubleshootPrompt({ host: 'db-1', hostId: 'h2', alert: '磁盘 / 已用 96%' })
    expect(t.split('\n')[0]).toBe('「db-1」（已保存主机 id：h2）出现 磁盘 / 已用 96%，请排查原因。')
    expect(t).toContain('create_terminal')
  })
  it('上下文太长取末尾', () => {
    const t = troubleshootPrompt({ host: 'h', alert: 'a', context: 'x'.repeat(TROUBLESHOOT_CONTEXT_MAX + 100) + 'END' })
    expect(t).toContain('END')
    expect(t.length).toBeLessThan(TROUBLESHOOT_CONTEXT_MAX + 300)
  })
  it('会话标题截短', () => {
    expect(troubleshootTitle({ host: 'web-1', alert: '磁盘 /\n已用 96%' })).toBe('排查：web-1 磁盘 / 已用 96%')
    expect(troubleshootTitle({ host: 'w', alert: 'x'.repeat(100) }).length).toBe(30)
  })
})
