// 命令历史 → 上下文 chip：chip 上只显示命令（截断）或「N 条命令」，全文随消息发给 AI。
// 注意：历史条目里只有命令 / 时间 / 终端 / 来源，**没有退出码**——所以文案里不能承诺「这条失败了」，
// 只能问「如果失败了该怎么查」。
import { tr, type CommandHistoryEntry } from '@lingshell/shared'

/** 批量归纳时最多带多少条（再多就只是噪音） */
export const MAX_BATCH = 10

/** chip 的名字 + 随消息发出去的全文 */
export interface ChipQuote { name: string; text: string }

const fmtTime = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // 本地时间、精确到秒：跨时区排障时 ISO 串反而不直观
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const srcLabel = (s: CommandHistoryEntry['source']) => (s === 'ai' ? tr('AI 执行') : tr('我手敲'))

/** chip 名：命令首行截断；太长的省略号收尾 */
const chipNameOf = (cmd: string): string => {
  const one = cmd.split('\n')[0].trim()
  return one.length > 48 ? `${one.slice(0, 48)}…` : one
}

export interface HistoryEntryChipInput {
  /** 可读主机名，如「本机」「prod-web-01」 */
  host: string
  entry: CommandHistoryEntry
}

/** 单条命令：chip 名 = 命令本身 */
export function historyEntryChip(i: HistoryEntryChipInput): ChipQuote {
  return {
    name: chipNameOf(i.entry.command),
    text: [
      tr('【命令历史】'),
      tr('主机：{host}', { host: i.host }),
      tr('终端：{term}', { term: i.entry.terminalTitle }),
      tr('终端 id：{id}', { id: i.entry.terminalId }),
      ...(i.entry.hostKey ? [tr('主机标识：{key}', { key: i.entry.hostKey })] : []),
      tr('来源：{src}', { src: srcLabel(i.entry.source) }),
      tr('时间：{time}', { time: fmtTime(i.entry.at) }),
      '',
      '```',
      i.entry.command,
      '```',
      '',
      tr('注意：这是历史记录，没有退出码，无法判断当时成功与否。'),
    ].join('\n'),
  }
}

export interface HistoryBatchChipInput {
  host: string
  entries: CommandHistoryEntry[]
}

/** 一段命令：chip 名 = 「N 条命令」 */
export function historyBatchChip(i: HistoryBatchChipInput): ChipQuote {
  // 面板默认最新在前；归纳要按时间先后读，所以这里统一排一次序（at 是 ISO 串，可直接比）
  const ordered = [...i.entries].sort((a, b) => a.at.localeCompare(b.at))
  const list = ordered.slice(0, MAX_BATCH)
  const lines = [
    tr('【命令历史】'),
    tr('主机：{host}', { host: i.host }),
    tr('共 {n} 条，按时间先后：', { n: list.length }),
    '',
  ]
  list.forEach((e, idx) => {
    lines.push(`${idx + 1}. [${fmtTime(e.at)} · ${e.terminalTitle} · ${srcLabel(e.source)}]`)
    lines.push('```')
    lines.push(e.command)
    lines.push('```')
  })
  if (i.entries.length > MAX_BATCH) lines.push(tr('（另有 {n} 条未带）', { n: i.entries.length - MAX_BATCH }))
  lines.push('', tr('注意：这是历史记录，没有退出码，无法判断当时成功与否。'))
  return { name: tr('{n} 条命令', { n: list.length }), text: lines.join('\n') }
}
