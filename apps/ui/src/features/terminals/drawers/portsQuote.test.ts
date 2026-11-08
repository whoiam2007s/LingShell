import { describe, it, expect } from 'vitest'
import { MAX_BATCH, isLoopback, isWildcard, portBatchQuote, portEntryQuote } from './portsQuote.js'

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

describe('单个端口的引用文本', () => {
  it('写明监听地址的性质、进程与探测工具', () => {
    const q = portEntryQuote({ host: 'prod-web-01', entry: p(3306), tool: 'ss' })
    expect(q).toContain('prod-web-01')
    expect(q).toContain('3306')
    expect(q).toContain('所有网卡（对外）')
    expect(q).toContain('nginx（PID 1234）')
    expect(q).toContain('探测工具：ss')
    expect(q).toContain('不是命令输出')
  })

  it('回环端口标「仅本机回环」；看不到进程时给明确说明', () => {
    const q = portEntryQuote({ host: '本机', entry: { proto: 'tcp', addr: '127.0.0.1', port: 5432 } })
    expect(q).toContain('仅本机回环')
    expect(q).toContain('看不到进程')
    expect(q).not.toContain('探测工具')
  })
})

describe('整表引用文本', () => {
  it('统计对外条数，并按端口号排序', () => {
    const q = portBatchQuote({ host: 'web', entries: [p(8080), p(22), p(5432, '127.0.0.1')] })
    expect(q).toContain('其中 2 条监听所有网卡 = 对外暴露')
    // 按端口号升序：22 → 5432 → 8080
    expect(q.indexOf(':22')).toBeLessThan(q.indexOf(':5432'))
    expect(q.indexOf(':5432')).toBeLessThan(q.indexOf(':8080'))
    expect(q).toContain('【对外】')
  })

  it('最多 30 条，多余只报数', () => {
    const many = Array.from({ length: MAX_BATCH + 3 }, (_, i) => p(1000 + i))
    const q = portBatchQuote({ host: 'web', entries: many })
    expect(q).toContain('后面还有 3 条没带上')
    expect(q).toContain(`:${1000 + MAX_BATCH - 1} `)          // 第 30 条（1029）带上
    expect(q).not.toContain(`:${1000 + MAX_BATCH} `)          // 第 31 条（1030）起不带
    expect(q).not.toContain(`:${1000 + MAX_BATCH + 2} `)
  })
})
