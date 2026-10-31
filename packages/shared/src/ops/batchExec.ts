// ── 批量执行：多台主机跑同一条命令，结果汇总成表 ──────────────
// 用户手动发起；每台走独立 exec channel（不往交互终端里敲）。并发调度与进度在 UI，主进程一台一次调用。
import type { HostSummary, HostEnv, TerminalInfo } from '../protocol/index.js'
import { compareChoices } from '../files/fileCompare.js'
import type { CompareChoice, CompareTarget } from '../files/index.js'
import { groupHosts } from '../terminal/hostGroups.js'
import { dangerCheck } from '../ai/danger.js'
import { tr } from '../i18n/i18n.js'

export type BatchTarget = CompareTarget
export type BatchChoice = CompareChoice
export interface BatchGroup { name: string; items: BatchChoice[] }

export const BATCH_DEFAULT_TIMEOUT_SEC = 30
export const BATCH_MAX_TIMEOUT_SEC = 3600
export const BATCH_DEFAULT_CONCURRENCY = 5
export const BATCH_MAX_CONCURRENCY = 20
export const BATCH_MAX_OUTPUT = 200 * 1024   // 每台输出上限（stdout+stderr 合计）
export const BATCH_DECISION = 'batch_exec'

/** 主进程跑完一台的结果。output = stdout/stderr 按到达顺序合并；超时 / 取消时为已收到的部分 */
export interface BatchExecResult {
  status: 'ok' | 'fail' | 'timeout' | 'conn_error' | 'canceled'
  exitCode?: number | null     // null = 被信号终止
  output?: string
  truncated?: boolean
  error?: string               // 连接失败原因
  ms: number
}
export type BatchStatus = 'pending' | 'running' | BatchExecResult['status']
export interface BatchRow { status: BatchStatus; result?: BatchExecResult }

// 空输入 Number('') = 0：不能当成「1 秒超时 / 并发 1」，回默认值
export const clampInt = (v: number, min: number, max: number, dflt: number) => (Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, Math.round(v))) : dflt)

/** 候选按分组：已保存主机按 group（未分组在后）→ 未保存主机的在线 SSH 终端 → 本机 */
export function batchGroups(hosts: HostSummary[], terms: TerminalInfo[]): BatchGroup[] {
  const cs = compareChoices(hosts, terms)
  const byKey = new Map(cs.map((c) => [c.key, c]))
  const unsaved = cs.filter((c) => c.target.kind === 'terminal')
  return [
    ...groupHosts(hosts).map((g) => ({ name: g.group || tr('未分组'), items: g.hosts.map((h) => byKey.get(`host:${h.id}`)!) })),
    ...(unsaved.length ? [{ name: tr('未保存的在线终端'), items: unsaved }] : []),
    { name: tr('本机'), items: [byKey.get('local')!] },
  ]
}

/** 组头勾选框：组内全选了 → 全取消；否则补齐 */
export function toggleGroup(picked: string[], keys: string[]): string[] {
  return keys.every((k) => picked.includes(k)) ? picked.filter((k) => !keys.includes(k)) : [...picked, ...keys.filter((k) => !picked.includes(k))]
}

/** 勾选的目标，按列表顺序（不按点击先后） */
export function pickedTargets(groups: BatchGroup[], picked: string[]): BatchChoice[] {
  return groups.flatMap((g) => g.items).filter((c) => picked.includes(c.key))
}

/** 运行前闸门：有生产目标 → prod（黄色提示）；生产目标 + 危险命令 → danger（红色确认，列出生产主机）。
 *  command 可以是多条（分批执行时主命令 + 健康检查命令），任意一条命中危险模式就算 danger */
export function batchGate(command: string | string[], targets: { label: string; env?: HostEnv }[]): { level: 'none' | 'prod' | 'danger'; prod: string[] } {
  const prod = targets.filter((t) => t.env === 'prod').map((t) => t.label)
  if (!prod.length) return { level: 'none', prod }
  const cmds = (Array.isArray(command) ? command : [command]).filter((c) => c.trim())
  return { level: cmds.some((c) => dangerCheck(c) === 'dangerous') ? 'danger' : 'prod', prod }
}

export function batchStatusText(r: BatchRow): string {
  switch (r.status) {
    case 'pending': return tr('等待中')
    case 'running': return tr('运行中')
    case 'ok': return tr('成功')
    case 'fail': return r.result?.exitCode == null ? tr('失败（被信号终止）') : tr('失败（{code}）', { code: r.result.exitCode })
    case 'timeout': return tr('超时')
    case 'conn_error': return tr('连接失败')
    // 带输出的取消 = 命令已经发出去、执行到一半被中止（这台可能处在半执行状态）
    case 'canceled': return r.result?.output !== undefined ? tr('中途中止') : tr('已取消')
  }
}

