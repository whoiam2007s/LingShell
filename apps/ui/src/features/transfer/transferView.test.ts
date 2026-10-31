import { describe, it, expect } from 'vitest'
import type { TransferProgressEvent } from '@lingshell/shared'
import { detailLine, fmtEta, panelOrder, stateLabel, summarize } from './transferView.js'

const ev = (p: Partial<TransferProgressEvent>): TransferProgressEvent => ({
  type: 'transfer:progress', taskId: 't', kind: 'download', files: ['a'], stage: 'transfer', stagePercent: 0, overallPercent: 0, state: 'running', createdAt: 0, ...p,
})

describe('传输面板展示', () => {
  it('汇总：都有字节数按字节加权，否则平均百分比；排队中的不稀释进度', () => {
    expect(summarize([ev({ bytesDone: 10, bytesTotal: 100 }), ev({ bytesDone: 90, bytesTotal: 100 }), ev({ state: 'done' })]))
      .toEqual({ active: 2, percent: 50, failed: 0 })
    // 一个跑 80% + 一个排队：只看跑着的（以前把排队算 0，显示 40%）
    expect(summarize([ev({ overallPercent: 80 }), ev({ state: 'queued', overallPercent: 0 }), ev({ state: 'error' })]))
      .toEqual({ active: 2, percent: 80, failed: 1 })
    expect(summarize([ev({ state: 'queued' }), ev({ state: 'queued' })])).toEqual({ active: 2, percent: 0, failed: 0 })
    expect(summarize([])).toEqual({ active: 0, percent: 100, failed: 0 })
  })
  it('状态文字与细节', () => {
    expect(stateLabel(ev({ state: 'queued' }))).toBe('排队中')
    expect(stateLabel(ev({ stage: 'pack' }))).toBe('扫描目录')
    expect(stateLabel(ev({ kind: 'upload', stage: 'pack' }))).toBe('打包加密')
    expect(stateLabel(ev({ state: 'cancelled', stage: 'error' }))).toBe('已取消')
    expect(detailLine(ev({ bytesDone: 1024, bytesTotal: 4096, fileDone: 1, fileTotal: 3, speed: 2048, etaSec: 75 })))
      .toBe('1.0K / 4.0K · 1/3 个文件 · 2.0K/s · 剩余 1 分 15 秒')
    expect(detailLine(ev({ state: 'done', bytesDone: 10, bytesTotal: 10, speed: 5 }))).toBe('10B / 10B')
    expect([fmtEta(5), fmtEta(3700), fmtEta(undefined)]).toEqual(['5 秒', '1 小时 1 分', ''])
    expect(stateLabel(ev({ state: 'queued', queuePos: 2 }))).toBe('排队中 · 第 2 个')
  })
  it('面板顺序：进行中 → 排队中（按队内位置）→ 已结束（新的在上）', () => {
    const list = [
      ev({ taskId: 'd1', state: 'done', createdAt: 1 }), ev({ taskId: 'q2', state: 'queued', queuePos: 2, createdAt: 2 }),
      ev({ taskId: 'r', state: 'running', createdAt: 3 }), ev({ taskId: 'q1', state: 'queued', queuePos: 1, createdAt: 4 }),
      ev({ taskId: 'e', state: 'error', createdAt: 5 }),
    ]
    expect(panelOrder(list).map((t) => t.taskId)).toEqual(['r', 'q1', 'q2', 'e', 'd1'])
  })
})
