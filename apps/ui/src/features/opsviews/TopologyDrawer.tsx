import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Network } from 'lucide-react'
import { TOPO_COLS, edgePath, layoutTopology, portsSupported, tk, tr, type TerminalInfo, type TopoNode, type Topology } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { HelpTip } from '../../components/ui/form.js'
import { DrawerHeader, MUTED, Unsupported, errText } from './common.js'

const W = 118, H = 40, GAP = 64   // 画布按抽屉宽度等比缩放（viewBox）
// 节点配色：入口（对外监听）强调色、内部中性、数据库警示色、外部虚线
const FILL: Record<TopoNode['role'], string> = {
  entry: 'color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-panel))',
  internal: 'var(--color-bg-raised)',
  data: 'color-mix(in srgb, var(--color-warn) 16%, var(--color-bg-panel))',
  external: 'var(--color-bg-panel)',
}
const STROKE: Record<TopoNode['role'], string> = { entry: 'var(--color-accent)', internal: 'var(--color-border-default)', data: 'var(--color-warn)', external: 'var(--color-text-muted)' }
const ROLE_TEXT: Record<TopoNode['role'], string> = { entry: tk('入口（监听在对外地址上）'), internal: tk('内部服务（只监听本机）'), data: tk('数据库 / 中间件'), external: tk('外部地址') }
const KIND_TEXT: Record<TopoNode['kind'], string> = { process: tk('kind|进程'), container: tk('kind|容器'), external: tk('外部'), port: tk('端口') }
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const sub = (n: TopoNode) => (n.kind === 'external' ? tr('出站目标') : n.listen.length ? n.listen.map((l) => `:${l.port}`).filter((x, i, a) => a.indexOf(x) === i).join(' ') : tr(KIND_TEXT[n.kind]))

