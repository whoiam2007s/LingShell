import { randomUUID } from 'node:crypto'
import type { AgentEvent, AuthDecision, InspectionRun, InspectionSchedule, ScheduleWhen } from '@lingshell/shared'
import { fillTemplate } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { awaitTurn } from '../integrations/index.js'
import { isReadOnlyCommand } from './readonlyCommand.js'

// 定时巡检：主进程里的小调度器。只在应用开着时跑——应用关着期间错过的不补跑多次：
// 启动后锚点（上次开跑时间）已过期的计划只补跑一次，之后按新锚点继续。
//
// 无人值守授权（巡检没人点授权卡，绝不能挂在授权上）：
//  - 巡检会话 trust=readonly，并预授予目标主机 read（仅该会话，用户亲手配的计划即视为同意）；
//  - 运行期间该会话的决策走 unattendedDecide：只能碰本次目标主机；exec 只放行白名单只读命令，其余自动拒绝；
//    任何意外的授权卡也立即按拒绝处理（见 ipc.ts requestApproval）。

const HOUR = 3_600_000
const TICK_MS = 30_000
const TURN_TIMEOUT_MS = 20 * 60_000

/** 锚点之后的下一次运行时间（ms）。daily 按本地时间 */
export function nextRunAt(when: ScheduleWhen, anchorMs: number): number {
  if (when.kind === 'interval') return anchorMs + Math.max(1, when.hours) * HOUR
  const [h, m] = when.time.split(':').map(Number)
  const d = new Date(anchorMs)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= anchorMs) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function isDue(s: InspectionSchedule, nowMs: number): boolean {
  if (!s.enabled) return false
  return nowMs >= nextRunAt(s.when, Date.parse(s.lastRunAt ?? s.createdAt))
}

