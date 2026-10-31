// 服务拓扑：采集 ss（监听 + 已建立连接）、docker 网络与端口映射，推导「进程 / 容器 A → B:端口」的有向关系，再做简单分层布局
// （入口在左、内部服务居中、数据库 / 外部在右）。只读，走独立 exec channel；画图在界面（SVG，不加依赖）
import { shq } from '../files/explorer.js'
import { tk, tr } from '../i18n/i18n.js'
import { parsePorts, splitHostPort, type ListenPort } from './ports.js'

export const TOPOLOGY_TIMEOUT_MS = 20_000
export type TopoRole = 'entry' | 'internal' | 'data' | 'external'
export interface TopoNode {
  id: string            // proc:nginx / ctr:web / ext:1.2.3.4:3306 / port:9000
  label: string
  kind: 'process' | 'container' | 'external' | 'port'
  role: TopoRole
  listen: { addr: string; port: number }[]
  pids: number[]
  inExternal: number    // 来自外部地址的入站连接数
  inConns: number       // 本机内别的节点连进来的连接数
  outConns: number
}
export interface TopoEdge { from: string; to: string; port: number; count: number }
export interface Topology { nodes: TopoNode[]; edges: TopoEdge[]; docker: boolean; procVisible: boolean }

export const topologyCommand = () => `sh -c ${shq([
  'export LC_ALL=C',
  'rr() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@" 2>/dev/null || "$@"; fi; }',
  'echo "@@listen"; rr ss -ltnpH 2>/dev/null || rr ss -ltnp 2>/dev/null',
  'echo "@@estab"; rr ss -tnpH state established 2>/dev/null || rr ss -tnp state established 2>/dev/null',
  'echo "@@addrs"; hostname -I 2>/dev/null || hostname -i 2>/dev/null',
  'if command -v docker >/dev/null 2>&1; then',
  '  echo "@@dockerps"; rr docker ps --format "{{.Names}}\t{{.Ports}}" 2>/dev/null',
  '  echo "@@dockernet"; n=$(rr docker network ls -q 2>/dev/null); [ -n "$n" ] && rr docker network inspect $n 2>/dev/null',
  'fi',
].join('\n'))}`

interface Conn { local: { addr: string; port: number }; peer: { addr: string; port: number }; proc?: string; pid?: number }
// ss 已建立连接一行：[ESTAB] Recv-Q Send-Q Local Peer [users:(("x",pid=1,fd=3))]（按 state 过滤时没有 State 列）
function parseConn(line: string): Conn | null {
  const t = line.trim().split(/\s+/).filter((x) => x !== 'tcp' && x !== 'ESTAB')
  if (t.length < 4 || !/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1])) return null
  const local = splitHostPort(t[2]), peer = splitHostPort(t[3])
  if (!local || !peer) return null
  const m = /users:\(\("([^"]*)",pid=(\d+)/.exec(t.slice(4).join(' '))
  return { local, peer: { ...peer, addr: v4(peer.addr) }, ...(m ? { proc: m[1], pid: Number(m[2]) } : {}) }
}
const v4 = (a: string) => a.replace(/^::ffff:/i, '')
const LOOP = (a: string) => /^127\./.test(a) || a === '::1' || a === 'localhost'
const WILD = (a: string) => a === '0.0.0.0' || a === '::' || a === '*' || a === ''

// 数据库 / 中间件：按端口或进程名归到右侧
const DATA_PORTS = new Set([3306, 33060, 5432, 6379, 27017, 9200, 9300, 11211, 5672, 9092, 2181, 8123, 9000, 2379, 1521, 1433, 6380, 26379, 15672, 4222])
const DATA_NAME = /mysql|maria|postgres|redis|mongo|elastic|memcache|rabbit|kafka|zookeeper|clickhouse|etcd|oracle|mssql|sqlserver|nats|influx|minio/i

