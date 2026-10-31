// ── 分批执行（滚动发布 / 金丝雀）：批量执行之上的批次调度 ──────────────
// 单台执行仍走批量执行的独立通道（client.batch.exec），这里只管：切批、每批后健康检查（带重试）、失败即停 / 跳过、
// 第一批后暂停等确认。调度用注入的钩子跑，便于单测；界面见 ui/features/terminals/batch/RolloutRun.tsx
import { runPool, type BatchExecResult, type BatchRow } from './batchExec.js'
import { shq } from '../files/explorer.js'
import { tr } from '../i18n/i18n.js'

export type RolloutSizeKind = 'count' | 'percent'
export type HealthMode = 'none' | 'command' | 'url'
export interface RolloutOpts {
  sizeKind: RolloutSizeKind
  size: number                 // 每批台数 / 百分比
  canary: boolean              // 第一批跑完先暂停，等用户点「继续」
  health: HealthMode
  healthCmd: string            // health=command：退出码 0 算健康；health=url：URL（期望 HTTP 200）
  retries: number              // 健康检查失败后再试几次
  intervalSec: number          // 重试间隔
  onFail: 'stop' | 'skip'      // 有主机失败：停止 / 跳过这台继续
  rollback: string             // 回滚命令（可空）：结束后可对已执行的主机运行
}
export const ROLLOUT_DEFAULTS: RolloutOpts = { sizeKind: 'count', size: 1, canary: true, health: 'none', healthCmd: '', retries: 2, intervalSec: 5, onFail: 'stop', rollback: '' }
export const ROLLOUT_MAX_RETRIES = 10
/** 「跳过这台继续」时累计失败超过这个比例就停（至少允许 1 台） */
export const ROLLOUT_SKIP_MAX_RATIO = 0.3
export const ROLLOUT_MAX_INTERVAL_SEC = 600
export const HEALTH_TIMEOUT_SEC = 15

/** 切批：返回每批的下标。百分比按向上取整（至少 1 台）；台数夹到 [1, n] */
export function splitBatches(n: number, kind: RolloutSizeKind, size: number): number[][] {
  if (n <= 0) return []
  const s = Number.isFinite(size) && size > 0 ? size : 1
  const per = kind === 'percent' ? Math.max(1, Math.ceil((n * Math.min(100, s)) / 100)) : Math.min(n, Math.max(1, Math.floor(s)))
  const out: number[][] = []
  for (let i = 0; i < n; i += per) out.push(Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k))
  return out
}

/** URL 健康检查命令：curl（没有就 wget）取状态码，等于 expect 才退出 0。只读 */
export function httpCheckCommand(url: string, expect = 200): string {
  const u = shq(url)
  return `if command -v curl >/dev/null 2>&1; then c=$(curl -sS -o /dev/null -m ${HEALTH_TIMEOUT_SEC - 2} -w '%{http_code}' ${u}); `
    + `elif command -v wget >/dev/null 2>&1; then c=$(wget -q -S -O /dev/null -T ${HEALTH_TIMEOUT_SEC - 2} --tries=1 ${u} 2>&1 | awk '/HTTP\\//{x=$2} END{print x}'); `
    + `else echo '没有 curl 或 wget，无法检查 URL'; exit 127; fi; echo "HTTP \${c:-000}"; [ "$c" = "${expect}" ]`   // i18n-ignore 远端 shell 脚本里的输出
}

/** 健康检查实际要跑的命令；不检查 / 没填 → undefined */
export function healthCommand(o: Pick<RolloutOpts, 'health' | 'healthCmd'>): string | undefined {
  const c = o.healthCmd.trim()
  if (o.health === 'none' || !c) return undefined
  return o.health === 'url' ? httpCheckCommand(c) : c
}

export type HealthStatus = 'running' | 'retry' | 'ok' | 'fail' | 'canceled'
export interface RolloutRow extends BatchRow {
  batch: number                 // 第几批（0 起）
  health?: { status: HealthStatus; tries: number; result?: BatchExecResult }
  skipped?: boolean             // 失败后按「跳过这台继续」放过的
  rollback?: BatchRow           // 回滚命令的结果
}
export type RolloutState = 'running' | 'paused' | 'done' | 'stopped' | 'aborted'
export interface RolloutPhase { state: RolloutState; batch: number; reason?: string }

export interface RolloutHooks {
  run(i: number, batch: number): Promise<BatchExecResult>      // 在第 i 台跑命令
  health(i: number, batch: number): Promise<BatchExecResult>   // 在第 i 台跑一次健康检查
  sleep(ms: number): Promise<void>
  gate(batch: number): Promise<boolean>                        // 金丝雀暂停：true 继续 / false 中止
  row(i: number, r: RolloutRow): void
  phase(p: RolloutPhase): void
  aborted(): boolean
}

/** 一台的执行结果算不算失败（成功以外都算） */
const bad = (r: BatchExecResult) => r.status !== 'ok'

/** 跑分批：返回最终状态。批内并发 concurrency；某批有失败且策略为 stop → 停止（后面的批不跑）；
 *  第一批跑完且开了金丝雀 → 暂停等 gate；最后一批跑完 → done。中止（aborted）后不再起新主机 */