/** 从 AI 报告里取最后一个「状态: 正常|异常」（容忍全角冒号、markdown 粗体/反引号） */
export function parseInspectionStatus(text: string): 'normal' | 'abnormal' | 'unknown' {
  let last: 'normal' | 'abnormal' | 'unknown' = 'unknown'
  for (const m of text.replace(/[*`]/g, '').matchAll(/状态\s*[:：]\s*(正常|异常)/g)) last = m[1] === '正常' ? 'normal' : 'abnormal'   // i18n-ignore 解析模型输出
  return last
}

export function buildInspectionPrompt(name: string, task: string, terms: { terminalId: string; label: string }[]): string {
  const filled = fillTemplate(task, { 主机: terms.map((t) => t.label).join('、') })   // i18n-ignore 提示词
  return [
    `【定时巡检 · ${name}】这是无人值守的自动巡检，没有人会响应授权请求。`,   // i18n-ignore 提示词
    '本次巡检的目标终端（已打开）：',   // i18n-ignore 提示词
    ...terms.map((t) => `- terminal_id=${t.terminalId}（${t.label}）`),   // i18n-ignore 提示词
    '规则：',   // i18n-ignore 提示词
    '1. 只使用上面列出的终端；只执行只读的检查命令（查看状态、日志、资源占用），不要修改、重启、删除、安装任何东西。非只读命令会被自动拒绝，被拒就换只读的方式，或在报告中说明无法检查的项。',   // i18n-ignore 提示词
    '2. 不要使用 sudo、命令替换 $(...)、写文件重定向；同一终端一次只发一条命令。',   // i18n-ignore 提示词
    '3. 最后给出简短的巡检报告（要点列表），并以单独一行结尾：`状态: 正常` 或 `状态: 异常`（发现任何需要人工关注的问题即为异常）。',   // i18n-ignore 提示词
    '',
    '巡检任务：',   // i18n-ignore 提示词
    filled,
  ].join('\n')
}

/** 巡检运行期间该会话的授权决策（纯函数）。不返回 prompt：没人会点 */
export function unattendedDecide(targets: Set<string>, hostKey: string, needed: 'read' | 'write', command?: string): AuthDecision {
  if (!targets.has(hostKey)) return { kind: 'deny', reason: 'inspection: 只能操作本次巡检的目标终端' }   // i18n-ignore 返回给模型
  if (needed === 'read') return { kind: 'allow' }
  if (command && isReadOnlyCommand(command)) return { kind: 'allow' }
  return { kind: 'deny', reason: 'inspection: 巡检为只读，只放行白名单内的只读命令（不允许 sudo/重定向写入/命令替换/修改类命令）' }   // i18n-ignore 返回给模型
}

type Unsub = () => void
export interface InspectionDeps {
  list(): InspectionSchedule[]
  markRun(id: string, at: string): void
  putRun(run: InspectionRun): void
  /** 建巡检会话 + 授权 + 开目标终端；返回会话 id、终端、收尾函数（关终端、解除无人值守） */
  prepare(s: InspectionSchedule, title: string): Promise<{ sessionId: string; terms: { terminalId: string; label: string }[]; cleanup(): Promise<void> }>
  sendTurn(sessionId: string, text: string): Promise<void>
  interruptTurn(sessionId: string): Promise<void>
  onEvent(h: (ev: AgentEvent) => void): Unsub
  /** 运行记录变化（UI 刷新） */
  emitRun(run: InspectionRun): void
  /** 结果需要人关注（异常/失败/超时/无状态行） */
  alert(run: InspectionRun): void
  /** 推送到群机器人（是否推送/推给谁由实现决定）；返回失败原因，记到运行记录 alertError */
  push?(s: InspectionSchedule, run: InspectionRun): Promise<string | undefined>
  log?(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void
  turnTimeoutMs?: number
}

const fmtTime = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export class InspectionScheduler {
  private timer?: ReturnType<typeof setInterval>
  private queue: Promise<void> = Promise.resolve()
  private pending = new Set<string>()     // 已入队/在跑的计划，防重复
  constructor(private deps: InspectionDeps) {}

  start(): void { this.timer ??= setInterval(() => this.tick(), TICK_MS) }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  tick(now = Date.now()): void {
    for (const s of this.deps.list()) if (isDue(s, now)) this.enqueue(s.id)
  }

  /** 入队（串行执行，避免同时开一堆会话/终端）。已在队列里的忽略 */
  enqueue(id: string): void {
    if (this.pending.has(id)) return
    this.pending.add(id)
    // 先记锚点：失败也不会每个 tick 重试
    this.deps.markRun(id, new Date().toISOString())
    this.queue = this.queue.then(() => this.run(id)).finally(() => this.pending.delete(id))
  }

  private async run(id: string): Promise<void> {
    const s = this.deps.list().find((x) => x.id === id)
    if (!s) return
    const at = new Date()
    const run: InspectionRun = { id: `run_${randomUUID().slice(0, 8)}`, scheduleId: s.id, scheduleName: s.name, at: at.toISOString(), status: 'running', summary: '' }
    const put = (patch: Partial<InspectionRun>) => { Object.assign(run, patch); this.deps.putRun({ ...run }); this.deps.emitRun({ ...run }) }
    put({})
    let cleanup: (() => Promise<void>) | undefined
    try {
      const p = await this.deps.prepare(s, tr('巡检 · {name} · {time}', { name: s.name, time: fmtTime(at) }))
      cleanup = p.cleanup
      put({ sessionId: p.sessionId })
      // 先订阅再发：事件可能早于 sendTurn 返回
      const wait = awaitTurn((h) => this.deps.onEvent(h), p.sessionId, this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS)
      try { await this.deps.sendTurn(p.sessionId, buildInspectionPrompt(s.name, s.prompt, p.terms)) }
      catch (e) { wait.cancel(); throw e }
      const r = await wait.promise
      const summary = r.summary.slice(0, 4000)
      if (r.status === 'timeout') {
        await this.deps.interruptTurn(p.sessionId).catch(() => {})   // 无人值守：超时就停，不让它一直跑
        put({ status: 'timeout', summary, error: tr('巡检超时，已中断') })
      } else if (r.status === 'failed') put({ status: 'failed', summary, error: r.error })
      else put({ status: parseInspectionStatus(summary), summary })
    } catch (e) {
      put({ status: 'failed', error: e instanceof Error ? e.message : String(e) })
    } finally {
      await cleanup?.().catch((e) => this.deps.log?.('warn', 'inspection cleanup failed', { err: String(e) }))
    }
    put({ finishedAt: new Date().toISOString() })
    this.deps.log?.('info', 'inspection done', { scheduleId: s.id, status: run.status, sessionId: run.sessionId })
    if (run.status !== 'normal') this.deps.alert({ ...run })
    // 推送失败只记录，不影响巡检
    const alertError = await this.deps.push?.(s, { ...run }).catch((e: unknown) => e instanceof Error ? e.message : String(e))
    if (alertError) put({ alertError })
  }
}