interface DockerInfo { ips: Map<string, string>; ports: Map<number, { name: string; port: number }> }
function parseDocker(ps: string[], net: string): DockerInfo {
  const ips = new Map<string, string>(), ports = new Map<number, { name: string; port: number }>()
  for (const l of ps) {
    const [name, spec = ''] = l.split('\t')
    if (!name?.trim()) continue
    for (const m of spec.matchAll(/(?:[\d.]+|\[::\]|::):(\d+)->(\d+)\/tcp/g)) ports.set(Number(m[1]), { name: name.trim(), port: Number(m[2]) })
  }
  try {
    const arr = JSON.parse(net || '[]') as { Containers?: Record<string, { Name?: string; IPv4Address?: string }> }[]
    for (const n of Array.isArray(arr) ? arr : []) for (const c of Object.values(n.Containers ?? {})) {
      const ip = c.IPv4Address?.split('/')[0]
      if (ip && c.Name) ips.set(ip, c.Name)
    }
  } catch { /* docker network inspect 没输出 / 被截断：只用端口映射 */ }
  return { ips, ports }
}

/** 从 topologyCommand 的输出推导拓扑 */
export function deriveTopology(out: string): Topology {
  const sec = new Map<string, string[]>()
  let k = ''
  for (const l of out.replace(/\r/g, '').split('\n')) {
    if (/^@@(listen|estab|addrs|dockerps|dockernet)$/.test(l)) { k = l.slice(2); sec.set(k, []); continue }
    if (k) sec.get(k)!.push(l)
  }
  const listens: ListenPort[] = parsePorts(`@@tool:ss\n${(sec.get('listen') ?? []).join('\n')}`).rows
  const conns = (sec.get('estab') ?? []).map(parseConn).filter((c): c is Conn => !!c)
  const localIps = new Set((sec.get('addrs') ?? []).join(' ').split(/\s+/).filter(Boolean))
  for (const l of listens) if (!WILD(l.addr) && !LOOP(l.addr)) localIps.add(l.addr)
  const docker = sec.has('dockerps') ? parseDocker(sec.get('dockerps')!, (sec.get('dockernet') ?? []).join('\n')) : { ips: new Map(), ports: new Map() }

  const nodes = new Map<string, TopoNode>()
  const node = (id: string, label: string, kind: TopoNode['kind']): TopoNode => {
    let n = nodes.get(id)
    if (!n) nodes.set(id, n = { id, label, kind, role: 'internal', listen: [], pids: [], inExternal: 0, inConns: 0, outConns: 0 })
    return n
  }
  const procNode = (name?: string, pid?: number) => {
    const n = name ? node(`proc:${name}`, name, 'process') : node('proc:?', tr('未知进程（没有权限看）'), 'process')
    if (pid && !n.pids.includes(pid)) n.pids.push(pid)
    return n
  }
  // 监听者：docker-proxy（或映射端口）→ 容器节点；否则按进程名
  const listenerNode = (l: ListenPort) => {
    const m = docker.ports.get(l.port)
    if (m && (!l.process || /docker-proxy/.test(l.process))) return node(`ctr:${m.name}`, m.name, 'container')
    return l.process ? procNode(l.process, l.pid) : node(`port:${l.port}`, tr(':{port}（看不到进程）', { port: l.port }), 'port')
  }
  for (const l of listens) {
    const n = listenerNode(l)
    if (!n.listen.some((x) => x.port === l.port && x.addr === l.addr)) n.listen.push({ addr: l.addr, port: l.port })
  }
  const listenerOn = (addr: string, port: number) => listens.find((l) => l.port === port && (WILD(l.addr) || l.addr === addr || (LOOP(addr) && LOOP(l.addr))))
  const isLocal = (a: string) => LOOP(a) || localIps.has(a)

  const edges = new Map<string, TopoEdge>()
  for (const c of conns) {
    const mine = c.proc ? listens.find((l) => l.port === c.local.port && l.process === c.proc) : listenerOn(c.local.addr, c.local.port)
    if (mine) {   // 服务端那一头：本机内的由客户端那头记；外部来的计入站
      if (!isLocal(c.peer.addr) && !docker.ips.has(c.peer.addr)) listenerNode(mine).inExternal++
      continue
    }
    const src = c.proc && /docker-proxy/.test(c.proc) ? undefined : procNode(c.proc, c.pid)
    if (!src) continue   // docker-proxy → 容器：就是容器自己的入站，已在映射里体现
    let dst: TopoNode
    const ctr = docker.ips.get(c.peer.addr)
    if (ctr) dst = node(`ctr:${ctr}`, ctr, 'container')
    else if (isLocal(c.peer.addr)) { const l = listenerOn(c.peer.addr, c.peer.port); dst = l ? listenerNode(l) : node(`port:${c.peer.port}`, `:${c.peer.port}`, 'port') }
    else dst = node(`ext:${c.peer.addr}:${c.peer.port}`, tr('外部 {addr}:{port}', { addr: c.peer.addr, port: c.peer.port }), 'external')
    if (dst.id === src.id) continue
    const key = `${src.id}>${dst.id}>${c.peer.port}`
    const e = edges.get(key) ?? { from: src.id, to: dst.id, port: c.peer.port, count: 0 }
    e.count++; edges.set(key, e)
    src.outConns++; dst.inConns++
  }
  for (const n of nodes.values()) {
    n.listen.sort((a, b) => a.port - b.port)
    n.role = n.kind === 'external' ? (DATA_PORTS.has(Number(n.id.split(':').pop())) ? 'data' : 'external')
      : n.listen.some((l) => DATA_PORTS.has(l.port)) || DATA_NAME.test(n.label) ? 'data'
        : n.listen.some((l) => !LOOP(l.addr)) ? 'entry' : 'internal'
  }
  return {
    nodes: [...nodes.values()].filter((n) => n.listen.length || n.inConns || n.outConns),
    edges: [...edges.values()], docker: sec.has('dockerps'), procVisible: listens.some((l) => !!l.process),
  }
}

