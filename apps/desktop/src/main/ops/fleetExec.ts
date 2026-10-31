// 跨主机提问（AI 工具 run_on_hosts）的执行：每台一次 runBatchHost（独立 exec channel，不往交互终端里敲），
// 并发上限 FLEET_CONCURRENCY；连接选择同批量执行：该主机有在线终端就复用它的连接，否则临时连、跑完即断。
// 授权、只读判定、执行记录都在 dsh-controller 的工具层（terminalTools.ts），这里只管跑。
import { setMaxListeners } from 'node:events'
import { runPool, fleetRow, FLEET_CONCURRENCY, type FleetHost, type FleetRow, type SshConnectOpts } from '@lingshell/shared'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'
import { runBatchHost, type Runner } from './batchExec.js'

export async function runOnHosts(hosts: FleetHost[], open: (h: FleetHost) => () => Promise<Runner>, command: string, timeoutMs: number,
  signal: AbortSignal = new AbortController().signal, concurrency = FLEET_CONCURRENCY): Promise<FleetRow[]> {
  setMaxListeners(100, signal)   // 并发的每台各挂 1–2 个中止监听
  const rows: (FleetRow | undefined)[] = []
  await runPool(hosts.length, concurrency, async (i) => { rows[i] = fleetRow(hosts[i], await runBatchHost(open(hosts[i]), command, timeoutMs, signal)) }, signal)
  // 中止后没起的主机记「已取消」
  return hosts.map((h, i) => rows[i] ?? fleetRow(h, { status: 'canceled', ms: 0 }))
}

/** 已保存主机的执行通道：有在线终端复用其连接（close 空操作），否则临时连接（close 断开）。
 *  unattended：无人值守（巡检 / 定时任务）——临时连接遇到未知 / 变化的指纹直接失败，绝不弹确认框等人点 */
export function hostRunner(d: {
  liveTerminal(hostId: string): string | undefined
  execOnTerminal(terminalId: string, command: string, o: ExecFullOpts): Promise<ExecFullResult>
  connectOpts(hostId: string): SshConnectOpts
  connect(o: SshConnectOpts): Promise<{ client: unknown; close(): void }>
  execOnClient(client: unknown, command: string, o: ExecFullOpts): Promise<ExecFullResult>
}, unattended = false) {
  return (h: FleetHost) => async (): Promise<Runner> => {
    const tid = d.liveTerminal(h.id)
    if (tid) return { exec: (c, o) => d.execOnTerminal(tid, c, o), close() {} }
    const o = d.connectOpts(h.id)
    const conn = await d.connect(unattended ? { ...o, noHostKeyPrompt: true } : o)
    return { exec: (c, x) => d.execOnClient(conn.client, c, { ...x, encoding: o.encoding }), close: () => conn.close() }
  }
}
