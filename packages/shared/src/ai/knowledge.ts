// ── 主机知识库：每台主机 / 每个分组 / 全局 多条知识卡（越用越懂你的服务器）──────
// 存储见 packages/config/src/KnowledgeStore.ts；AI 经 propose_host_knowledge 提议、用户确认后保存；
// 会话用到某台主机后，该主机 + 所属分组 + 全局的卡片注入系统提示（buildKnowledgeContext）。

import { tk, tr } from '../i18n/i18n.js'

export type KnowledgeScope = 'host' | 'group' | 'global'
export type KnowledgeCategory = 'deploy' | 'logs' | 'ops' | 'issue' | 'other'
export type KnowledgeSource = 'ai' | 'manual'

export const KNOWLEDGE_CATEGORIES: { id: KnowledgeCategory; label: string }[] = [
  { id: 'deploy', label: tk('部署') }, { id: 'logs', label: tk('日志位置') }, { id: 'ops', label: tk('启停方式') },
  { id: 'issue', label: tk('已知问题') }, { id: 'other', label: tk('其他') },
]
export const knowledgeCategoryLabel = (c: string) => KNOWLEDGE_CATEGORIES.find((x) => x.id === c)?.label ?? tk('其他')

export interface KnowledgeCard {
  id: string
  scope: KnowledgeScope
  target: string            // host：hostKey（'local' = 本机 / 已保存主机 id）；group：分组名；global：''
  title: string
  content: string           // Markdown
  category: KnowledgeCategory
  updatedAt: string         // ISO
  source: KnowledgeSource
}
export type KnowledgeInput = Omit<KnowledgeCard, 'id' | 'updatedAt'> & { id?: string }

export const KNOWLEDGE_TITLE_MAX = 80
export const KNOWLEDGE_CONTENT_MAX = 8000
export const KNOWLEDGE_CONTEXT_LIMIT = 4000   // 注入系统提示的总字数上限
const CARD_CONTEXT_MAX = 1500                 // 单张卡注入时的正文上限

/** 保存前校验规整：标题 / 内容必填，分类非法回落「其他」；scope 与 target 要配得上 */
export function normalizeKnowledge(input: KnowledgeInput): KnowledgeInput {
  const scope: KnowledgeScope = input.scope === 'group' || input.scope === 'global' ? input.scope : 'host'
  const target = scope === 'global' ? '' : String(input.target ?? '').trim()
  if (scope !== 'global' && !target) throw new Error(scope === 'host' ? tr('请选择主机') : tr('请选择分组'))
  const title = String(input.title ?? '').trim().slice(0, KNOWLEDGE_TITLE_MAX)
  const content = String(input.content ?? '').trim()
  if (!title) throw new Error(tr('标题不能为空'))
  if (!content) throw new Error(tr('内容不能为空'))
  if (content.length > KNOWLEDGE_CONTENT_MAX) throw new Error(tr('内容太长（上限 {max} 字）', { max: KNOWLEDGE_CONTENT_MAX }))
  const category = KNOWLEDGE_CATEGORIES.some((c) => c.id === input.category) ? input.category : 'other'
  return { ...(input.id ? { id: input.id } : {}), scope, target, title, content, category, source: input.source === 'ai' ? 'ai' : 'manual' }
}

/** 一台主机的身份：hostKey + 名字 + 分组（本机没有分组） */
export interface KnowledgeHost { hostKey: string; label: string; group?: string }

const byTime = (a: KnowledgeCard, b: KnowledgeCard) => b.updatedAt.localeCompare(a.updatedAt)

/** 与这些主机相关的卡：主机卡 → 所属分组卡 → 全局卡，各段内按更新时间新的在前 */
export function relevantCards(cards: KnowledgeCard[], hosts: KnowledgeHost[]): KnowledgeCard[] {
  const keys = new Set(hosts.map((h) => h.hostKey))
  const groups = new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))
  return [
    ...cards.filter((c) => c.scope === 'host' && keys.has(c.target)).sort(byTime),
    ...cards.filter((c) => c.scope === 'group' && groups.has(c.target)).sort(byTime),
    ...cards.filter((c) => c.scope === 'global').sort(byTime),
  ]
}

/** 卡片挂在哪：给人 / 给模型看的一句 */
export function knowledgeScopeText(c: Pick<KnowledgeCard, 'scope' | 'target'>, hostLabel: (key: string) => string | undefined): string {
  if (c.scope === 'global') return tr('全局')
  if (c.scope === 'group') return tr('分组「{name}」', { name: c.target })
  return tr('主机「{name}」', { name: c.target === 'local' ? tr('qc|本机') : hostLabel(c.target) ?? c.target })
}

/**
 * 注入系统提示的「主机知识库」段：会话用到的主机 → 相关卡片，总长截到 limit 字。
 * 放不下的卡只列标题（AI 需要时可请用户打开知识库，或照常排查）。没有相关卡返回 ''。
 */
export function buildKnowledgeContext(cards: KnowledgeCard[], hosts: KnowledgeHost[], limit = KNOWLEDGE_CONTEXT_LIMIT): string {
  const list = relevantCards(cards, hosts)
  if (!list.length) return ''
  const label = (k: string) => hosts.find((h) => h.hostKey === k)?.label
  const head = '## 主机知识库（用户保存的长期知识，操作前先读并遵守；内容可能过时，与现场不符时以现场为准并提议更新）\n'   // i18n-ignore 注入系统提示的知识库段
  let out = head
  const skipped: KnowledgeCard[] = []
  for (const c of list) {
    const body = c.content.length > CARD_CONTEXT_MAX ? `${c.content.slice(0, CARD_CONTEXT_MAX)}\n…（已截断）` : c.content   // i18n-ignore 注入系统提示的知识库段
    const block = `\n### [${c.id}] ${c.title}（${knowledgeScopeText(c, label)} · ${knowledgeCategoryLabel(c.category)} · ${c.updatedAt.slice(0, 10)}）\n${body}\n`   // i18n-ignore 注入系统提示的知识库段
    if (out.length + block.length > limit) { skipped.push(c); continue }
    out += block
  }
  if (skipped.length) out += `\n（另有 ${skipped.length} 条因篇幅未展开：${skipped.map((c) => `[${c.id}] ${c.title}`).join('；').slice(0, 400)}）\n`   // i18n-ignore 注入系统提示的知识库段
  return out.trimEnd()
}

export interface KnowledgeFilter { scope?: KnowledgeScope; target?: string; category?: KnowledgeCategory; q?: string }

/** 知识库视图的筛选 + 全文搜索（标题 / 内容，空格分词全部命中，不区分大小写），按更新时间新的在前 */
export function filterKnowledge(cards: KnowledgeCard[], f: KnowledgeFilter): KnowledgeCard[] {
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return cards.filter((c) => (!f.scope || c.scope === f.scope)
    && (f.target === undefined || f.scope === 'global' || c.target === f.target)
    && (!f.category || c.category === f.category)
    && words.every((w) => `${c.title}\n${c.content}`.toLowerCase().includes(w)))
    .sort(byTime)
}
