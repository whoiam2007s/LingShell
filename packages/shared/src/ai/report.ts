import type { AuditEntry, HostSummary } from '../protocol/index.js'
import type { ItemKind, ItemStatus, ToolCallInfo, TodoItem } from '../protocol/index.js'
import { redactSecrets } from './redact.js'
import { explorerAuditLabel } from '../files/explorer.js'
import { tk, tr } from '../i18n/i18n.js'

// 会话导出（仅对话 / 完整报告）：纯函数，UI 的 ConvItem 结构上兼容 ReportItem。
// 完整报告 = 概要 + 对话与过程 + 执行记录 + 文件改动 + 授权记录，给排查复盘 / 附进工单用。

type Verdict = 'allow' | 'deny' | 'timeout' | 'cancelled'   // cancelled = 本轮结束，卡片没来得及处理
export interface ReportItem {
  kind: ItemKind
  status: ItemStatus
  text: string
  tool?: ToolCallInfo
  todos?: TodoItem[]
  error?: string
  auth?: { terminalId: string; needed: 'read' | 'write'; reason?: string; command?: string; result?: Verdict }
  plan?: { title: string; steps: { command: string; purpose?: string }[]; result?: Verdict }
}

const OUTPUT_MAX = 4000
export const DIFF_MAX_LINES = 200
// 围栏比正文里最长的一串反引号再长一个：命令输出里带 ``` 时不会提前闭合代码块、把后面的内容当 Markdown 渲染
const fence = (body: string, lang = '') => {
  const s = body.replace(/\s+$/, '')
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((x) => x.length))
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${s}\n${f}`
}
const pad = (n: number) => String(n).padStart(2, '0')
// 本地时间 YYYY-MM-DD HH:mm:ss
export function fmtTime(iso: string): string {
  const t = new Date(iso)
  if (isNaN(t.getTime())) return iso
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
}

// ── 脱敏：规则在 redact.ts（与「发给 AI 前脱敏」共用），这里转出保持原 API ──
export { REDACTED, redactSecrets } from './redact.js'

// ── 执行记录 decision → 中文 ─────────────────────────
const ALLOW_REASON: Record<string, string> = { first_access: tk('首次授权'), elevation: tk('提升为写入'), dangerous_command: tk('危险命令确认'), user: tk('批准'), plan: tk('计划内') }
export function auditDecisionLabel(d: string): string {
  const fixed: Record<string, string> = {
    exec_allowed: tk('audit|执行'), 'exec_allowed:edited': tk('改后执行'), read_allowed: tk('audit|读取'), upload_allowed: tk('上传'),
    download_allowed: tk('下载'), write_allowed: tk('改文件'), restored: tk('已还原'), turn_undo: tk('撤销本轮改动'), user_edit: tk('手动编辑'), 'deny:user': tk('你拒绝'),
    file_delete: tk('删除文件'), file_rename: tk('重命名'),
  }
  if (fixed[d]) return tr(fixed[d])
  const ex = explorerAuditLabel(d)
  if (ex) return ex
  if (d.startsWith('allow:')) return tr(ALLOW_REASON[d.slice(6)] ?? ALLOW_REASON.user)
  if (d.startsWith('deny:user:')) return tr('你拒绝：{reason}', { reason: d.slice(10) })
  if (d.startsWith('deny:')) return tr('拦截：{reason}', { reason: d.slice(5) })
  return d
}
const isFailed = (a: AuditEntry) => a.exitCode !== undefined && a.exitCode !== 0

// diff 超长截断（按行）
export function truncateDiff(diff: string, max = DIFF_MAX_LINES): string {
  const lines = diff.replace(/\s+$/, '').split('\n')
  return lines.length <= max ? lines.join('\n') : `${lines.slice(0, max).join('\n')}\n${tr('…（后面省略 {n} 行）', { n: lines.length - max })}`
}

// ── 对话与过程 ──────────────────────────────────────
function toolBlock(it: ReportItem): string {
  const t = it.tool
  if (!t) return ''
  const input = (t.input ?? {}) as Record<string, unknown>
  const cmd = typeof input.command === 'string' ? input.command : undefined
  // 文件工具只记路径：write_file 的 content/old_text 可能很长，整段 JSON 塞进记录没法读
  const filePath = !cmd && typeof input.path === 'string' && t.name.endsWith('_file') ? input.path : undefined
  const term = String(input.terminal_id ?? '?')
  const head = cmd ? `${tr('**执行** `{name}`（终端 {term}）', { name: t.name, term })}\n\n${fence(cmd, 'bash')}`
    : filePath ? tr('**文件** `{name}` `{path}`（终端 {term}）', { name: t.name, path: filePath, term })
    : tr('**工具** `{name}` {input}', { name: t.name, input: JSON.stringify(input) })
  let out = (t.output ?? it.error ?? '').trim()
  // exec 的结果是 JSON：{ output, exit_code, ... }，拆出来更好读
  try {
    const j = JSON.parse(out) as { output?: string; exit_code?: number }
    if (typeof j.output === 'string') out = `${j.output}${j.exit_code !== undefined ? `\n${tr('[退出码 {code}]', { code: j.exit_code })}` : ''}`
  } catch { /* 不是 JSON 就原样 */ }
  if (out.length > OUTPUT_MAX) out = `${tr('…（前面省略 {n} 字）', { n: out.length - OUTPUT_MAX })}\n${out.slice(-OUTPUT_MAX)}`
  return out ? `${head}\n\n<details><summary>${it.status === 'failed' ? tr('输出（失败）') : tr('输出')}</summary>\n\n${fence(out)}\n\n</details>` : head
}

const verdict = (r: Verdict | undefined, allow: string) =>
  r === 'allow' ? `✅ ${allow}` : r === 'deny' ? tr('⛔ 已拒绝') : r === 'timeout' ? tr('⏱ 超时拒绝') : r === 'cancelled' ? tr('⏹ 未处理（本轮结束）') : tr('待决定')

// h = 用户消息的标题级别（仅对话 2，完整报告里嵌在章节下用 3）
function conversationParts(items: ReportItem[], h = 2): string[] {
  const H = '#'.repeat(h)
  const parts: string[] = []
  for (const it of items) {
    switch (it.kind) {
      case 'user_message': parts.push(`${H} 🧑 ${tr('用户')}\n\n${it.text}`); break
      case 'agent_message': if (it.text.trim()) parts.push(`${H}# 🤖 AI\n\n${it.text}`); break
      case 'tool_call': parts.push(toolBlock(it)); break
      case 'todo':
        if (it.todos?.length) parts.push(`**${tr('任务清单')}**\n\n${it.todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n')}`)
        break
      case 'auth_request': {
        const a = it.auth
        if (a) parts.push(`> ${tr('授权请求：{level} {term}', { level: a.needed === 'write' ? tr('写入') : tr('读取'), term: a.terminalId })}${a.command ? ` — \`${a.command}\`` : ''} → ${verdict(a.result, tr('已允许'))}`)
        break
      }
      case 'plan_request': {
        const p = it.plan
        if (p) parts.push(`> ${tr('执行计划：{title}', { title: p.title })} → ${verdict(p.result, tr('已批准'))}\n${p.steps.map((s, i) => `> ${i + 1}. \`${s.command}\`${s.purpose ? ` — ${s.purpose}` : ''}`).join('\n')}`)
        break
      }
      default: break   // agent_reasoning 等不导出
    }
  }
  return parts
}

const stamp = (now: Date) => `> ${tr('导出于 {time}', { time: fmtTime(now.toISOString()) })}`

export function conversationToMarkdown(title: string, items: ReportItem[], opts: { redact?: boolean; now?: Date } = {}): string {
  const md = [`# ${title}`, stamp(opts.now ?? new Date()), ...conversationParts(items)].join('\n\n') + '\n'
  return opts.redact ? redactSecrets(md) : md
}

