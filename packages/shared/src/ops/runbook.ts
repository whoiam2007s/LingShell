// ── 运维手册 Runbook ────────────────────────────────────
// 把成功的排查/操作流程沉淀成可重复执行的多步清单。命令里可含 {{参数}}，运行前由用户填写。
import { templateVars, fillTemplate } from './ops.js'
import type { AuditEntry } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

export type RunbookStepKind = 'check' | 'change'   // check=只读检查（直接跑）；change=改动（先 propose_plan 批准）
export interface RunbookParam { name: string; label: string; default?: string }
export interface RunbookStep { title: string; command?: string; expect?: string; kind: RunbookStepKind }
export interface Runbook { id: string; name: string; description: string; params: RunbookParam[]; steps: RunbookStep[]; updatedAt: string }
export type RunbookInput = Omit<Runbook, 'id' | 'updatedAt'> & { id?: string }

/** 校验并规整：去空白、丢空字段；步骤里用到但没声明的参数自动补上，参数名去重 */
export function normalizeRunbook(input: RunbookInput): RunbookInput {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error(tr('手册名称不能为空'))
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error(tr('手册至少要有一个步骤'))
  const steps: RunbookStep[] = input.steps.map((s, i) => {
    const title = String(s?.title ?? '').trim(), command = String(s?.command ?? '').trim(), expect = String(s?.expect ?? '').trim()
    if (!title) throw new Error(tr('第 {n} 步缺少标题', { n: i + 1 }))
    if (s?.kind !== 'check' && s?.kind !== 'change') throw new Error(tr('第 {n} 步类型无效', { n: i + 1 }))
    return { title, kind: s.kind, ...(command ? { command } : {}), ...(expect ? { expect } : {}) }
  })
  const params: RunbookParam[] = []
  for (const p of Array.isArray(input.params) ? input.params : []) {
    const n = String(p?.name ?? '').trim()
    if (!n || /[{}]/.test(n) || params.some((x) => x.name === n)) continue
    const def = String(p.default ?? '').trim()
    params.push({ name: n, label: String(p.label ?? '').trim() || n, ...(def ? { default: def } : {}) })
  }
  for (const n of runbookVars(steps)) if (!params.some((p) => p.name === n)) params.push({ name: n, label: n })
  return { ...(input.id ? { id: input.id } : {}), name, description: String(input.description ?? '').trim(), params, steps }
}

/** 步骤（命令/标题/预期）里出现的占位符，去重保序 */
export function runbookVars(steps: RunbookStep[]): string[] {
  return templateVars(steps.map((s) => `${s.title}\n${s.command ?? ''}\n${s.expect ?? ''}`).join('\n'))
}

/** 参数值：用户填的优先，空则用默认值 */
export function runbookValues(rb: Pick<Runbook, 'params'>, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of rb.params) out[p.name] = (values[p.name] ?? '').trim() || p.default || ''
  return out
}

/** 填好参数的步骤 */
export function fillRunbook(rb: Pick<Runbook, 'params' | 'steps'>, values: Record<string, string>): RunbookStep[] {
  const v = runbookValues(rb, values)
  return rb.steps.map((s) => ({
    ...s, title: fillTemplate(s.title, v),
    ...(s.command ? { command: fillTemplate(s.command, v) } : {}),
    ...(s.expect ? { expect: fillTemplate(s.expect, v) } : {}),
  }))
}

/** 运行手册时发给 AI 的提示词（纯函数） */
export function buildRunbookPrompt(rb: Runbook, values: Record<string, string>, terminals: { id: string; title: string; detail?: string }[]): string {
  const steps = fillRunbook(rb, values)
  const v = runbookValues(rb, values)
  const L: string[] = [`按运维手册「${rb.name}」执行。`]   // i18n-ignore 发给 AI 的提示词
  if (rb.description) L.push(`说明：${rb.description}`)   // i18n-ignore 发给 AI 的提示词
  L.push('', '目标终端：')   // i18n-ignore 发给 AI 的提示词
  for (const t of terminals) L.push(`- ${t.id}（${t.title}${t.detail ? ` · ${t.detail}` : ''}）`)   // i18n-ignore 发给 AI 的提示词
  if (rb.params.length) {
    L.push('', '参数：')   // i18n-ignore 发给 AI 的提示词
    for (const p of rb.params) L.push(`- ${p.label}（${p.name}）= ${v[p.name] || '（未填）'}`)   // i18n-ignore 发给 AI 的提示词
  }
  L.push('', '步骤（按顺序）：')   // i18n-ignore 发给 AI 的提示词
  steps.forEach((s, i) => {
    L.push(`${i + 1}. [${s.kind === 'change' ? '改动' : '检查'}] ${s.title}`)   // i18n-ignore 发给 AI 的提示词
    if (s.command) L.push(`   命令：${s.command}`)   // i18n-ignore 发给 AI 的提示词
    if (s.expect) L.push(`   预期：${s.expect}`)   // i18n-ignore 发给 AI 的提示词
  })
  const hasChange = steps.some((s) => s.kind === 'change')
  L.push('', '执行要求：',   // i18n-ignore 发给 AI 的提示词
    '1. 严格按步骤顺序执行，每个步骤在每个目标终端上都要做；不要跳步、合并或擅自增加步骤。',   // i18n-ignore 发给 AI 的提示词
    '2. [检查] 步骤直接用 exec_in_terminal 执行。')   // i18n-ignore 发给 AI 的提示词
  if (hasChange) L.push('3. [改动] 步骤执行前先调用 propose_plan，把即将执行的连续改动步骤（每个目标终端各一条，命令与手册一致）一次列给用户批准；批准后按批准结果逐字执行，不要改写命令。')   // i18n-ignore 发给 AI 的提示词
  else L.push('3. 本手册只有检查步骤，不需要 propose_plan。')   // i18n-ignore 发给 AI 的提示词
  L.push(
    '4. 每步执行后对照「预期」说明结果是否符合；没有预期的步骤简述输出要点。',   // i18n-ignore 发给 AI 的提示词
    '5. 结果不符合预期、命令报错或出现意外情况时立即停下，说明现象并询问我如何继续，不要自行修复或继续后续步骤。',   // i18n-ignore 发给 AI 的提示词
    '6. 全部完成后按步骤逐条汇总：步骤、终端、结果（符合/不符合）。',   // i18n-ignore 发给 AI 的提示词
  )
  return L.join('\n')
}

