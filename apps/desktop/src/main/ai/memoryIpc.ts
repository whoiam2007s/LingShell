// 主机记忆库（见 shared/ai/memory.ts、config/MemoryStore.ts）：
//  - IPC：memory:list / save / remove（记忆库视图、AI 提议卡片的「保存」）
//  - 给引擎用：context（会话用到的主机 → 注入文本）、titles（list_terminals 带的卡片标题）、propose（AI 提议 → 卡片草稿）
//  - 自动梳理：卡片攒够 50 张、或距上次超过 7 天，后台跑一次只出清单（不动数据），
//    结果存 memory-schedule.json，界面在记忆库按钮上提示「有 N 条建议」
// 每次读之前先把旧「主机备注」/ 本机备注同步成卡片（向后兼容；备注没变时不写盘）。
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { MemoryStore } from '@lingshell/config'
import {
  buildMemoryContext, normalizeMemory, MEMORY_CONSOLIDATE_MAX, memoryScopeText, MEMORY_CATEGORIES, CONSOLIDATE_SIZE_THRESHOLD, shouldConsolidate,
  buildConsolidatePrompt, countAfter, parseConsolidateReply, validateConsolidateActions,
  type ConsolidateAction, type ConsolidatePlan,
  type HostSummary, type MemoryCard, type MemoryHost, type MemoryInput, type MemoryCategory, tr,
} from '@lingshell/shared'

export interface ProposalReq { cardId?: string; scope?: MemoryInput['scope']; target?: string; title: string; content: string; category?: string }
export interface Proposal { draft: MemoryInput; targetLabel: string; previous?: { title: string; content: string } }

/** 记忆库里的「主机」：已保存主机 + 本机 */
export function memoryHosts(hosts: HostSummary[]): MemoryHost[] {
  return [{ hostKey: 'local', label: tr('本机') }, ...hosts.map((h) => ({ hostKey: h.id, label: h.label, ...(h.group ? { group: h.group } : {}) }))]
}

/**
 * AI 的提议 → 卡片草稿：带 card_id 时沿用原卡归属（没另给的话）；校验主机 / 分组 / 卡片存在。
 * 纯函数，抛出的错误原样进模型
 */
export function buildProposal(cards: MemoryCard[], hosts: MemoryHost[], req: ProposalReq): Proposal {
  const existing = req.cardId ? cards.find((c) => c.id === req.cardId) : undefined
  if (req.cardId && !existing) throw new Error(`记忆卡不存在：${req.cardId}（新建请不要填 card_id）`)   // i18n-ignore 报错原样进模型
  const scope = req.scope ?? existing!.scope
  const target = req.scope ? req.target ?? '' : existing!.target
  if (scope === 'host' && !hosts.some((h) => h.hostKey === target)) {
    throw new Error(target.includes(':') ? '该终端连的是未保存的临时主机，无法记入记忆库；可提示用户先把它保存为主机' : `主机不存在：${target}`)   // i18n-ignore 报错原样进模型
  }
  if (scope === 'group' && !hosts.some((h) => h.group === target)) {
    const groups = [...new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))]
    throw new Error(`分组不存在：${target}（现有分组：${groups.join('、') || '无'}）`)   // i18n-ignore 报错原样进模型
  }
  const category: MemoryCategory = MEMORY_CATEGORIES.some((c) => c.id === req.category) ? req.category as MemoryCategory : existing?.category ?? 'other'
  const draft = normalizeMemory({ ...(existing ? { id: existing.id } : {}), scope, target, title: req.title, content: req.content, category, source: 'ai' })
  const label = (k: string) => hosts.find((h) => h.hostKey === k)?.label
  return { draft, targetLabel: memoryScopeText(draft, label), ...(existing ? { previous: { title: existing.title, content: existing.content } } : {}) }
}