// ── 完整报告 ────────────────────────────────────────
export interface SessionReportInput {
  title: string
  items: ReportItem[]
  audit: AuditEntry[]
  hosts: Pick<HostSummary, 'id' | 'label' | 'env'>[]
  redact?: boolean
  now?: Date
}

const cell = (s: string, max = 200) => {
  // 反斜杠要先转义：命令里的 `\|` 否则会变成 `\\|`，表格仍会把 | 当分隔符
  const t = s.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ⏎ ').replace(/\|/g, '\\|')
  return t.length > max ? `${t.slice(0, max)}…` : t
}
const AUTH_REASON: Record<string, string> = { first_access: tk('首次访问'), elevation: tk('提升为写入'), dangerous_command: tk('危险命令') }
const VERDICT: Record<Verdict, string> = { allow: tk('允许'), deny: tk('拒绝'), timeout: tk('超时'), cancelled: tk('未处理') }

interface FileChange { path: string; source: string; diff?: string; backup?: string }
function fileChanges(items: ReportItem[], audit: AuditEntry[]): FileChange[] {
  const out: FileChange[] = []
  for (const it of items) {
    if (it.kind !== 'tool_call' || it.tool?.name !== 'write_file') continue
    let j: { path?: string; diff?: string; backup_path?: string } | undefined
    try { j = JSON.parse(it.tool.output ?? '') as typeof j } catch { /* 失败/无结果 */ }
    if (!j?.diff) continue
    const input = (it.tool.input ?? {}) as Record<string, unknown>
    out.push({ path: j.path ?? String(input.path ?? '?'), source: tr('AI 写入'), diff: j.diff, backup: j.backup_path })
  }
  // 手动编辑 / 还原只在执行记录里，没有 diff，列路径 + 备份
  for (const a of audit) {
    if ((a.decision === 'user_edit' || a.decision === 'restored' || a.decision === 'turn_undo') && a.filePath)
      out.push({ path: a.filePath, source: auditDecisionLabel(a.decision), backup: a.backupPath })
  }
  return out
}

