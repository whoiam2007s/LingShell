// ── 主机记忆库：每台主机 / 每个分组 / 全局 多条记忆卡（越用越懂你的服务器）──────
// 存储见 packages/config/src/MemoryStore.ts；AI 经 propose_host_memory 提议、用户确认后保存；
// 会话用到某台主机后，该主机 + 所属分组 + 全局的卡片注入系统提示（buildMemoryContext）。

import { tk, tr } from '../i18n/i18n.js'

export type MemoryScope = 'host' | 'group' | 'global'
export type MemoryCategory = 'deploy' | 'logs' | 'ops' | 'issue' | 'other'
export type MemorySource = 'ai' | 'manual'

export const MEMORY_CATEGORIES: { id: MemoryCategory; label: string }[] = [
  { id: 'deploy', label: tk('部署') }, { id: 'logs', label: tk('日志位置') }, { id: 'ops', label: tk('启停方式') },
  { id: 'issue', label: tk('已知问题') }, { id: 'other', label: tk('其他') },
]
export const memoryCategoryLabel = (c: string) => MEMORY_CATEGORIES.find((x) => x.id === c)?.label ?? tk('其他')

export interface MemoryCard {
  id: string
  scope: MemoryScope
  target: string            // host：hostKey（'local' = 本机 / 已保存主机 id）；group：分组名；global：''
  title: string
  content: string           // Markdown
  category: MemoryCategory
  updatedAt: string         // ISO
  source: MemorySource
}
export type MemoryInput = Omit<MemoryCard, 'id' | 'updatedAt'> & { id?: string }

export const MEMORY_TITLE_MAX = 80
export const MEMORY_CONTENT_MAX = 2000   // 写入上限：一张卡就是一小块可照做的知识，超了请拆成多张
export const MEMORY_CONTEXT_LIMIT = 4000   // 注入系统提示的总字数上限

/** 保存前校验规整：标题 / 内容必填，分类非法回落「其他」；scope 与 target 要配得上 */
export function normalizeMemory(input: MemoryInput): MemoryInput {
  const scope: MemoryScope = input.scope === 'group' || input.scope === 'global' ? input.scope : 'host'
  const target = scope === 'global' ? '' : String(input.target ?? '').trim()
  if (scope !== 'global' && !target) throw new Error(scope === 'host' ? tr('请选择主机') : tr('请选择分组'))
  const title = String(input.title ?? '').trim().slice(0, MEMORY_TITLE_MAX)
  const content = String(input.content ?? '').trim()
  if (!title) throw new Error(tr('标题不能为空'))
  if (!content) throw new Error(tr('内容不能为空'))
  if (content.length > MEMORY_CONTENT_MAX) throw new Error(tr('内容太长（{n} 字，上限 {max} 字）：只留可照做的结论（命令、路径、判据），细节拆成另一张卡', { n: content.length, max: MEMORY_CONTENT_MAX }))
  const category = MEMORY_CATEGORIES.some((c) => c.id === input.category) ? input.category : 'other'
  return { ...(input.id ? { id: input.id } : {}), scope, target, title, content, category, source: input.source === 'ai' ? 'ai' : 'manual' }
}

/** 一台主机的身份：hostKey + 名字 + 分组（本机没有分组） */
export interface MemoryHost { hostKey: string; label: string; group?: string }

const byTime = (a: MemoryCard, b: MemoryCard) => b.updatedAt.localeCompare(a.updatedAt)

/** 与这些主机相关的卡：主机卡 → 所属分组卡 → 全局卡，各段内按更新时间新的在前 */
export function relevantCards(cards: MemoryCard[], hosts: MemoryHost[]): MemoryCard[] {
  const keys = new Set(hosts.map((h) => h.hostKey))
  const groups = new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))
  return [
    ...cards.filter((c) => c.scope === 'host' && keys.has(c.target)).sort(byTime),
    ...cards.filter((c) => c.scope === 'group' && groups.has(c.target)).sort(byTime),
    ...cards.filter((c) => c.scope === 'global').sort(byTime),
  ]
}

/** 卡片挂在哪：给人 / 给模型看的一句 */
export function memoryScopeText(c: Pick<MemoryCard, 'scope' | 'target'>, hostLabel: (key: string) => string | undefined): string {
  if (c.scope === 'global') return tr('全局')
  if (c.scope === 'group') return tr('分组「{name}」', { name: c.target })
  return tr('主机「{name}」', { name: c.target === 'local' ? tr('qc|本机') : hostLabel(c.target) ?? c.target })
}

/**
 * 注入系统提示的「主机记忆库」段：会话用到的主机 → 相关卡片，总长截到 limit 字。
 * 放不下的卡只列标题（AI 需要时可请用户打开记忆库，或照常排查）。没有相关卡返回 ''。
 */
export function buildMemoryContext(cards: MemoryCard[], hosts: MemoryHost[], limit = MEMORY_CONTEXT_LIMIT): string {
  const list = relevantCards(cards, hosts)
  if (!list.length) return ''
  const label = (k: string) => hosts.find((h) => h.hostKey === k)?.label
  const head = '## 主机记忆库（用户保存的长期知识，操作前先读并遵守；内容可能过时，与现场不符时以现场为准并提议更新）\n'   // i18n-ignore 注入系统提示的记忆库段
  let out = head
  const skipped: MemoryCard[] = []
  // 正文**不截断**（用户定的口径：读的时候给全，写的时候限制 2000 字）：
  // 整张卡放不下时降级成题名行，而不是塞半截内容让模型以为那就是全部
  for (const c of list) {
    const block = `\n### [${c.id}] ${c.title}（${memoryScopeText(c, label)} · ${memoryCategoryLabel(c.category)} · ${c.updatedAt.slice(0, 10)}）\n${c.content}\n`   // i18n-ignore 注入系统提示的记忆库段
    if (out.length + block.length > limit) { skipped.push(c); continue }
    out += block
  }
  if (skipped.length) out += `\n（另有 ${skipped.length} 条因篇幅未展开：${skipped.map((c) => `[${c.id}] ${c.title}`).join('；').slice(0, 400)}）\n`   // i18n-ignore 注入系统提示的记忆库段
  return out.trimEnd()
}

export interface MemoryFilter { scope?: MemoryScope; target?: string; category?: MemoryCategory; q?: string }

/** 记忆库视图的筛选 + 全文搜索（标题 / 内容，空格分词全部命中，不区分大小写），按更新时间新的在前 */
export function filterMemory(cards: MemoryCard[], f: MemoryFilter): MemoryCard[] {
  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return cards.filter((c) => (!f.scope || c.scope === f.scope)
    && (f.target === undefined || f.scope === 'global' || c.target === f.target)
    && (!f.category || c.category === f.category)
    && words.every((w) => `${c.title}\n${c.content}`.toLowerCase().includes(w)))
    .sort(byTime)
}
