import type { SplitMode, TerminalSplitLayout } from '../protocol/index.js'

// ── 终端多窗格分屏（纯逻辑，UI 只负责渲染 / 拖动） ──────────
// 窗格按行优先排成网格；sizes 是分割线位置（0~1 累计）：
// cols2/rows2 [线]；cols3 [线1, 线2]；grid4 [竖线 x, 横线 y]（十字共用）
export const SPLIT_MODES: SplitMode[] = ['single', 'cols2', 'rows2', 'cols3', 'grid4']
const GRID: Record<SplitMode, [number, number]> = { single: [1, 1], cols2: [1, 2], rows2: [2, 1], cols3: [1, 3], grid4: [2, 2] }
export const paneCount = (m: SplitMode) => GRID[m][0] * GRID[m][1]
export const paneCell = (m: SplitMode, i: number): [number, number] => [Math.floor(i / GRID[m][1]), i % GRID[m][1]]

export function defaultSizes(m: SplitMode): number[] {
  return m === 'single' ? [] : m === 'cols3' ? [1 / 3, 2 / 3] : m === 'grid4' ? [0.5, 0.5] : [0.5]
}
// 分割线 k 的方向：x = 竖线（左右拖），y = 横线（上下拖）
export const dividerAxis = (m: SplitMode, k: number): 'x' | 'y' => m === 'rows2' || (m === 'grid4' && k === 1) ? 'y' : 'x'

// 网格轨道占比（列 / 行）
export function splitTracks(m: SplitMode, s: number[]): { cols: number[]; rows: number[] } {
  const cuts = (xs: number[]) => [...xs, 1].map((x, i, a) => x - (i ? a[i - 1] : 0))
  if (m === 'cols2' || m === 'cols3') return { cols: cuts(s), rows: [1] }
  if (m === 'rows2') return { cols: [1], rows: cuts(s) }
  if (m === 'grid4') return { cols: cuts([s[0]]), rows: cuts([s[1]]) }
  return { cols: [1], rows: [1] }
}

// 拖动分割线 k 到 p：两侧窗格各至少 lim（cols3 还不能越过另一条线）；容器太窄放不下则不动
export function clampDivider(m: SplitMode, s: number[], k: number, p: number, lim: number): number[] {
  const lo = m === 'cols3' && k === 1 ? s[0] + lim : lim
  const hi = m === 'cols3' && k === 0 ? s[1] - lim : 1 - lim
  if (lo > hi) return s
  return s.map((x, i) => i === k ? Math.min(hi, Math.max(lo, p)) : x)
}

// 持久化的 sizes 校验：数量对、在 [0.1, 0.9]、cols3 递增，否则取默认
export function normSizes(m: SplitMode, s: unknown): number[] {
  const d = defaultSizes(m)
  if (!Array.isArray(s) || s.length !== d.length || !s.every((x) => typeof x === 'number' && x >= 0.1 && x <= 0.9)) return d
  return m === 'cols3' && s[1] - s[0] < 0.1 ? d : s as number[]
}

// layout.json 读取：兼容旧版两窗格 {left,right,ratio,vertical}；不合法 → undefined（不分屏）
export function migrateSplit(raw: unknown): TerminalSplitLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const idx = (x: unknown) => Number.isInteger(x) && (x as number) >= 0
  if (idx(r.left) && idx(r.right)) {
    const mode: SplitMode = r.vertical ? 'rows2' : 'cols2'
    return { mode, panes: [r.left as number, r.right as number], sizes: normSizes(mode, [Math.min(0.85, Math.max(0.15, Number(r.ratio) || 0.5))]) }
  }
  const mode = r.mode as SplitMode
  if (!SPLIT_MODES.includes(mode) || mode === 'single' || !Array.isArray(r.panes) || r.panes.length !== paneCount(mode) || !r.panes.every(idx)) return undefined
  return { mode, panes: r.panes as number[], sizes: normSizes(mode, r.sizes) }
}

// ── 运行时视图：panes 存终端 id，'' = 空位（等新建的终端填进来） ──
export interface PaneView { mode: SplitMode; panes: string[]; focus: number; sizes: number[] }
export const EMPTY_VIEW: PaneView = { mode: 'single', panes: [''], focus: 0, sizes: [] }
export const focusedId = (v: PaneView) => v.panes[v.focus] ?? ''

