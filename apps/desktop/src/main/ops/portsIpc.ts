import { connect } from 'node:net'
import {
  PORTS_TIMEOUT_MS, forwardTarget, localPortCandidates, parsePorts, portsListCommand, portsSupported,
  type PortForwardInfo, type PortForwardInput, type PortList, type SshConnectOpts, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { ExecRead } from './processes.js'

// 监听端口视图（见 shared/ops/ports.ts）：独立 exec channel 跑 ss / netstat；「转发到本机」= 临时本地端口转发，
// 复用 PortForwardManager（另开一条 SSH 连接，参数取自该终端）。临时转发不写主机配置，终端关闭时 stopTerminal 停掉
export interface PortsIpcDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  terminal(id: string): TerminalInfo | undefined
  exec(id: string): ExecRead
  sshOpts(id: string): SshConnectOpts
  hostKey(id: string): string
  forwards: {
    start(input: PortForwardInput, opts: () => SshConnectOpts, hostLabel: string): Promise<PortForwardInfo>
    stop(id: string): void
    list(): PortForwardInfo[]
  }
  inUse?(port: number): Promise<boolean>   // 本机端口是否已有程序在听（测试注入）
  // 本机视图：本地终端列本机监听端口（不给就不支持本地终端；本机没有「转发」，结束进程走 processes:signal）
  localPorts?(): Promise<PortList>
}

// 本机 127.0.0.1:port 能连上 = 已有程序在听。Windows 上别的程序监听 0.0.0.0 时我们照样能绑 127.0.0.1，
// 光靠 listen 报错发现不了，会把流量截走，所以先探一下
export function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (v: boolean) => { clearTimeout(t); s.destroy(); resolve(v) }
    const t = setTimeout(() => done(false), timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

const IP = /^[0-9a-fA-F:.*]{1,64}$/   // 监听地址只会是 IP / * / ::（不是任意主机名）

export function registerPorts(d: PortsIpcDeps): { stopTerminal(id: string): void; forward(id: string, addr: string, remotePort: number): Promise<PortForwardInfo>; stop(id: string, fwdId: string): void } {
  const temps = new Map<string, Set<string>>()   // 终端 → 它的临时转发 id
  const inUse = d.inUse ?? portInUse
  const target = (id: unknown) => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!portsSupported(t.type, t.os)) throw new Error(tr('监听端口只支持 Linux 的 SSH 终端'))
    return t
  }
  // 本终端还活着的临时转发（在设置 → 端口转发里被停掉的顺手清掉）
  const mine = (tid: string): PortForwardInfo[] => {
    const ids = temps.get(tid)
    if (!ids) return []
    const all = d.forwards.list().filter((f) => ids.has(f.id))
    for (const id of [...ids]) if (!all.some((f) => f.id === id)) ids.delete(id)
    return all
  }

  d.handle('ports:list', async (_e, id): Promise<PortList> => {
    const lt = typeof id === 'string' ? d.terminal(id) : undefined
    if (lt?.type === 'local' && d.localPorts) return d.localPorts()
    const out = await d.exec(target(id).id)(portsListCommand(), PORTS_TIMEOUT_MS)
    if (!out.includes('@@tool:')) throw new Error(tr('读不到监听端口：远端没有 ss / netstat 命令'))
    return parsePorts(out)
  })
  d.handle('ports:forwards', (_e, id) => mine(target(id).id))
  const forward = async (id: unknown, addr: unknown, remotePort: unknown): Promise<PortForwardInfo> => {
    const t = target(id)
    if (typeof addr !== 'string' || !IP.test(addr)) throw new Error(tr('非法的监听地址'))
    if (typeof remotePort !== 'number' || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error(tr('非法的端口'))
    const remoteHost = forwardTarget(addr)
    const dup = mine(t.id).find((f) => f.kind !== 'dynamic' && f.kind !== 'remote' && f.remoteHost === remoteHost && f.remotePort === remotePort)
    if (dup) return dup
    const opts = d.sshOpts(t.id)   // 现在取一次：终端之后断线重连 / 关闭都不影响这条转发的参数
    const taken = new Set(d.forwards.list().filter((f) => f.kind !== 'remote').map((f) => f.localPort))
    const tried: number[] = []
    // Linux/macOS 非 root 不能监听 <1024：远端 80/443 时从 1024 起找，不然 20 个候选全是权限错误
    for (const localPort of localPortCandidates(remotePort, 20, process.platform === 'win32' ? 1 : 1024)) {
      if (taken.has(localPort) || await inUse(localPort)) { tried.push(localPort); continue }
      try {
        const info = await d.forwards.start({ hostId: d.hostKey(t.id), kind: 'local', localPort, remoteHost, remotePort }, () => opts, tr('{name}（临时）', { name: t.title }))
        let s = temps.get(t.id)
        if (!s) temps.set(t.id, s = new Set())
        s.add(info.id)
        return info
      } catch (e) {
        if (!/^local_(port_in_use|listen_failed):/.test(e instanceof Error ? e.message : '')) throw e
        tried.push(localPort)
      }
    }
    throw new Error(tr('本机端口 {from}–{to} 都被占用，没能转发', { from: tried[0], to: tried[tried.length - 1] }))
  }
  d.handle('ports:forward', (_e, id, addr, remotePort) => forward(id, addr, remotePort))
  const stop = (id: unknown, fwdId: unknown) => {
    const t = target(id)
    if (typeof fwdId !== 'string' || !temps.get(t.id)?.has(fwdId)) return
    temps.get(t.id)!.delete(fwdId)
    d.forwards.stop(fwdId)
  }
  d.handle('ports:stop', (_e, id, fwdId) => stop(id, fwdId))
  return {
    // Kubernetes 视图的端口转发复用：远端 kubectl port-forward 听的端口 → 本机
    forward: (id: string, addr: string, remotePort: number) => forward(id, addr, remotePort),
    stop: (id: string, fwdId: string) => stop(id, fwdId),
    stopTerminal(id) {
      for (const f of temps.get(id) ?? []) d.forwards.stop(f)
      temps.delete(id)
    },
  }
}
