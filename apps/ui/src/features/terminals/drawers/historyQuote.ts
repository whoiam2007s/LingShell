// 命令历史 → 对话：把「面板上真的有的东西」拼成引用文本。
// 注意：历史条目里只有命令 / 时间 / 终端 / 来源，**没有退出码**——所以文案里不能承诺「这条失败了」，
// 只能问「如果失败了该怎么查」。
import { tr, type CommandHistoryEntry } from '@lingshell/shared'

/** 批量归纳时最多带多少条（再多就只是噪音） */
export const MAX_BATCH = 10

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // 本地时间、精确到秒：跨时区排障时 ISO 串反而不直观
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const srcLabel = (s: CommandHistoryEntry['source']) => (s === 'ai' ? tr('AI 执行') : tr('我手敲'))

export interface HistoryQuoteInput {
  /** 可读主机名，如「本机」「prod-web-01」 */
  host: string
  entry: CommandHistoryEntry
}

/** 单条命令：问「这条是干什么的 / 失败该怎么查」 */
export function historyEntryQuote(i: HistoryQuoteInput): string {
  return [
    tr('帮我看看这条命令。', {}),
    '',
    tr('（下面是我从「命令历史」复制的记录，不是命令输出）'),
    tr('主机：{host}', { host: i.host }),
    tr('终端：{term}', { term: i.entry.terminalTitle }),
    tr('来源：{src}', { src: srcLabel(i.entry.source) }),
    tr('时间：{time}', { time: fmtTime(i.entry.at) }),
    '',
    '```',
    i.entry.command,
    '```',
    '',
    tr('1) 这条命令是做什么的，有哪些容易被忽略的副作用？2) 如果它失败了，最可能的原因和排查步骤是什么（给出可直接运行的诊断命令）？'),
  ].join('\n')
}

export interface HistoryBatchQuoteInput {
  host: string
  entries: CommandHistoryEntry[]
}

/** 一段命令：归纳在干什么 + 找危险操作 + 看能不能并成脚本 */
export function historyBatchQuote(i: HistoryBatchQuoteInput): string {
  // 面板默认最新在前；归纳要按时间先后读，所以这里统一排一次序（at 是 ISO 串，可直接比）
  const ordered = [...i.entries].sort((a, b) => a.at.localeCompare(b.at))
  const list = ordered.slice(0, MAX_BATCH)
  const lines = [
    tr('帮我归纳一下我在【{host}】上做的这些操作。', { host: i.host }),
    '',
    tr('（从「命令历史」复制的 {n} 条记录，按时间先后；没有退出码，别假设它们都成功了）', { n: list.length }),
    '',
  ]
  list.forEach((e, idx) => {
    lines.push(`${idx + 1}. [${fmtTime(e.at)} · ${e.terminalTitle} · ${srcLabel(e.source)}]`)
    lines.push('```')
    lines.push(e.command)
    lines.push('```')
  })
  if (i.entries.length > MAX_BATCH) lines.push(tr('（后面还有 {n} 条没带上）', { n: i.entries.length - MAX_BATCH }))
  lines.push('', tr('请回答：1) 这段操作整体在做什么；2) 其中哪些是危险或不可逆的；3) 有没有可以合并成一个脚本的重复步骤（给脚本）。'))
  return lines.join('\n')
}
