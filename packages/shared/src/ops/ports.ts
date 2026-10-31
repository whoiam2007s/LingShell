// 监听端口视图：远端 TCP 监听端口（ss / netstat）的命令构造 + 纯解析。只支持 Linux 的 SSH 终端，走独立 exec channel，不碰交互 shell。
// 一键转发 = 临时本地端口转发（见 desktop/main/ops/portsIpc.ts），不写进主机配置，终端关闭即停。
import type { TermOs, TerminalType } from '../protocol/index.js'

export interface ListenPort {
  proto: 'tcp' | 'tcp6'
  addr: string        // 监听地址：0.0.0.0 / :: / * / 127.0.0.1 / ::1 / 具体 IP（去掉方括号和 %网卡）
  port: number
  process?: string    // 进程名（-p 要权限：别的用户的进程看不到，留空）
  pid?: number
}
// local：本机视图（本地终端）的端口，界面据此把「转发到本机」换成「结束进程」（windows 用 taskkill）
export interface PortList { rows: ListenPort[]; tool: 'ss' | 'netstat' | 'lsof'; local?: 'windows' | 'unix' }

export const PORTS_TIMEOUT_MS = 15_000
// 先看到 os 是 macOS / Windows 就不给（macOS 没有 ss、netstat 不带进程）；unknown（没探测出来）放行，命令不可用时报错
export const portsSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows' && os !== 'macos'

const TOOL = '@@tool:'
// ss -H 是新版才有的；老版本 ss 不认 -H 就退回带表头的 ss，再退回 netstat。哪个成功由 @@tool: 行告诉解析器
export const portsListCommand = () => `sh -c '${[
  'export LC_ALL=C',
  `if o=$(ss -ltnpH 2>/dev/null) || o=$(ss -ltnp 2>/dev/null); then echo "${TOOL}ss"; printf "%s\\n" "$o"`,
  `elif o=$(netstat -ltnp 2>/dev/null) || o=$(netstat -ltn 2>/dev/null); then echo "${TOOL}netstat"; printf "%s\\n" "$o"`,
  'else exit 1; fi',
].join('; ')}'`

// 「地址:端口」拆开：[::]:22 / *:80 / 127.0.0.53%lo:53 / :::22（netstat 的 v6）/ 0.0.0.0:22
export function splitHostPort(s: string): { addr: string; port: number } | null {
  const i = s.lastIndexOf(':')
  if (i < 0) return null
  const port = Number(s.slice(i + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  let addr = s.slice(0, i)
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  addr = addr.replace(/%.*$/, '')
  return { addr: addr || '*', port }
}

const isV6 = (addr: string) => addr.includes(':')

// ss：State Recv-Q Send-Q Local Peer [Process]，前面可能多一列 Netid（tcp）；带表头时表头行没有 LISTEN，自然跳过
function parseSsLine(line: string): ListenPort | null {
  const t = line.trim().split(/\s+/)
  const k = t.indexOf('LISTEN')
  if (k < 0 || t.length < k + 5) return null
  const hp = splitHostPort(t[k + 3])
  if (!hp) return null
  const rest = t.slice(k + 5).join(' ')
  const m = /users:\(\("([^"]*)",pid=(\d+)/.exec(rest)
  return { proto: isV6(hp.addr) ? 'tcp6' : 'tcp', ...hp, ...(m ? { process: m[1], pid: Number(m[2]) } : {}) }
}

// netstat：Proto Recv-Q Send-Q Local Foreign State [PID/Program name]
function parseNetstatLine(line: string): ListenPort | null {
  const t = line.trim().split(/\s+/)
  if (!/^tcp6?$/.test(t[0]) || t[5] !== 'LISTEN') return null
  const hp = splitHostPort(t[3])
  if (!hp) return null
  const m = /^(\d+)\/(.+)$/.exec(t.slice(6).join(' '))
  const proc = m?.[2].split(/[:\s]/)[0]   // 「800/sshd: /usr/sbin」只要 sshd
  return { proto: t[0] === 'tcp6' || isV6(hp.addr) ? 'tcp6' : 'tcp', ...hp, ...(m ? { process: proc, pid: Number(m[1]) } : {}) }
}

/** 解析 portsListCommand 的输出：按 @@tool: 选格式；同一地址端口只留一条，按端口、地址排序 */
export function parsePorts(out: string): PortList {
  const lines = out.split(/\r?\n/)
  const head = lines.findIndex((l) => l.startsWith(TOOL))
  const tool: PortList['tool'] = head >= 0 && lines[head].slice(TOOL.length).trim() === 'netstat' ? 'netstat' : 'ss'
  const parse = tool === 'ss' ? parseSsLine : parseNetstatLine
  const seen = new Set<string>()
  const rows: ListenPort[] = []
  for (const l of lines.slice(head + 1)) {
    const r = parse(l)
    if (!r || seen.has(`${r.addr}|${r.port}`)) continue
    seen.add(`${r.addr}|${r.port}`)
    rows.push(r)
  }
  rows.sort((a, b) => a.port - b.port || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
  return { rows, tool }
}

/** 过滤：端口号 / 地址 / 进程名 / PID 子串（不分大小写） */
export function filterPorts(rows: ListenPort[], q: string): ListenPort[] {
  const s = q.trim().toLowerCase()
  if (!s) return rows
  return rows.filter((r) => [String(r.port), r.addr, r.process ?? '', r.pid ? String(r.pid) : ''].some((x) => x.toLowerCase().includes(s)))
}

/** 转发时在远端连哪个地址：IPv4 全部地址连 127.0.0.1；IPv6 全部地址连 ::1（服务可能 IPV6_V6ONLY，连 127.0.0.1 会拒绝） */
export function forwardTarget(addr: string): string {
  if (addr === '::') return '::1'
  return addr === '0.0.0.0' || addr === '*' || addr === '' ? '127.0.0.1' : addr
}

/** 本地端口候选：默认同号，被占用依次 +1（最多试 20 个，不超过 65535）。
 *  min：非 Windows 传 1024，远端 80/443 时不能从特权端口开始（非 root 必然 EACCES） */
export function localPortCandidates(remotePort: number, n = 20, min = 1): number[] {
  const out: number[] = []
  const start = Math.max(Math.floor(remotePort), Math.max(1, Math.floor(min)))
  for (let p = start; p <= 65535 && out.length < n; p++) out.push(p)
  return out
}

/** 浏览器里打开的地址：本地转发都监听 127.0.0.1；远端是 443/8443 时用 https（否则打开是 TLS 错误页） */
export const localForwardUrl = (localPort: number, remotePort = localPort) =>
  `${remotePort === 443 || remotePort === 8443 ? 'https' : 'http'}://127.0.0.1:${localPort}/`