/** 需要「只重跑失败的」的行 */
export const isBatchFailed = (s: BatchStatus) => s === 'fail' || s === 'timeout' || s === 'conn_error' || s === 'canceled'
/** 命令可能已经在这台上跑过（超时 / 执行中被取消，带了输出）：重跑前要提醒，非幂等命令会被执行两次 */
export const maybeExecuted = (r: Pick<BatchRow, 'status' | 'result'>) => r.status === 'timeout' || (r.status === 'canceled' && r.result?.output !== undefined)

export const firstLine = (s = '') => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
export const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`)

/** 输出分组：跑完（成功 / 失败）的行按「退出码 + 输出」归组。group[i] = 组号（-1 未参与）；
 *  majority = 唯一最大且至少 2 台的组，没有（并列 / 全都不同）为 -1 */
export function groupOutputs(rows: BatchRow[]): { group: number[]; counts: number[]; majority: number } {
  const ids = new Map<string, number>()
  const counts: number[] = []
  const group = rows.map((r) => {
    if ((r.status !== 'ok' && r.status !== 'fail') || !r.result) return -1
    // 输出被截断的行不能参与「输出相同 / 多数」：截断点之后可能不一样，说相同会掩盖真实差异
    if (r.result.truncated) return -1
    const key = `${r.result.exitCode}\u0000${r.result.output ?? ''}`
    let g = ids.get(key)
    if (g === undefined) { g = counts.length; ids.set(key, g); counts.push(0) }
    counts[g]++
    return g
  })
  const max = Math.max(0, ...counts)
  const majority = max >= 2 && counts.filter((c) => c === max).length === 1 ? counts.indexOf(max) : -1
  return { group, counts, majority }
}

/** 「与多数不同」：已结束且不在多数组里的行（超时 / 连接失败也算）。没有多数时为空 */
export function outliers(rows: BatchRow[]): number[] {
  const { group, majority } = groupOutputs(rows)
  if (majority < 0) return []
  return rows.flatMap((r, i) => (r.status !== 'pending' && r.status !== 'running' && group[i] !== majority ? [i] : []))
}

export interface BatchExportRow { label: string; row: BatchRow }
const outputOf = (r: BatchRow) => (r.result?.error ? `${r.result.error}\n` : '') + (r.result?.output ?? '')
const msOf = (r: BatchRow) => (r.result ? fmtMs(r.result.ms) : '')

/** 复制为 Markdown：汇总表 + 每台完整输出 */
export function batchMarkdown(command: string, rows: BatchExportRow[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|')
  const fenceFor = (s: string) => { let f = '```'; while (s.includes(f)) f += '`'; return f }
  const out = [`**${tr('命令')}**`, '', fenceFor(command) + 'bash', command, fenceFor(command), '', `| ${tr('主机')} | ${tr('状态')} | ${tr('耗时')} | ${tr('输出首行')} |`, '| --- | --- | --- | --- |']
  for (const { label, row } of rows) out.push(`| ${cell(label)} | ${batchStatusText(row)} | ${msOf(row)} | ${cell(firstLine(outputOf(row)))} |`)
  for (const { label, row } of rows) {
    const o = outputOf(row).replace(/\n$/, '')
    const f = fenceFor(o)
    out.push('', `### ${label}`, '', f, o, f)
  }
  return out.join('\n') + '\n'
}

/** 复制为 TSV（可直接贴进 Excel）：含制表符 / 换行 / 引号的字段加引号 */
export function batchTsv(rows: BatchExportRow[]): string {
  const q = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return [[tr('主机'), tr('状态'), tr('耗时'), tr('输出')], ...rows.map(({ label, row }) => [label, batchStatusText(row), msOf(row), outputOf(row).replace(/\n$/, '')])]
    .map((cols) => cols.map(q).join('\t')).join('\n') + '\n'
}

/** 并发跑 n 个任务：按下标顺序起，同时最多 limit 个；signal 中止后不再起新任务（未起的不调用 run）。run 不应抛 */
export async function runPool(n: number, limit: number, run: (i: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0
  const worker = async () => { while (next < n && !signal?.aborted) await run(next++) }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, n)) }, worker))
}

export const batchAuditLabel = (decision: string) => (decision === BATCH_DECISION ? tr('批量执行') : undefined)
