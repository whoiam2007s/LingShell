import { describe, it, expect } from 'vitest'
import { MAX_BATCH, isLoopback, isWildcard, portBatchChip, portEntryChip } from './portsQuote.js'

const p = (port: number, addr = '0.0.0.0', over: Partial<{ proto: string; process: string; pid: number }> = {}) =>
  ({ proto: 'tcp', addr, port, process: 'nginx', pid: 1234, ...over })

describe('端口暴露判定', () => {
  it('通配地址算对外：0.0.0.0 / :: / [::] / *', () => {
    for (const a of ['0.0.0.0', '::', '[::]', '*']) expect(isWildcard(a)).toBe(true)
    for (const a of ['127.0.0.1', '10.0.0.5', '::1']) expect(isWildcard(a)).toBe(false)
  })

  it('回环判定', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('[::1]')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
  })
})

describe('单个端口 → chip', () => {
  it('chip 名是「地址:端口」，全文带主机/协议/进程/PID/探测工具', () => {
    const c = portEntryChip({ host: 'prod-web-01', entry: p(3306), tool: 'ss' })
    expect(c.name).toBe('0.0.0.0:3306')
    expect(c.text).toContain('prod-web-01')
    expect(c.text).toContain('所有网卡（对外）')
    expect(c.text).toContain('PID 1234')
    expect(c.text).toContain('探测工具：ss')
    expect(c.text).toContain('不是命令输出')
  })

  it('回环端口标「仅本机回环」；看不到进程时写明原因', () => {
    const c = portEntryChip({ host: '本机', entry: { proto: 'tcp', addr: '127.0.0.1', port: 5432 } })
    expect(c.name).toBe('127.0.0.1:5432')
    expect(c.text).toContain('仅本机回环')
    expect(c.text).toContain('进程看不到')
  })
})

describe('整表端口 → chip', () => {
  it('chip 名是条数，全文统计对外条数并按端口号排序', () => {
    const c = portBatchChip({ host: 'web', entries: [p(8080), p(22), p(5432, '127.0.0.1')] })
    expect(c.name).toBe('3 个端口')
    expect(c.text).toContain('3 条')
    expect(c.text).toContain('2 条监听所有网卡 = 对外暴露')
    expect(c.text.indexOf(':22')).toBeLessThan(c.text.indexOf(':5432'))
    expect(c.text.indexOf(':5432')).toBeLessThan(c.text.indexOf(':8080'))
    expect(c.text).toContain('【对外】')
  })

  it('最多 30 条，多余只报数（仍算在 Chip 名里）', () => {
    const many = Array.from({ length: MAX_BATCH + 3 }, (_, i) => p(1000 + i))
    const c = portBatchChip({ host: 'web', entries: many })
    expect(c.name).toBe('30 个端口')
    expect(c.text).toContain('另有 3 条未带')
    expect(c.text).toContain(`:${1000 + MAX_BATCH - 1} `)
    expect(c.text).not.toContain(`:${1000 + MAX_BATCH} `)
  })
})