// ── 布局：三列（入口 / 内部 / 数据库与外部），列内按名字排；纯函数，界面直接按坐标画 ──
export interface TopoLayout { nodes: (TopoNode & { x: number; y: number; col: number })[]; width: number; height: number; nodeW: number; nodeH: number }
export const TOPO_COLS = [tk('入口（对外监听）'), tk('内部服务'), tk('数据库 / 外部')] as const
export function layoutTopology(t: Topology, o: { colGap?: number; rowGap?: number; nodeW?: number; nodeH?: number; pad?: number } = {}): TopoLayout {
  const nodeW = o.nodeW ?? 168, nodeH = o.nodeH ?? 44, colGap = o.colGap ?? 110, rowGap = o.rowGap ?? 16, pad = o.pad ?? 16
  const colOf = (n: TopoNode) => (n.role === 'entry' ? 0 : n.role === 'internal' ? 1 : 2)
  const cols: TopoNode[][] = [[], [], []]
  for (const n of t.nodes) cols[colOf(n)].push(n)
  // 第三列：数据库在上、外部在下；其余按名字
  const rank = (n: TopoNode) => (n.role === 'data' && n.kind !== 'external' ? 0 : n.role === 'data' ? 1 : 2)
  for (const c of cols) c.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
  const rows = Math.max(1, ...cols.map((c) => c.length))
  const height = pad * 2 + 22 + rows * nodeH + (rows - 1) * rowGap
  const out: TopoLayout['nodes'] = []
  cols.forEach((c, ci) => {
    const colH = c.length * nodeH + Math.max(0, c.length - 1) * rowGap
    const top = pad + 22 + (height - pad * 2 - 22 - colH) / 2   // 列内竖直居中
    c.forEach((n, i) => out.push({ ...n, col: ci, x: pad + ci * (nodeW + colGap), y: Math.round(top + i * (nodeH + rowGap)) }))
  })
  return { nodes: out, width: pad * 2 + 3 * nodeW + 2 * colGap, height, nodeW, nodeH }
}

/** 连线路径（三次贝塞尔）：左列 → 右列从右边出、左边进；同列 / 往回连从右侧绕 */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number): string {
  const y1 = a.y + h / 2, y2 = b.y + h / 2
  if (b.x > a.x) { const x1 = a.x + w, x2 = b.x, dx = (x2 - x1) / 2; return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` }
  const x1 = a.x + w, x2 = b.x + w, bulge = 40 + Math.abs(y2 - y1) / 4
  return `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`
}