// 把 id 放进第 pane 个窗格并聚焦；它已在别的窗格 → 两窗格互换（同一终端不进两个窗格）
export function assign(v: PaneView, pane: number, id: string): PaneView {
  const panes = [...v.panes], j = panes.indexOf(id)
  if (j >= 0) panes[j] = panes[pane]
  panes[pane] = id
  return { ...v, panes, focus: pane }
}

// 点标签 / agent 切终端：已在某窗格 → 焦点移过去；否则先填空位，没有空位就换掉焦点窗格
export function activate(v: PaneView, id: string): PaneView {
  const i = v.panes.indexOf(id)
  if (i >= 0) return i === v.focus ? v : { ...v, focus: i }
  const e = v.panes.indexOf('')
  return assign(v, e >= 0 ? e : v.focus, id)
}

// 切模式：当前焦点终端 + 已显示的 + 标签顺序里焦点之后的终端依次填格；不够的留空位（UI 新建本地终端补）
export function setMode(v: PaneView, mode: SplitMode, ids: string[]): PaneView {
  const n = paneCount(mode), cur = focusedId(v), i = ids.indexOf(cur)
  const next = i < 0 ? ids : [...ids.slice(i + 1), ...ids.slice(0, i)]
  const pick = [...new Set([cur, ...v.panes, ...next])].filter((x) => x && ids.includes(x)).slice(0, n)
  return { mode, panes: Array.from({ length: n }, (_, k) => pick[k] ?? ''), focus: 0, sizes: mode === v.mode ? v.sizes : defaultSizes(mode) }
}

// 窗格数减少时的模式：四宫格→三列→两列→单屏（上下 2 保持上下）
function collapse(m: SplitMode, n: number): SplitMode {
  if (n >= paneCount(m)) return m
  return n >= 3 ? 'cols3' : n === 2 ? (m === 'rows2' ? 'rows2' : 'cols2') : 'single'
}
function shrink(v: PaneView, panes: string[]): PaneView {
  if (!panes.length) return EMPTY_VIEW
  const mode = collapse(v.mode, panes.length), f = panes.indexOf(focusedId(v))
  return { mode, panes, focus: f >= 0 ? f : Math.min(v.focus, panes.length - 1), sizes: mode === v.mode ? v.sizes : defaultSizes(mode) }
}

// 关闭终端 id（rest = 关闭后剩下的终端，标签顺序）：所在窗格换上一个未显示的终端；没有则窗格收掉、模式降级
export function dropTerm(v: PaneView, id: string, rest: string[]): PaneView {
  const i = v.panes.indexOf(id)
  if (i < 0) return v
  const spare = rest.find((t) => !v.panes.includes(t))
  if (spare) return { ...v, panes: v.panes.map((p, k) => k === i ? spare : p) }
  return shrink(v, v.panes.filter((p) => p && p !== id))
}

// 启动恢复：ids = 按布局下标恢复出的终端 id（失败为 ''）；恢复失败的窗格去掉，不足则降级
export function restoreView(s: TerminalSplitLayout | undefined, ids: string[], active: string): PaneView {
  const single: PaneView = { ...EMPTY_VIEW, panes: [active] }
  if (!s) return single
  const panes = [...new Set(s.panes.map((i) => ids[i] ?? ''))].filter(Boolean)
  if (panes.length < 2) return single
  const v = shrink({ mode: s.mode, panes: s.panes.map(() => ''), focus: 0, sizes: s.sizes }, panes)
  const f = panes.indexOf(active)
  return { ...v, focus: f >= 0 ? f : 0 }
}

// 存布局：单屏或有窗格不可持久化（临时 ssh / 空位）→ undefined
export function toSplitLayout(v: PaneView, idx: (id: string) => number): TerminalSplitLayout | undefined {
  if (v.mode === 'single') return undefined
  const panes = v.panes.map(idx)
  return panes.every((i) => i >= 0) ? { mode: v.mode, panes, sizes: v.sizes } : undefined
}

// Ctrl+Alt+方向键：网格里相邻窗格；到边则不动
export type PaneDir = 'left' | 'right' | 'up' | 'down'
export function neighborPane(m: SplitMode, i: number, d: PaneDir): number {
  const [rows, cols] = GRID[m]
  let [r, c] = paneCell(m, i)
  if (d === 'left') c--; else if (d === 'right') c++; else if (d === 'up') r--; else r++
  return r < 0 || c < 0 || r >= rows || c >= cols ? i : r * cols + c
}