export function buildSessionReport(input: SessionReportInput): string {
  const { title, items, hosts } = input
  const audit = [...input.audit].sort((a, b) => a.at.localeCompare(b.at))
  const hostName = (k: string) => {
    if (k === 'local') return tr('本地')
    const h = hosts.find((x) => x.id === k)
    return h ? `${h.label}${h.env === 'prod' ? tr('（生产）') : ''}` : k
  }
  const where = (a: AuditEntry) => `${hostName(a.hostKey)}${a.terminalTitle ? ` / ${a.terminalTitle}` : ''}`
  const auths = items.filter((i) => (i.kind === 'auth_request' && i.auth) || (i.kind === 'plan_request' && i.plan))
  const result = (i: ReportItem) => (i.auth ?? i.plan)?.result
  const files = fileChanges(items, audit)
  const execs = audit.filter((a) => a.decision.startsWith('exec_allowed'))

  // 1. 概要
  const hostKeys = [...new Set(audit.map((a) => a.hostKey))]
  const summary = [
    `- ${tr('会话：{title}', { title })}`,
    `- ${tr('时间：{range}', { range: audit.length ? `${fmtTime(audit[0].at)} ~ ${fmtTime(audit[audit.length - 1].at)}` : tr('—（无执行记录）') })}`,
    `- ${tr('涉及主机：{hosts}', { hosts: hostKeys.length ? hostKeys.map(hostName).join(tr('list|、')) : '—' })}`,
    `- ${tr('执行命令：{n} 条，失败 {failed} 条', { n: execs.length, failed: execs.filter(isFailed).length })}`,
    `- ${tr('文件改动：{n} 个文件', { n: new Set(files.map((f) => f.path)).size })}`,
    `- ${tr('授权：允许 {allow} 次，拒绝 {deny} 次，超时 {timeout} 次', { allow: auths.filter((i) => result(i) === 'allow').length, deny: auths.filter((i) => result(i) === 'deny').length, timeout: auths.filter((i) => result(i) === 'timeout').length })}`,
  ].join('\n')

  // 3. 执行记录
  const auditMd = audit.length
    ? [tr('| 时间 | 主机 / 终端 | 命令 | 决定 | 退出码 |'), '| --- | --- | --- | --- | --- |',
      ...audit.map((a) => `| ${fmtTime(a.at)} | ${cell(where(a))} | ${cell(a.command ?? a.filePath ?? '')} | ${cell(auditDecisionLabel(a.decision))} | ${a.exitCode === undefined ? '' : isFailed(a) ? `❌ **${a.exitCode}**` : a.exitCode}${a.truncated ? tr('（输出截断）') : ''} |`),
    ].join('\n')
    : tr('report|无')

  // 4. 文件改动
  const filesMd = files.length
    ? files.map((f) => [`### \`${f.path}\`${tr('（{why}）', { why: f.source })}`, f.diff ? fence(truncateDiff(f.diff), 'diff') : tr('（无 diff 记录）'), f.backup ? tr('备份：`{path}`', { path: f.backup }) : '']
      .filter(Boolean).join('\n\n')).join('\n\n')
    : tr('report|无')

  // 5. 授权记录：拒绝理由在执行记录里（deny:user:<理由>），按终端 + 命令对上
  const denyNote = (terminalId: string, command?: string) =>
    audit.find((a) => a.decision.startsWith('deny:user:') && a.terminalId === terminalId && (!command || a.command === command))?.decision.slice(10)
  const termName = (id: string) => audit.find((a) => a.terminalId === id && a.terminalTitle)?.terminalTitle ?? id
  const authMd = auths.length
    ? auths.map((i) => {
      const r = result(i)
      const v = r ? tr(VERDICT[r]) : tr('待决定')
      if (i.plan) return `- ${tr('执行计划「{title}」（{n} 步）', { title: i.plan.title, n: i.plan.steps.length })}→ **${v}**`
      const a = i.auth!
      const note = r === 'deny' ? denyNote(a.terminalId, a.command) : undefined
      const why = a.reason ? (AUTH_REASON[a.reason] ? tr(AUTH_REASON[a.reason]) : a.reason) : ''
      return `- ${a.needed === 'write' ? tr('写入') : tr('读取')} ${termName(a.terminalId)}${a.command ? ` — \`${a.command}\`` : ''}${why ? tr('（{why}）', { why }) : ''} → **${v}**${note ? tr('，理由：{note}', { note }) : ''}`
    }).join('\n')
    : tr('report|无')

  const conv = conversationParts(items, 3)
  const md = [
    `# ${tr('会话报告：{title}', { title })}`, stamp(input.now ?? new Date()),
    `## 1. ${tr('概要')}\n\n${summary}`,
    `## 2. ${tr('对话与过程')}\n\n${conv.length ? conv.join('\n\n') : tr('report|无')}`,
    `## 3. ${tr('执行记录')}\n\n${auditMd}`,
    `## 4. ${tr('文件改动')}\n\n${filesMd}`,
    `## 5. ${tr('授权记录')}\n\n${authMd}`,
  ].join('\n\n') + '\n'
  return input.redact ? redactSecrets(md) : md
}
