import { describe, it, expect } from 'vitest'
import type { CommandHistoryEntry } from '@lingshell/shared'
import { MAX_BATCH, historyBatchChip, historyEntryChip } from './historyQuote.js'

const e = (n: number, over: Partial<CommandHistoryEntry> = {}): CommandHistoryEntry => ({
  command: `cmd-${n}`,
  terminalId: 'term_1',
  terminalTitle: '本地 1',
  hostKey: 'local',
  // 真 ISO 串（零填充），排序才和真实数据一致
  at: new Date(Date.UTC(2026, 10, 8, 10, 0, n)).toISOString(),
  source: 'user',
  ...over,
})

describe('命令历史 → 上下文 chip', () => {
  it('单条：chip 名是命令本身，全文带主机、终端 id、来源、时间', () => {
    const c = historyEntryChip({ host: 'prod-web-01', entry: e(1) })
    expect(c.name).toBe('cmd-1')
    expect(c.text).toContain('prod-web-01')
    expect(c.text).toContain('本地 1')
    expect(c.text).toContain('term_1')          // 终端 id 也带上
    expect(c.text).toContain('local')           // 主机标识
    expect(c.text).toContain('我手敲')
    expect(c.text).toContain('没有退出码')        // 明确说明，别让模型以为失败了
  })

  it('chip 名超长命令截断', () => {
    const long = 'echo ' + 'a'.repeat(200)
    expect(historyEntryChip({ host: '本机', entry: e(1, { command: long }) }).name.length).toBeLessThanOrEqual(49)
  })

  it('单条：AI 执行的命令标明来源', () => {
    expect(historyEntryChip({ host: '本机', entry: e(2, { source: 'ai' }) }).text).toContain('AI 执行')
  })

  it('批量：chip 名是条数，全文按时间先后排序', () => {
    const c = historyBatchChip({ host: '本机', entries: [e(3), e(1), e(2)] })
    expect(c.name).toBe('3 条命令')
    const i1 = c.text.indexOf('cmd-1')
    const i2 = c.text.indexOf('cmd-2')
    const i3 = c.text.indexOf('cmd-3')
    expect(i1).toBeGreaterThan(-1)
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })

  it('批量：最多 10 条，多余只报数不带上', () => {
    const many = Array.from({ length: MAX_BATCH + 4 }, (_, i) => e(i + 1))
    const c = historyBatchChip({ host: '本机', entries: many })
    expect(c.name).toBe(`${MAX_BATCH} 条命令`)
    expect(c.text).toContain('另有 4 条未带')
    expect(c.text).not.toContain(`cmd-${MAX_BATCH + 1}`)
  })

  it('批量：明确声明没有退出码，避免模型假设都成功', () => {
    expect(historyBatchChip({ host: '本机', entries: [e(1)] }).text).toContain('没有退出码')
  })
})
