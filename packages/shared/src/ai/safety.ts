// ── 安全与流程：分层规则 / AI 复核 / 预演模式 / sudo 限时提权 的纯逻辑（主进程、引擎、界面共用）──
import { splitCommand } from './commandRules.js'
import type { TrustLevel, PlanStep } from '../protocol/index.js'
import { tk, tr } from '../i18n/i18n.js'

// ── 分层规则：全局（设置里的「全局自定义规则」）→ 分组 → 主机 → 工作目录（AGENTS.md / .lingshell/rules.md）──
// 分组 / 主机规则存 <配置目录>/rules.json（见 desktop/main/ai/safetyIpc.ts）；只注入本会话用到过的主机的规则
export interface LayerRules { groups: Record<string, string>; hosts: Record<string, string> }
export const RULE_TEXT_MAX = 4000        // 单条规则保存上限（字）
export const RULE_BLOCK_MAX = 1500       // 注入时单层上限
export const RULES_INJECT_MAX = 6000     // 注入总上限
/** 会话工作目录里会读的规则文件（相对工作目录） */
export const WORKDIR_RULE_FILES = ['AGENTS.md', '.lingshell/rules.md']

export type RuleLayerKind = 'group' | 'host' | 'workdir'
export interface RuleLayer { kind: RuleLayerKind; label: string; text: string }

/** 保存前规整：去首尾空白，超长截断 */
export function normalizeRuleText(s: unknown): string {
  return typeof s === 'string' ? s.trim().slice(0, RULE_TEXT_MAX) : ''
}

/** 会话用到的主机（+ 工作目录规则文件）→ 各层规则，顺序：分组 → 主机 → 工作目录（空的不出） */
export function ruleLayersFor(rules: LayerRules, hosts: { hostKey: string; label: string; group?: string }[], workdir: { file: string; text: string }[] = []): RuleLayer[] {
  const groups = [...new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))]
  return [
    ...groups.map((g) => ({ kind: 'group' as const, label: `分组「${g}」`, text: rules.groups[g] ?? '' })),   // i18n-ignore 注入系统提示的规则段
    ...hosts.map((h) => ({ kind: 'host' as const, label: `主机「${h.label}」`, text: rules.hosts[h.hostKey] ?? '' })),   // i18n-ignore 注入系统提示的规则段
    ...workdir.map((w) => ({ kind: 'workdir' as const, label: `工作目录 ${w.file}`, text: w.text })),   // i18n-ignore 注入系统提示的规则段
  ].filter((l) => l.text.trim())
}

const RANK: Record<RuleLayerKind, number> = { workdir: 3, host: 2, group: 1 }

/**
 * 注入系统提示的「分层规则」段。每层截到 RULE_BLOCK_MAX；总长超 limit 时优先保留更具体的层（工作目录 > 主机 > 分组），
 * 放不下的只列名字。没有任何规则返回 ''
 */
export function buildLayeredRules(layers: RuleLayer[], limit = RULES_INJECT_MAX): string {
  if (!layers.length) return ''
  const head = '## 分层规则（用户为分组 / 主机 / 工作目录写的规则，必须遵守）\n'   // i18n-ignore 注入系统提示的规则段
    + '规则按「全局 → 分组 → 主机 → 工作目录」叠加：全局规则（如有）见上文「用户自定义规则」；越具体的层级优先，冲突时以更具体的为准。规则只约束你的做法，不代表用户已授权任何操作。\n'   // i18n-ignore 注入系统提示的规则段
  const blocks = layers.map((l) => {
    const t = l.text.trim()
    const body = t.length > RULE_BLOCK_MAX ? `${t.slice(0, RULE_BLOCK_MAX)}\n…（已截断）` : t   // i18n-ignore 注入系统提示的规则段
    return `\n### ${l.label}\n${body}\n`
  })
  const order = layers.map((_, i) => i).sort((a, b) => RANK[layers[b].kind] - RANK[layers[a].kind] || a - b)
  const keep = new Set<number>()
  let len = head.length
  for (const i of order) if (len + blocks[i].length <= limit) { keep.add(i); len += blocks[i].length }
  let out = head + blocks.filter((_, i) => keep.has(i)).join('')
  const skipped = layers.filter((_, i) => !keep.has(i))
  if (skipped.length) out += `\n（另有 ${skipped.length} 层规则因篇幅未展开：${skipped.map((l) => l.label).join('、').slice(0, 300)}）\n`   // i18n-ignore 注入系统提示的规则段
  return out.trimEnd()
}

