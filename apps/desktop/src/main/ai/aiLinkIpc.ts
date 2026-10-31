// AI 与终端联动的主进程部分：预测下一条命令、录像 AI 摘要。都是一次性模型调用（同「自然语言写命令」的通道）。
// 发给模型前按「发给 AI 前脱敏」处理（已知机密明文 + 密钥样式）；录像只读输出事件，不读键入（可能有密码）。
import { readFile, writeFile } from 'node:fs/promises'
import {
  buildPredictPrompt, buildSummaryPrompt, normalizePredict, parseCast, parseChapters, sanitizeNlCommand, segmentCast,
  type PredictRequest, type RecordingSummary, tr,
} from '@lingshell/shared'

export interface AiLinkDeps {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  complete(system: string, user: string, signal: AbortSignal, source: string): Promise<string>
  redact(text: string): string
  castPath(id: string): string           // 录像 id → .cast 绝对路径（含校验）
}

/** 摘要文件：录像旁的 <名>.summary.json */
export const summaryPathOf = (castPath: string) => castPath.replace(/\.cast$/, '.summary.json')

export async function summarize(d: Pick<AiLinkDeps, 'complete' | 'redact'>, castFile: string, signal: AbortSignal): Promise<RecordingSummary> {
  const { header, events } = parseCast(await readFile(castFile, 'utf8'))
  const segs = segmentCast(events)
  if (!segs.length) throw new Error(tr('录像里没有可摘要的输出'))
  const dur = events.at(-1)?.[0] ?? 0
  const p = buildSummaryPrompt(segs, header.title ?? '终端', dur)   // i18n-ignore 发给模型的录像标题
  const raw = await d.complete(p.system, d.redact(p.user), signal, 'recording-summary')
  const chapters = parseChapters(raw, dur)
  if (!chapters.length) throw new Error(tr('模型没有给出章节'))
  const s: RecordingSummary = { version: 1, createdAt: new Date().toISOString(), chapters }
  await writeFile(summaryPathOf(castFile), JSON.stringify(s, null, 1), 'utf8')
  return s
}

export function registerAiLink(d: AiLinkDeps): void {
  // 预测：拿不准 / 出错（含未配置 API Key）一律空串，界面静默
  d.handle('aiLink:predict', async (_e, req) => {
    const r = normalizePredict(req as Partial<PredictRequest>)
    if (!r.commands.length) return ''
    if (r.outputTail) r.outputTail = d.redact(r.outputTail)
    r.commands = r.commands.map((c) => d.redact(c))
    const p = buildPredictPrompt(r)
    try {
      const s = sanitizeNlCommand(await d.complete(p.system, p.user, AbortSignal.timeout(15_000), 'predict-command'))
      return 'command' in s ? s.command.replace(/^\d+[.)、]\s*/, '').slice(0, 300) : ''   // 模型照抄提示里的「1. 」编号时去掉
    } catch { return '' }
  })
  d.handle('aiLink:summarize', (_e, id) => summarize(d, d.castPath(String(id)), AbortSignal.timeout(90_000)))
  d.handle('aiLink:summary', async (_e, id) => {
    try {
      const j = JSON.parse(await readFile(summaryPathOf(d.castPath(String(id))), 'utf8')) as RecordingSummary
      return Array.isArray(j?.chapters) ? j : null
    } catch { return null }
  })
}