export async function runRollout(n: number, o: RolloutOpts, concurrency: number, h: RolloutHooks): Promise<RolloutPhase> {
  const batches = splitBatches(n, o.sizeKind, o.size)
  const rows: RolloutRow[] = []
  batches.forEach((b, k) => b.forEach((i) => { rows[i] = { batch: k, status: 'pending' } }))
  const set = (i: number, p: Partial<RolloutRow>) => { rows[i] = { ...rows[i], ...p }; h.row(i, rows[i]) }
  const hc = healthCommand(o)
  const end = (p: RolloutPhase) => {
    // 没轮到的标「已取消」
    rows.forEach((r, i) => { if (r.status === 'pending') set(i, { status: 'canceled' }) })
    h.phase(p)
    return p
  }
  for (let k = 0; k < batches.length; k++) {
    if (h.aborted()) return end({ state: 'aborted', batch: k })
    h.phase({ state: 'running', batch: k })
    const b = batches[k]
    await runPool(b.length, concurrency, async (j) => {
      const i = b[j]
      if (h.aborted()) return
      set(i, { status: 'running' })
      const r = await h.run(i, k)
      set(i, { status: r.status, result: r })
      if (bad(r) || !hc) return
      // 健康检查：失败按间隔重试，最多 1 + retries 次
      for (let t = 1; ; t++) {
        // 中止 ≠ 不健康：没查完就标「已取消」，不误导成服务挂了
        if (h.aborted()) { set(i, { health: { status: 'canceled', tries: t - 1 } }); return }
        set(i, { health: { status: t === 1 ? 'running' : 'retry', tries: t } })
        const x = await h.health(i, k)
        if (!bad(x)) { set(i, { health: { status: 'ok', tries: t, result: x } }); return }
        if (t > o.retries) { set(i, { health: { status: 'fail', tries: t, result: x } }); return }
        set(i, { health: { status: 'retry', tries: t, result: x } })
        await h.sleep(o.intervalSec * 1000)
      }
    })
    if (h.aborted()) return end({ state: 'aborted', batch: k })
    const failed = b.filter((i) => bad(rows[i].result ?? { status: 'canceled', ms: 0 }) || rows[i].health?.status === 'fail')
    if (failed.length) {
      if (o.onFail === 'stop') return end({ state: 'stopped', batch: k, reason: tr('第 {k} 批有 {n} 台失败，已停止', { k: k + 1, n: failed.length }) })
      // 「跳过继续」也有底线：一整批全挂说明命令本身有问题（包地址错、脚本语法错），继续推只会把所有主机都弄坏
      if (failed.length === b.length && b.length > 1) return end({ state: 'stopped', batch: k, reason: tr('第 {k} 批 {n} 台全部失败，已停止（选了「跳过这台继续」也不会在整批失败时继续）', { k: k + 1, n: b.length }) })
      const total = rows.filter((r) => r.skipped).length + failed.length
      const limit = Math.max(1, Math.floor(n * ROLLOUT_SKIP_MAX_RATIO))
      if (total > limit) return end({ state: 'stopped', batch: k, reason: tr('累计已有 {n} 台失败（超过总数的 {pct}%），已停止', { n: total, pct: Math.round(ROLLOUT_SKIP_MAX_RATIO * 100) }) })
      failed.forEach((i) => set(i, { skipped: true }))
    }
    if (k === batches.length - 1) break
    if (k === 0 && o.canary) {
      h.phase({ state: 'paused', batch: k })
      if (!(await h.gate(k))) return end({ state: 'aborted', batch: k, reason: tr('已在金丝雀批次后中止') })
    }
  }
  return end({ state: 'done', batch: batches.length - 1 })
}

/** 「对已执行的主机运行回滚命令」：命令确实跑过的（成功 / 失败 / 超时），以及执行到一半被中止的
 *  （canceled 但带输出 = 命令已经发出去；这几台最可能处在半部署状态，回滚不能漏） */
export const rolloutExecuted = (rows: RolloutRow[]): number[] =>
  rows.flatMap((r, i) => (r.status === 'ok' || r.status === 'fail' || r.status === 'timeout' || (r.status === 'canceled' && r.result?.output !== undefined) ? [i] : []))
/** 回滚确认里要单独提示的：超时 / 中途中止的主机，远端命令可能还在跑，回滚会和它并发 */
export const rolloutUncertain = (rows: RolloutRow[]): number[] =>
  rows.flatMap((r, i) => (r.status === 'timeout' || (r.status === 'canceled' && r.result?.output !== undefined) ? [i] : []))

/** 执行记录标注：批量执行 decision 后缀。batch_exec:rollout:2 = 分批执行第 2 批 */
export type BatchTag = { kind: 'rollout' | 'health'; batch: number } | { kind: 'rollback' }
export function batchTagDecision(base: string, tag?: BatchTag): string {
  if (!tag) return base
  return tag.kind === 'rollback' ? `${base}:rollback` : `${base}:${tag.kind}:${Math.max(1, Math.floor(tag.batch))}`
}
/** 执行记录里的中文标签；不是分批执行的记录 → undefined */
export function rolloutAuditLabel(decision: string): string | undefined {
  const m = /^batch_exec:(rollout|health|rollback)(?::(\d+))?$/.exec(decision)
  if (!m) return undefined
  return m[1] === 'rollback' ? tr('分批执行 · 回滚') : m[1] === 'rollout' ? tr('分批执行 · 第 {n} 批', { n: m[2] }) : tr('分批执行 · 第 {n} 批健康检查', { n: m[2] })
}
