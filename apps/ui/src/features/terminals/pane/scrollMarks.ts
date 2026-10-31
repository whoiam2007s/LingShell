// 滚动条标记（同 Windows Terminal showMarksOnScrollbar）：xterm 的概览标尺（overviewRuler，盖在滚动条上）画
// 命令成败（绿 / 红，左道）、搜索命中（黄，中道，SearchAddon 自己画）、关键字告警（橙，右道）；点标记跳到那一行。
// 颜色取当前界面主题的 CSS 变量（标尺是 canvas，要具体色值）
import type { Terminal } from '@xterm/xterm'
import { hideTip, showTipAt } from '../../../lib/tooltip.js'

export const RULER_WIDTH = 10

const HEX = /^#[0-9a-f]{6}$/i
/** 读主题变量当前值（须是 #rrggbb，SearchAddon 也只认这种）；读不到用兜底 */
export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (HEX.test(v)) return v
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`
  return fallback
}
/** 两个 #rrggbb 按比例混合（告警的橙 = 警告黄与危险红之间） */
export function mixHex(a: string, b: string, t = 0.5): string {
  const p = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16))
  const x = p(a), y = p(b)
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}
export function markColors() {
  const warn = themeColor('--color-warn', '#d29922')
  return {
    ok: themeColor('--color-success', '#3fb950'), fail: themeColor('--color-danger', '#f85149'), unknown: themeColor('--color-text-muted', '#8b949e'),
    search: warn, alert: mixHex(warn, themeColor('--color-danger', '#f85149'), 0.45),
  }
}

export interface RulerMark { line: number; label: string }
/** 标签太长只留前面：取第一行，超过 n 字截断加省略号 */
export const clipLabel = (s: string, n = 80) => { const l = s.trim().split('\n')[0].replace(/\s+/g, ' '); return l.length > n ? `${l.slice(0, n)}…` : l }

/**
 * 标尺上的标记：悬停离某个标记 ≤ 5px 时显示它的说明（命令 / 告警行的前部分），点击跳到那一行
 * （标记行放在第 3 行，上面留点上下文）并吞掉这次按下；没点中标记 / 按在滚动条滑块上 → 照常交给滚动条（拖动、翻页不受影响）
 */
export function installRulerClick(term: Terminal, el: HTMLElement, marks: () => RulerMark[]): () => void {
  const hit = (e: MouseEvent) => {
    const ruler = el.querySelector<HTMLCanvasElement>('.xterm-decoration-overview-ruler')
    if (!ruler || (e.target as HTMLElement).closest?.('.slider')) return null
    const r = ruler.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom || !r.height) return null
    const total = Math.max(1, term.buffer.active.length)
    let best: (RulerMark & { y: number }) | null = null, dist = 6
    for (const m of marks()) {
      const y = r.top + (m.line / total) * r.height, d = Math.abs(y - e.clientY)
      if (d < dist) { dist = d; best = { ...m, y } }
    }
    return best && { ...best, r }
  }
  let tipOn = false
  const onMove = (e: MouseEvent) => {
    const h = hit(e)
    if (h) { tipOn = true; showTipAt(h.label, { left: h.r.left, right: h.r.right, width: h.r.width, top: h.y - 2, bottom: h.y + 2 }) }
    else if (tipOn) { tipOn = false; hideTip() }
  }
  const onLeave = () => { if (tipOn) { tipOn = false; hideTip() } }
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    const h = hit(e)
    if (!h) return
    e.preventDefault(); e.stopPropagation(); onLeave()
    term.scrollToLine(Math.max(0, h.line - 2))
  }
  el.addEventListener('mousedown', onDown, true); el.addEventListener('mousemove', onMove); el.addEventListener('mouseleave', onLeave)
  return () => { el.removeEventListener('mousedown', onDown, true); el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave); onLeave() }
}
