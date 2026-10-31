// 基线合规检查（条目、判定见 shared/ops/compliance.ts）：
//  - compliance:run(终端)：主机体检抽屉「合规」页，走该终端的独立 exec channel（同主机体检，不进交互 shell / 命令历史 / AI）
//  - compliance:batch(主机 id[])：「批量合规检查」，并发同跨主机提问（有在线终端复用其连接，否则临时连、跑完即断）
//  - compliance:config / setDisabled：设置里关掉的条目，存 <配置目录>/compliance.json
// 只读：脚本不改任何东西、不用 sudo，也不记执行记录（同主机体检）
import { join } from 'node:path'
import { setMaxListeners } from 'node:events'
import { readJson, writeJson } from '@lingshell/config'
import {
  COMPLIANCE_TIMEOUT_MS, FLEET_CONCURRENCY, LINUX_BASELINE, complianceCommand, enabledItems, hostCheckSupported, parseCompliance, runPool,
  type ComplianceHostRow, type FleetHost, type HostSummary, type TerminalInfo,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import type { ExecFullOpts, ExecFullResult } from '@lingshell/terminal-core'
import { runBatchHost, type Runner } from './batchExec.js'

const MAX_BYTES = 512 * 1024
export interface ComplianceConfig { disabled: string[] }

export interface ComplianceDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string
  terminal(id: string): TerminalInfo | undefined
  hostKey(terminalId: string): string
  exec(terminalId: string, command: string, o: ExecFullOpts): Promise<ExecFullResult>
  hosts(): HostSummary[]
  open(h: FleetHost): () => Promise<Runner>
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

export function registerCompliance(d: ComplianceDeps) {
  const file = join(d.dir, 'compliance.json')
  const config = (): ComplianceConfig => {
    const raw = readJson<ComplianceConfig>(file)
    const ids = new Set(LINUX_BASELINE.map((i) => i.id))
    return { disabled: Array.isArray(raw?.disabled) ? raw.disabled.filter((x) => ids.has(x)) : [] }
  }
  const items = () => enabledItems(config().disabled)

  d.handle('compliance:config', () => config())
  d.handle('compliance:setDisabled', (_e, ids) => {
    const known = new Set(LINUX_BASELINE.map((i) => i.id))
    const disabled = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === 'string' && known.has(x)))] : []
    writeJson(file, { disabled })
    return { disabled }
  })

  d.handle('compliance:run', async (_e, id): Promise<ComplianceHostRow> => {
    const t = typeof id === 'string' ? d.terminal(id) : undefined
    if (!t) throw new Error('terminal_not_found')
    if (!hostCheckSupported(t.type, t.os)) throw new Error(tr('合规检查只支持 Linux 的 SSH 终端'))
    const its = items()
    const r = await d.exec(t.id, complianceCommand(its), { timeoutMs: COMPLIANCE_TIMEOUT_MS, maxBytes: MAX_BYTES })
    const row = { hostId: d.hostKey(t.id), label: t.title, at: new Date().toISOString(), results: parseCompliance(r.output, its) }
    d.log?.('info', 'compliance 单机完成', { hostKey: row.hostId, stopped: r.stopped })   // i18n-ignore 日志
    return row
  })

  d.handle('compliance:batch', async (_e, ids): Promise<ComplianceHostRow[]> => {
    const want = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    const hosts = d.hosts().filter((h) => want.includes(h.id))
    if (!hosts.length) throw new Error(tr('请先选择主机'))
    const its = items(), cmd = complianceCommand(its)
    const signal = new AbortController().signal
    setMaxListeners(100, signal)
    const rows: ComplianceHostRow[] = []
    await runPool(hosts.length, FLEET_CONCURRENCY, async (i) => {
      const h = hosts[i]
      const r = await runBatchHost(d.open({ id: h.id, label: h.label, ...(h.group ? { group: h.group } : {}) }), cmd, COMPLIANCE_TIMEOUT_MS, signal)
      const base = { hostId: h.id, label: h.label, at: new Date().toISOString() }
      rows[i] = r.status === 'conn_error' || r.status === 'canceled' ? { ...base, error: r.error ?? tr('连接失败'), results: [] }
        : { ...base, results: parseCompliance(r.output ?? '', its) }
    })
    d.log?.('info', 'compliance 批量完成', { hosts: hosts.length })   // i18n-ignore 日志
    return rows
  })
}
