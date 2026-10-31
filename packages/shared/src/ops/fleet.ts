// ── 跨主机提问（舰队视角）：AI 工具 run_on_hosts 在多台已保存主机上并行跑同一条只读命令 ──
// 执行复用批量执行（desktop/main/ops/batchExec.ts 的 runBatchHost：每台独立 exec channel）；这里是目标解析与结果整理的纯逻辑。
import type { HostEnv } from '../protocol/index.js'
import type { BatchExecResult } from './batchExec.js'
import { tr } from '../i18n/i18n.js'

export const FLEET_MAX_HOSTS = 50
export const FLEET_CONCURRENCY = 8
export const FLEET_DEFAULT_TIMEOUT_SEC = 30
export const FLEET_MAX_TIMEOUT_SEC = 300
export const FLEET_OUTPUT_MAX = 4000      // 每台给模型的输出上限（取末尾）
export const FLEET_DECISION = 'fleet_exec'

/** 可被 run_on_hosts 访问的主机（只有名称 / id / 分组 / 环境，不含任何凭据） */
export interface FleetHost { id: string; label: string; group?: string; env?: HostEnv }

/**
 * targets 每项可以是主机 id、分组名或主机名（精确匹配，按这个顺序认），按出现顺序去重展开。
 * 认不出来的放 unknown（工具据此报错，不猜）。
 */
export function resolveFleetTargets(targets: unknown, hosts: FleetHost[]): { hosts: FleetHost[]; unknown: string[] } {
  const list = Array.isArray(targets) ? targets.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []
  const out: FleetHost[] = []
  const unknown: string[] = []
  const add = (h: FleetHost) => { if (!out.some((x) => x.id === h.id)) out.push(h) }
  for (const t of list) {
    const byId = hosts.find((h) => h.id === t)
    if (byId) { add(byId); continue }
    const inGroup = hosts.filter((h) => h.group === t)
    if (inGroup.length) { inGroup.forEach(add); continue }
    const byLabel = hosts.filter((h) => h.label === t)
    if (byLabel.length) { byLabel.forEach(add); continue }
    unknown.push(t)
  }
  return { hosts: out, unknown }
}

/** 一台的结果（进模型 / 工具卡表格）。status 同批量执行 */
export interface FleetRow {
  host_id: string; label: string; group?: string
  status: BatchExecResult['status']
  exit_code?: number | null
  ms: number
  output: string
  truncated?: boolean
  error?: string
  executed?: boolean   // 已取消但命令已经发出去了（执行到一半被中止）：执行记录据此照样记一笔
}

export function fleetRow(h: FleetHost, r: BatchExecResult, max = FLEET_OUTPUT_MAX): FleetRow {
  const full = (r.output ?? '').replace(/\r/g, '')
  const cut = full.length > max
  return {
    host_id: h.id, label: h.label, ...(h.group ? { group: h.group } : {}),
    status: r.status, ...(r.exitCode !== undefined ? { exit_code: r.exitCode } : {}), ms: r.ms,
    output: cut ? full.slice(-max) : full,
    ...(cut || r.truncated ? { truncated: true } : {}),
    ...(r.error ? { error: r.error } : {}),
    // 只给唯一有歧义的情况打标：取消了但命令已发出（其它状态从 status 就能判断，不往模型输出里加噪音）
    ...(r.status === 'canceled' && r.output !== undefined ? { executed: true } : {}),
  }
}

export interface FleetSummary { total: number; ok: number; failed: string[]; same_output_groups: string[][] }

/** 汇总：成功数、失败（非 0 / 超时 / 连接失败 / 取消）的主机 id、输出完全相同的分组（只算跑完的，去首尾空白比较） */
export function summarizeFleet(rows: FleetRow[]): FleetSummary {
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    if (r.status !== 'ok' && r.status !== 'fail') continue
    const k = `${r.exit_code}\0${r.output.trim()}`
    groups.set(k, [...(groups.get(k) ?? []), r.host_id])
  }
  return {
    total: rows.length,
    ok: rows.filter((r) => r.status === 'ok').length,
    failed: rows.filter((r) => r.status !== 'ok').map((r) => r.host_id),
    same_output_groups: [...groups.values()],
  }
}

/** 工具卡 / 汇总里的状态文字 */
export function fleetStatusText(r: Pick<FleetRow, 'status' | 'exit_code'>): string {
  switch (r.status) {
    case 'ok': return tr('成功')
    case 'fail': return r.exit_code == null ? tr('失败（被信号终止）') : tr('失败（{code}）', { code: r.exit_code })
    case 'timeout': return tr('超时')
    case 'conn_error': return tr('连接失败')
    case 'canceled': return tr('已取消')
  }
}

/** 系统提示里的主机清单：一行一台（名称 · id · 分组 · 生产），只给这些，不给地址和凭据 */
export function fleetHostLines(hosts: FleetHost[]): string {
  return hosts.map((h) => `- ${h.label} · id=${h.id}${h.group ? ` · 分组=${h.group}` : ''}${h.env === 'prod' ? ' · 生产' : h.env === 'test' ? ' · 测试' : ''}`).join('\n')   // i18n-ignore 系统提示词
}
