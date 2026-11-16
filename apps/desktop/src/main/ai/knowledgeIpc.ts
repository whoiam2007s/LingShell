// 主机知识库（见 shared/ai/knowledge.ts、config/KnowledgeStore.ts）：
//  - IPC：knowledge:list / save / remove（知识库视图、AI 提议卡片的「保存」）
//  - 给引擎用：context（会话用到的主机 → 注入文本）、titles（list_terminals 带的卡片标题）、propose（AI 提议 → 卡片草稿）
// 每次读之前先把旧「主机备注」/ 本机备注同步成卡片（向后兼容；备注没变时不写盘）。
import { KnowledgeStore } from '@lingshell/config'
import {
  buildKnowledgeContext, normalizeKnowledge, knowledgeScopeText, KNOWLEDGE_CATEGORIES,
  buildConsolidatePrompt, countAfter, parseConsolidateReply, validateConsolidateActions,
  type ConsolidateAction, type ConsolidatePlan,
  type HostSummary, type KnowledgeCard, type KnowledgeHost, type KnowledgeInput, type KnowledgeCategory, tr,
} from '@lingshell/shared'

export interface ProposalReq { cardId?: string; scope?: KnowledgeInput['scope']; target?: string; title: string; content: string; category?: string }
export interface Proposal { draft: KnowledgeInput; targetLabel: string; previous?: { title: string; content: string } }

/** 知识库里的「主机」：已保存主机 + 本机 */
export function knowledgeHosts(hosts: HostSummary[]): KnowledgeHost[] {
  return [{ hostKey: 'local', label: tr('本机') }, ...hosts.map((h) => ({ hostKey: h.id, label: h.label, ...(h.group ? { group: h.group } : {}) }))]
}

/**
 * AI 的提议 → 卡片草稿：带 card_id 时沿用原卡归属（没另给的话）；校验主机 / 分组 / 卡片存在。
 * 纯函数，抛出的错误原样进模型
 */
export function buildProposal(cards: KnowledgeCard[], hosts: KnowledgeHost[], req: ProposalReq): Proposal {
  const existing = req.cardId ? cards.find((c) => c.id === req.cardId) : undefined
  if (req.cardId && !existing) throw new Error(`知识卡不存在：${req.cardId}（新建请不要填 card_id）`)   // i18n-ignore 报错原样进模型
  const scope = req.scope ?? existing!.scope
  const target = req.scope ? req.target ?? '' : existing!.target
  if (scope === 'host' && !hosts.some((h) => h.hostKey === target)) {
    throw new Error(target.includes(':') ? '该终端连的是未保存的临时主机，无法记入知识库；可提示用户先把它保存为主机' : `主机不存在：${target}`)   // i18n-ignore 报错原样进模型
  }
  if (scope === 'group' && !hosts.some((h) => h.group === target)) {
    const groups = [...new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))]
    throw new Error(`分组不存在：${target}（现有分组：${groups.join('、') || '无'}）`)   // i18n-ignore 报错原样进模型
  }
  const category: KnowledgeCategory = KNOWLEDGE_CATEGORIES.some((c) => c.id === req.category) ? req.category as KnowledgeCategory : existing?.category ?? 'other'
  const draft = normalizeKnowledge({ ...(existing ? { id: existing.id } : {}), scope, target, title: req.title, content: req.content, category, source: 'ai' })
  const label = (k: string) => hosts.find((h) => h.hostKey === k)?.label
  return { draft, targetLabel: knowledgeScopeText(draft, label), ...(existing ? { previous: { title: existing.title, content: existing.content } } : {}) }
}

