// 故障复盘报告（SRE postmortem）：向当前会话发一条「生成复盘」指令，附上本会话的执行记录（真实时间）、文件改动、主机变化，
// 由 AI 按固定模板整理成 Markdown；回复完成后可「保存为文件」。纯函数，ChatPanel 用
import type { AuditEntry, HostSummary } from '../protocol/index.js'
import type { TurnChanges } from './turnChanges.js'
import type { TurnHostReport } from '../ops/index.js'
import { auditDecisionLabel, fmtTime } from './report.js'
import { tr } from '../i18n/i18n.js'

export const POSTMORTEM_TAG = '【生成复盘】'   // i18n-ignore 消息前缀标识（isPostmortemRequest 按它识别）
export const POSTMORTEM_MAX_ROWS = 200

export interface PostmortemInput {
  title: string
  audit: AuditEntry[]
  turnChanges: TurnChanges[]
  hostReports: TurnHostReport[]
  hosts: Pick<HostSummary, 'id' | 'label' | 'env'>[]
  redact?: (s: string) => string
}

const cell = (s: string, max = 200) => {
  const t = s.replace(/\r?\n/g, ' ⏎ ').replace(/\|/g, '\\|')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export const POSTMORTEM_TEMPLATE = [
  '# 故障复盘：<一句话概括故障>',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 影响概述',   // i18n-ignore 发给 AI 的提示词与模板
  '<影响的主机 / 服务 / 用户，持续时间（按执行记录估算，写明依据），严重程度>',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 时间线',   // i18n-ignore 发给 AI 的提示词与模板
  '| 时间 | 事件 | 命令 / 发现 |',   // i18n-ignore 发给 AI 的提示词与模板
  '| --- | --- | --- |',
  '| <取自执行记录的时间> | <发生了什么> | <对应命令及关键输出 / 结论> |',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 根因',   // i18n-ignore 发给 AI 的提示词与模板
  '<直接原因与深层原因；不确定的写「待确认」并说明还缺什么证据>',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 处理过程',   // i18n-ignore 发给 AI 的提示词与模板
  '<按顺序列出排查与修复步骤，含改过的文件>',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 恢复验证',   // i18n-ignore 发给 AI 的提示词与模板
  '<用哪些命令 / 现象确认已恢复；没验证过就写「未验证」>',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 后续改进项',   // i18n-ignore 发给 AI 的提示词与模板
  '| 行动项 | 负责人 | 期限 |',   // i18n-ignore 发给 AI 的提示词与模板
  '| --- | --- | --- |',
  '| <具体可执行的改进> | 待定 | 待定 |',   // i18n-ignore 发给 AI 的提示词与模板
  '',
  '## 附录：关键命令与输出摘要',   // i18n-ignore 发给 AI 的提示词与模板
  '<关键命令（代码块）+ 输出要点，不贴大段原文>',   // i18n-ignore 发给 AI 的提示词与模板
].join('\n')

/** 拼「生成复盘」指令：要求 + 模板 + 执行记录时间线（真实时间）+ 文件改动 + 主机变化 */
export function buildPostmortemPrompt(i: PostmortemInput): string {
  const red = i.redact ?? ((s: string) => s)
  const hostName = (k: string) => {
    if (k === 'local') return '本地'   // i18n-ignore 发给 AI 的提示词与模板
    const h = i.hosts.find((x) => x.id === k)
    return h ? `${h.label}${h.env === 'prod' ? '（生产）' : ''}` : k   // i18n-ignore 发给 AI 的提示词与模板
  }
  const audit = [...i.audit].filter((a) => a.command || a.filePath).sort((a, b) => a.at.localeCompare(b.at))
  const omitted = Math.max(0, audit.length - POSTMORTEM_MAX_ROWS)
  const rows = omitted ? audit.slice(-POSTMORTEM_MAX_ROWS) : audit
  const auditMd = rows.length
    ? ['| 时间 | 主机 / 终端 | 命令 / 文件 | 结果 | 退出码 |', '| --- | --- | --- | --- | --- |',   // i18n-ignore 发给 AI 的提示词与模板
      ...rows.map((a) => `| ${fmtTime(a.at)} | ${cell(`${hostName(a.hostKey)}${a.terminalTitle ? ` / ${a.terminalTitle}` : ''}`, 60)} | ${cell(red(a.command ?? a.filePath ?? ''))} | ${cell(auditDecisionLabel(a.decision), 40)} | ${a.exitCode ?? ''} |`)].join('\n')
    : '（本会话没有执行记录）'   // i18n-ignore 发给 AI 的提示词与模板

  const files = i.turnChanges.flatMap((t) => t.files)
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt))
    .map((f) => `- ${fmtTime(f.firstAt)}${f.lastAt !== f.firstAt ? ` ~ ${fmtTime(f.lastAt)}` : ''} ${hostName(f.hostKey)} \`${f.path}\`（${f.created ? '新建' : '修改'}，写入 ${f.writes} 次${f.undoneAt ? `，${fmtTime(f.undoneAt)} 已撤销` : ''}）`)   // i18n-ignore 发给 AI 的提示词与模板
  const hostLines = [...i.hostReports].sort((a, b) => a.at.localeCompare(b.at)).flatMap((r) => r.hosts
    .filter((h) => h.summary.length || h.error)
    .map((h) => `- ${fmtTime(r.at)} ${h.hostLabel ?? hostName(h.hostKey)}：${h.summary.length ? h.summary.join('、') : `快照失败（${h.error}）`}`))   // i18n-ignore 发给 AI 的提示词与模板

  const span = audit.length ? `${fmtTime(audit[0].at)} ~ ${fmtTime(audit[audit.length - 1].at)}` : '—'
  return [
    `${POSTMORTEM_TAG}请把本会话整理成一份故障复盘报告（Markdown）。`,   // i18n-ignore 发给 AI 的提示词与模板
    '',
    '要求：',   // i18n-ignore 发给 AI 的提示词与模板
    '- 只依据本会话的对话，以及下面的执行记录、文件改动和主机变化，不要编造事实。',   // i18n-ignore 发给 AI 的提示词与模板
    '- 时间线里的时间必须取自下面执行记录 / 文件改动 / 主机变化里的时间（精确到秒）；对话里提到但没有记录的事件，时间写「—」。',   // i18n-ignore 发给 AI 的提示词与模板
    '- 不要再执行任何命令，也不要改文件；直接输出报告正文，不要把整份报告包在代码块里，报告前后不要加别的话。',   // i18n-ignore 发给 AI 的提示词与模板
    '- 严格按下面的模板和标题顺序；负责人一律写「待定」；无法确定的内容写「待确认」。',   // i18n-ignore 发给 AI 的提示词与模板
    '',
    '模板：',   // i18n-ignore 发给 AI 的提示词与模板
    '',
    POSTMORTEM_TEMPLATE,
    '',
    '---',
    `会话：${i.title}`,   // i18n-ignore 发给 AI 的提示词与模板
    `执行时间范围：${span}`,   // i18n-ignore 发给 AI 的提示词与模板
    '',
    `### 执行记录（共 ${audit.length} 条，按时间${omitted ? `；只列最近 ${POSTMORTEM_MAX_ROWS} 条，更早的 ${omitted} 条省略` : ''}）`,   // i18n-ignore 发给 AI 的提示词与模板
    auditMd,
    '',
    '### 文件改动（AI 经 write_file 写入）',   // i18n-ignore 发给 AI 的提示词与模板
    files.length ? files.join('\n') : '（无）',   // i18n-ignore 发给 AI 的提示词与模板
    '',
    '### 主机变化（AI 改动前后的快照对比）',   // i18n-ignore 发给 AI 的提示词与模板
    hostLines.length ? hostLines.join('\n') : '（无）',   // i18n-ignore 发给 AI 的提示词与模板
  ].join('\n')
}

export const isPostmortemRequest = (text: string | undefined) => !!text?.startsWith(POSTMORTEM_TAG)

/** AI 回复 → 要保存的 Markdown：整份包在 ```markdown 代码块里时剥掉外壳；报告标题前的客套话去掉 */
export function postmortemMarkdown(reply: string): string {
  let s = reply.trim()
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(s)
  if (m) s = m[1].trim()
  const h = s.search(/^# /m)
  if (h > 0) s = s.slice(h)
  return `${s}\n`
}

/** 默认文件名：复盘-<会话标题>-<YYYY-MM-DD>.md（去掉 Windows 不允许的字符） */
export function postmortemFileName(title: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const t = (title || tr('会话')).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60)
  return tr('复盘-{title}-{date}.md', { title: t, date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` })
}
