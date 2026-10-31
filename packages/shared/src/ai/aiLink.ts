// i18n-ignore-file 全部是发给模型的提示词与解析
// ── AI 与终端联动：预测下一条命令 / 录像 AI 摘要 ─────────
// 纯函数，主进程（拼提示词、切分录像、解析模型输出）与界面（节流、章节时间换算）共用。
import type { TermOs } from '../protocol/index.js'
import type { CastEvent } from '../terminal/index.js'
import { cleanOutput } from '../terminal/termAssist.js'

// ── 预测下一条命令（参考 Warp Next Command）─────────────
// commands：该终端最近几条用户命令（旧 → 新）；outputTail：最后一条命令输出的尾部（已脱敏；生产主机不带）
export interface PredictRequest { os?: TermOs; cwd?: string; prod?: boolean; commands: string[]; outputTail?: string }

export const PREDICT_MAX_COMMANDS = 5
export const PREDICT_OUTPUT_TAIL = 1500

/** 请求体规整：只留最近 5 条、每条 ≤ 300 字，输出尾部 ≤ 1500 字；生产主机丢掉输出（主进程再兜一次） */
export function normalizePredict(r: Partial<PredictRequest> | undefined): PredictRequest {
  const commands = (Array.isArray(r?.commands) ? r.commands : []).filter((c): c is string => typeof c === 'string' && !!c.trim())
    .slice(-PREDICT_MAX_COMMANDS).map((c) => c.trim().slice(0, 300))
  const os = (['linux', 'macos', 'windows'] as const).find((x) => x === r?.os) ?? 'unknown'
  const prod = r?.prod === true
  const tail = !prod && typeof r?.outputTail === 'string' ? r.outputTail.slice(-PREDICT_OUTPUT_TAIL) : undefined
  return { os, prod, commands, ...(typeof r?.cwd === 'string' && r.cwd ? { cwd: r.cwd.slice(0, 300) } : {}), ...(tail?.trim() ? { outputTail: tail } : {}) }
}

export function buildPredictPrompt(r: PredictRequest): { system: string; user: string } {
  const system = [
    '你根据用户最近在终端里执行的命令，预测他下一条最可能要执行的 shell 命令。',
    `目标环境：${r.os === 'windows' ? 'Windows 上的 Git Bash' : r.os === 'macos' ? 'macOS' : r.os === 'linux' ? 'Linux' : '未知系统（按 POSIX bash）'}。`,
    r.prod ? '这是生产主机：只预测只读、影响小的命令，不要预测删除 / 重启 / 改配置类命令。' : '',
    '输出要求：只输出一行命令本身，不要解释、不要 markdown、不要行首 $；没有把握时只输出一行 #。',
  ].filter(Boolean).join('\n')
  const L = ['最近执行的命令（旧 → 新）：', ...r.commands.map((c, i) => `${i + 1}. ${c}`)]
  if (r.cwd) L.push(`当前目录：${r.cwd}`)
  if (r.outputTail) L.push('最后一条命令输出的末尾：', '```', r.outputTail.replace(/\s+$/, ''), '```')
  return { system, user: L.join('\n') }
}

/**
 * 预测节流：同一个提示符（key 用 marker 等对象身份）只请求一次；全局每分钟最多 max 次。
 * allow 返回 true = 可以发（同时记下这次）
 */
export class PredictThrottle {
  private times: number[] = []
  private keys = new WeakSet<object>()
  constructor(private max = 6, private windowMs = 60_000) {}
  allow(key: object, now = Date.now()): boolean {
    if (this.keys.has(key)) return false
    this.times = this.times.filter((t) => now - t < this.windowMs)
    if (this.times.length >= this.max) return false
    this.times.push(now); this.keys.add(key)
    return true
  }
}

