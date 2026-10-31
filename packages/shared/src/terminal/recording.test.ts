import { describe, it, expect } from 'vitest'
import { castHeaderLine, castEventLine, parseCast, limitIdle, parseSize } from './recording.js'

describe('asciicast 解析', () => {
  it('header + 事件往返，坏行/未知类型跳过', () => {
    const text = castHeaderLine({ version: 2, width: 120, height: 40, timestamp: 1700000000, title: '本地 1' })
      + castEventLine(0.5, 'o', 'hi\r\n') + castEventLine(1, 'i', 'ls\r') + 'garbage\n' + '[2,"x","?"]\n'
      + castEventLine(2.5, 'r', '100x30') + '[3,"o","trunc'
    const { header, events } = parseCast(text)
    expect(header).toMatchObject({ version: 2, width: 120, height: 40, title: '本地 1' })
    expect(events).toEqual([[0.5, 'o', 'hi\r\n'], [1, 'i', 'ls\r'], [2.5, 'r', '100x30']])
  })
  it('无 header 用默认尺寸', () => {
    expect(parseCast('').header).toMatchObject({ width: 80, height: 24 })
  })
  it('limitIdle 压缩长空闲', () => {
    expect(limitIdle([[1, 'o', 'a'], [10, 'o', 'b'], [10.5, 'o', 'c']], 2)).toEqual([[1, 'o', 'a'], [3, 'o', 'b'], [3.5, 'o', 'c']])
  })
  it('parseSize', () => {
    expect(parseSize('100x30')).toEqual([100, 30])
    expect(parseSize('bad')).toBeUndefined()
  })
})