// 服务拓扑：当前 SSH 终端所在主机（Linux）上进程 / 容器之间谁连谁（ss 已建立连接 + 监听 + docker 网络推导，只读）。
// 三列：入口在左、内部服务居中、数据库 / 外部在右；点节点看端口与连接数，相关连线高亮
export function TopologyDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && portsSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const [topo, setTopo] = useState<Topology>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string>()

  // 请求序号：迟到的旧响应不能覆盖新结果；节点变了就把已选中的清掉（详情不会停在旧节点上）
  const seq = useRef(0)
  const refresh = useCallback(() => {
    if (!ok) return
    const n = ++seq.current
    setLoading(true)
    client.topology.get(tid).then((r) => {
      if (n !== seq.current) return
      setTopo(r); setSel((s) => (s && r.nodes.some((x) => x.id === s) ? s : undefined)); setErr('')
    }).catch((e) => { if (n === seq.current) setErr(errText(e)) })
      .finally(() => { if (n === seq.current) setLoading(false) })
  }, [ok, tid])
  useEffect(() => { refresh() }, [refresh])

  const lay = useMemo(() => (topo ? layoutTopology(topo, { nodeW: W, nodeH: H, colGap: GAP, rowGap: 14, pad: 10 }) : undefined), [topo])
  const pos = useMemo(() => new Map(lay?.nodes.map((n) => [n.id, n]) ?? []), [lay])
  const selNode = sel ? pos.get(sel) : undefined
  const label = (id: string) => pos.get(id)?.label ?? id

  const header = <DrawerHeader icon={<Network className="h-3.5 w-3.5" />} title={tr('服务拓扑')} loading={loading} onRefresh={ok ? refresh : undefined} onClose={onClose}
    extra={ok ? <HelpTip>{tr('按 ss 看到的已建立 TCP 连接和监听端口、docker 网络推导：A → B:端口 表示 A 正连着 B 的这个端口，线越粗连接越多。只是采集那一刻的快照，点刷新重新采。本机内的连接只画一次；连到外部的按「外部 地址:端口」汇总。')}</HelpTip> : undefined} />
  if (!ok) return <div className="flex h-full flex-col">{header}<Unsupported what={tr('服务拓扑')} /></div>

  return (
    <div className="flex h-full flex-col" data-topology-drawer>
      {header}
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      {topo && !topo.procVisible && topo.nodes.length > 0 && <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-warn)]">{tr('看不到进程名（需要 root 或免密 sudo），节点按端口显示。')}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {!topo && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{loading ? tr('采集中…') : ''}</div>}
        {topo && !topo.nodes.length && <div className={`px-3 py-3 text-[12px] ${MUTED}`}>{tr('没有读到监听端口和连接。')}</div>}
        {lay && topo && topo.nodes.length > 0 && (
          <svg data-topology-svg viewBox={`0 0 ${lay.width} ${lay.height}`} width="100%" style={{ maxWidth: lay.width }} className="block select-none font-sans" onClick={() => setSel(undefined)}>
            <defs>
              <marker id="topo-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="var(--color-text-muted)" /></marker>
              <marker id="topo-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="var(--color-accent)" /></marker>
            </defs>
            {TOPO_COLS.map((t, i) => <text key={t} x={10 + i * (W + GAP) + W / 2} y={18} textAnchor="middle" fontSize={10.5} fill="var(--color-text-muted)">{tr(t)}</text>)}
            {topo.edges.map((e, i) => {
              const a = pos.get(e.from), b = pos.get(e.to)
              if (!a || !b) return null
              const on = sel === e.from || sel === e.to
              const d = edgePath(a, b, W, H)
              // 端口标签放在曲线 70% 处（离目标近、同一来源的几条线在这里已经分开）
              const t = 0.7, k = 3 * t * t - 2 * t * t * t
              const mx = a.x + W + (b.x - a.x - W) * t, my = a.y + H / 2 + (b.y - a.y) * k
              return (
                <g key={i} data-edge={`${e.from}>${e.to}`} opacity={sel && !on ? 0.25 : 1}>
                  <path d={d} fill="none" stroke={on ? 'var(--color-accent)' : 'var(--color-text-muted)'} strokeWidth={Math.min(4, 1 + Math.log2(e.count))} markerEnd={`url(#topo-arrow${on ? '-on' : ''})`}>
                    <title>{`${label(e.from)} → ${label(e.to)}${b.kind === 'external' ? '' : `:${e.port}`}${tr('（{n} 条连接）', { n: e.count })}`}</title>
                  </path>
                  {b.x > a.x && <text x={mx} y={my - 3} textAnchor="middle" fontSize={9.5} stroke="var(--color-bg-panel)" strokeWidth={3} paintOrder="stroke" fill={on ? 'var(--color-accent)' : 'var(--color-text-muted)'}>:{e.port}{e.count > 1 ? ` ×${e.count}` : ''}</text>}
                </g>
              )
            })}
            {lay.nodes.map((n) => (
              <g key={n.id} data-node={n.id} transform={`translate(${n.x},${n.y})`} className="cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSel(n.id === sel ? undefined : n.id) }}
                opacity={sel && sel !== n.id && !topo.edges.some((e) => (e.from === sel && e.to === n.id) || (e.to === sel && e.from === n.id)) ? 0.45 : 1}>
                <title>{`${n.label}\n${tr(ROLE_TEXT[n.role])}`}</title>
                <rect width={W} height={H} rx={6} fill={FILL[n.role]} stroke={sel === n.id ? 'var(--color-accent)' : STROKE[n.role]} strokeWidth={sel === n.id ? 2 : 1} strokeDasharray={n.kind === 'external' ? '4 3' : undefined} />
                <text x={8} y={16} fontSize={11.5} fontWeight={600} fill="var(--color-text-primary)">{cut(`${n.kind === 'container' ? '▣ ' : ''}${n.label}`, 17)}</text>
                <text x={8} y={31} fontSize={10} fill="var(--color-text-muted)">{cut(sub(n), 20)}{n.inExternal ? tr(' · 外部 {n}', { n: n.inExternal }) : ''}</text>
              </g>
            ))}
          </svg>
        )}
      </div>
      {selNode && topo && (
        <div data-topo-detail className="max-h-[42%] shrink-0 overflow-y-auto border-t border-[var(--color-border-default)] px-3 py-2 text-[11.5px]">
          <div className="flex items-center gap-2">
            <span className="font-mono font-semibold text-[var(--color-text-primary)]">{selNode.label}</span>
            <span className={MUTED}>{tr(KIND_TEXT[selNode.kind])} · {tr(ROLE_TEXT[selNode.role])}</span>
          </div>
          {selNode.pids.length > 0 && <div className={`mt-0.5 ${MUTED}`}>{tr('PID：{list}', { list: selNode.pids.join(tr('、')) })}</div>}
          {selNode.listen.length > 0 && <div className="mt-0.5 text-[var(--color-text-secondary)]">{tr('监听：')}<span className="font-mono">{selNode.listen.map((l) => `${l.addr.includes(':') ? `[${l.addr}]` : l.addr}:${l.port}`).join('  ')}</span></div>}
          <div className="mt-0.5 text-[var(--color-text-secondary)]">{tr('连接：外部入站 {ext} · 本机内入站 {local} · 出站 {out}', { ext: selNode.inExternal, local: selNode.inConns, out: selNode.outConns })}</div>
          {topo.edges.filter((e) => e.from === selNode.id).map((e) => <div key={`o${e.to}${e.port}`} className="font-mono text-[11px] text-[var(--color-text-secondary)]">→ {label(e.to)}{pos.get(e.to)?.kind === 'external' ? '' : `:${e.port}`} · {tr('conn|{n} 条', { n: e.count })}</div>)}
          {topo.edges.filter((e) => e.to === selNode.id).map((e) => <div key={`i${e.from}${e.port}`} className="font-mono text-[11px] text-[var(--color-text-secondary)]">← {label(e.from)}{tr('（连 :{port}）· {n} 条', { port: e.port, n: e.count })}</div>)}
        </div>
      )}
      <div className={`shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[10.5px] ${MUTED}`}>{topo ? `${tr('{n} 个节点 · {m} 条关系', { n: topo.nodes.length, m: topo.edges.length })}${topo.docker ? tr(' · 含 docker') : ''}` : ''}</div>
    </div>
  )
}