// ── AI 复核：高风险命令弹授权卡前，先让第二个模型（可选更便宜的配置）审一遍 ──
export type AiReviewScope = 'prodWrite' | 'dangerous' | 'allWrite'
export type AiReviewVerdict = 'safe' | 'risky' | 'block' | 'unreviewed'
export interface AiReviewSettings {
  enabled: boolean
  profileId?: string        // 复核用的模型配置；空 = 默认配置
  scope: AiReviewScope
  onBlock: 'deny' | 'warn'  // 复核判「拦截」：直接拒绝并告诉主 AI / 只在授权卡上提示
  autoAllowSafe: boolean    // 非生产 + 信任档「确认」时：复核判「安全」就自动放行（危险命令除外）
}
export const DEFAULT_AI_REVIEW: AiReviewSettings = { enabled: false, scope: 'prodWrite', onBlock: 'deny', autoAllowSafe: false }
export const AI_REVIEW_SCOPES: { id: AiReviewScope; label: string }[] = [
  { id: 'prodWrite', label: tk('生产主机的写命令') }, { id: 'dangerous', label: tk('所有危险命令') }, { id: 'allWrite', label: tk('所有写命令') },
]
export const AI_REVIEW_TIMEOUT_MS = 15_000
export interface AiReviewResult { verdict: AiReviewVerdict; reason: string; model?: string }
export const REVIEW_VERDICT_LABEL: Record<AiReviewVerdict, string> = { safe: tk('review|安全'), risky: tk('review|风险'), block: tk('建议拦截'), unreviewed: tk('未复核') }
export const REVIEW_DECISION = 'deny:ai_review'   // 复核拦截的执行记录 decision 前缀

/** 这条命令在不在复核范围内 */
export function aiReviewApplies(scope: AiReviewScope, c: { prod: boolean; write: boolean; dangerous: boolean }): boolean {
  if (scope === 'allWrite') return c.write || c.dangerous
  if (scope === 'dangerous') return c.dangerous
  return c.prod && (c.write || c.dangerous)
}

const VERDICT_ALIAS: Record<string, AiReviewVerdict> = { safe: 'safe', ok: 'safe', allow: 'safe', risky: 'risky', risk: 'risky', warn: 'risky', block: 'block', deny: 'block', reject: 'block' }

/** 复核模型的回复 → 结果。容忍代码块包裹 / 前后废话；认不出就是「未复核」（按没复核处理，不放行也不拦） */
export function parseReviewReply(text: string): AiReviewResult {
  const objs = text.match(/\{[^{}]*\}/g) ?? []
  for (const raw of objs.reverse()) {
    try {
      const j = JSON.parse(raw) as { verdict?: unknown; reason?: unknown }
      const v = VERDICT_ALIAS[String(j.verdict ?? '').trim().toLowerCase()]
      if (v) return { verdict: v, reason: String(j.reason ?? '').trim().slice(0, 200) || tr('（未给理由）') }
    } catch { /* 下一个 */ }
  }
  return { verdict: 'unreviewed', reason: tr('复核模型没有按格式回复') }
}

export type AiReviewAction = 'deny' | 'allow' | 'ask'
/**
 * 复核结果 → 怎么处理：block 且设置为拦截 → 直接拒绝；safe 只在「非生产 + 信任档确认 + 开了自动放行 + 不是危险命令」时自动放行；
 * 其余一律照常弹授权卡（卡上带复核徽标）。生产主机上 safe 也要人确认
 */
