// 会话流程图的导出：不引第三方截图库，直接从节点 / 连线数据生成一张干净的 SVG，
// PNG 再把这个 SVG 画到 canvas 上转出去。好处是输出确定、可单测，也不必把界面 CSS 整个内联。
//
// 尺寸与配色是**唯一来源**：SessionFlowDrawer 从这里 import，避免界面和导出各写一份走样。
import type { FlowEdgeKind, FlowNodeKind } from '@lingshell/shared'

export const NODE_W: Record<FlowNodeKind, number> = { ask: 148, chip: 148, tool: 118, text: 104, file: 124, auth: 96 }
export const NODE_H: Record<FlowNodeKind, number> = { ask: 30, chip: 22, tool: 26, text: 26, file: 24, auth: 24 }
export const FLOW_ICON: Record<FlowNodeKind, string> = { ask: '🧑', chip: '🔖', tool: '⚡', text: '💬', file: '📄', auth: '🛡' }
export const EDGE_COLOR: Record<FlowEdgeKind, string> = { ask: '#1f6feb', write: '#d29922', weak: '#484f58', chip: '#a371f7', next: '#3fb950' }

/** 节点的强调色（左边框 / 失败用红） */
export function accentOf(kind: FlowNodeKind, ok?: boolean): string {
  return kind === 'ask' ? '#58a6ff' : kind === 'chip' ? '#a371f7' : kind === 'text' ? '#8b949e'
    : kind === 'file' ? '#6e7681' : kind === 'auth' ? '#f0883e' : ok === false ? '#f85149' : '#3fb950'
}

export interface ExportNode {
  position: { x: number; y: number }
  data: { kind: FlowNodeKind; label?: string; ok?: boolean; dim?: boolean }
}
export interface ExportEdge {
  source: string
  target: string
  data?: { kind?: FlowEdgeKind }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 标签按节点宽度截断（中英文混排，按「半角宽」估算：中文算 2） */
export function clipLabel(label: string, width: number): string {
  const limit = Math.max(3, Math.floor((width - 26) / 5.4))
  let used = 0
  let out = ''
  for (const ch of label) {
    const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
    if (used + w > limit) return `${out}…`
    out += ch
    used += w
  }
  return out
}

/**
 * 生成可独立打开的 SVG（贴工单 / 发同事用）。
 * 画布按所有节点的外接框 + padding 计算，所以翻到哪一组、导出的都是那一组。
 */
export function buildFlowSvg(nodes: readonly ExportNode[], edges: readonly ExportEdge[], pad = 20, bg = '#0d1117'): string {
  if (!nodes.length) {
    const w = 240, h = 60
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
      + `<rect width="${w}" height="${h}" fill="${bg}"/>`
      + `<text x="${w / 2}" y="${h / 2 + 4}" fill="#8b949e" font-size="12" text-anchor="middle" font-family="system-ui,sans-serif">No nodes</text></svg>`
  }
  const box = (n: ExportNode) => ({
    x: n.position.x, y: n.position.y,
    w: NODE_W[n.data.kind] ?? 120, h: NODE_H[n.data.kind] ?? 26,
  })
  const boxes = nodes.map((n) => ({ n, ...box(n) }))
  const minX = Math.min(...boxes.map((b) => b.x)) - pad
  const minY = Math.min(...boxes.map((b) => b.y)) - pad
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + pad
  const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + pad
  const W = Math.round(maxX - minX), Hh = Math.round(maxY - minY)
  const byId = new Map<string, { x: number; y: number; w: number; h: number }>()
  // React Flow 的节点带 id：连线按 id 找两端的几何
  for (const b of boxes) {
    const id = (b.n as unknown as { id?: string }).id
    if (id) byId.set(id, { x: b.x, y: b.y, w: b.w, h: b.h })
  }

  const lines: string[] = []
  for (const e of edges) {
    const s = byId.get(e.source), t = byId.get(e.target)
    if (!s || !t) continue
    const color = EDGE_COLOR[(e.data?.kind ?? 'weak') as FlowEdgeKind] ?? EDGE_COLOR.weak
    // 按相对位置选连接点：横向走「右→左」，往下走「下→上」，否则「上→下」
    let x1: number, y1: number, x2: number, y2: number
    if (t.x >= s.x + s.w) { x1 = s.x + s.w; y1 = s.y + s.h / 2; x2 = t.x; y2 = t.y + t.h / 2 }
    else if (t.y >= s.y + s.h) { x1 = s.x + s.w / 2; y1 = s.y + s.h; x2 = t.x + t.w / 2; y2 = t.y }
    else { x1 = s.x + s.w / 2; y1 = s.y; x2 = t.x + t.w / 2; y2 = t.y + t.h }
    const mx = (x1 + x2) / 2
    lines.push(`<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.2" marker-end="url(#arrow-${(e.data?.kind ?? 'weak')})" opacity="0.85"/>`)
  }

  const shapes: string[] = []
  for (const b of boxes) {
    const d = b.n.data
    const accent = accentOf(d.kind, d.ok)
    const isChip = d.kind === 'chip'
    const label = clipLabel(d.label ?? '', b.w)
    shapes.push(
      `<g opacity="${d.dim ? 0.25 : 1}">`
      + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${isChip ? 10 : 5}" fill="#161b22" stroke="#30363d" stroke-width="1"/>`
      + (isChip ? '' : `<rect x="${b.x}" y="${b.y}" width="2.5" height="${b.h}" rx="1" fill="${accent}"/>`)
      + `<text x="${b.x + (isChip ? 10 : 12)}" y="${b.y + b.h / 2 + 3.5}" fill="#e6edf3" font-size="${d.kind === 'ask' ? 10 : 9.5}" font-family="system-ui,sans-serif">${esc(label)}</text>`
      + `</g>`,
    )
  }

  const markers = (Object.keys(EDGE_COLOR) as FlowEdgeKind[]).map((k) =>
    `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${EDGE_COLOR[k]}"/></marker>`,
  ).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}">`
    + `<defs>${markers}</defs>`
    + `<rect width="${W}" height="${Hh}" fill="${bg}"/>`
    + `<g transform="translate(${-minX} ${-minY})">${lines.join('')}${shapes.join('')}</g>`
    + `</svg>`
}

/** 触发一次下载（SVG 原文） */
export function downloadSvg(name: string, svg: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  triggerDownload(name, url)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * SVG → PNG（2 倍分辨率，贴出去不发虚）。
 * 失败原因只可能是 canvas 被污染，这里不会发生（SVG 内没有外部资源与 foreignObject）。
 */
export async function downloadPng(name: string, svg: string, scale = 2): Promise<void> {
  const img = new Image()
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('image load failed'))
      img.src = url
    })
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    triggerDownload(name, canvas.toDataURL('image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function triggerDownload(name: string, href: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
