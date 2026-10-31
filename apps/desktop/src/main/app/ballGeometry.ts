// 悬浮球几何（纯函数，坐标都是屏幕 DIP）：贴边吸附、半隐藏、校正到可见区域、悬停卡片往哪边展开。
// 只吸附到「外侧」屏幕边：边外紧挨着另一块显示器时不吸（半隐藏会把半个球露到旁边那块屏上）。

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export type Edge = 'left' | 'right'
export interface BallPos extends Pt { edge?: Edge }

export const BALL_SIZE = 52
export const SNAP_PX = 24          // 离屏幕边这么近就吸过去
export const CARD_WIDTH = 280

const inside = (p: Pt, r: Rect) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** 球心所在（或离球心最近）的工作区 */
export function areaOf(p: Pt, areas: Rect[], size = BALL_SIZE): Rect | undefined {
  const c = { x: p.x + size / 2, y: p.y + size / 2 }
  const hit = areas.find((a) => inside(c, a))
  if (hit) return hit
  const dist = (a: Rect) => Math.hypot(c.x - clamp(c.x, a.x, a.x + a.width), c.y - clamp(c.y, a.y, a.y + a.height))
  return [...areas].sort((a, b) => dist(a) - dist(b))[0]
}

/** 这条边外侧是不是另一块显示器 */
function outerEdge(a: Rect, edge: Edge, y: number, areas: Rect[]): boolean {
  const probe = { x: edge === 'left' ? a.x - 2 : a.x + a.width + 1, y }
  return !areas.some((o) => o !== a && inside(probe, o))
}

/** 拖动松手：校正进工作区，靠近外侧左右边就吸附（记下贴的哪条边） */
export function snapBall(p: Pt, areas: Rect[], size = BALL_SIZE, snap = SNAP_PX): BallPos {
  const a = areaOf(p, areas, size)
  if (!a) return { x: Math.round(p.x), y: Math.round(p.y) }
  const x = clamp(p.x, a.x, a.x + a.width - size)
  const y = clamp(p.y, a.y, a.y + a.height - size)
  const cy = y + size / 2
  if (x - a.x <= snap && outerEdge(a, 'left', cy, areas)) return { x: a.x, y: Math.round(y), edge: 'left' }
  if (a.x + a.width - size - x <= snap && outerEdge(a, 'right', cy, areas)) return { x: a.x + a.width - size, y: Math.round(y), edge: 'right' }
  return { x: Math.round(x), y: Math.round(y) }
}

/** 半隐藏时窗口的位置：贴哪边就往外推半个球 */
export function hiddenPos(p: BallPos, size = BALL_SIZE): Pt {
  if (p.edge === 'left') return { x: p.x - Math.round(size / 2), y: p.y }
  if (p.edge === 'right') return { x: p.x + Math.round(size / 2), y: p.y }
  return { x: p.x, y: p.y }
}

/** 显示器拔掉 / 分辨率变了：已存位置重新校正（贴边的重新贴到所在屏的同一边） */
export function fixBall(p: BallPos | undefined, areas: Rect[], size = BALL_SIZE): BallPos {
  const primary = areas[0]
  // 没存过：主屏右侧偏下
  if (!p || !primary) return primary ? { x: primary.x + primary.width - size - 24, y: primary.y + Math.round(primary.height * 0.6) } : { x: 100, y: 100 }
  const s = snapBall(p, areas, size, 0)
  if (!p.edge) return s
  const a = areaOf(s, areas, size)!
  const want = p.edge === 'left' ? a.x : a.x + a.width - size
  return outerEdge(a, p.edge, s.y + size / 2, areas) ? { x: want, y: s.y, edge: p.edge } : { x: s.x, y: s.y }
}

/**
 * 悬停展开：窗口从球变成「球 + 卡片」（球嵌在卡片头部一角，位置不动）。
 * 右边放得下就往右展开（球在左上 / 左下角），否则往左；下面放得下就往下（球在上沿），否则往上。
 */
export function expandBounds(p: Pt, cardHeight: number, area: Rect, size = BALL_SIZE, width = CARD_WIDTH): { bounds: Rect; side: Edge; valign: 'top' | 'bottom' } {
  const height = Math.min(Math.max(size, Math.round(cardHeight)), area.height)
  const side: Edge = p.x + width <= area.x + area.width ? 'right' : 'left'
  const valign = p.y + height <= area.y + area.height ? 'top' : 'bottom'
  const x = side === 'right' ? p.x : p.x + size - width
  const y = valign === 'top' ? p.y : p.y + size - height
  return { bounds: { x: clamp(x, area.x, area.x + area.width - width), y: clamp(y, area.y, area.y + area.height - height), width, height }, side, valign }
}
