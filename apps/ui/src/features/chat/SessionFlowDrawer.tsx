import { useMemo, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { buildSessionFlow, tr, type FlowInput, type FlowNode, type FlowNodeKind, type SubagentView } from '@lingshell/shared'
// 尺寸 / 配色 / 图标与「导出图片」共用一份（见 flowExport.ts），避免界面和导出各写一套走样
import { EDGE_COLOR, FLOW_ICON as ICON, NODE_H as H, NODE_W as W, buildFlowSvg, downloadPng, downloadSvg, type ExportEdge, type ExportNode } from './flowExport.js'

// 会话流程图：每轮三段（提问+chips → 工具/文字 → 产物），横向按轮推进，阶段内竖向多节点。
// 节点只放「图标 + 短名」，完整信息在悬停与点击详情里；连线不放文字，只用颜色。
// 长对话：一次只画 WINDOW 轮，顶部用刻度条 + 上/下一组翻页（几十轮也不会缩成一条线、节点数稳定）。
const WINDOW = 8
const STAGE_X = [0, 176, 392]
const TURN_GAP = 540
const VGAP = 14

type D = FlowNode & { dim?: boolean; sel?: boolean }

function NodeBox({ data }: NodeProps) {
  const d = data as unknown as D
  const accent = d.kind === 'ask' ? '#58a6ff' : d.kind === 'chip' ? '#a371f7' : d.kind === 'text' ? '#8b949e' : d.kind === 'file' ? '#6e7681' : d.kind === 'auth' ? '#f0883e' : d.ok === false ? '#f85149' : '#3fb950'
  const isChip = d.kind === 'chip'
  return (
    <div
      data-flow-node={d.id}
      title={d.title}
      style={{
        width: W[d.kind], height: H[d.kind], borderRadius: isChip ? 10 : 5,
        background: d.kind === 'ask' ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-bg-panel))' : isChip ? 'color-mix(in srgb, #a371f7 10%, var(--color-bg-base))' : 'var(--color-bg-raised)',
        border: `1px solid ${d.sel ? accent : 'var(--color-border-default)'}`,
        borderLeft: isChip ? undefined : `2px solid ${accent}`,
        padding: isChip ? '0 8px' : '0 6px',
        display: 'flex', alignItems: 'center', gap: 4,
        opacity: d.dim ? 0.22 : 1,
        cursor: 'pointer',
        boxShadow: d.sel ? `0 0 0 2px ${accent}55` : 'none',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Left} id="l" style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} id="r" style={{ opacity: 0 }} />
      {/* chip 链：从上一节「底部」出、从下一节「顶部」进 —— 提问和 chips 串成一条竖线 */}
      {isChip && <Handle type="target" position={Position.Top} id="t" style={{ opacity: 0 }} />}
      {(isChip || d.kind === 'ask') && <Handle type="source" position={Position.Bottom} id="b" style={{ opacity: 0 }} />}
      <span style={{ fontSize: 8.5, flexShrink: 0 }}>{ICON[d.kind]}</span>
      <span style={{ fontSize: d.kind === 'ask' ? 10 : 9.5, fontWeight: d.kind === 'ask' ? 600 : 500, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
      {d.count && d.count > 1 && <span style={{ fontSize: 8, color: accent, flexShrink: 0 }}>{d.folded ? `+${d.count}` : `×${d.count}`}</span>}
    </div>
  )
}

const nodeTypes = { box: NodeBox }

export function SessionFlowDrawer({ items, subagents, title, onClose }: { items: FlowInput[]; subagents?: SubagentView[]; title?: string; onClose: () => void }) {
  const [sel, setSel] = useState<string>()
  const [from, setFrom] = useState<number | undefined>(undefined)   // undefined = 贴到最后几轮
  const flow = useMemo(() => buildSessionFlow(items, { size: WINDOW, from }), [items, from])
  const selNode = flow.nodes.find((n) => n.id === sel)
  // 导出文件名：会话标题（去非法字符）+ 当前这一组的轮次范围
  const exportName = `会话流程图-${(title ?? 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${flow.from + 1}-${flow.from + flow.turns}`   // i18n-ignore 导出文件名，不进字典
  const svgOf = () => buildFlowSvg(graph.nodes as unknown as ExportNode[], graph.edges as unknown as ExportEdge[])
  // 点中的是子代理节点时，按 task / 标题匹配到它的执行轨迹（数据源与「导出会话」里的子代理段一致）
  const sub = useMemo(() => {
    if (!selNode || selNode.label !== 'agent' || !subagents?.length) return undefined
    const d = selNode.detail ?? ''
    return subagents.find((s) => (s.title && d.includes(s.title)) || (s.task && d.includes(s.task.slice(0, 12))))
  }, [selNode, subagents])

  const maxFrom = Math.max(0, flow.totalTurns - WINDOW)
  const step = (d: number) => setFrom(Math.max(0, Math.min(maxFrom, flow.from + d * WINDOW)))
  const hasEarlier = flow.from > 0
  const hasLater = flow.from + flow.turns < flow.totalTurns

  const graph = useMemo(() => {
    // 按 (轮, 阶段) 分列，列内纵向居中
    const cols = new Map<string, FlowNode[]>()
    for (const n of flow.nodes) {
      const k = `${n.turn}-${n.stage}`
      if (!cols.has(k)) cols.set(k, [])
      cols.get(k)!.push(n)
    }
    const maxH = Math.max(0, ...[...cols.values()].map((l) => l.reduce((s, n) => s + H[n.kind] + VGAP, 0)))
    const nodes: Node[] = []
    for (const [k, list] of cols) {
      const [turn, stage] = k.split('-').map(Number)
      const colH = list.reduce((s, n) => s + H[n.kind] + VGAP, 0) - VGAP
      let y = (maxH - colH) / 2
      for (const n of list) {
        nodes.push({
          id: n.id, type: 'box',
          position: { x: turn * TURN_GAP + STAGE_X[stage as 0 | 1 | 2], y },
          style: { width: W[n.kind], height: H[n.kind] },
          data: { ...n, dim: !!sel && sel !== n.id, sel: sel === n.id } satisfies D,
        })
        y += H[n.kind] + VGAP
      }
    }
    const kindOf = (id: string) => flow.nodes.find((n) => n.id === id)?.kind
    const edges: Edge[] = flow.edges.map((e, i) => {
      const on = !!sel && (sel === e.from || sel === e.to)
      const color = EDGE_COLOR[e.kind]
      // 提问 → chip 走竖向（提问底部 → chip 顶部）；其余走横向（右 → 左）
      const down = e.kind === 'chip' && kindOf(e.to) === 'chip'
      return {
        id: `e${i}`, source: e.from, target: e.to,
        sourceHandle: down ? 'b' : 'r',
        targetHandle: down ? 't' : 'l',
        type: 'default',
        animated: e.kind === 'write' || (e.kind === 'chip' && !down),
        style: {
          stroke: color,
          strokeWidth: on ? 1.6 : e.kind === 'weak' ? 0.9 : 1.2,
          strokeDasharray: e.kind === 'weak' ? '4 3' : e.kind === 'chip' ? '2 2' : undefined,
          opacity: sel ? (on ? 1 : 0.08) : e.kind === 'weak' ? 0.35 : 0.75,
        },
        markerEnd: { type: MarkerType.Arrow, width: 8, height: 8, color },
      } satisfies Edge
    })
    return { nodes, edges }
  }, [flow, sel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45" data-session-flow onClick={onClose}>
      <div className="flex h-[86vh] w-[92vw] max-w-[1600px] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3">
          <span className="text-[12.5px] font-medium text-[var(--color-text-primary)]">{tr('会话流程图')}</span>
          <span className="truncate text-[10.5px] text-[var(--color-text-muted)]">
            {title ?? ''} · {tr('共 {n} 轮 · 每屏 {m} 轮', { n: flow.totalTurns, m: WINDOW })}{flow.folded ? tr(' · 折叠 {n} 个', { n: flow.folded }) : ''}
          </span>
          {/* 导出：给一张能贴工单 / 发同事的图（当前这一组轮次） */}
          <button data-flow-export="svg" onClick={() => downloadSvg(`${exportName}.svg`, svgOf())}
            title={tr('导出为 SVG（矢量，文字可选中）')}
            className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
            <Download className="h-3 w-3" />SVG
          </button>
          <button data-flow-export="png" onClick={() => { void downloadPng(`${exportName}.png`, svgOf()).catch(() => {}) }}
            title={tr('导出为 PNG（2 倍分辨率）')}
            className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
            <Download className="h-3 w-3" />PNG
          </button>
          <button onClick={onClose} title={tr('关闭')} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* 轮次导航：刻度条 + 上/下一组（长对话靠它翻页，不用把几十轮塞进一张图） */}
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 text-[10.5px] text-[var(--color-text-muted)]">
          <button disabled={!hasEarlier} onClick={() => step(-1)}
            className="rounded px-1.5 py-0.5 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]">
            ← {tr('更早')}
          </button>
          <span className="tabular-nums">
            {tr('第 {a}–{b} 轮', { a: flow.from + 1, b: flow.from + flow.turns })}
          </span>
          <div className="flex h-3 flex-1 items-center gap-[2px] overflow-hidden" data-flow-scale>
            {Array.from({ length: flow.totalTurns }, (_, i) => {
              const inWin = i >= flow.from && i < flow.from + flow.turns
              return (
                <button key={i} onClick={() => setFrom(Math.min(i, maxFrom))} title={tr('第 {n} 轮', { n: i + 1 })}
                  className={`h-2 min-w-[2px] flex-1 rounded-sm transition-colors ${inWin ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-default)] hover:bg-[var(--color-text-muted)]'}`} />
              )
            })}
          </div>
          <button disabled={!hasLater} onClick={() => step(1)}
            className="rounded px-1.5 py-0.5 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]">
            {tr('更晚')} →
          </button>
        </div>
        <div className="min-h-0 flex-1" onClick={() => setSel(undefined)}>
          <ReactFlow
            nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
            fitView fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
            minZoom={0.2} maxZoom={1.8} nodesConnectable={false}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            onNodeClick={(e, n) => {
              e.stopPropagation()
              setSel(n.id === sel ? undefined : n.id)
            }}
          >
            <Background gap={24} size={0.8} color="var(--color-border-subtle)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {/* 点击节点 → 详情（图上只留短名，完整信息在这里）；点子代理节点会展开它自己的步骤 */}
        <div className="max-h-[168px] shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] px-3 py-1.5 text-[10.5px]">
          {selNode ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span>{ICON[selNode.kind]}</span>
                <span className="text-[11.5px] font-semibold text-[var(--color-text-primary)]">{selNode.title.split('\n')[0]}</span>
                <span className="text-[var(--color-text-muted)]">{tr('第 {n} 轮', { n: flow.from + selNode.turn + 1 })}</span>
                {selNode.ok === false && <span className="text-[var(--color-danger)]">{tr('失败')}</span>}
                {sub && <span className="text-[var(--color-text-muted)]">{tr('子代理 · {n} 步', { n: sub.steps?.length ?? 0 })}</span>}
              </div>
              <div className="truncate font-mono text-[var(--color-text-secondary)]" title={selNode.detail}>{selNode.detail ?? selNode.title}</div>
              {/* 子代理：把它的执行轨迹展开（跟导出会话里那段同源） */}
              {sub && (
                <div className="mt-0.5 flex flex-col gap-0.5 border-t border-[var(--color-border-subtle)] pt-1 text-[10px] text-[var(--color-text-secondary)]">
                  {(sub.steps ?? []).map((s, i) => (
                    <div key={`${s.at}${i}`} className="truncate" title={s.label}>
                      <span className="text-[var(--color-text-muted)]">{i + 1}.</span> {s.label}
                    </div>
                  ))}
                  {sub.summary && <div className="mt-0.5 truncate text-[var(--color-text-secondary)]" title={sub.summary}>{tr('结论：')}{sub.summary}</div>}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-3 pt-4 text-[10px] text-[var(--color-text-muted)]">
              <span>🧑 提问</span><span>🔖 chip</span><span>⚡ 工具</span><span>💬 文字</span><span>📄 产物</span>{/* i18n-ignore 图例（emoji + 名词） */}
              <span className="text-[var(--color-border-default)]">|</span>
              <span>{tr('蓝=提问连结 · 黄=写入 · 灰虚线=产出/跨轮 · 紫=chip 来源 · 点节点看详情')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
