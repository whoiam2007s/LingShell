import { describe, it, expect } from 'vitest'
import { ReplayBuffer, chunksUpTo, replayCapOf, REPLAY_DEFAULT_MB } from './replay.js'

describe('ReplayBuffer', () => {
  it('按时间存块；50ms 内同尺寸的合并，尺寸变了另起一块', () => {
    const b = new ReplayBuffer(1000)
    b.push(0, 'a', 80, 24); b.push(30, 'b', 80, 24); b.push(200, 'c', 80, 24); b.push(210, 'd', 100, 30)
    expect(b.chunks()).toEqual([{ t: 0, data: 'ab', cols: 80, rows: 24 }, { t: 200, data: 'c', cols: 80, rows: 24 }, { t: 210, data: 'd', cols: 100, rows: 30 }])
    expect(b.size).toBe(4)
  })
  it('超上限从最早的丢起；单块超上限只留尾部', () => {
    const b = new ReplayBuffer(10)
    for (let i = 0; i < 5; i++) b.push(i * 100, '1234', 80, 24)
    expect(b.chunks().map((c) => c.t)).toEqual([300, 400])
    expect(b.size).toBe(8)
    b.push(1000, 'x'.repeat(25) + 'END', 80, 24)
    expect(b.chunks()).toEqual([{ t: 1000, data: 'xxxxxxxEND', cols: 80, rows: 24 }])
    expect(b.size).toBe(10)
  })
  it('上限 0 = 关：不存，改成 0 清空', () => {
    const b = new ReplayBuffer(0)
    b.push(0, 'a', 80, 24)
    expect(b.chunks()).toEqual([])
    b.setCap(100); b.push(0, 'a', 80, 24); b.push(500, 'b', 80, 24)
    b.setCap(1)
    expect(b.chunks().map((c) => c.data)).toEqual(['b'])
    b.setCap(0)
    expect(b.chunks()).toEqual([]); expect(b.size).toBe(0)
  })
  it('大量块：内部数组定期压缩，内容不变', () => {
    const b = new ReplayBuffer(3000)
    for (let i = 0; i < 5000; i++) b.push(i * 100, 'ab', 80, 24)
    const c = b.chunks()
    expect(c).toHaveLength(1500)
    expect(c[0].t).toBe(3500 * 100)
  })
})

describe('chunksUpTo / replayCapOf', () => {
  it('二分出 t 之前（含）的块数', () => {
    const c = [0, 100, 100, 250].map((t) => ({ t, data: '', cols: 80, rows: 24 }))
    expect([-1, 0, 99, 100, 249, 250, 9e9].map((t) => chunksUpTo(c, t))).toEqual([0, 1, 1, 3, 3, 4, 4])
  })
  it('MB → 字节：缺省 4MB、夹在 0–64', () => {
    expect(replayCapOf(undefined)).toBe(REPLAY_DEFAULT_MB * 1024 * 1024)
    expect(replayCapOf(0)).toBe(0)
    expect(replayCapOf(-3)).toBe(0)
    expect(replayCapOf(999)).toBe(64 * 1024 * 1024)
    expect(replayCapOf(0.5)).toBe(512 * 1024)
  })
})
