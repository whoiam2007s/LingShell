// 对话区 / 会话列表的时间显示（纯函数，本地时区）。时间一律是 epoch 毫秒；拿不到时间的不显示，不猜
import { tr } from '../i18n/i18n.js'

const p2 = (n: number) => String(n).padStart(2, '0')

/** HH:mm，seconds=true 时 HH:mm:ss */
export function fmtClock(ts: number, seconds = false): string {
  const d = new Date(ts)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}${seconds ? `:${p2(d.getSeconds())}` : ''}`
}

/** yyyy-MM-dd HH:mm（seconds=true 带秒） */
export function fmtDateTime(ts: number, seconds = false): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(ts, seconds)}`
}

/** ISO 串 / 毫秒 → 毫秒；空、非法、≤0 → undefined */
export function toMs(v: string | number | undefined | null): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 会话列表的相对时间：1 分钟内「刚刚」，1 小时内「N 分钟前」，24 小时内「HH:mm」，更早「N 天前」。
 * 未来时间（时钟偏差）按「刚刚」。
 */
export function relativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return tr('刚刚')
  if (diff < 3_600_000) return tr('{n} 分钟前', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return fmtClock(ts)
  return tr('{n} 天前', { n: Math.floor(diff / 86_400_000) })
}

/** 会话条目的时间：显示最近活动（没有就创建时间），tooltip 给完整的创建 / 最近活动时间 */
export function sessionTime(s: { createdAt?: string; lastActiveAt?: string }, now: number): { text: string; title: string } | undefined {
  const created = toMs(s.createdAt), active = toMs(s.lastActiveAt)
  const ts = active ?? created
  if (ts === undefined) return undefined
  const parts = [created !== undefined && tr('创建于 {t}', { t: fmtDateTime(created) }), active !== undefined && tr('最近活动 {t}', { t: fmtDateTime(active) })].filter(Boolean)
  return { text: relativeTime(ts, now), title: parts.join(' · ') }
}

/** 消息时间：今天 HH:mm；今年 MM-DD HH:mm；更早 yyyy-MM-dd HH:mm */
export function messageTime(ts: number, now: number): string {
  const d = new Date(ts), n = new Date(now)
  if (d.getFullYear() !== n.getFullYear()) return fmtDateTime(ts)
  if (d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return fmtClock(ts)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${fmtClock(ts)}`
}

/** 时长：< 10 秒「N.N秒」，< 1 分钟「N秒」，< 1 小时「X分Y秒」，否则「X时Y分Z秒」。负数 / 非法按 0 */
export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (v < 10_000) return tr('{s}秒', { s: (Math.floor(v / 100) / 10).toFixed(1) })
  const s = Math.floor(v / 1000)
  if (s < 60) return tr('{s}秒', { s })
  if (s < 3600) return tr('{m}分{s}秒', { m: Math.floor(s / 60), s: s % 60 })
  return tr('{h}时{m}分{s}秒', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 })
}

/**
 * 一段耗时：有开始有结束 = 结束 − 开始；没结束且仍在进行（now 有值）= now − 开始；否则 undefined（不显示）。
 * 结束早于开始（时钟偏差）按 0。
 */
export function elapsedMs(start: number | undefined, end: number | undefined, now?: number): number | undefined {
  if (start === undefined) return undefined
  const to = end ?? now
  return to === undefined ? undefined : Math.max(0, to - start)
}

/** 一轮的时间点（主进程按 dsh 事件时间戳给出，见 agent:turnTiming） */
export interface TurnTimes {
  startedAt?: number   // turn/start
  firstAt?: number     // 模型首次返回（首个流式块 / 工具调用）
  endedAt?: number     // turn/end
}

/**
 * 回合头部 / 执行过程的显示数据。
 * live = 本轮仍在进行（进行中才用 now 实时计时；历史里没结束的轮不显示耗时，免得显示一个越走越大的错数）。
 * askedAt = 用户提问时间（缺省用 startedAt），用于「提问后多久开始回答」。
 */
export function turnTimeView(t: TurnTimes | undefined, opts: { live: boolean; now: number; askedAt?: number }): {
  first?: { text: string; title: string }
  duration?: string
} {
  if (!t) return {}
  const asked = opts.askedAt ?? t.startedAt
  const first = t.firstAt === undefined ? undefined : {
    text: tr('开始回答 {t}', { t: fmtClock(t.firstAt, true) }),
    title: `${fmtDateTime(t.firstAt, true)}${asked !== undefined ? tr(' · 提问后 {d} 开始回答', { d: formatDuration(t.firstAt - asked) }) : ''}`,
  }
  const ms = elapsedMs(t.startedAt, t.endedAt, opts.live ? opts.now : undefined)
  return { first, duration: ms === undefined ? undefined : formatDuration(ms) }
}

/** HH:mm:ss.S（精确到 0.1 秒） */
export function fmtClockTenths(ts: number): string {
  return `${fmtClock(ts, true)}.${Math.floor(new Date(ts).getMilliseconds() / 100)}`
}

/**
 * 工具卡片耗时的 hover 说明。at = 识别到工具（或旧会话的开始执行）；callAt = 参数生成完、开始执行（只有知道识别时刻时才有）；doneAt = 拿到结果。
 * 有 callAt：「识别 A → 完成 B（其中生成参数 X、执行 Y）」；没有：「开始 A → 完成 B」。未结束：箭头后写当前阶段。
 * preparing = 还停在生成参数阶段（结束了还是它 = 参数没生成完就中止）
 */
export function toolTimeTitle(t: { at?: number; callAt?: number; doneAt?: number; preparing?: boolean }): string {
  if (t.at === undefined) return ''
  const split = t.callAt !== undefined && t.callAt >= t.at
  const head = split || t.preparing ? tr('识别 {t}', { t: fmtClockTenths(t.at) }) : tr('开始 {t}', { t: fmtClockTenths(t.at) })
  if (t.doneAt === undefined) {
    if (t.preparing) return tr('{head} → 生成参数中…', { head })
    return split ? tr('{head} → 执行中（生成参数 {d}）', { head, d: formatDuration(t.callAt! - t.at) }) : tr('{head} → 执行中…', { head })
  }
  if (t.preparing) return tr('{head} → 中止 {t}（参数没生成完，未执行）', { head, t: fmtClockTenths(t.doneAt) })
  const tail = tr('{head} → 完成 {t}', { head, t: fmtClockTenths(t.doneAt) })
  return split ? tr('{tail}（其中生成参数 {gen}、执行 {run}）', { tail, gen: formatDuration(t.callAt! - t.at), run: formatDuration(t.doneAt - t.callAt!) }) : tail
}

/** 字符数：按 Unicode 字符计（[...text].length），汉字、英文字母、数字、标点、emoji 各算 1 */
export function charCount(text: string): number {
  return [...text].length
}

/** 「1,234 字」 */
export function fmtChars(n: number): string {
  return tr('{n} 字', { n: n.toLocaleString('en-US') })
}

/** 思考时长的 hover：「开始 A → 结束 B」；还在输出「开始 A → 思考中…」 */
export function reasoningTimeTitle(t: { at?: number; doneAt?: number }): string {
  if (t.at === undefined) return ''
  const head = tr('开始 {t}', { t: fmtClockTenths(t.at) })
  return t.doneAt === undefined ? tr('{head} → 思考中…', { head }) : tr('{head} → 结束 {t}', { head, t: fmtClockTenths(t.doneAt) })
}