const CHANGE_RE = /(^|[\s;&|(])(sudo\s+)?(rm|mv|cp|chmod|chown|ln|mkdir|rmdir|touch|kill|pkill|killall|reboot|shutdown|useradd|userdel|passwd|crontab|tee|dd|mkfs|mount|umount|sed\s+-i|apt(-get)?\s+(install|remove|purge|upgrade)|yum\s+(install|remove|update)|dnf\s+(install|remove)|pip3?\s+install|npm\s+(i|install)|systemctl\s+(start|stop|restart|reload|enable|disable)|service\s+\S+\s+(start|stop|restart|reload)|docker\s+(run|rm|stop|start|restart|pull)|kubectl\s+(apply|delete|scale|rollout))\b|(?<![\d&>])>>?(?!\s*\/dev\/null|&)/
/** 粗判命令是否改动系统（只作勾选默认值，用户可改） */
export function guessStepKind(command: string): RunbookStepKind { return CHANGE_RE.test(command) ? 'change' : 'check' }

/** 执行记录 → 手册步骤：只取执行成功（exit 0）的命令，按时间正序，去掉连续重复 */
export function auditToSteps(entries: AuditEntry[]): RunbookStep[] {
  const ok = entries
    .filter((e) => e.decision.startsWith('exec_allowed') && e.exitCode === 0 && !e.truncated && e.command?.trim())
    .sort((a, b) => a.at.localeCompare(b.at))
  const out: RunbookStep[] = []
  for (const e of ok) {
    const command = e.command!.trim()
    if (out.at(-1)?.command === command) continue
    out.push({ title: command.length > 40 ? `${command.slice(0, 40)}…` : command, command, kind: guessStepKind(command) })
  }
  return out
}

/** 建议参数化的值：命令里出现的 IP、绝对路径、user@host，按出现次数降序 */
export function suggestParamValues(steps: RunbookStep[]): string[] {
  const n = new Map<string, number>()
  const re = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|[\w.-]+@[\w.-]+|(?<![\w.{])\/(?:[\w.@-]+\/)*[\w.@-]+/g
  for (const s of steps) for (const m of (s.command ?? '').matchAll(re)) if (m[0].length > 2) n.set(m[0], (n.get(m[0]) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

/** 把步骤里出现的 value 全部换成 {{name}}，并补上参数（默认值 = 原值） */
export function parameterize(rb: Pick<Runbook, 'params' | 'steps'>, value: string, name: string): Pick<Runbook, 'params' | 'steps'> {
  if (!value || !name.trim()) return rb
  const ph = `{{${name.trim()}}}`
  const rep = (s?: string) => s?.split(value).join(ph)
  const steps = rb.steps.map((s) => ({ ...s, title: rep(s.title)!, ...(s.command ? { command: rep(s.command) } : {}), ...(s.expect ? { expect: rep(s.expect) } : {}) }))
  const params = rb.params.some((p) => p.name === name.trim()) ? rb.params : [...rb.params, { name: name.trim(), label: name.trim(), default: value }]
  return { params, steps }
}

// ── 手册视图（手动逐条执行，参考 Warp Notebooks）──
/** 填好参数后命令里还没填的参数（密钥保险箱的 {{secret:名称}} 不算，发送时由主进程展开） */
export function runbookMissing(rb: Pick<Runbook, 'params' | 'steps'>, values: Record<string, string>): string[] {
  return templateVars(fillRunbook(rb, values).map((s) => s.command ?? '').join('\n')).filter((k) => !k.startsWith('secret:'))
}

export interface StepRun { exitCode?: number; durationMs: number; lines: number }
/** 一个命令块按行发出、每行一条命令：合并各行结果（第一个非 0 退出码为准，耗时累加） */
export function mergeStepRuns(rs: { exitCode?: number; durationMs: number }[]): StepRun {
  const bad = rs.find((r) => r.exitCode !== undefined && r.exitCode !== 0)
  return { exitCode: bad ? bad.exitCode : rs.at(-1)?.exitCode, durationMs: rs.reduce((n, r) => n + r.durationMs, 0), lines: rs.length }
}

/** 导入单个手册 JSON：校验后去掉 id（作为新手册保存） */
export function parseRunbookJson(text: string): RunbookInput {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(tr('不是有效的 JSON')) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(tr('JSON 不是单个手册对象'))
  const { id: _id, updatedAt: _u, ...rest } = raw as Runbook
  return normalizeRunbook(rest)
}