export function registerKnowledge(d: {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string
  hosts: () => HostSummary[]
  localNotes: () => string
  /** 调一次模型（梳理用）；缺省 = 不提供梳理功能 */
  complete?(system: string, user: string, signal: AbortSignal, source: string): Promise<string>
}) {
  const store = new KnowledgeStore(d.dir)
  const cards = (): KnowledgeCard[] => {
    try { store.syncLegacy([{ hostKey: 'local', notes: d.localNotes() }, ...d.hosts().map((h) => ({ hostKey: h.id, notes: h.notes }))]) } catch { /* 同步失败不影响读 */ }
    return store.list()
  }
  d.handle('knowledge:list', () => cards())
  d.handle('knowledge:save', (_e, input) => store.save(input as KnowledgeInput))
  d.handle('knowledge:remove', (_e, id) => { if (typeof id === 'string') store.delete(id) })
  // 梳理：把全部卡片交给模型，产出合并 / 更新 / 删除清单（不落库，交界面勾选）
  d.handle('knowledge:consolidate', async (_e, trigger) => {
    if (!d.complete) throw new Error(tr('这台机器上没有可用的模型通道，无法梳理'))
    const all = cards()
    if (all.length < 2) throw new Error(tr('至少要有 2 张卡才值得整理'))
    const hosts = knowledgeHosts(d.hosts())
    const { system, user } = buildConsolidatePrompt(all, (k) => hosts.find((h) => h.hostKey === k)?.label ?? k)
    const ac = new AbortController()
    const text = await d.complete(system, user, ac.signal, 'knowledge-consolidate')
    const parsed = parseConsolidateReply(text)
    if (parsed.error || !parsed.actions) throw new Error(parsed.error ?? tr('模型没有给出整理清单'))
    const errs = validateConsolidateActions(parsed.actions, all)
    if (errs.length) throw new Error(tr('模型给的整理清单不合法：{err}', { err: errs.slice(0, 5).join('；') }))   // i18n-ignore 列表分隔符（中文分号）
    const plan: ConsolidatePlan = {
      trigger: trigger === 'size' || trigger === 'schedule' ? trigger : 'manual',
      before: all.length,
      after: countAfter(parsed.actions, all.length),
      actions: parsed.actions,
    }
    return plan
  })
  // 应用清单：用户勾选后的动作一次性写回（全部校验通过才动，避免半途失败留下脏数据）
  d.handle('knowledge:consolidateApply', (_e, actions) => {
    const list = Array.isArray(actions) ? (actions as ConsolidateAction[]) : []
    if (!list.length) return { applied: 0 }
    const all = cards()
    const errs = validateConsolidateActions(list, all)
    if (errs.length) throw new Error(tr('清单不合法：{err}', { err: errs.slice(0, 5).join('；') }))   // i18n-ignore 列表分隔符（中文分号）
    const byId = new Map(all.map((c) => [c.id, c]))
    let applied = 0
    for (const a of list) {
      const patchOf = () => ({
        ...(a.category ? { category: a.category } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        ...(a.target !== undefined ? { target: a.target } : {}),
      })
      if (a.kind === 'drop') {
        store.delete(a.ids[0])
        applied++
        continue
      }
      const first = byId.get(a.ids[0])
      if (!first) continue
      if (a.kind === 'update') {
        store.save({ ...first, title: a.title ?? first.title, content: a.content ?? first.content, ...patchOf() })
        applied++
        continue
      }
      // merge：先建合并后的新卡，再删掉被合并的旧卡
      store.save({ ...first, id: undefined, title: a.title ?? first.title, content: a.content ?? first.content, ...patchOf() })
      for (const id of a.ids) store.delete(id)
      applied++
    }
    return { applied }
  })
  return {
    context: (hostKeys: string[]) => {
      const all = knowledgeHosts(d.hosts())
      // 只用到了临时主机（未保存）：没有主机 / 分组卡，全局卡照样给
      return hostKeys.length ? buildKnowledgeContext(cards(), all.filter((h) => hostKeys.includes(h.hostKey))) : ''
    },
    titles: (hostKey: string) => cards().filter((c) => c.scope === 'host' && c.target === hostKey).map((c) => c.title),
    propose: (req: ProposalReq) => buildProposal(cards(), knowledgeHosts(d.hosts()), req),
  }
}
