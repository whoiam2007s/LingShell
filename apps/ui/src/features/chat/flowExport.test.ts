import { describe, it, expect } from 'vitest'
import { NODE_H, NODE_W, EDGE_COLOR, buildFlowSvg, clipLabel } from './flowExport.js'

const node = (id: string, x: number, y: number, kind: 'ask' | 'tool' = 'ask', label = '检查磁盘', extra: { ok?: boolean; dim?: boolean } = {}) =>
  ({ id, position: { x, y }, data: { kind, label, ...extra } })

describe('流程图导出 SVG', () => {
  it('没有节点时给一个「空」图，不报错', () => {
    const svg = buildFlowSvg([], [])
    expect(svg).toContain('<svg')
    expect(svg).toContain('No nodes')
  })

  it('画布按节点外接框 + padding 计算（翻到哪组就导出哪组）', () => {
    const svg = buildFlowSvg([node('a', 0, 0), node('b', 500, 100, 'tool')], [], 20)
    // x 方向 0..500+W(tool)，y 方向 0..100+H(tool)，各加 20 padding
    expect(svg).toContain(`width="${500 + NODE_W.tool + 40}"`)
    expect(svg).toContain(`height="${100 + NODE_H.tool + 40}"`)
  })

  it('节点标签进 <text>，XML 特殊字符被转义', () => {
    const svg = buildFlowSvg([node('a', 0, 0, 'ask', 'a<b&c')], [])
    expect(svg).toContain('a&lt;b&amp;c')
    expect(svg).not.toContain('<text x="32" y="17.5" fill="#e6edf3" font-size="10" font-family="system-ui,sans-serif">a<b')
  })

  it('连线按 id 找两端：横向走右→左，且带上箭头定义', () => {
    const svg = buildFlowSvg([node('a', 0, 0), node('b', 400, 0, 'tool')], [{ source: 'a', target: 'b', data: { kind: 'next' } }])
    expect(svg).toContain('<path')
    expect(svg).toContain('marker-end="url(#arrow-next)"')
    expect(svg).toContain('id="arrow-next"')
    // 起点在源节点右边缘、终点在目标节点左边缘
    expect(svg).toContain(`M${NODE_W.ask} ${NODE_H.ask / 2}`)
    expect(svg).toContain(`${400} ${NODE_H.tool / 2}`)
  })

  it('两端 id 对不上时跳过这条线，不抛错', () => {
    const svg = buildFlowSvg([node('a', 0, 0)], [{ source: 'a', target: 'ghost' }])
    // 只剩箭头定义里的 path（每个箭头种一条），没有真正的连线
    expect((svg.match(/<path/g) ?? []).length).toBe(Object.keys(EDGE_COLOR).length)
  })

  it('被折叠 / 无关的节点用降低不透明度表示', () => {
    const svg = buildFlowSvg([node('a', 0, 0, 'ask', 'x', { dim: true })], [])
    expect(svg).toContain('opacity="0.25"')
  })
})

describe('标签截断', () => {
  it('短标签原样，长标签带省略号', () => {
    expect(clipLabel('短', 148)).toBe('短')
    expect(clipLabel('一二三四五六七八九十一二三四五六七八九十', 104).endsWith('…')).toBe(true)
  })
  it('中文按双宽估算（同样宽度能放的中文字比英文少）', () => {
    const cn = clipLabel('检查磁盘使用率并列出前五个大文件目录', 118)
    const en = clipLabel('abcdefghijklmnopqrstuvwxyz', 118)
    expect(en.length).toBeGreaterThan(cn.length)
  })
})
