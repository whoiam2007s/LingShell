import { describe, it, expect } from 'vitest'
import type { CommandHistoryEntry } from '@lingshell/shared'
import { MAX_BATCH, historyBatchQuote, historyEntryQuote } from './historyQuote.js'

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

describe('命令历史 → 对话的引用文本', () => {
  it('单条：带主机、终端、来源、时间与命令原文', () => {
    const q = historyEntryQuote({ host: 'prod-web-01', entry: e(1) })
    expect(q).toContain('prod-web-01')
    expect(q).toContain('本地 1')
    expect(q).toContain('我手敲')
    expect(q).toContain('cmd-1')
    expect(q).toContain('不是命令输出')
    expect(q).toContain('排查步骤')
  })

  it('单条：AI 执行的命令标明来源', () => {
    expect(historyEntryQuote({ host: '本机', entry: e(2, { source: 'ai' }) })).toContain('AI 执行')
  })

  it('批量：按时间先后排序（面板默认最新在前）', () => {
    const q = historyBatchQuote({ host: '本机', entries: [e(3), e(1), e(2)] })
    const i1 = q.indexOf('cmd-1')
    const i2 = q.indexOf('cmd-2')
    const i3 = q.indexOf('cmd-3')
    expect(i1).toBeGreaterThan(-1)
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
  })

  it('批量：最多 10 条，多余只报数不带上', () => {
    const many = Array.from({ length: MAX_BATCH + 4 }, (_, i) => e(i + 1))
    const q = historyBatchQuote({ host: '本机', entries: many })
    expect(q).toContain(`${MAX_BATCH} 条记录`)
    expect(q).toContain('还有 4 条没带上')
    expect(q).not.toContain(`cmd-${MAX_BATCH + 1}`)
  })

  it('批量：明确声明没有退出码，避免模型假设都成功', () => {
    expect(historyBatchQuote({ host: '本机', entries: [e(1)] })).toContain('没有退出码')
  })
})
