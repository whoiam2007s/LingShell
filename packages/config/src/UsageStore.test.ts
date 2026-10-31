import { describe, it, expect } from 'vitest'
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeUsage, DEFAULT_USAGE_PRICES } from '@lingshell/shared'
import { UsageStore } from './UsageStore.js'
import { SettingsStore, type Encryptor } from './SettingsStore.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-13T12:00:00Z')
const rec = (atMs: number, sessionId = 's1') => ({ at: new Date(atMs).toISOString(), sessionId, provider: 'deepseek', model: 'm', input: 10, cacheRead: 20, output: 5 })
const lines = (dir: string) => readFileSync(join(dir, 'usage.jsonl'), 'utf8').trim().split('\n')

describe('UsageStore', () => {
  it('追加写，重开后仍在；半行跳过；可直接聚合', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    const s = new UsageStore(dir, 100, 180, () => NOW)
    s.add(rec(NOW - 1000)); s.add(rec(NOW, 's2'))
    appendFileSync(join(dir, 'usage.jsonl'), '{"at":"x","sess')
    const again = new UsageStore(dir, 100, 180, () => NOW)
    expect(again.list().map((r) => r.sessionId)).toEqual(['s1', 's2'])
    expect(summarizeUsage(again.list(), DEFAULT_USAGE_PRICES, 'all').totals).toMatchObject({ requests: 2, input: 20, cacheRead: 40, output: 10 })
  })

  it('载入时裁掉超过天数的，并重写文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    const s = new UsageStore(dir, 100, 180, () => NOW)
    s.add(rec(NOW - 200 * DAY, 'old')); s.add(rec(NOW - 10 * DAY, 'new'))
    expect(new UsageStore(dir, 100, 180, () => NOW).list().map((r) => r.sessionId)).toEqual(['new'])
    expect(lines(dir)).toHaveLength(1)
  })

  it('超过行数上限裁掉最旧的', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    const s = new UsageStore(dir, 3, 180, () => NOW)
    for (const id of ['1', '2', '3', '4', '5']) s.add(rec(NOW, id))
    expect(new UsageStore(dir, 3, 180, () => NOW).list().map((r) => r.sessionId)).toEqual(['3', '4', '5'])
    expect(lines(dir)).toHaveLength(3)
  })
})

const plain: Encryptor = { available: () => false, encrypt: (p) => p, decrypt: (c) => c }

describe('SettingsStore 单价', () => {
  it('默认空表；保存时规整（去空行、去重、负数视为未填），settings.save 不抹掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    const s = new SettingsStore(dir, plain)
    expect(s.getUsagePrices()).toEqual({ currency: 'CNY', models: [] })
    s.saveUsagePrices({ currency: 'USD', models: [
      { provider: 'deepseek', model: ' m1 ', input: 1, output: -2 },
      { provider: 'deepseek', model: '', input: 1 },
      { provider: 'deepseek', model: 'm1', input: 3, cacheRead: 0.5 },
    ] })
    const want = { currency: 'USD', models: [{ provider: 'deepseek', model: 'm1', input: 3, cacheRead: 0.5, output: undefined }] }
    expect(s.getUsagePrices()).toEqual(want)
    s.save({ provider: 'deepseek', model: 'x', baseUrl: 'https://x' })
    expect(s.getUsagePrices()).toEqual(want)
    expect(s.get().model).toBe('x')
  })
})
