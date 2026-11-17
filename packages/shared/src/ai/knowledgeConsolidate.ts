// i18n-ignore-file 本文件的中文都是给模型看的提示词与校验说明，不进界面翻译
import { KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_TITLE_MAX, type KnowledgeCard, type KnowledgeCategory, type KnowledgeScope } from './knowledge.js'

/**
 * 知识库梳理：让模型对现有卡片做合并 / 更新 / 删除，产出**变更清单**交给用户勾选。
 *
 * 明确不允许「凭空创造」：只有 merge（多张旧卡合成一张）/ update（改写一张）/ drop（删一张）。
 * merge 产生的新内容必须来自被合并的旧卡，不会引入模型自己编的知识。
 */
export type ConsolidateKind = 'merge' | 'update' | 'drop'

export interface ConsolidateAction {
  kind: ConsolidateKind
  /** 涉及的旧卡 id：merge 至少 2 个，update / drop 恰好 1 个 */
  ids: string[]
  /** merge / update 的新标题（drop 不用） */
  title?: string
  /** merge / update 的新内容（drop 不用） */
  content?: string
  category?: KnowledgeCategory
  scope?: KnowledgeScope
  target?: string
  /** 这条改了什么（给用户看的一句话） */
  reason: string
}

export interface ConsolidatePlan {
  /** 为什么触发：manual / size / schedule */
  trigger: 'manual' | 'size' | 'schedule'
  /** 梳理前的卡片数 */
  before: number
  /** 应用全部变更后的卡片数（估算） */
  after: number
  actions: ConsolidateAction[]
}

const SCOPES: readonly KnowledgeScope[] = ['host', 'group', 'global']
const CATEGORIES: readonly KnowledgeCategory[] = ['deploy', 'logs', 'ops', 'issue', 'other']

/** 从模型回复里抠出 JSON（容忍 ```json 包裹和前后废话） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 把模型回复解析成动作列表；解析不出来返回 error */
export function parseConsolidateReply(text: string): { actions?: ConsolidateAction[]; error?: string } {
  const raw = extractJson(text) as { actions?: unknown } | undefined
  if (!raw || !Array.isArray((raw as { actions?: unknown }).actions)) {
    return { error: '模型回复的格式不对（不是 { actions: [...] }），可以再试一次' }
  }
  const actions: ConsolidateAction[] = []
  for (const item of (raw as { actions: unknown[] }).actions) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const kind = String(a.kind ?? '')
    if (kind !== 'merge' && kind !== 'update' && kind !== 'drop') continue
    const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : []
    if (!ids.length) continue
    actions.push({
      kind,
      ids,
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(typeof a.content === 'string' ? { content: a.content } : {}),
      ...(typeof a.category === 'string' && CATEGORIES.includes(a.category as KnowledgeCategory) ? { category: a.category as KnowledgeCategory } : {}),
      ...(typeof a.scope === 'string' && SCOPES.includes(a.scope as KnowledgeScope) ? { scope: a.scope as KnowledgeScope } : {}),
      ...(typeof a.target === 'string' ? { target: a.target } : {}),
      reason: typeof a.reason === 'string' ? a.reason.slice(0, 300) : '',
    })
  }
  // 空清单是**合法结果**（不是异常）：卡片本来就整齐时模型会返回 { actions: [] }，
  // 界面该显示「没发现需要整理的地方」，不该报错（问题 13）
  return { actions }
}

/** 校验动作清单：id 存在、类型匹配、长度不超限；返回错误列表（空=全部合法） */
export function validateConsolidateActions(actions: ConsolidateAction[], cards: KnowledgeCard[]): string[] {
  const byId = new Map(cards.map((c) => [c.id, c]))
  const errs: string[] = []
  const used = new Set<string>()
  for (const a of actions) {
    const label = `#${a.ids.join('+')}（${a.kind}）`
    if (a.kind === 'merge' && a.ids.length < 2) errs.push(`${label}：合并至少要两张卡`)
    if (a.kind !== 'merge' && a.ids.length !== 1) errs.push(`${label}：${a.kind} 只能涉及一张卡`)
    for (const id of a.ids) {
      if (!byId.has(id)) errs.push(`${label}：找不到卡片 ${id}`)
      if (used.has(id)) errs.push(`${label}：卡片 ${id} 被多个动作重复引用`)
      used.add(id)
    }
    if (a.kind !== 'drop') {
      if (!a.title?.trim()) errs.push(`${label}：缺标题`)
      else if (a.title.length > KNOWLEDGE_TITLE_MAX) errs.push(`${label}：标题超过 ${KNOWLEDGE_TITLE_MAX} 字`)
      if (!a.content?.trim()) errs.push(`${label}：缺内容`)
      else if (a.content.length > KNOWLEDGE_CONTENT_MAX) errs.push(`${label}：内容超过 ${KNOWLEDGE_CONTENT_MAX} 字`)
      if (a.scope && !SCOPES.includes(a.scope)) errs.push(`${label}：scope 不合法`)
      if (a.category && !CATEGORIES.includes(a.category)) errs.push(`${label}：category 不合法`)
    }
  }
  return errs
}

