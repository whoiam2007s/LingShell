import { useEffect, useRef, useState } from 'react'
import type { AppEvent, ItemKind, ItemStatus, ToolCallInfo, TodoItem, PlanStepView, ApprovalTarget, McpCallView, TurnTimes, MsgAttachment, TurnAttachment } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { logger } from '../../lib/logger.js'

// 对话时间线里的一个可渲染单元（聚合自 agent item 事件）
export interface ConvItem {
  itemId: string
  kind: ItemKind
  status: ItemStatus
  text: string                 // agent_message / agent_reasoning 的累积文本
  tool?: ToolCallInfo          // 工具调用信息
  todos?: TodoItem[]           // todo 清单
  completionPct?: number
  error?: string
  turnId?: string              // 所属 dsh 轮（对回合时间用）
  at?: number                  // 出现时间（用户消息 = 发送时间；工具 = 在模型输出里识别到它的时间），epoch ms；未知不填
  doneAt?: number              // 结束时间（工具 = 拿到结果）
  callAt?: number              // 工具：参数生成完、开始执行的时间
  phase?: 'preparing'          // 工具：模型还在生成参数
  auth?: {                     // Phase 3：授权请求卡片数据
    approvalId: string
    terminalId: string
    needed: 'read' | 'write'
    reason: 'first_access' | 'elevation' | 'dangerous_command'
    risk: 'safe' | 'dangerous'
    tool?: string
    command?: string
    diff?: string              // write_file 的 unified diff
    explain?: string           // AI 对命令的说明
    targets?: ApprovalTarget[] // exec_on_terminals 的全部目标
    mcp?: McpCallView          // MCP 工具调用：服务/工具/参数
    rule?: string              // 命中的命令规则（卡片注明「按规则：…」）
    rollback?: string          // AI 给的回滚命令（与执行命令并排）
    rollbackNote?: string
    rollbackMissing?: boolean  // 变更命令没给回滚方案（标黄）
    review?: import('@lingshell/shared').AiReviewResult   // AI 复核结果（徽标）
    sudo?: boolean             // 需要提权：可选「本主机 N 分钟内允许提权」
    deadlineMs: number
    result?: 'allow' | 'deny' | 'timeout' | 'cancelled'
  }
  plan?: {                     // 计划审批卡片数据（propose_plan）
    approvalId: string
    title: string
    steps: PlanStepView[]
    deadlineMs: number
    result?: 'allow' | 'deny' | 'timeout' | 'cancelled'
  }
  knowledge?: Omit<import('@lingshell/shared').KnowledgeProposalEvent, 'type' | 'sessionId'>   // AI 提议的知识卡（propose_host_knowledge）
  ask?: Omit<import('@lingshell/shared').AskRequestEvent, 'type' | 'sessionId'> & { result?: 'answered' | 'skipped' | 'timeout'; answer?: import('@lingshell/shared').AskAnswer }   // AI 提问卡（ask_user）
  attachments?: MsgAttachment[]   // user_message 带的附件（气泡下方显示）
  msgId?: string               // user_message 的服务端 id（回显 / 回放后才有；编辑重发、分叉、重新生成按它定位）
  steered?: boolean            // user_message：本轮中途插入的追问
}

// 一条消息带的附件：send 发给主进程，view 用于本地乐观气泡显示
export interface OutgoingAttachments { send: TurnAttachment[]; view: MsgAttachment[] }

export type SessionPhase =
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'no-key' }
  | { phase: 'error'; message: string }

// 上下文状态（都不阻塞对话）：compacting=dsh 正在自动压缩（任务照常继续）；compactFailed=这次压缩失败；
// suggest=会话步数已多且压缩过，建议用压缩摘要开新会话（用户可忽略）
export type ContextState =
  | { stage: 'compacting' }
  | { stage: 'compactFailed'; error: string }
  | { stage: 'suggest'; steps: number; compactions: number; summary: string }

const log = logger.scope('chat')