export function reviewAction(r: AiReviewResult, o: { onBlock: 'deny' | 'warn'; autoAllowSafe: boolean; prod: boolean; trust: TrustLevel; dangerous: boolean }): AiReviewAction {
  if (r.verdict === 'block' && o.onBlock === 'deny') return 'deny'
  if (r.verdict === 'safe' && o.autoAllowSafe && !o.prod && o.trust === 'confirm' && !o.dangerous) return 'allow'
  return 'ask'
}

export interface ReviewPromptInput {
  tool: string; command: string; diff?: string; explain?: string; rollback?: string
  hosts: { label: string; env?: string }[]
  context: string           // 会话最近上下文摘要
  rules: string             // 这些主机适用的分层规则（已截断）
  knowledge: string[]       // 这些主机的知识卡标题
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（已截断）` : s)   // i18n-ignore 发给复核模型的提示词

/** 复核请求的系统提示 + 用户内容（一次性调用，不带工具） */
export function buildReviewPrompt(i: ReviewPromptInput): { system: string; user: string } {
  const system = '你是运维变更的第二审核人（双人复核）。另一个 AI 助手准备在服务器上执行下面的操作，请独立判断风险，不要轻信它的说明。\n'   // i18n-ignore 发给复核模型的提示词
    + '只输出一个 JSON 对象，不要输出其它任何内容：{"verdict":"safe|risky|block","reason":"一句中文理由，60 字以内"}\n'   // i18n-ignore 发给复核模型的提示词
    + 'safe = 只读，或影响很小、可轻松撤销；risky = 有实际影响，需要人仔细确认（重启 / 停止服务、改配置、装删软件包、删除可恢复的数据等）；'   // i18n-ignore 发给复核模型的提示词
    + 'block = 明显危险或不该做：违反下面的主机规则、与用户的意图不符、不可逆的破坏（删库、清空磁盘、rm -rf 关键目录、关闭防火墙 / SSH 等）、生产主机上没有回滚办法的重大变更。'   // i18n-ignore 发给复核模型的提示词
  const hosts = i.hosts.map((h) => `${h.label}${h.env === 'prod' ? '（生产）' : h.env === 'test' ? '（测试）' : ''}`).join('、') || '本地'   // i18n-ignore 发给复核模型的提示词
  const parts = [
    `主机：${hosts}`,   // i18n-ignore 发给复核模型的提示词
    `工具：${i.tool}`,   // i18n-ignore 发给复核模型的提示词
    `要执行的操作：\n${clip(i.command, 2000)}`,   // i18n-ignore 发给复核模型的提示词
    i.diff ? `文件改动（diff）：\n${clip(i.diff, 2000)}` : '',   // i18n-ignore 发给复核模型的提示词
    i.explain ? `执行方 AI 的说明：${clip(i.explain, 300)}` : '',   // i18n-ignore 发给复核模型的提示词
    i.rollback ? `执行方给的回滚命令：\n${clip(i.rollback, 600)}` : '',   // i18n-ignore 发给复核模型的提示词
    i.rules.trim() ? `适用的主机规则：\n${clip(i.rules.trim(), 2500)}` : '适用的主机规则：（无）',   // i18n-ignore 发给复核模型的提示词
    i.knowledge.length ? `该主机的知识卡（标题）：${i.knowledge.slice(0, 20).join('；')}` : '',   // i18n-ignore 发给复核模型的提示词
    i.context.trim() ? `会话最近的上下文（摘要）：\n${clip(i.context.trim(), 1500)}` : '',   // i18n-ignore 发给复核模型的提示词
  ]
  return { system, user: parts.filter(Boolean).join('\n\n') }
}

// ── 预演模式（只说不做）：方案步骤卡片 ──
// AI 在预演模式下调 propose_plan：不弹审批卡，工具结果带 preview=true 与步骤，界面在回复末尾显示可勾选的「方案步骤」
export interface PreviewPlan { title: string; steps: (PlanStep & { hostKey?: string; dangerous?: boolean })[] }

/** propose_plan 的工具结果 → 预演方案（不是预演结果返回 undefined） */
export function previewPlanOf(output: string | undefined): PreviewPlan | undefined {
  try {
    const j = JSON.parse(output ?? '') as { preview?: unknown; title?: unknown; steps?: unknown }
    if (j?.preview !== true || !Array.isArray(j.steps)) return undefined
    const steps = (j.steps as PreviewPlan['steps']).filter((s) => typeof s?.terminal_id === 'string' && typeof s?.command === 'string' && s.command.trim())
    return steps.length ? { title: String(j.title ?? tr('方案')), steps } : undefined
  } catch { return undefined }
}

/** AI 没调 propose_plan 时的兜底：回复里 bash / sh / shell 代码块的每一行命令当一步（没有终端，执行时交给 AI 照常授权） */
export function codeBlockSteps(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/```(?:bash|sh|shell|console)\s*\n([\s\S]*?)```/g)) {
    for (const line of m[1].split('\n')) {
      const c = line.replace(/^\s*\$\s+/, '').trim()
      if (c && !c.startsWith('#')) out.push(c)
    }
  }
  return out.slice(0, 30)
}

/** 「执行选中步骤」发给 AI 的那条消息 */
export function previewRunMessage(title: string, steps: { terminal_id?: string; command: string; purpose?: string; path?: string }[]): string {
  const lines = steps.map((s, i) => `${i + 1}. ${s.terminal_id ? `[${s.terminal_id}] ` : ''}${s.path ? `写文件 ${s.path}` : s.command}${s.purpose ? `  —— ${s.purpose}` : ''}`)   // i18n-ignore 发给 AI 的话
  const planned = steps.every((s) => s.terminal_id)
  return `预演结束，请执行「${title}」中我勾选的 ${steps.length} 步：\n${lines.join('\n')}\n\n`   // i18n-ignore 发给 AI 的话
    + (planned ? '这些步骤已作为批准的计划，按顺序执行，命令必须与上面逐字一致（一步一次调用），不要执行未列出的写操作；某步失败就停下来告诉我。'   // i18n-ignore 发给 AI 的话
      : '请按顺序执行，每步照常走授权；某步失败就停下来告诉我。')   // i18n-ignore 发给 AI 的话
}

// ── sudo 限时提权：授权卡上「本主机 N 分钟内允许提权」，期间同主机需要 root 的命令不再弹卡（危险命令 / 规则询问仍问）──
export const SUDO_LEASE_MINUTES = [5, 15, 60] as const
export const SUDO_LEASE_DEFAULT = 15
export interface SudoLease { hostKey: string; until: number }   // until：到期时间 epoch ms

const ELEVATORS = new Set(['sudo', 'doas', 'pkexec', 'su', 'run0'])
/** 需要提权：任一命令段以 sudo / doas / pkexec / su / run0 开头（跳过 VAR=x 前缀），或以 root 登录执行写命令 */
export function needsElevation(command: string | undefined, o: { rootUser?: boolean; readOnly?: boolean } = {}): boolean {
  if (!command?.trim()) return false
  for (const seg of splitCommand(command)) {
    const words = seg.trim().replace(/^[({\s]+/, '').split(/\s+/).filter((w) => !/^\w+=/.test(w))
    if (ELEVATORS.has(words[0]?.replace(/^.*\//, '') ?? '')) return true
  }
  return !!o.rootUser && !o.readOnly
}

/** 剩余时间（给人看）：「12 分 05 秒」 */
export function leaseRemainText(until: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((until - now) / 1000))
  return tr('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') })
}
export const SUDO_LEASE_RULE = '限时提权'   // i18n-ignore 存进执行记录的规则名（期间免卡放行的执行记录里「按规则：限时提权」）

/**
 * 限时提权叠到授权决策上：期内（active）、命令需要提权（elevation）、原本只是因为首次 / 确认档要问 → 免卡放行（标「限时提权」）。
 * 危险命令、命中「总是询问」规则的照问；拒绝的照拒
 */
export function applySudoLease<D extends { kind: string; reason?: string; rule?: string }>(d: D, o: { active: boolean; elevation: boolean }): D | { kind: 'allow'; rule: string } {
  if (d.kind === 'prompt' && o.active && o.elevation && d.reason !== 'dangerous_command' && !d.rule) return { kind: 'allow', rule: SUDO_LEASE_RULE }
  return d
}