export function registerMemory(d: {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void
  dir: string
  hosts: () => HostSummary[]
  localNotes: () => string
  /** 调一次模型（梳理用）；缺省 = 不提供梳理功能 */
  complete?(system: string, user: string, signal: AbortSignal, source: string): Promise<string>
  /** 后台梳理出了建议清单（界面可以据此弹个提示）；异步，抛错不影响梳理 */
  onPending?(plan: ConsolidatePlan): void
}) {
  const store = new MemoryStore(d.dir)
  const cards = (): MemoryCard[] => {
    try { store.syncLegacy([{ hostKey: 'local', notes: d.localNotes() }, ...d.hosts().map((h) => ({ hostKey: h.id, notes: h.notes }))]) } catch { /* 同步失败不影响读 */ }
    return store.list()
  }

  // ── 自动梳理的状态（lastAt = 上次梳理时间；pending = 后台产出、等用户确认的清单）──
  type State = { lastAt?: string; pending?: { at: string; plan: ConsolidatePlan } }
  const stateFile = join(d.dir, 'memory-schedule.json')
  const readState = (): State => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) as State } catch { return {} } }
  const writeState = (s: State) => {
    try { mkdirSync(d.dir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(s, null, 2)) } catch { /* 状态存不下不影响主流程 */ }
  }

  /** 一次整理最多等这么久：模型要读完全部卡片，慢模型 / 卡片多时要给足（以前 60 秒，长卡片库经常被掐） */
  const CONSOLIDATE_TIMEOUT_MS = 180_000
  // 同时只跑一路：后台 tick 与手动点击很容易撞在一起，撞上就复用在跑的那次，不并发烧 token
  let inflight: Promise<ConsolidatePlan> | null = null

  // 跑一次梳理（不落库）：手动 / 后台共用。单飞包装在下面（runConsolidate），
  // 先定义 once —— 常量在函数定义处就求值，别让 const 互相前向引用
  const runConsolidateOnce = async (trigger: ConsolidatePlan['trigger']): Promise<ConsolidatePlan> => {
    if (!d.complete) throw new Error(tr('这台机器上没有可用的模型通道，无法梳理'))
    const all = cards()
    if (all.length < 2) throw new Error(tr('至少要有 2 张卡才值得整理'))
    const hosts = memoryHosts(d.hosts())
    const { system, user } = buildConsolidatePrompt(all, (k) => hosts.find((h) => h.hostKey === k)?.label ?? k)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), CONSOLIDATE_TIMEOUT_MS)
    let text: string
    try {
      text = await d.complete(system, user, ac.signal, 'memory-consolidate')
    } catch (e) {
      if (ac.signal.aborted) {
        throw new Error(tr('整理超时（{n} 秒）：卡片较多时可以先删掉几张没用的再试', { n: Math.round(CONSOLIDATE_TIMEOUT_MS / 1000) }), { cause: e })
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
    const parsed = parseConsolidateReply(text)
    if (parsed.error || !parsed.actions) throw new Error(parsed.error ?? tr('模型没有给出整理清单'))
    const errs = validateConsolidateActions(parsed.actions, all)
    if (errs.length) throw new Error(tr('模型给的整理清单不合法：{err}', { err: errs.slice(0, 5).join('；') }))   // i18n-ignore 列表分隔符（中文分号）
    return { trigger, before: all.length, after: countAfter(parsed.actions, all.length), actions: parsed.actions }
  }

  /** 单飞：正在跑就复用同一个 Promise（后台 tick 与手动点击撞上时只发一次模型请求） */
  const runConsolidate = (trigger: ConsolidatePlan['trigger']): Promise<ConsolidatePlan> => {
    if (inflight) return inflight
    inflight = runConsolidateOnce(trigger).finally(() => { inflight = null })
    return inflight
  }

  // 后台那一趟：只出清单、绝不写回（合并 / 删除记忆卡必须用户自己确认）
  let running = false
  const tick = async () => {
    if (running || !d.complete) return
    const st = readState()
    const all = cards()
    if (!shouldConsolidate({ count: all.length, lastAt: st.lastAt, pendingCount: st.pending ? st.pending.plan.before : undefined })) return
    running = true
    try {
      const plan = await runConsolidate(all.length >= CONSOLIDATE_SIZE_THRESHOLD ? 'size' : 'schedule')
      writeState({ lastAt: new Date().toISOString(), ...(plan.actions.length ? { pending: { at: new Date().toISOString(), plan } } : {}) })
      if (plan.actions.length) { try { d.onPending?.(plan) } catch { /* 提示失败不影响结果 */ } }
    } catch { /* 后台失败不打扰用户：下一趟再试 */ } finally { running = false }
  }
  // 启动后 30 秒先看一次（别和启动抢模型），之后每 10 分钟看一次
  const first = d.complete ? setTimeout(() => { void tick() }, 30_000) : undefined
  const every = d.complete ? setInterval(() => { void tick() }, 10 * 60_000) : undefined
  first?.unref?.(); every?.unref?.()

  d.handle('memory:list', () => cards())
  d.handle('memory:save', (_e, input) => store.save(input as MemoryInput))
  d.handle('memory:remove', (_e, id) => { if (typeof id === 'string') store.delete(id) })
  // 后台攒下的待处理清单：界面在记忆库入口显示「有 N 条整理建议」
  d.handle('memory:consolidatePending', () => readState().pending ?? null)
  d.handle('memory:consolidatePendingClear', () => { const st = readState(); writeState({ ...st, pending: undefined }) })
  // 梳理：把全部卡片交给模型，产出合并 / 更新 / 删除清单（不落库，交界面勾选）
  d.handle('memory:consolidate', async (_e, trigger) => {
    const plan = await runConsolidate(trigger === 'size' || trigger === 'schedule' ? trigger : 'manual')
    // 界面手动跑过一次也算「最近梳理过」：清掉后台那份待处理，免得重复提示
    writeState({ lastAt: new Date().toISOString() })
    return plan
  })
  // 应用清单：用户勾选后的动作一次性写回（全部校验通过才动，避免半途失败留下脏数据）
  d.handle('memory:consolidateApply', (_e, actions) => {
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
        store.save({ ...first, title: a.title ?? first.title, content: a.content ?? first.content, ...patchOf() }, MEMORY_CONSOLIDATE_MAX)
        applied++
        continue
      }
      // merge：先建合并后的新卡，再删掉被合并的旧卡（合并后的长度按整理上限写入，不受单卡上限限制）
      store.save({ ...first, id: undefined, title: a.title ?? first.title, content: a.content ?? first.content, ...patchOf() }, MEMORY_CONSOLIDATE_MAX)
      for (const id of a.ids) store.delete(id)
      applied++
    }
    const st = readState()
    writeState({ ...st, lastAt: new Date().toISOString(), pending: undefined })
    return { applied }
  })
  return {
    /** 停掉后台定时器（应用退出时调） */
    stop: () => { if (first) clearTimeout(first); if (every) clearInterval(every) },
    context: (hostKeys: string[], window?: number) => {
      const all = memoryHosts(d.hosts())
      // 注入上限按模型窗口的 2% 算（8K–80K）：大窗口模型多给点，小窗口模型别把上下文吃光
      const limit = Math.min(80_000, Math.max(8_000, Math.floor((window ?? 0) * 0.02)))
      // 只用到了临时主机（未保存）：没有主机 / 分组卡，全局卡照样给
      return hostKeys.length ? buildMemoryContext(cards(), all.filter((h) => hostKeys.includes(h.hostKey)), limit) : ''
    },
    titles: (hostKey: string) => cards().filter((c) => c.scope === 'host' && c.target === hostKey).map((c) => c.title),
    propose: (req: ProposalReq) => buildProposal(cards(), memoryHosts(d.hosts()), req),
  }
}