/** 应用全部动作后的卡片数（用于确认窗里给用户看） */
export function countAfter(actions: ConsolidateAction[], before: number): number {
  let n = before
  for (const a of actions) n += a.kind === 'merge' ? 1 - a.ids.length : a.kind === 'drop' ? -1 : 0
  return n
}

/** 给模型看的梳理提示词（要求结构化 JSON） */
export function buildConsolidatePrompt(cards: KnowledgeCard[], hostLabel: (key: string) => string): { system: string; user: string } {
  const system = [
    '你是知识库整理助手。用户有一批运维知识卡（主机部署、日志位置、启停方式、已知问题）。',
    '你的任务：找出重复、重叠、过时、可以合并的卡片，输出**变更清单**。',
    '',
    '硬规则：',
    '1. 只能做三种动作：merge（合并多张）、update（改写一张）、drop（删除一张）；',
    '2. **绝不能凭空新增知识**——合并后的内容必须来自被合并的卡片，不能编造原文没有的事实；',
    '3. 宁可少整理，不要把不同主题的卡硬合到一起；',
    '4. 每张卡最多被一个动作引用；',
    `5. 标题不超过 ${KNOWLEDGE_TITLE_MAX} 字，内容不超过 ${KNOWLEDGE_CONTENT_MAX} 字。`,
    '',
    '只输出 JSON，不要解释：',
    '{"actions":[{"kind":"merge","ids":["id1","id2"],"title":"...","content":"...","category":"ops","scope":"host","target":"hostKey","reason":"两张卡都在讲 nginx 日志位置，合并"}]}',
  ].join('\n')

  const body = cards.map((c) => [
    `id: ${c.id}`,
    `范围: ${c.scope}${c.target ? ` / ${c.target}${c.scope === 'host' ? `（${hostLabel(c.target) ?? c.target}）` : ''}` : ''}`,
    `分类: ${c.category}`,
    `标题: ${c.title}`,
    `内容:\n${c.content}`,
  ].join('\n')).join('\n---\n')

  return { system, user: `当前共 ${cards.length} 张卡：\n\n${body}` }
}

// ── 什么时候该自动梳理一次 ──────────────────────────────────────────
/** 卡片攒到这么多就有必要整理（再往上翻起来就累了） */
export const CONSOLIDATE_SIZE_THRESHOLD = 50
/** 距上次梳理超过这么多天，主动提醒一次 */
export const CONSOLIDATE_INTERVAL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 该不该在后台跑一次梳理（只出清单，不动数据）。
 * 纯函数，方便单测：
 *  - 卡片少于 2 张：没必要
 *  - 已经有待处理的清单、且卡片数没变：别重复烧模型钱
 *  - 卡片数到阈值 → 该跑
 *  - 距上次超过 7 天（且卡片数 ≥ 10，太少不值得）→ 该跑
 *  - 从没梳理过且卡片数 ≥ 10 → 该跑（首次建库后攒够一批再整理）
 */
export function shouldConsolidate(o: {
  count: number
  lastAt?: string
  pendingCount?: number
  now?: number
  sizeThreshold?: number
  intervalDays?: number
}): boolean {
  const { count, lastAt, pendingCount, now = Date.now() } = o
  const threshold = o.sizeThreshold ?? CONSOLIDATE_SIZE_THRESHOLD
  const days = o.intervalDays ?? CONSOLIDATE_INTERVAL_DAYS
  if (count < 2) return false
  if (pendingCount !== undefined && pendingCount === count) return false   // 清单还是新的，等用户处理
  if (count >= threshold) return true
  if (count < 10) return false
  const last = lastAt ? Date.parse(lastAt) : NaN
  if (!Number.isFinite(last)) return true
  return now - last >= days * DAY_MS
}
