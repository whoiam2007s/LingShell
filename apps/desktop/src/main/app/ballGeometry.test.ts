import { describe, it, expect } from 'vitest'
import { BALL_SIZE as S, expandBounds, fixBall, hiddenPos, snapBall, areaOf } from './ballGeometry.js'

const main = { x: 0, y: 0, width: 1920, height: 1040 }          // 主屏（任务栏占 40）
const right = { x: 1920, y: 0, width: 1280, height: 984 }       // 右边第二块屏

describe('snapBall', () => {
  it('靠近左 / 右边吸附并记边', () => {
    expect(snapBall({ x: 10, y: 300 }, [main])).toEqual({ x: 0, y: 300, edge: 'left' })
    expect(snapBall({ x: 1920 - S - 15, y: 300 }, [main])).toEqual({ x: 1920 - S, y: 300, edge: 'right' })
  })
  it('离边远不吸；拖出屏幕外校正回来', () => {
    expect(snapBall({ x: 500, y: 300 }, [main])).toEqual({ x: 500, y: 300 })
    expect(snapBall({ x: 800, y: 2000 }, [main])).toEqual({ x: 800, y: 1040 - S })
    expect(snapBall({ x: -300, y: -50 }, [main])).toEqual({ x: 0, y: 0, edge: 'left' })
  })
  it('两块屏相邻的那条边不吸附', () => {
    expect(snapBall({ x: 1920 - S - 10, y: 300 }, [main, right])).toEqual({ x: 1920 - S - 10, y: 300 })
    expect(snapBall({ x: 1925, y: 300 }, [main, right])).toEqual({ x: 1925, y: 300 })
    // 右屏比主屏矮：主屏右边在右屏底下那一段是外侧边，可以吸
    expect(snapBall({ x: 1920 - S - 10, y: 1040 - S }, [main, right])).toEqual({ x: 1920 - S, y: 1040 - S, edge: 'right' })
    expect(snapBall({ x: 3200 - S - 5, y: 100 }, [main, right])).toEqual({ x: 3200 - S, y: 100, edge: 'right' })
  })
})

describe('hiddenPos', () => {
  it('贴哪边往外推半个球', () => {
    expect(hiddenPos({ x: 0, y: 10, edge: 'left' })).toEqual({ x: -S / 2, y: 10 })
    expect(hiddenPos({ x: 1868, y: 10, edge: 'right' })).toEqual({ x: 1868 + S / 2, y: 10 })
    expect(hiddenPos({ x: 300, y: 10 })).toEqual({ x: 300, y: 10 })
  })
})

describe('fixBall', () => {
  it('没存过：主屏右侧偏下', () => {
    const p = fixBall(undefined, [main])
    expect(p.x).toBe(1920 - S - 24); expect(p.y).toBe(624)
  })
  it('第二块屏拔掉：挪回主屏，贴右边的仍贴右边', () => {
    expect(fixBall({ x: 3200 - S, y: 200, edge: 'right' }, [main])).toEqual({ x: 1920 - S, y: 200, edge: 'right' })
    expect(fixBall({ x: 2500, y: 500 }, [main])).toEqual({ x: 1920 - S, y: 500, edge: 'right' })
  })
  it('分辨率变小：拉回可见区域', () => {
    expect(fixBall({ x: 1700, y: 900 }, [{ x: 0, y: 0, width: 1366, height: 728 }])).toEqual({ x: 1366 - S, y: 728 - S, edge: 'right' })
  })
  it('位置还在屏内保持不动', () => expect(fixBall({ x: 400, y: 400 }, [main, right])).toEqual({ x: 400, y: 400 }))
})

describe('areaOf', () => {
  it('球心所在屏，不在任何屏时取最近的', () => {
    expect(areaOf({ x: 2000, y: 10 }, [main, right])).toBe(right)
    expect(areaOf({ x: 2500, y: 1500 }, [main, right])).toBe(right)
    expect(areaOf({ x: 2000, y: 1500 }, [main, right])).toBe(main)
  })
})

describe('expandBounds', () => {
  it('右下有空间：往右下展开，球在左上角', () => {
    expect(expandBounds({ x: 100, y: 100 }, 300, main)).toEqual({ bounds: { x: 100, y: 100, width: 280, height: 300 }, side: 'right', valign: 'top' })
  })
  it('贴右边、靠下：往左上展开，球仍在原处（右下角）', () => {
    const r = expandBounds({ x: 1920 - S, y: 900 }, 300, main)
    expect(r.side).toBe('left'); expect(r.valign).toBe('bottom')
    expect(r.bounds).toEqual({ x: 1920 - 280, y: 900 + S - 300, width: 280, height: 300 })
  })
  it('卡片比屏幕高：夹到工作区高度', () => {
    expect(expandBounds({ x: 0, y: 0 }, 5000, { x: 0, y: 0, width: 800, height: 600 }).bounds.height).toBe(600)
  })
})