// 多会话对话状态机：每个 sessionId 一份 items + 索引 + busy。activeSessionId 决定渲染哪个会话。
// relay 事件按 e.sessionId 分发到对应会话的 items（与 activeSessionId 无关，后台会话也累积）。
export function useConversation(activeSessionId: string, onFirstUserMessage?: (sid: string, text: string) => void) {
  const itemsMap = useRef<Map<string, ConvItem[]>>(new Map())
  const indexMap = useRef<Map<string, Map<string, number>>>(new Map())  // sessionId → (itemId → idx)
  const busyRef = useRef<Set<string>>(new Set())
  const ctxRef = useRef<Map<string, ContextState>>(new Map())   // sessionId → 上下文超线状态
  const usageRef = useRef<Map<string, { inputTokens: number; limit: number }>>(new Map())   // sessionId → 上下文用量
  // 本轮进行中用户补发的消息（thread 同时只允许一个活跃 turn，发不进去）→ 排队，本轮结束逐条发出。
  // 排队消息不进 items（否则本轮后续步骤会被 groupTurns 归到它名下），由 ChatPanel 在时间线底部单独显示，真正发出时才入 items。
  const queueRef = useRef<Map<string, { text: string; atts?: OutgoingAttachments }[]>>(new Map())
  // 本轮进行中的追问（steering）：已交给 dsh，等当前步骤结束、下一次请求前插进对话。同样不进 items（时间线底部显示「等待插入」，可撤回），
  // 被接纳时 user_message 回显的 itemId = 这里记下的消息 id → 那时才落进时间线（位置就是实际插入点）
  type Steer = { key: string; text: string; atts?: OutgoingAttachments; id?: string }
  const steerRef = useRef<Map<string, Steer[]>>(new Map())
  // 本地已乐观显示、等服务端回显的用户消息（按发送顺序）。服务端 user_message 与队首相同 → 消费并跳过，否则照常显示（历史重放）。
  // id = 乐观气泡的本地 itemId，回显时把服务端 itemId 指到同一条，之后的历史重放（LRU 释放后重连）原地更新而不是再插一条
  const pendingRef = useRef<Map<string, { text: string; id: string }[]>>(new Map())
  // sessionId → 当前活跃 turnId（turnStarted 记录）。结束事件 turnId 对不上（被中断的旧 turn 迟到的 end）→ 不动 busy。
  const turnIdRef = useRef<Map<string, string>>(new Map())
  // sessionId → (turnId → 该轮时间点)，来自 agent:turnTiming（实时与历史回放都有；旧会话可能没有）
  const timesRef = useRef<Map<string, Map<string, TurnTimes>>>(new Map())
  // 用户中断过的 turnId：其迟到的 end 只用来放行排队消息，不清 busy、不出错误气泡（中断时已本地标记）
  const abortedRef = useRef<Set<string>>(new Set())
  // 已点停止、但 turnStarted 还没到（没法按 turnId 标记）：turn 一旦开始就立刻中断
  const stopReqRef = useRef<Set<string>>(new Set())
  // 事件订阅只挂载一次（空依赖），闭包里拿不到最新的 flushQueue → 用 ref 转发
  const flushRef = useRef<(sid: string) => void>(() => {})
  const enqueueRef = useRef<(sid: string, text: string, atts?: OutgoingAttachments) => void>(() => {})
  const [, forceRender] = useState(0)
  const rerender = () => forceRender((n) => n + 1)

  const itemsOf = (sid: string) => itemsMap.current.get(sid) ?? []
  const idxOf = (sid: string): Map<string, number> => {
    let m = indexMap.current.get(sid)
    if (!m) { m = new Map(); indexMap.current.set(sid, m) }
    return m
  }

  // 回合结束（完成 / 失败 / 停止）时，还没处理的授权 / 计划卡片标为已取消：
  // 否则卡片一直显示「等待授权」直到 5 分钟超时，而且多半被收在执行过程里看不见
  const settleCards = (sid: string) => {
    const items = itemsOf(sid)
    let changed = false
    const next = items.map((it) => {
      if (it.status !== 'in_progress') return it
      if (it.kind === 'auth_request' && it.auth && !it.auth.result) {
        changed = true; return { ...it, status: 'failed' as const, auth: { ...it.auth, result: 'cancelled' as const } }
      }
      if (it.kind === 'plan_request' && it.plan && !it.plan.result) {
        changed = true; return { ...it, status: 'failed' as const, plan: { ...it.plan, result: 'cancelled' as const } }
      }
      return it
    })
    if (changed) { itemsMap.current.set(sid, next); rerender() }
  }

  const upsert = (sid: string, partial: ConvItem) => {
    const items = [...itemsOf(sid)]
    const idx = idxOf(sid).get(partial.itemId)
    if (idx === undefined) { idxOf(sid).set(partial.itemId, items.length); items.push(partial) }
    else items[idx] = { ...items[idx], ...partial }
    itemsMap.current.set(sid, items)
    rerender()
  }

  useEffect(() => {
    const off = client.on((ev: AppEvent) => {
      const e = ev
      const sid = 'sessionId' in e ? e.sessionId : undefined
      switch (e.type) {
        case 'agent:turnStarted':
          if (sid) {
            busyRef.current.add(sid); turnIdRef.current.set(sid, e.turnId)
            // 停止按钮在 turnStarted 之前就点了：现在才有 turnId，补标记并再取消一次（第一次 cancel 可能落在 turn 开始前）
            if (stopReqRef.current.delete(sid)) {
              abortedRef.current.add(e.turnId)
              busyRef.current.delete(sid); turnIdRef.current.delete(sid)
              client.agent.interruptTurn(sid).catch(() => {})
            }
            rerender()
          }
          break
        case 'agent:turnCompleted':
        case 'agent:turnFailed': {
          if (!sid) break
          // 用户主动停止（后端标了 stopped）：不算错误、不出错误气泡；只收尾并放行排队消息
          if (e.type === 'agent:turnFailed' && e.stopped) {
            const cur0 = turnIdRef.current.get(sid)
            if (cur0 !== undefined && cur0 !== e.turnId) break
            turnIdRef.current.delete(sid); busyRef.current.delete(sid); stopReqRef.current.delete(sid)
            settleCards(sid); rerender(); flushRef.current(sid); break
          }
          // 被中断的旧 turn 迟到的 end：busy 已在中断时清掉，可能已有新 turn 在跑 → 只放行队列（flushQueue 自己判 busy）
          if (abortedRef.current.delete(e.turnId)) { settleCards(sid); flushRef.current(sid); break }
          // turnId 对不上当前 turn → 旧事件，忽略（当前 turnId 未知时放行，如 turnStarted 之前就失败）
          const cur = turnIdRef.current.get(sid)
          if (cur !== undefined && cur !== e.turnId) break
          turnIdRef.current.delete(sid)
          busyRef.current.delete(sid)
          stopReqRef.current.delete(sid)
          settleCards(sid)
          if (e.type === 'agent:turnFailed') {
            upsert(sid, { itemId: `err_${e.turnId}`, kind: 'agent_message', status: 'failed', text: `⚠️ ${e.error}`, error: e.error })
            // 出错结束：还没插入的追问从引擎撤回，改成排队重发（撤不回 = 已被接纳或已清掉，就不重发，免得重复）
            for (const s of [...(steerRef.current.get(sid) ?? [])]) {
              if (!s.id) continue
              void client.agent.unsteer(sid, s.id).catch(() => false).then((ok) => {
                const l = steerRef.current.get(sid) ?? [], i = l.indexOf(s)
                if (i < 0) return
                l.splice(i, 1)
                if (ok) { enqueueRef.current(sid, s.text, s.atts); flushRef.current(sid) }
                rerender()
              })
            }
          }
          else rerender()
          flushRef.current(sid)
          break
        }
        case 'agent:itemStarted':
          // itemStarted 无 text 字段。user_message 跳过（其文本在 itemUpdated 才来）；
          // 其余 kind 建占位项，text 由后续 delta/updated 填充。
          if (!sid || e.kind === 'user_message') break
          {
            // 工具会先以「生成参数中」出卡、tool/call 时同一 itemId 再来一次：保留先记下的识别时间与名字；phase 每次都显式覆盖（不带 = 已开始执行）
            const idx = idxOf(sid).get(e.itemId)
            const prev = idx === undefined ? undefined : itemsOf(sid)[idx]
            const tool = e.tool && { ...e.tool, name: e.tool.name || prev?.tool?.name || '' }
            upsert(sid, {
              itemId: e.itemId, kind: e.kind, status: e.status, text: '', tool, turnId: e.turnId,
              at: e.at ?? prev?.at, callAt: e.callAt ?? prev?.callAt, phase: e.phase,
              doneAt: undefined,   // 重新开始（如思考块在流出错重试时用同一 itemId 重开）：清掉上次的结束时间
            })
          }
          break
        case 'agent:itemDelta': {
          if (!sid || e.kind === 'user_message') break
          const items = [...itemsOf(sid)]
          const idx = idxOf(sid).get(e.itemId)
          if (idx === undefined) { idxOf(sid).set(e.itemId, items.length); items.push({ itemId: e.itemId, kind: e.kind, status: 'in_progress', text: e.text, turnId: e.turnId, at: e.at }) }
          else items[idx] = { ...items[idx], text: items[idx].text + e.text }
          itemsMap.current.set(sid, items)
          rerender()
          break
        }
        case 'agent:itemUpdated':
          if (!sid) break
          // user_message：实时场景是本地乐观气泡的回显（= 待回显队首）→ 消费并跳过；
          // 否则（重连历史重放等）显示它。按队列配对而非按文本全局去重——重复发的同样文本（如两次「继续」）不会被吞。
          if (e.kind === 'user_message') {
            const txt = e.text ?? ''
            if (!txt && !e.attachments?.length) break
            // 追问被接纳：按消息 id 配对（id 还没回来时按文本），从「等待插入」移进时间线末尾
            const sl = steerRef.current.get(sid)
            const si = sl?.findIndex((x) => x.id === e.itemId) ?? -1
            const sj = si >= 0 ? si : sl?.findIndex((x) => !x.id && x.text.trim() === txt.trim()) ?? -1
            if (sj >= 0) {
              sl!.splice(sj, 1)
              upsert(sid, { itemId: e.itemId, msgId: e.itemId, kind: 'user_message', status: 'completed', text: txt, turnId: e.turnId, at: e.at ?? Date.now(), steered: true, ...(e.attachments?.length ? { attachments: e.attachments } : {}) })
              break
            }
            const pending = pendingRef.current.get(sid)
            if (pending?.length && pending[0].text.trim() === txt.trim()) {
              const local = idxOf(sid).get(pending.shift()!.id)
              if (local !== undefined) {
                idxOf(sid).set(e.itemId, local)
                const items = [...itemsOf(sid)]
                items[local] = { ...items[local], msgId: e.itemId }   // 记下服务端 id（编辑 / 分叉要用）
                itemsMap.current.set(sid, items)
                rerender()
              }
              break
            }
            // 兜底：主进程发送前会把密钥保险箱里的值替换成 {{secret:…}}，回显文本和本地输入对不上。
            // 以前这里不认领 → 这条没有 msgId，后面的每条也都错位重复。带占位符的回显按顺序认领队首。
            if (pending?.length && txt.includes('{{secret:')) {
              const local = idxOf(sid).get(pending.shift()!.id)
              if (local !== undefined) {
                idxOf(sid).set(e.itemId, local)
                const items = [...itemsOf(sid)]
                items[local] = { ...items[local], text: txt, msgId: e.itemId }   // 以脱敏后的服务端文本为准
                itemsMap.current.set(sid, items)
                rerender()
              }
              break
            }
            // 历史重放到已有的同一条（LRU 释放后重连）：保留原来的时间
            const pi = idxOf(sid).get(e.itemId)
            upsert(sid, { itemId: e.itemId, msgId: e.itemId, kind: 'user_message', status: 'completed', text: txt, turnId: e.turnId, at: (pi === undefined ? undefined : itemsOf(sid)[pi]?.at) ?? e.at, ...(e.steered ? { steered: true } : {}), ...(e.attachments?.length ? { attachments: e.attachments } : {}) })
            break
          }
          {
            // 只用有值的字段覆盖：tool/result 带的是 name:''、没有 input，整体替换会把开始时记下的工具名和命令冲掉
            const idx = idxOf(sid).get(e.itemId)
            const prev = idx === undefined ? undefined : itemsOf(sid)[idx]
            const tool = e.tool && { ...prev?.tool, ...e.tool, name: e.tool.name || prev?.tool?.name || '', input: e.tool.input ?? prev?.tool?.input }
            upsert(sid, {
              itemId: e.itemId, kind: e.kind, status: e.status,
              text: e.text || prev?.text || '', tool: tool ?? prev?.tool, todos: e.todos ?? prev?.todos,
              completionPct: e.completionPct ?? prev?.completionPct, error: e.error ?? prev?.error,
              turnId: e.turnId || prev?.turnId, at: prev?.at ?? e.at,
              doneAt: e.status === 'in_progress' ? prev?.doneAt : e.at ?? prev?.doneAt,
              phase: prev?.phase,   // 生成参数时就失败的保留标记（hover 说明用）；正常执行的在 tool/call 时已清掉
            })
          }
          break
        case 'agent:turnTiming': {
          // 只并入有值的字段（开始 / 首次返回 / 结束分几次到）
          const m = timesRef.current.get(e.sessionId) ?? new Map<string, TurnTimes>()
          timesRef.current.set(e.sessionId, m)
          const t = { ...m.get(e.turnId) }
          if (e.startedAt) t.startedAt = e.startedAt
          if (e.firstAt) t.firstAt = e.firstAt
          if (e.endedAt) t.endedAt = e.endedAt
          m.set(e.turnId, t)
          rerender()
          break
        }
        case 'agent:contextUsage':
          usageRef.current.set(e.sessionId, { inputTokens: e.inputTokens, limit: e.limit })
          rerender()
          break
        case 'agent:contextCompacting':
          ctxRef.current.set(e.sessionId, { stage: 'compacting' })
          rerender()
          break
        case 'agent:contextCompacted':
          if (e.error) ctxRef.current.set(e.sessionId, { stage: 'compactFailed', error: e.error })
          else if (ctxRef.current.get(e.sessionId)?.stage === 'compacting') ctxRef.current.delete(e.sessionId)
          rerender()
          break
        case 'agent:resetSuggested':
          ctxRef.current.set(e.sessionId, { stage: 'suggest', steps: e.steps, compactions: e.compactions, summary: e.summary })
          rerender()
          break
        case 'agent:historyUnrecoverable':
          upsert(e.sessionId, {
            itemId: `notice_history_${Date.now()}`, kind: 'system_notice', status: 'completed',
            text: tr('这个会话的历史无法恢复（{reason}），已开一个新的空会话，可以继续对话。', { reason: e.reason }) + (e.path ? tr('原记录保留在 {path}', { path: e.path }) : ''),
          })
          break
        case 'auth:request':
          upsert(e.sessionId, {
            itemId: e.approvalId, kind: 'auth_request', status: 'in_progress', text: '',
            auth: {
              approvalId: e.approvalId, terminalId: e.terminalId, needed: e.needed,
              reason: e.reason, risk: e.risk, tool: e.tool, command: e.command, diff: e.diff,
              explain: e.explain, targets: e.targets, mcp: e.mcp, deadlineMs: e.deadlineMs, rule: e.rule,
              rollback: e.rollback, rollbackNote: e.rollbackNote, rollbackMissing: e.rollbackMissing,
              review: e.review, sudo: e.sudo,
            },
          })
          break
        case 'plan:request':
          upsert(e.sessionId, {
            itemId: e.approvalId, kind: 'plan_request', status: 'in_progress', text: '',
            plan: { approvalId: e.approvalId, title: e.title, steps: e.steps, deadlineMs: e.deadlineMs },
          })
          break
        case 'knowledge:proposal':
          upsert(e.sessionId, {
            itemId: e.proposalId, kind: 'host_note', status: 'completed', text: '',
            knowledge: { proposalId: e.proposalId, draft: e.draft, targetLabel: e.targetLabel, previous: e.previous },
          })
          break
        case 'ask:request': {
          const { type: _t, sessionId: s, ...ask } = e
          upsert(s, { itemId: e.askId, kind: 'ask_request', status: 'in_progress', text: '', ask })
          break
        }
        case 'ask:resolved':
          for (const [s, items] of itemsMap.current) {
            const idx = idxOf(s).get(e.askId)
            if (idx === undefined || !items[idx].ask) continue
            const next = [...items]
            next[idx] = { ...next[idx], status: e.result === 'answered' ? 'completed' : 'failed', ask: { ...next[idx].ask!, result: e.result, answer: e.answer } }
            itemsMap.current.set(s, next)
            rerender()
            break
          }
          break
        case 'auth:resolved': {
          // auth:resolved 不带 sessionId，遍历所有会话找 approvalId
          for (const [s, items] of itemsMap.current) {
            const idx = idxOf(s).get(e.approvalId)
            if (idx === undefined) continue
            const next = [...items]
            const cur = next[idx]
            const status = e.result === 'allow' ? 'completed' : 'failed'
            next[idx] = cur.plan
              ? { ...cur, status, plan: { ...cur.plan, result: e.result } }
              : { ...cur, status, auth: { ...cur.auth!, result: e.result } }
            itemsMap.current.set(s, next)
            rerender()
            break
          }
          break
        }
      }
    })
    return off
  }, [])

  // 本地乐观气泡 + 记入待回显队列（服务端 user_message 回显时据此配对跳过）
  const addUserMessage = (sid: string, text: string, atts?: OutgoingAttachments) => {
    const id = `user_${Date.now()}_${itemsOf(sid).length}`
    upsert(sid, { itemId: id, kind: 'user_message', status: 'completed', text, at: Date.now(), ...(atts?.view.length ? { attachments: atts.view } : {}) })
    const p = pendingRef.current.get(sid) ?? []
    p.push({ text, id })
    pendingRef.current.set(sid, p)
    return id
  }
  // 没发出去（不会有回显）→ 从待回显队列撤掉，否则队首卡住，后面的回显全对不上
  const dropPending = (sid: string, text: string) => {
    const p = pendingRef.current.get(sid)
    const i = p?.findIndex((x) => x.text === text) ?? -1
    if (i >= 0) p!.splice(i, 1)
  }

  // 真正把一段文本发给后端（气泡由调用方负责，这里只管 busy + IPC + 失败气泡）
  // 带附件的走 attachments.send（文件 / 目录路径 + 图片），否则照旧
  const dispatch = (sid: string, text: string, atts?: OutgoingAttachments) => {
    busyRef.current.add(sid)
    rerender()
    log.info('sendTurn', { len: text.length, atts: atts?.send.length ?? 0 })
    ;(atts?.send.length ? client.attachments.send(sid, text, atts.send) : client.agent.sendTurn(sid, text)).catch((err) => {
      busyRef.current.delete(sid)
      dropPending(sid, text)
      rerender()
      log.error('sendTurn failed', { err: String(err?.message ?? err) })
      const msg = /context_full/.test(String(err?.message ?? err))
        ? tr('上下文已满，请先重置会话再继续')
        : tr('发送失败：{msg}', { msg: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
      upsert(sid, { itemId: `senderr_${Date.now()}`, kind: 'agent_message', status: 'failed', text: `⚠️ ${msg}` })
    })
  }

  // 本轮结束后发出排队的补充消息，一次一条（下一轮结束再发下一条）。
  // 不合并成一条：合并后的文本与本地任何一个气泡都对不上，历史重放的 user_message 去重会失效、多出一条。
  // 延一拍再发：让同一批事件（turn 结束等）先落地再判断 busy
  const flushQueue = (sid: string) => {
    if (!queueRef.current.get(sid)?.length) return
    setTimeout(() => {
      const q = queueRef.current.get(sid)
      if (!q?.length || busyRef.current.has(sid)) return
      const next = q.shift()!
      if (!q.length) queueRef.current.delete(sid)
      addUserMessage(sid, next.text, next.atts)
      dispatch(sid, next.text, next.atts)
    }, 0)
  }
  flushRef.current = flushQueue

  // 返回 false 表示没收下（调用方据此保留输入框内容，不清空）。atts：本条带的附件（可以只有附件没有文字）
  // opts.queue：本轮在跑时不插入，排到本轮结束后作为新一轮发出（Alt+Enter）
  const send = (text: string, atts?: OutgoingAttachments, opts?: { queue?: boolean }): boolean => sendTo(activeSessionId, text, atts, opts)
  const enqueue = (sid: string, text: string, atts?: OutgoingAttachments) => {
    const q = queueRef.current.get(sid) ?? []
    q.push({ text, atts })
    queueRef.current.set(sid, q)
  }
  enqueueRef.current = enqueue
  // 发到指定会话（编辑重发：分叉出新会话后，界面切换还没生效时就要发）
  const sendTo = (sid: string, text: string, atts?: OutgoingAttachments, opts?: { queue?: boolean }): boolean => {
    if ((!text.trim() && !atts?.send.length) || !sid) return false
    if (busyRef.current.has(sid)) {
      // 本轮还在跑：默认作为追问在下一步前插入；Alt+Enter 排队到本轮结束
      if (opts?.queue) { enqueue(sid, text, atts); rerender(); return true }
      const s: Steer = { key: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, text, atts }
      steerRef.current.set(sid, [...(steerRef.current.get(sid) ?? []), s])
      rerender()
      client.agent.steer(sid, text, atts?.send.length ? atts.send : undefined).then((id) => { s.id = id; rerender() }, (err) => {
        // 插不进去（引擎不支持等）：退回排队，本轮结束后照常发出，不丢
        log.warn('steer failed, fallback to queue', { err: String(err?.message ?? err) })
        const l = steerRef.current.get(sid) ?? []
        const i = l.indexOf(s)
        if (i >= 0) { l.splice(i, 1); enqueue(sid, text, atts); if (!busyRef.current.has(sid)) flushQueue(sid) }
        rerender()
      })
      return true
    }
    const isFirst = itemsOf(sid).length === 0
    addUserMessage(sid, text, atts)
    // 首条用户消息用作会话标题。放在显示消息之后、且脱离当前同步流（命名会触发 App
    // refreshSessions→setSessions 重渲染，若在 addUserMessage 前同步触发会吞掉首条乐观气泡）。
    if (isFirst) queueMicrotask(() => onFirstUserMessage?.(sid, text.trim() || atts?.view[0]?.name || tr('附件')))
    dispatch(sid, text, atts)
    return true
  }

  // 上下文重置：用交接总结开一个新 thread。旧对话在新 thread 里不存在，本地也一并清空。
  const resetContext = (summary: string) => {
    const sid = activeSessionId
    if (!sid || busyRef.current.has(sid)) return   // 本轮执行中不重置：会杀掉进行中的任务并丢掉排队 / 追问
    ctxRef.current.delete(sid)
    usageRef.current.delete(sid)
    queueRef.current.delete(sid)
    steerRef.current.delete(sid)
    clearSession(sid)
    // 只有真会发出 seed 才置 busy——否则 seed 为空时没有 turn 来把 busy 清掉，输入框永久锁死
    if (summary.trim()) { busyRef.current.add(sid); addUserMessage(sid, summary) }
    rerender()
    client.agent.resetContext(sid, summary).catch((err) => {
      busyRef.current.delete(sid)
      dropPending(sid, summary)
      rerender()
      log.error('resetContext failed', { err: String(err?.message ?? err) })
      upsert(sid, { itemId: `reseterr_${Date.now()}`, kind: 'agent_message', status: 'failed', text: `⚠️ ${tr('重置失败：{msg}', { msg: String(err?.message ?? err) })}` })
    })
  }

  // 重新生成最后一轮：主进程把本会话换成切点前的分叉并重发那条消息（见 DshController.forkSession），
  // 切点前的历史随即回放，这里先清空本地对话再收；busy 先置上，由新一轮的 turn 事件接管
  const regenerate = (msgId: string) => {
    const sid = activeSessionId
    if (!sid || busyRef.current.has(sid)) return
    clearSession(sid)
    busyRef.current.add(sid)
    rerender()
    client.agent.forkSession(sid, msgId, 'regenerate').catch((err) => {
      log.error('regenerate failed', { err: String(err?.message ?? err) })
      // 没动成：重连让主进程把历史重放回来（它已标记待重放），再出错误气泡
      clearSession(sid)
      const msg = tr('重新生成失败：{msg}', { msg: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
      client.agent.reconnectSession(sid).catch(() => {}).finally(() => fail(sid, msg))
    })
  }

  // 对话区出一条错误气泡（分叉 / 重新生成失败等）
  const fail = (sid: string, text: string) => upsert(sid, { itemId: `forkerr_${Date.now()}`, kind: 'agent_message', status: 'failed', text: `⚠️ ${text}` })

  // 用户选「继续当前会话」/ 关掉提示：收起即可（会话从未暂停）
  const dismissContextPrompt = () => {
    ctxRef.current.delete(activeSessionId)
    rerender()
  }

  // 清空某会话的对话状态（删除会话/上下文重置时调用）
  const clearSession = (sid: string) => {
    itemsMap.current.delete(sid)
    indexMap.current.delete(sid)
    busyRef.current.delete(sid)
    ctxRef.current.delete(sid)
    queueRef.current.delete(sid)
    steerRef.current.delete(sid)
    pendingRef.current.delete(sid)
    turnIdRef.current.delete(sid)
    timesRef.current.delete(sid)
    stopReqRef.current.delete(sid)
    rerender()
  }

  // 撤回一条「本轮结束后发送」的排队消息（文字放回输入框）
  const withdrawQueued = (index: number): { text: string; atts?: OutgoingAttachments } | undefined => {
    const sid = activeSessionId
    const q = queueRef.current.get(sid)
    if (!q || index < 0 || index >= q.length) return undefined
    const [item] = q.splice(index, 1)
    if (!q.length) queueRef.current.delete(sid)
    rerender()
    return item
  }

  // 撤回还没插入的追问（已经插入的撤不回：返回 false，界面上它已落进时间线）。返回文本，调用方可放回输入框
  const withdrawSteer = async (key: string): Promise<{ text: string; atts?: OutgoingAttachments } | undefined> => {
    const sid = activeSessionId
    const l = steerRef.current.get(sid)
    const s = l?.find((x) => x.key === key)
    if (!s) return undefined
    if (s.id && !(await client.agent.unsteer(sid, s.id).catch(() => false))) return undefined
    const i = l!.indexOf(s)
    if (i < 0) return undefined   // 撤回途中已被接纳
    l!.splice(i, 1)
    rerender()
    return { text: s.text, atts: s.atts }
  }

  // 中断当前会话的 turn：调后端 interruptTurn（dsh 取消后发真实 turn/end，带原 turnId）。
  // 本地立即清 busy，避免按钮卡在 loading；该 turnId 记为已中断，其迟到的 end 不再动 busy（可能已有新 turn）。
  const interrupt = () => {
    if (!activeSessionId) return
    const sid = activeSessionId
    const tid = turnIdRef.current.get(sid)
    busyRef.current.delete(sid)
    // 停止会清空 dsh 收件箱：还没插入的追问挪回排队，停下后作为新一轮发出（排在已排队的前面，按发出顺序）
    const st = steerRef.current.get(sid)
    if (st?.length) {
      steerRef.current.delete(sid)
      queueRef.current.set(sid, [...st.map((s) => ({ text: s.text, atts: s.atts })), ...(queueRef.current.get(sid) ?? [])])
    }
    if (tid !== undefined) {
      turnIdRef.current.delete(sid)
      abortedRef.current.add(tid)
    } else {
      // turnStarted 还没到：记下停止请求，turn 一开始就中断（首次 cancel 可能落空）；同时放行排队消息
      stopReqRef.current.add(sid)
      rerender()
      flushQueue(sid)
    }
    // 用户主动停止不算错误：不出「⚠️ 已中断」气泡（历史回放里也不存在，避免实时与重载后不一致）
    client.agent.interruptTurn(sid).catch((err) => {
      log.error('interruptTurn failed', { err: String(err?.message ?? err) })
    })
  }

  return {
    items: itemsOf(activeSessionId),
    // 待发送（本轮结束后自动发出），不在 items 里
    queued: (queueRef.current.get(activeSessionId) ?? []).map((q) => (q.atts?.view.length ? `${q.text}${tr('（附件 {n} 个）', { n: q.atts.view.length })}`.trim() : q.text)),
    withdrawQueued,
    // 等待插入的追问（key 用于撤回；sent = 已交给引擎）
    steering: (steerRef.current.get(activeSessionId) ?? []).map((s) => ({ key: s.key, sent: !!s.id, text: s.atts?.view.length ? `${s.text}${tr('（附件 {n} 个）', { n: s.atts.view.length })}`.trim() : s.text })),
    withdrawSteer,
    busy: busyRef.current.has(activeSessionId),
    context: ctxRef.current.get(activeSessionId),
    usage: usageRef.current.get(activeSessionId),
    turnTimes: timesRef.current.get(activeSessionId),
    send,
    sendTo,
    regenerate,
    fail,
    interrupt,
    clearSession,
    resetContext,
    dismissContextPrompt,
  }
}
