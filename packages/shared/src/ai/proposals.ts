// ── AI 提议的快速命令 / 运维手册（工具 propose_quick_commands / propose_runbook）──
// 工具体只校验、规整，不落盘；对话里出可编辑的预览卡，用户点「保存」才经 quickCommands.save / runbooks.save 写入。
import { normalizeRunbook, guessStepKind } from '../ops/runbook.js'
import type { RunbookInput } from '../ops/index.js'
import { newQuickId, normalizeQuickCommands } from '../terminal/quickCommands.js'
import type { QuickCommand, QuickCommandsData } from '../terminal/index.js'

export interface QuickProposalItem { label: string; command: string; description?: string }
export interface QuickProposal { setName: string; commands: QuickProposalItem[] }

const s = (v: unknown) => String(v ?? '').trim()
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
export const QUICK_PROPOSAL_MAX = 30

/** 工具入参 → 快速命令提议（字段名兼容 name / title / label）；不合法抛错（中文原因回给模型） */
export function normalizeQuickProposal(args: unknown): QuickProposal {
  const a = obj(args)
  const setName = s(a.set_name ?? a.setName ?? a.group)
  if (!setName) throw new Error('set_name（命令组名）不能为空')   // i18n-ignore 工具报错回给模型
  const raw = Array.isArray(a.commands) ? a.commands : []
  const commands: QuickProposalItem[] = []
  for (const [i, x] of raw.entries()) {
    const c = obj(x)
    const label = s(c.name ?? c.label ?? c.title), command = String(c.command ?? '').replace(/\s+$/, '')
    if (!label || !command.trim()) throw new Error(`第 ${i + 1} 条缺少名称或命令`)   // i18n-ignore 工具报错回给模型
    const description = s(c.description ?? c.desc)
    commands.push({ label, command, ...(description ? { description } : {}) })
  }
  // i18n-ignore-next 工具报错回给模型
  if (!commands.length) throw new Error('commands 至少要有一条')
  if (commands.length > QUICK_PROPOSAL_MAX) throw new Error(`一次最多 ${QUICK_PROPOSAL_MAX} 条`)   // i18n-ignore 工具报错回给模型
  return { setName, commands }
}

/** 保存提议：同名命令组已有 → 追加（同样的命令不重复加），否则新建一组；保存后切到这组。返回新数据与组 id */
export function applyQuickProposal(d: QuickCommandsData, p: QuickProposal): { data: QuickCommandsData; setId: string; added: number } {
  const toCmd = (c: QuickProposalItem): QuickCommand => ({ id: newQuickId('qc'), label: c.label, command: c.command, appendEnter: true, target: 'active', ...(c.description ? { description: c.description } : {}) })
  const old = d.sets.find((x) => x.name === p.setName)
  if (old) {
    const fresh = p.commands.filter((c) => !old.commands.some((x) => x.command === c.command))
    const sets = d.sets.map((x) => (x.id === old.id ? { ...x, commands: [...x.commands, ...fresh.map(toCmd)] } : x))
    return { data: normalizeQuickCommands({ ...d, sets, activeSetId: old.id }), setId: old.id, added: fresh.length }
  }
  const id = newQuickId('qs')
  const data = normalizeQuickCommands({ ...d, sets: [...d.sets, { id, name: p.setName, commands: p.commands.map(toCmd) }], activeSetId: id })
  return { data, setId: id, added: p.commands.length }
}

/** 工具入参 → 手册（标题 / 说明 / 步骤 / 参数；步骤类型缺省按命令猜）；校验同手册编辑（normalizeRunbook） */
export function runbookFromProposal(args: unknown): RunbookInput {
  const a = obj(args)
  const steps = (Array.isArray(a.steps) ? a.steps : []).map((x) => {
    const st = obj(x)
    const command = String(st.command ?? '').trim()
    const kind = st.kind === 'change' || st.kind === 'check' ? st.kind : guessStepKind(command)
    return { title: s(st.title ?? st.name) || command.slice(0, 40), command, expect: s(st.expect), kind }
  })
  const params = (Array.isArray(a.params) ? a.params : []).map((x) => { const p = obj(x); return { name: s(p.name), label: s(p.label ?? p.name), default: s(p.default) } })
  return normalizeRunbook({ name: s(a.title ?? a.name), description: s(a.description), steps, params })
}

/** 执行记录多选 →「让 AI 整理成手册」发给 AI 的话（AI 调 propose_runbook 出预览卡） */
export function runbookFromAuditPrompt(commands: string[]): string {
  return [
    '把下面这些我执行成功的命令整理成一本运维手册，调用 propose_runbook 提交（不要执行任何命令）：',   // i18n-ignore 发给 AI 的话
    '- 给手册起简短的标题，写一句说明（什么时候用）；每步一个简短标题，必要时写「预期结果」；',   // i18n-ignore 发给 AI 的话
    '- 把主机名、IP、路径、服务名、用户名这类会变的值提成参数，命令里用双花括号包住参数名，并给出参数的显示名和默认值（默认值用原值）；',   // i18n-ignore 发给 AI 的话
    '- 只读查看的步骤 kind=check，会改动系统的 kind=change；去掉重复和无意义的命令。',   // i18n-ignore 发给 AI 的话
    '',
    '命令（按执行顺序）：',   // i18n-ignore 发给 AI 的话
    ...commands.map((c, i) => `${i + 1}. ${c}`),
  ].join('\n')
}
