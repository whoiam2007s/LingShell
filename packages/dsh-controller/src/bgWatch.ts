// i18n-ignore-file 本文件的文案全是发给模型的上下文（任务完成通知），不进界面字典
// 后台任务观察者（宿主侧）：模型不再「wait + check」空转，任务跑完由这里叫醒它。
//
// 分工：
//  - 终端工具（start_background / check_background）只负责**报告事实**（起好了 / 刚被查过）；
//  - 本模块维护「还有哪些任务在跑」的表，以及「该不该通知、通知怎么合」的纯逻辑；
//  - 轮询、注入消息由 DshController 驱动（它才有 agent 句柄和定时器）。
//
// 为什么不在模型侧轮询：每轮轮询都是一次完整的模型请求（全部输入 token 重算），
// 而且会话一直停在 running，用户插话也进不去。注释里记着实证：90 秒的任务被查了三十多次。

/** 一个在跑的后台任务（只在内存，不落盘：应用重启即放弃跟踪，见规划文档） */
export interface BgTask {
  jobId: string
  sessionId: string
  terminalId: string
  /** 原始命令（通知里展示，按需截断） */
  command: string
  startedAt: number
  /** 起任务时所在回合：判断「这个回合是不是在等它」 */
  startedTurn?: number
  /** 最近一次被模型自己 check 的时间 / 回合 */
  checkedAt?: number
  checkedTurn?: number
  /** 连续几轮查不到它（终端关了 / 连接断了 / job 文件被清了）：攒够了就放弃跟踪 */
  misses?: number
}

export type BgEnd = 'finished' | 'unknown' | 'cancelled'

export interface BgEnded {
  task: BgTask
  end: BgEnd
  exitCode?: number
}

/** 模型 10 秒内刚自己查到结果：别再推一遍（否则同一条结果会重复出现在上下文里） */
export const BG_DEDUPE_MS = 10_000
/** 同一会话连续推送上限：超过就改推一条汇总（防止注入风暴） */
export const BG_NOTICE_LIMIT = 5
/**
 * 连续这么多轮查不到就放弃跟踪（5 秒一轮 ≈ 1 分钟）。
 * 为什么需要：终端被关掉 / 连接断了以后，查询会一直失败，任务却永远留在表里 ——
 * 定时器就再也不停，每 5 秒对一个已经不存在的终端发一次命令，跑到应用关闭为止。
 */
export const BG_MAX_MISS = 12

export class BgTaskRegistry {
  private m = new Map<string, BgTask>()

  add(t: BgTask): void { this.m.set(t.jobId, t) }
  get(jobId: string): BgTask | undefined { return this.m.get(jobId) }
  remove(jobId: string): BgTask | undefined {
    const t = this.m.get(jobId)
    if (t) this.m.delete(jobId)
    return t
  }
  /** 某会话还活着的任务（状态条 / 面板 / 取消用） */
  of(sessionId: string): BgTask[] { return [...this.m.values()].filter((t) => t.sessionId === sessionId) }
  /** 按终端分组：状态查询是「一次连上问完这个终端的所有任务」 */
  byTerminal(): Map<string, BgTask[]> {
    const out = new Map<string, BgTask[]>()
    for (const t of this.m.values()) {
      const list = out.get(t.terminalId)
      if (list) list.push(t)
      else out.set(t.terminalId, [t])
    }
    return out
  }
  all(): BgTask[] { return [...this.m.values()] }
  get size(): number { return this.m.size }
  markChecked(jobId: string, at: number, turn?: number): void {
    const t = this.m.get(jobId)
    if (!t) return
    t.checkedAt = at
    if (turn !== undefined) t.checkedTurn = turn
  }

  /** 这一轮没查到它：返回累计次数（调用方按 BG_MAX_MISS 决定是否放弃） */
  miss(jobId: string): number {
    const t = this.m.get(jobId)
    if (!t) return 0
    t.misses = (t.misses ?? 0) + 1
    return t.misses
  }

  /** 查到了（不管跑没跑完）：清掉失败计数，免得偶发一次超时就把它丢掉 */
  seen(jobId: string): void {
    const t = this.m.get(jobId)
    if (t) delete t.misses
  }
}

/** 这个任务结束时该不该主动通知（模型刚查过就不必了） */
export function shouldNotify(t: BgTask, now: number): boolean {
  return t.checkedAt === undefined || now - t.checkedAt > BG_DEDUPE_MS
}

/** 命令太长时只留开头，通知里够认出来就行 */
export const clipCommand = (cmd: string, max = 80): string => {
  const one = cmd.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/**
 * 一条通知的正文。多个任务合并成一条（同一次轮询里结束的都算一起），
 * 这样连续结束 3 个任务只叫醒模型一次。
 */
export function noticeText(ended: readonly BgEnded[]): string {
  const failed = ended.filter((e) => e.end !== 'finished' || (e.exitCode ?? 0) !== 0)
  const ok = ended.length - failed.length
  const head = failed.length === 0
    ? `[后台任务完成] ${ended.length} 个任务已结束，全部成功。`
    : `[后台任务完成] ${ended.length} 个任务已结束：${ok} 个成功、${failed.length} 个失败。`
  const lines = ended.map((e) => {
    const why = e.end === 'cancelled' ? '已被取消'
      : e.end === 'unknown' ? '状态未知（进程已不存在）'
      : `退出码 ${e.exitCode ?? '?'}`
    return `- ${e.task.jobId}（${clipCommand(e.task.command)}）：${why}`
  })
  return `${head}\n${lines.join('\n')}\n先看结果再下结论；需要细节用 check_background 查日志尾巴。`   // i18n-ignore 发给模型的上下文
}

/** 超过上限时的汇总文案（继续硬推会把上下文灌满） */
export const noticeOverflowText = (n: number): string =>
  `[后台任务完成] 又有 ${n} 个任务结束，已省略明细；用 check_background 按 job_id 查看。`   // i18n-ignore 发给模型的上下文

/** 会话级推送计数：只在内存，窗口过期自动失效 */
export class NoticeLimiter {
  private m = new Map<string, { from: number; n: number }>()
  constructor(private readonly windowMs = 10 * 60_000) {}
  /** 记一次推送；返回 true = 已经超过上限，这次应改成汇总 */
  hit(sessionId: string, now: number, limit = BG_NOTICE_LIMIT): boolean {
    const cur = this.m.get(sessionId)
    if (!cur || now - cur.from > this.windowMs) {
      this.m.set(sessionId, { from: now, n: 1 })
      return false
    }
    cur.n += 1
    return cur.n > limit
  }
  reset(sessionId: string): void { this.m.delete(sessionId) }
}