// ── 录像 AI 摘要 ─────────────────────────────────────────
export interface CastSegment { t: number; command?: string; ai?: boolean; output: string }
export interface RecordingChapter { t: number; title: string }
export interface RecordingSummary { version: 1; createdAt: string; chapters: RecordingChapter[] }

// eslint-disable-next-line no-control-regex
const MARK = /\x1b\]133;([BC])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)|\x1b\[36m([^\x1b\r\n]{1,2000})\x1b\[0m\r\n/g
const SEG_MAX = 120
const TIME_SLICE = 60

/**
 * 按命令切分录像：shell integration 的 OSC 133（B = 输入开始，C = 开始执行，两者之间的回显就是命令行）
 * 与 AI 执行时的青色命令回显（见 terminal-core execCapture）。没有任何命令标记时按 60 秒一段切。
 * 只读输出事件（o），不读键入（i）——键入里可能有密码。
 */
export function segmentCast(events: CastEvent[]): CastSegment[] {
  let text = ''
  const offs: number[] = [], times: number[] = []
  for (const [t, code, data] of events) {
    if (code !== 'o') continue
    offs.push(text.length); times.push(t); text += data
  }
  const timeAt = (pos: number) => {   // 包含该位置的输出事件时间（二分）
    let lo = 0, hi = offs.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= pos) lo = mid; else hi = mid - 1 }
    return times[lo] ?? 0
  }
  const starts: { pos: number; end: number; t: number; command?: string; ai?: boolean }[] = []
  let inputAt = -1
  for (const m of text.matchAll(MARK)) {
    const i = m.index ?? 0
    if (m[1] === 'B') inputAt = i + m[0].length
    else if (m[1] === 'C') {
      const cmd = inputAt >= 0 ? cleanOutput(text.slice(inputAt, i), 2000).text.split('\n').pop()?.trim() : undefined
      starts.push({ pos: i, end: i + m[0].length, t: timeAt(i), ...(cmd ? { command: cmd } : {}) })
      inputAt = -1
    } else if (m[2]) starts.push({ pos: i, end: i + m[0].length, t: timeAt(i), command: m[2].trim(), ai: true })
  }
  const segs: CastSegment[] = []
  if (starts.length) {
    starts.forEach((s, k) => {
      // 输出到命令结束（133;D）为止，不带后面的提示符和下一条命令的回显；空白行去掉
      const next = starts[k + 1]?.pos ?? text.length, d = text.indexOf('\x1b]133;D', s.end)
      const out = cleanOutput(text.slice(s.end, d >= 0 && d < next ? d : next), 5_000_000).text.replace(/^[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trim()
      segs.push({ t: s.t, ...(s.command ? { command: s.command } : {}), ...(s.ai ? { ai: true } : {}), output: out })
    })
  } else {
    // 没有命令标记：按时间切
    let k = 0
    while (k < offs.length) {
      const t0 = Math.floor(times[k] / TIME_SLICE) * TIME_SLICE
      let j = k
      while (j < offs.length && times[j] < t0 + TIME_SLICE) j++
      const out = cleanOutput(text.slice(offs[k], offs[j] ?? text.length), 5_000_000).text
      if (out.trim()) segs.push({ t: times[k], output: out })
      k = j
    }
  }
  return mergeSegments(segs, SEG_MAX)
}

/** 段数超过上限：相邻的合并（命令用「；」连起来），保证提示词不过长 */
export function mergeSegments(segs: CastSegment[], max: number): CastSegment[] {
  if (segs.length <= max) return segs
  const k = Math.ceil(segs.length / max), out: CastSegment[] = []
  for (let i = 0; i < segs.length; i += k) {
    const g = segs.slice(i, i + k)
    const cmds = g.map((s) => s.command).filter(Boolean)
    out.push({ t: g[0].t, ...(cmds.length ? { command: cmds.join('；') } : {}), output: g.map((s) => s.output).join('\n') })
  }
  return out
}

/** 输出摘要：超长只留头尾（中间写省略了多少字） */
export function clipMiddle(s: string, max: number): string {
  const t = s.replace(/\n{3,}/g, '\n\n').trim()
  if (t.length <= max) return t
  const h = Math.ceil(max / 2), tail = max - h
  return `${t.slice(0, h)}\n…（省略 ${t.length - max} 字）…\n${t.slice(-tail)}`
}

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
export const SUMMARY_PROMPT_MAX = 24_000

/** 摘要提示词：每段「时间点（秒）+ 命令 + 输出摘要」，要模型回 JSON 章节列表 */
export function buildSummaryPrompt(segs: CastSegment[], title: string, durationSec: number): { system: string; user: string } {
  const per = Math.max(120, Math.min(800, Math.floor(SUMMARY_PROMPT_MAX / Math.max(1, segs.length))))
  const system = [
    '你是终端录像整理助手。下面是一段终端录像按命令切分后的内容（时间点单位为秒、命令、输出摘要）。',
    '请把它整理成章节列表：相关的连续步骤合成一章，每章一句中文说明这段做了什么（如「安装依赖并启动服务」「排查 nginx 502，发现 upstream 端口未监听」），不超过 30 字。',
    '章节数 3–15 个（内容很少时可以更少），时间点取该章第一段的时间点（秒）。',
    '只输出 JSON 数组，不要其它文字：[{"t": 秒数, "title": "这段做了什么"}]',
  ].join('\n')
  const L = [`录像：${title}，时长 ${fmtT(durationSec)}（${Math.round(durationSec)} 秒）`, '']
  for (const s of segs) {
    L.push(`[${Math.round(s.t * 10) / 10}s]${s.command ? ` ${s.ai ? 'AI 执行' : '命令'}：${s.command}` : ' 输出'}`)
    const o = clipMiddle(s.output, per)
    if (o) L.push(o)
    L.push('')
  }
  return { system, user: L.join('\n').slice(0, SUMMARY_PROMPT_MAX + 2000) }
}

/** 模型输出 → 章节（JSON 数组优先；退回「1:23 说明」「83s 说明」逐行格式）。时间夹在 [0, 时长]，按时间排序去重，最多 40 章 */
export function parseChapters(raw: string, durationSec: number): RecordingChapter[] {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
  let list: RecordingChapter[] = []
  const a = s.indexOf('['), b = s.lastIndexOf(']')
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(s.slice(a, b + 1)) as unknown
      if (Array.isArray(j)) list = j.flatMap((x) => {
        const t = Number((x as { t?: unknown })?.t), title = (x as { title?: unknown })?.title
        return Number.isFinite(t) && typeof title === 'string' && title.trim() ? [{ t, title: title.trim().slice(0, 80) }] : []
      })
    } catch { /* 退回逐行 */ }
  }
  if (!list.length) {
    for (const ln of s.split('\n')) {
      const m = /^\s*[-*\d.]*\s*\[?(?:(\d+):(\d{1,2})|(\d+(?:\.\d+)?)\s*s)\]?\s*[-—:：]?\s*(.+)$/.exec(ln)
      if (m) list.push({ t: m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]), title: m[4].trim().slice(0, 80) })
    }
  }
  const max = Math.max(0, durationSec)
  const seen = new Set<number>()
  return list.map((c) => ({ ...c, t: Math.min(max, Math.max(0, c.t)) })).sort((x, y) => x.t - y.t)
    .filter((c) => { const k = Math.round(c.t * 10); if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 40)
}

/** 章节时间（录像原始时间）→ 回放器时间（空闲压缩后，见 limitIdle）：两份事件一一对应，取第一个不早于它的事件 */
export function mapChapterTime(orig: CastEvent[], limited: CastEvent[], t: number): number {
  for (let i = 0; i < orig.length; i++) if (orig[i][0] >= t - 1e-6) return limited[i]?.[0] ?? 0
  return limited.at(-1)?.[0] ?? 0
}
