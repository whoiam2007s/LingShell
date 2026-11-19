import { describe, expect, it } from 'vitest'
import { TerminalManager } from './TerminalManager.js'

// 重启恢复布局时要复用上次的终端 id：这样对话历史里的 term_xxxx 继续有效
describe('终端 id 复用（真实终端）', () => {
  it('createLocal 指定 id 时沿用它', async () => {
    const m = new TerminalManager()
    const info = m.createLocal({ id: 'term_abcd' })
    try {
      expect(info.id).toBe('term_abcd')
    } finally {
      await m.close(info.id).catch(() => {})
    }
  }, 30000)

  it('id 已被占用 / 格式不对时退回新生成，不报错', async () => {
    const m = new TerminalManager()
    const a = m.createLocal({ id: 'term_abcd' })
    const b = m.createLocal({ id: 'term_abcd' })      // 撞车
    const c = m.createLocal({ id: 'not-a-term-id' })  // 格式不对
    try {
      expect(a.id).toBe('term_abcd')
      expect(b.id).not.toBe('term_abcd')
      expect(b.id).toMatch(/^term_[0-9a-z]{4,}$/)
      expect(c.id).toMatch(/^term_[0-9a-z]{4,}$/)
    } finally {
      for (const t of [a, b, c]) await m.close(t.id).catch(() => {})
    }
  }, 30000)
})
