import { useMemo, useState } from 'react'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { edges as rawEdges, nodes as rawNodes, type GNode, type Kind } from './data4.js'

// 流程图只表达「流向 + 排布」：节点上只有图标和短名，完整信息放 hover 和点击后的详情
const STAGE_X = [0, 176, 392]
const TURN_GAP = 540
const W: Record<Kind, number> = { ask: 148, chip: 96, tool: 118, text: 104, file: 124 }
const H: Record<Kind, number> = { ask: 30, chip: 22, tool: 26, text: 26, file: 24 }
const VGAP = 14
const COL_MAX = 8

const TONE: Record<string, string> = { ok: '#3fb950', warn: '#d29922', error: '#f85149', chip: '#a371f7' }
const ICON: Record<Kind, string> = { ask: '🧑', chip: '🔖', tool: '⚡', text: '💬', file: '📄' }
const SHORT: Record<string, string> = {
  exec_in_terminal: 'exec', write_file: 'write', read_image: 'read_image',
  start_background: 'bg', check_background: 'read', '授权 · 危险命令': 'auth',
}

type D = GNode & { dim?: boolean; sel?: boolean }

const tip = (d: D) => [d.label, d.detail, d.meta, d.badge].filter(Boolean).join('\n')

function NodeBox({ data }: NodeProps) {
  const d = data as unknown as D
  const w = W[d.kind], h = H[d.kind]
  const accent = d.kind === 'ask' ? '#58a6ff' : d.kind === 'chip' ? '#a371f7' : d.kind === 'text' ? '#8b949e' : d.kind === 'file' ? '#6e7681' : TONE[d.tone ?? 'ok'] ?? '#3fb950'
  const isAsk = d.kind === 'ask', isChip = d.kind === 'chip'
  // 节点上只放最短的信息：工具名（短）/ 文件名 / 「你的提问」/「AI 说明」
  const label = d.kind === 'tool' ? SHORT[d.label] ?? d.label : d.kind === 'file' ? d.label : d.label
  return (
    <div
      title={tip(d)}
      style={{
        width: w, height: h, borderRadius: isChip ? 10 : 5,
        background: isAsk ? '#16202e' : isChip ? '#1e1a2c' : d.kind === 'file' ? '#1a2027' : '#1c232c',
        border: `1px solid ${d.sel ? accent : isChip ? '#a371f755' : '#2d333b'}`,
        borderLeft: isChip ? undefined : `2px solid ${accent}`,
        padding: isChip ? '0 8px' : '0 6px',
        display: 'flex', alignItems: 'center', gap: 4,
        opacity: d.dim ? 0.22 : 1,
        cursor: 'pointer',
        fontFamily: '-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        boxShadow: d.sel ? `0 0 0 2px ${accent}55` : isAsk ? '0 2px 8px #00000055' : 'none',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Left} id="l" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} id="r" style={{ opacity: 0 }} />
      <span style={{ fontSize: 8.5, flexShrink: 0 }}>{ICON[d.kind]}</span>
      <span style={{ fontSize: isAsk ? 10 : 9.5, fontWeight: isAsk ? 600 : 500, color: '#e6edf3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {d.badge && <span style={{ fontSize: 8, color: accent, flexShrink: 0 }}>{d.badge}</span>}
    </div>
  )
}

const nodeTypes = { box: NodeBox }

export function FlowView() {
  const [sel, setSel] = useState<string>()
  const selNode = rawNodes.find((n) => n.id === sel)

  const graph = useMemo(() => {
    const cols = new Map<string, GNode[]>()
    for (const n of rawNodes) {
      const k = `${n.turn}-${n.stage}`
      if (!cols.has(k)) cols.set(k, [])
      cols.get(k)!.push(n)
    }
    const folded = new Map<string, GNode[]>()
    for (const [k, list] of cols) {
      if (list.length <= COL_MAX) { folded.set(k, list); continue }
      const rest = list.slice(COL_MAX - 1)
      folded.set(k, [...list.slice(0, COL_MAX - 1), {
        ...rest[0], id: `${k}-more`, meta: '', badge: `+${rest.length}`,
        label: rest[0].kind === 'tool' ? '其余工具' : rest[0].kind === 'file' ? '其余产物' : '其余',
        detail: rest.map((r) => r.detail ?? r.label).join(' · '),
      }])
    }

    const maxH = Math.max(...[...folded.values()].map((list) => list.reduce((s, n) => s + H[n.kind] + VGAP, 0)))
    const nodes: Node[] = []
    for (const [k, list] of folded) {
      const [turn, stage] = k.split('-').map(Number)
      const colH = list.reduce((s, n) => s + H[n.kind] + VGAP, 0) - VGAP
      let y = (maxH - colH) / 2
      for (const n of list) {
        nodes.push({
          id: n.id, type: 'box', position: { x: turn * TURN_GAP + STAGE_X[stage], y },
          style: { width: W[n.kind], height: H[n.kind] },
          data: { ...n, dim: !!sel && sel !== n.id, sel: sel === n.id } satisfies D,
        })
        y += H[n.kind] + VGAP
      }
    }

    const edges: Edge[] = rawEdges.map((e, i) => {
      const on = !!sel && (sel === e.from || sel === e.to)
      const color = TONE[e.tone ?? 'weak'] ?? '#484f58'
      return {
        id: `e${i}`, source: e.from, target: e.to,
        type: 'default', animated: e.tone !== 'weak',
        style: {
          stroke: color, strokeWidth: on ? 1.6 : e.tone === 'weak' ? 0.9 : 1.2,
          strokeDasharray: e.dashed ? '4 3' : e.tone === 'chip' ? '2 2' : undefined,
          opacity: sel ? (on ? 1 : 0.08) : e.tone === 'weak' ? 0.35 : 0.75,
        },
        markerEnd: { type: MarkerType.Arrow, width: 8, height: 8, color },
      } satisfies Edge
    })

    return { nodes, edges }
  }, [sel])

  return (
    <div style={{ height: '100vh', background: '#0d1117', display: 'flex', flexDirection: 'column', fontFamily: '-apple-system,"Segoe UI","Microsoft YaHei",sans-serif' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #21262d', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#e6edf3' }}>会话数据流</span>
        <span style={{ fontSize: 10, color: '#8b949e' }}>sess_a6a6cc7e · 3 轮 · 悬停看摘要，点击看详情</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }} onClick={() => setSel(undefined)}>
        <ReactFlow
          nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
          fitView fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
          minZoom={0.08} maxZoom={1.8} nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: '#0d1117' }}
          onNodeClick={(e, n) => { e.stopPropagation(); setSel(n.id === sel ? undefined : n.id) }}
        >
          <Background gap={26} size={0.8} color="#1b2129" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {/* 点击节点 → 底部详情 */}
      <div style={{ height: 74, borderTop: '1px solid #21262d', padding: '6px 12px', fontSize: 10, color: '#c9d1d9', overflow: 'hidden' }}>
        {selNode ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11 }}>{ICON[selNode.kind]}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600 }}>{selNode.label}</span>
              <span style={{ color: '#6e7681' }}>{selNode.meta}</span>
              {selNode.badge && <span style={{ color: '#8b949e' }}>{selNode.badge}</span>}
            </div>
            <div style={{ color: '#8b949e', fontFamily: 'ui-monospace,Consolas,monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selNode.detail ?? '（无更多信息）'}</div>
            <div style={{ color: '#5b636e' }}>来自：第 {selNode.turn + 1} 轮 · 阶段 {['提问+chips', '工具/文字', '产物'][selNode.stage]}</div>
          </div>
        ) : (
          <div style={{ color: '#5b636e', paddingTop: 20, textAlign: 'center' }}>
            🔖 chip = 提问携带的引用　💬 文字节点 = AI 说明　黄实线=写入　灰虚线=产出　紫=chip 来源　|　点任意节点看完整信息
          </div>
        )}
      </div>
    </div>
  )
}
