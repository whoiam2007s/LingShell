import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Send, Square, Loader2, KeyRound, AlertTriangle, Sparkles, Plus, Pencil, Terminal, Bug, ListChecks, Server, ChevronUp, Clock, Download, X, ArrowDown, Bot, Info, FlaskConical, CornerDownRight } from 'lucide-react'
import { useConversation, type ContextState, type ConvItem, type SessionPhase } from './useConversation.js'
import { groupTurns, windowStart, type Turn } from './groupTurns.js'
import { MessageItem, MsgActionsContext, type MsgActions } from './items/MessageItem.js'
import { ToolSessionContext } from '../auth/index.js'
import { ReasoningItem } from './items/ReasoningItem.js'
import { ToolItem } from './items/ToolItem.js'
import { TodoItem } from './items/TodoItem.js'
import { AuthRequestItem } from './items/AuthRequestItem.js'
import { PlanRequestItem } from './items/PlanRequestItem.js'
import { KnowledgeItem } from './items/KnowledgeItem.js'
import { ProposalItem } from './items/ProposalItem.js'
import { isProposalCard } from './groupTurns.js'
import { TurnSteps } from './items/TurnSteps.js'
import { TurnElapsed, FirstAnswer } from './items/TurnTime.js'
import type { TurnTimes } from '@lingshell/shared'
import { tr, tk } from '@lingshell/shared'
import { onQuoteToChat } from '../../lib/quoteToChat.js'
import { onSendToChat, takeChatSends } from '../../lib/sendToChat.js'
import { onPalette, paletteCtx } from '../../lib/paletteBus.js'
import { conversationToMarkdown, buildSessionReport, fmtTokens, fmtCost, totalTokens, cacheHitRate, USAGE_PRICES_EVENT, type UsageTotals, type UsageCurrency } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { openUsage } from '../usage/index.js'
import { TemplatePicker } from './TemplatePicker.js'
import { RunbookPicker } from '../runbooks/index.js'
import { InputActionsMenu } from './InputActionsMenu.js'
import { ModelChip, type ModelMenuProps } from './ModelMenu.js'
import { useModelProfiles, profileOf } from '../../lib/modelProfiles.js'
import { logger } from '../../lib/logger.js'
import { AttachmentChips } from './AttachmentChips.js'
import { useAttachments } from './useAttachments.js'
import { withTermBlocks } from '../../lib/termBlock.js'
import { useToolFocus, ToolFocusContext, flashEl } from './toolFocus.js'
import { ChatRuler } from './ChatRuler.js'
import { focusToolCard } from '../terminals/index.js'
import type { MsgAttachment } from '@lingshell/shared'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { useTurnChanges, TurnChangesBar } from './TurnChanges.js'
import { useTurnHostChanges, TurnHostChangesBar } from './TurnHostChanges.js'
import { buildPostmortemPrompt, isPostmortemRequest, redactSecrets } from '@lingshell/shared'
import { PostmortemSaveBar } from './PostmortemSave.js'
import { AskRequestItem } from './items/AskRequestItem.js'
import { AtMenuPopup, useAtMenu, type AtPick } from './AtMenu.js'
import { ChatFind } from './ChatFind.js'
import { onChatJump, peekChatJump, clearChatJump, onChatContext } from '../../lib/chatBus.js'
import { bangCommand, shellBlockText, terminalRefText, hostRefText, sessionRefText, planCompose, pasteLine, type ComposePlan } from '@lingshell/shared'
import { getActiveTerminal } from '../../lib/activeTerminal.js'
import { isAction } from '../../lib/keybindings.js'
import { PasteConfirmDialog } from '../../components/PasteConfirm.js'
import { errMsg } from './attachments.js'
import { usePreview, PreviewBanner, PreviewPlanCard, previewPlanOfTurn } from './PreviewMode.js'

const log = logger.scope('chat')

// 受控对话面板：会话生命周期（创建/重连/选择/phase）由 App 管，这里只按 activeSessionId 渲染对话流。
export function ChatPanel({ activeSessionId, sessionPhase, sessionTitle, workDir, onPickWorkDir, onRename, onNew, onOpenHistory, onOpenSettings, onRetry, onBack, onFirstUserMessage, onManageTemplates, onManageRunbooks, onManageModels, onManageSkills, onOpenSession }: {
  onBack?: () => void          // 错误态「返回上一个会话」（没有可回的会话时不传）
  onOpenSession?: (id: string) => Promise<void>   // 切到某会话（分叉出的新会话：刷新列表并打开）
  activeSessionId: string
  sessionPhase: SessionPhase
  sessionTitle?: string
  workDir?: string
  onPickWorkDir?: () => void
  onRename?: (title: string) => void
  onNew?: () => void
  onOpenHistory?: () => void
  onOpenSettings?: () => void
  onRetry: () => void
  onFirstUserMessage?: (sid: string, text: string) => void
  onManageTemplates?: () => void
  onManageRunbooks?: () => void
  onManageModels?: () => void
  onManageSkills?: () => void
}) {
  const { items, queued, steering, withdrawSteer, withdrawQueued, busy, context, usage, turnTimes, send, sendTo, regenerate, fail, interrupt, resetContext, dismissContextPrompt } = useConversation(activeSessionId, onFirstUserMessage)
  const models = useSessionModel(activeSessionId, busy, onManageModels)
  const turnChanges = useTurnChanges(activeSessionId, busy)   // 回合末「本轮改了 N 个文件」
  const hostChanges = useTurnHostChanges(activeSessionId)     // 回合末「本轮主机变化」
  const preview = usePreview(activeSessionId)                 // 预演模式（只说不做）
  const [input, setInput] = useState('')
  // 输入框草稿按会话分开：切会话不把上一条没发出去的文字（和 Skill）带过去
  const draftRef = useRef<Map<string, string>>(new Map())
  const sidRef = useRef(activeSessionId); sidRef.current = activeSessionId
  const prevSidRef = useRef(activeSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // ── 只渲染尾部窗口 ────────────────────────────────────
  // 历史重放会一次灌进几千条 item（旧会话实测 60 万条事件），全量渲染 markdown 直接卡死。
  // 窗口 = max(最新一轮, 最近 PAGE 条)，向上滚动追加一页，直到见底。
  const PAGE = 50
  const [visible, setVisible] = useState(PAGE)
  const keepHeightRef = useRef(0)
  // 用户是否贴着底部（由 scroll 事件维护）。只有贴底时窗口起点才随新内容前移；
  // 往上翻着看时冻结起点——否则顶部条目被裁掉会把内容往上顶，且起点落在轮中间时轮的 key 变化会重挂载（丢展开态）。
  const pinnedRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)   // 同 pinnedRef，供「回到底部」按钮渲染
  const startRef = useRef<{ sid: string; visible: number; idx: number } | null>(null)
  useEffect(() => { setVisible(PAGE) }, [activeSessionId])
  // 切会话：强制回到底部（不沿用上个会话的滚动位置）
  useLayoutEffect(() => {
    pinnedRef.current = true; setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeSessionId])

  // items 只追加/原地替换，下标稳定 → 冻结时直接复用上次的起点下标
  const prevStart = startRef.current
  const startIdx = prevStart && prevStart.sid === activeSessionId && prevStart.visible === visible && prevStart.idx <= items.length && !pinnedRef.current
    ? prevStart.idx
    : windowStart(items, visible)
  startRef.current = { sid: activeSessionId, visible, idx: startIdx }
  const shown = startIdx === 0 ? items : items.slice(startIdx)
  const hasMore = startIdx > 0

  // 终端紫色标记 → 滚到工具卡片（见 toolFocus.ts）
  const toolFocus = useToolFocus({
    items, sessionId: activeSessionId, startIdx, openSession: onOpenSession, scrollEl: () => scrollRef.current,
    showFrom: (n) => setVisible((v) => Math.max(v, n)), unpin: () => { pinnedRef.current = false; setAtBottom(false) },
  })
  const loadMore = () => {
    const el = scrollRef.current
    keepHeightRef.current = el?.scrollHeight ?? 0
    setVisible((v) => v + PAGE)
  }
  // 追加历史后把视口钉在原来那条消息上，否则内容长高会把用户"顶"走
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !keepHeightRef.current) return
    el.scrollTop = el.scrollHeight - keepHeightRef.current
    keepHeightRef.current = 0
  }, [visible])

  // 自动滚到底：瞬时滚动。流式时 items 每个 chunk 都变，smooth 会排队一串动画，长列表下卡顿。
  // 仅在用户本来就贴着底部时才跟随——否则往上翻历史会被新 delta 一直拽回来。
  // 贴底与否看内容变化前的 pinnedRef，而不是变化后再量距离（一次长出 >120px 会误判成"已离开底部"）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || keepHeightRef.current || !pinnedRef.current) return
    el.scrollTo({ top: el.scrollHeight })
  }, [items, queued.length, steering.length, busy])
  // 内容渲染后才长高（markdown/代码块/diff 异步排版、历史批量灌入）时 items 不再变，上面的 effect 不会再触发，
  // 首次打开/切会话会停在半截。贴底时监听内容高度变化，长高就再钉到底。
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current, content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => { if (pinnedRef.current && !keepHeightRef.current) el.scrollTop = el.scrollHeight })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])
  // 取消跟随只认用户操作（滚轮 / 拖滚动条 / 触摸 / PageUp·↑·Home）。不能靠 scroll 事件本身判断：
  // 历史重放时布局自己也会挪 scrollTop——事件晚一帧到时又灌进一批内容（离底几千 px）、窗口裁掉顶部条目、
  // 浏览器滚动锚定补偿——都曾被误判成「用户往上翻了」，首次打开 / 解锁 / 切会话停在半截。
  // 跟随中出现的非用户滚动一律钉回底部；用户滚回离底 120px 内恢复跟随。
  const userScrollUntil = useRef(0)
  const pointerDown = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const mark = () => { userScrollUntil.current = Date.now() + 600 }
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) mark() }
    const onDown = () => { pointerDown.current = true }
    const onUp = () => { if (pointerDown.current) { pointerDown.current = false; mark() } }
    const onKey = (e: KeyboardEvent) => {
      if (!['PageUp', 'ArrowUp', 'Home'].includes(e.key)) return
      const a = document.activeElement
      if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a?.closest('.xterm')) return
      mark()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('touchmove', mark, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', onWheel); el.removeEventListener('pointerdown', onDown); el.removeEventListener('touchmove', mark)
      window.removeEventListener('pointerup', onUp); window.removeEventListener('keydown', onKey)
    }
  }, [])
  const trail = useRef<string[]>([])   // 最近几次贴底判断（诊断用，见下方切会话后的自检）
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
    const user = pointerDown.current || Date.now() < userScrollUntil.current
    if (dist <= 120) pinnedRef.current = true
    else if (user) pinnedRef.current = false
    else if (pinnedRef.current && !keepHeightRef.current) el.scrollTop = el.scrollHeight   // 布局造成的偏移：钉回底部
    trail.current = [...trail.current.slice(-7), `d=${dist} h=${el.scrollHeight} u=${user ? 1 : 0} p=${pinnedRef.current ? 1 : 0}`]
    setAtBottom(pinnedRef.current)
  }
  // 自检：切会话 / 启动 3s 后，没有用户操作却不在底部 → 记一条日志（定位「停在半截」用），并兜底钉到底
  useEffect(() => {
    trail.current = []
    const t = setTimeout(() => {
      const el = scrollRef.current
      if (!el || Date.now() < userScrollUntil.current || pointerDown.current) return
      const dist = Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
      if (dist <= 120) return
      log.warn('chat not at bottom after load', { dist, h: el.scrollHeight, pinned: pinnedRef.current, keep: keepHeightRef.current, trail: trail.current })
      if (!pinnedRef.current) return   // 用户（或误判）已取消跟随：只记录不强拉
      el.scrollTop = el.scrollHeight
    }, 3000)
    return () => clearTimeout(t)
  }, [activeSessionId])
  const toBottom = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true; setAtBottom(true)
    el.scrollTop = el.scrollHeight
  }

  // textarea 自适应高度：默认 1 行，随内容长高，最多 3 行（66px + 上下 3px 内边距），超出滚动。
  // 单行时高 28px 与两侧 28px 按钮等高，文字和「+」/发送按钮垂直居中对齐。
  // 先重置 height 再按 scrollHeight 设，钳在 max。input 变化（含清空/填入建议）时重算。
  const MAX_TA = 72
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TA)}px`
  }, [input])

  // 导出当前会话：仅对话 / 完整报告（+执行记录、文件改动、授权记录），可选 HTML；文件名去掉 Windows 不允许的字符
  const exportSession = async (mode: ExportMode, redact: boolean) => {
    const title = titleOf(sessionTitle)
    const name = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    if (mode === 'chat') { void client.system.saveTextFile(`${name}.md`, conversationToMarkdown(title, items, { redact })); return }
    const [audit, hosts] = await Promise.all([
      client.audit.listForSession(activeSessionId).catch(() => []),
      client.hosts.list().catch(() => []),
    ])
    const md = buildSessionReport({ title, items, audit, hosts, redact })
    if (mode === 'report') { void client.system.saveTextFile(`${name}-${tr('报告')}.md`, md); return }
    const { markdownToHtml } = await import('./reportHtml.js')
    void client.system.saveTextFile(`${name}-${tr('报告')}.html`, markdownToHtml(tr('会话报告：{title}', { title }), md))
  }

  // 故障复盘报告：向本会话发一条「生成复盘」指令（附执行记录时间线 / 文件改动 / 主机变化），AI 回复后在回复下方「保存为文件」
  const postmortemOff = !items.length ? tr('会话还是空的') : busy ? tr('本会话还在进行中，等这一轮结束再生成') : undefined
  const postmortem = async () => {
    if (postmortemOff || !activeSessionId) return
    const sid = activeSessionId
    const [audit, turns, hostReports, hosts, settings] = await Promise.all([
      client.audit.listForSession(sid).catch(() => []),
      client.turnChanges.list(sid).catch(() => []),
      client.hostChanges.list(sid).catch(() => []),
      client.hosts.list().catch(() => []),
      client.settings.get().catch(() => undefined),
    ])
    send(buildPostmortemPrompt({ title: sessionTitle || '会话', audit, turnChanges: turns, hostReports, hosts, redact: settings?.system?.aiRedact === false ? undefined : redactSecrets }))   // i18n-ignore 发给模型的提示词
  }
  const postmortemRef = useRef(postmortem); postmortemRef.current = postmortem
  paletteCtx.postmortemOff = postmortemOff
  useEffect(() => onPalette((c) => { if (c.type === 'postmortem') void postmortemRef.current() }), [])

  // 终端里选中文本点「问 AI」→ 追加到输入框（不直接发，留给用户补一句问题），光标放到末尾
  useEffect(() => onQuoteToChat((q) => {
    setInput((prev) => (prev.trim() ? prev.trimEnd() + '\n\n' : '') + q)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollTop = ta.scrollHeight
    })
  }), [])

  const canChat = sessionPhase.phase === 'ready' && !!activeSessionId
  // 终端「让 AI 排查」：直接作为用户消息发出（会话没就绪时排着，就绪后再发），焦点给输入框；被拒就放进输入框
  const sendRef = useRef(send); sendRef.current = send
  useEffect(() => {
    if (!canChat) return
    const drain = () => {
      const texts = takeChatSends()
      if (!texts.length) return
      for (const t of texts) if (!sendRef.current(t)) setInput((prev) => (prev.trim() ? prev.trimEnd() + '\n\n' : '') + t)
      requestAnimationFrame(() => taRef.current?.focus())
    }
    drain()
    return onSendToChat(drain)
  }, [canChat, activeSessionId])
  // 命令面板选了模板 / 手册：交给输入框旁的 picker 打开（参数、目标终端照旧在 picker 里填）
  paletteCtx.chatReady = canChat
  const [tplPreset, setTplPreset] = useState<{ id: string; n: number }>()
  const [rbPreset, setRbPreset] = useState<{ id: string; n: number }>()
  useEffect(() => onPalette((c) => {
    if (c.type === 'template') setTplPreset((p) => ({ id: c.id, n: (p?.n ?? 0) + 1 }))
    else if (c.type === 'runbook') setRbPreset((p) => ({ id: c.id, n: (p?.n ?? 0) + 1 }))
  }), [])
  // 只有真的收下了才清空输入框——被拒时留着内容，不让用户白打一遍
  // 选了 Skill：消息前加 `/名字`，由 dsh-tool-skill 把该 skill 的完整指令注入本轮（用户显式调用）
  const [skill, setSkill] = useState<string>()
  // 切会话：保存上一个会话的草稿，恢复当前会话的草稿；Skill 属于具体一条消息，不跨会话
  useEffect(() => {
    const prev = prevSidRef.current
    if (prev === activeSessionId) return
    draftRef.current.set(prev, input)
    setInput(draftRef.current.get(activeSessionId) ?? '')
    setSkill(undefined)
    prevSidRef.current = activeSessionId
  }, [activeSessionId])
  // 附件（文件 / 目录 / 图片）：tag 栏、粘贴 / 拖入、「+」菜单的选择框都在 useAttachments 里
  const att = useAttachments(!!models.current?.multimodal, activeSessionId)
  // 消息操作：编辑后重发 / 从这里分叉 → 主进程从该消息之前分叉出新会话并切过去；重新生成 → 本会话原地重跑最后一轮。
  // 回调经 ref 取最新闭包，context 值只随 busy / 会话变化，不带动所有消息重渲染
  const forkRef = useRef<(msgId: string, edited?: string) => void>(() => {})
  forkRef.current = (msgId, edited) => {
    const sid = activeSessionId
    client.agent.forkSession(sid, msgId, 'fork').then(async (r) => {
      await onOpenSession?.(r.session.id)
      if (edited !== undefined) sendTo(r.session.id, edited)
      else { draftRef.current.set(r.session.id, r.text); setInput(r.text); requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) } }) }
    }, (e) => fail(sid, tr('分叉失败：{msg}', { msg: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })))
  }
  const regenRef = useRef(regenerate)
  regenRef.current = regenerate
  const msgActions = useMemo<MsgActions>(() => ({
    busy,
    onEdit: (id, text) => forkRef.current(id, text),
    onFork: (id) => forkRef.current(id),
    onRegenerate: (id) => regenRef.current(id),
  }), [busy, activeSessionId])

  // queue：本轮在跑时排到本轮结束后再发（Alt+Enter），默认是在下一步前插入
  const submit = (opts?: { queue?: boolean }) => {
    const cmd = bangCommand(input)
    if (cmd !== null) { void runBang(cmd); return }   // `!命令`：不发给 AI，在当前终端执行
    if (!input.trim() && !skill && !att.items.length) return
    const out = att.outgoing()
    if (out === null) return   // 有图片但当前模型不支持：已提示，保留输入
    const text = withTermBlocks(input, att.blocks())   // 终端块拼成文本接在后面
    if (send(skill ? `/${skill} ${text}`.trim() : text, out, opts)) { setInput(''); draftRef.current.delete(activeSessionId); setSkill(undefined); att.clear() }
  }

  // ── `!命令` 直通终端（参考 Gemini CLI / Claude Code 的 ! 模式）──────────
  // 走撰写栏同一套确认（危险命令 / 隐藏字符 / 多行发到生产），这里对生产终端单行也确认；执行完结果变成「终端块」标签，接着写问题再发给 AI
  const bang = bangCommand(input)
  const [shellBusy, setShellBusy] = useState('')
  const [shellAsk, setShellAsk] = useState<{ plan: ComposePlan; tid: string; cmd: string } | null>(null)
  const execBang = async (tid: string, title: string, cmd: string) => {
    setShellBusy(title)
    const sid0 = activeSessionId
    try {
      const r = await client.chatPlus.runShell(tid, cmd, sid0)
      if (sidRef.current !== sid0) return   // 执行期间切了会话：结果别塞进新会话的输入框
      att.addContext('shell', `${cmd.replace(/\s+/g, ' ').slice(0, 48)}${tr('（退出码 {code}）', { code: r.exitCode })}`, shellBlockText({ terminal: r.terminal, command: cmd, exitCode: r.exitCode, output: r.output, truncated: r.truncated }))
      setInput((cur) => (bangCommand(cur) === cmd ? '' : cur))
      requestAnimationFrame(() => taRef.current?.focus())
    } catch (e) { att.setHint(tr('执行失败：{msg}', { msg: errMsg(e) })) } finally { setShellBusy('') }
  }
  const runBang = async (cmd: string) => {
    if (!cmd) { att.setHint(tr('在 ! 后面写要在终端执行的命令，如 !ls -la')); return }
    if (shellBusy) return
    const active = getActiveTerminal()
    const terms = await client.terminal.list().catch(() => [])
    const t = terms.find((x) => x.id === active?.id) ?? (terms.length === 1 ? terms[0] : undefined)
    if (!t) { att.setHint(tr('没有活动终端：先在右侧打开一个终端（或点一下要用的那个）')); return }
    const plan = planCompose(cmd, 'active', t.id, terms, null)
    if (!plan.sends.length) { att.setHint(tr('终端「{title}」已断开或正忙（AI 执行中），稍后再试', { title: t.title })); return }
    if (plan.confirm || plan.prod.length) { setShellAsk({ plan, tid: t.id, cmd }); return }
    void execBang(t.id, t.title, cmd)
  }

  // ── @ 引用 ───────────────────────────────────────────
  const [caret, setCaret] = useState(0)
  const onAtPick = async (p: AtPick, r: { start: number; end: number }) => {
    setInput((cur) => cur.slice(0, r.start) + cur.slice(r.end))
    setCaret(r.start)
    requestAnimationFrame(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(r.start, r.start) } })
    if (p.type === 'terminal') att.addContext('terminal', p.t.title, terminalRefText(p.t.title, p.t.id))
    else if (p.type === 'host') att.addContext('host', p.h.label, hostRefText(p.h.label, p.h.id, p.h.group))
    else if (p.type === 'file') att.pickFiles()
    else {
      const sid0 = activeSessionId
      try {
        const digest = await client.chatPlus.digest(p.s.id)
        if (sidRef.current !== sid0) return   // 读取期间切了会话：片段别附到新会话
        att.addContext('session', titleOf(p.s.title), sessionRefText(p.s.title || '会话', p.when, digest))   // i18n-ignore 引用文本发给模型，标题保持原值
      } catch (e) { if (sidRef.current === sid0) att.setHint(tr('读取会话「{title}」失败：{msg}', { title: tr(p.s.title), msg: errMsg(e) })) }
    }
  }
  const atMenu = useAtMenu(input, caret, activeSessionId, (p, r) => { void onAtPick(p, r) })

  // 跨会话搜索「问 AI」：检索片段作为上下文标签附上（send = 直接发出）
  const autoSend = useRef(false)
  useEffect(() => onChatContext((p) => {
    for (const c of p.chips) att.addContext(c.ctx, c.name, c.text)
    if (p.text !== undefined) setInput(p.text)
    if (p.send) autoSend.current = true
    else requestAnimationFrame(() => taRef.current?.focus())
  }), [])
  useEffect(() => { if (autoSend.current && canChat && att.items.length) { autoSend.current = false; submit() } })

  // ── 对话导航（Ctrl+↑ / Ctrl+↓ 在「我的提问」间跳）与会话内搜索（Ctrl+F）──────
  const rootRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  useEffect(() => { setFindOpen(false) }, [activeSessionId])
  const flash = (el: HTMLElement) => { el.removeAttribute('data-chat-flash'); void el.offsetWidth; el.setAttribute('data-chat-flash', ''); setTimeout(() => el.removeAttribute('data-chat-flash'), 1900) }
  const scrollToEl = (el: HTMLElement) => {
    const box = scrollRef.current
    if (!box) return
    pinnedRef.current = false; setAtBottom(false); userScrollUntil.current = Date.now() + 800   // 程序滚动也算用户意图：别被「贴底」拽回去
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8
    flash(el)
  }
  const navMsg = (d: 1 | -1) => {
    const box = scrollRef.current
    if (!box) return
    const top = box.getBoundingClientRect().top
    const msgs = [...box.querySelectorAll<HTMLElement>('[data-item-kind="user_message"]')]
    const off = (m: HTMLElement) => m.getBoundingClientRect().top - top
    const target = d < 0 ? [...msgs].reverse().find((m) => off(m) < -4) : msgs.find((m) => off(m) > 12)
    if (target) { scrollToEl(target); return }
    if (d < 0 && hasMore) loadMore()        // 已到窗口顶：加载更早的一页，再按一次继续
    else if (d > 0) toBottom()
  }
  const navRef = useRef(navMsg); navRef.current = navMsg
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('.fixed.inset-0')) return
      const t = e.target
      if (!(t === document.body || (t instanceof Node && rootRef.current?.contains(t)))) return
      if (isAction(e, 'chat.find')) {
        e.preventDefault()
        setFindOpen(true)
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-chat-find] input')?.select())
      } else if (isAction(e, 'chat.prevMsg') || isAction(e, 'chat.nextMsg')) {
        e.preventDefault()
        navRef.current(isAction(e, 'chat.prevMsg') ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 搜索词命中了窗口外更早的消息：把窗口扩到最早的那条
  const onFindQuery = (q: string) => {
    const x = q.trim().toLowerCase()
    if (!x) return
    const i = items.findIndex((it) => (it.kind === 'user_message' || it.kind === 'agent_message') && it.text.toLowerCase().includes(x))
    if (i >= 0 && i < startIdx) setVisible(items.length - i + 5)
  }

  // 对话区标尺（ChatRuler）：已渲染的「我的提问」
  const userMsgs = useMemo(() => items.slice(startIdx).filter((it) => it.kind === 'user_message').map((it) => ({ itemId: it.itemId, text: it.text })), [items, startIdx])

  // ── 跨会话搜索结果点击：切到会话后等历史回放到了，滚到命中的那条（在折叠的执行过程里就滚到本轮提问）──
  const [jumpTick, setJumpTick] = useState(0)
  useEffect(() => onChatJump(() => setJumpTick((n) => n + 1)), [])
  useEffect(() => {
    const j = peekChatJump(activeSessionId)
    if (!j || !items.length) return
    if (!j.itemId) { clearChatJump(); return }
    const idx = items.findIndex((it) => it.itemId === j.itemId || it.msgId === j.itemId)
    if (idx < 0) return   // 还没回放到，等下次 items 变化（请求 10 秒后作废）
    if (idx < startIdx) { setVisible(items.length - idx + 5); return }
    clearChatJump()
    // 命中的是命令（工具卡片，在折叠的「执行过程」里）：交给 toolFocus，展开执行过程、滚到卡片并闪一下（同终端紫色标记）
    if (items[idx].kind === 'tool_call') { focusToolCard({ sessionId: activeSessionId, callId: items[idx].itemId }); return }
    let u = idx
    while (u > 0 && items[u].kind !== 'user_message') u--
    const sel = (id: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)
    // 等本次渲染落地再滚（不用 rAF：窗口被遮挡时 rAF 会暂停）
    setTimeout(() => { const el = sel(items[idx].itemId) ?? sel(items[u].itemId); if (el) { scrollToEl(el); flashEl(el) } }, 30)
  }, [items, activeSessionId, jumpTick, startIdx])

  return (
    // tabIndex=-1：点对话区能拿到焦点，Ctrl+F / Ctrl+↑↓ 据此判断「焦点在对话区」
    <div ref={rootRef} tabIndex={-1} data-chat-root className="relative flex h-full flex-col bg-[var(--color-bg-panel)] outline-none">
      {/* 初始化覆盖层 */}
      {sessionPhase.phase !== 'ready' && <Overlay phase={sessionPhase} onOpenSettings={onOpenSettings} onRetry={onRetry} onNew={onNew} onBack={onBack} onOpenHistory={onOpenHistory} />}

      {/* 会话 header */}
      <SessionHeader hasSession={!!activeSessionId} sessionId={activeSessionId} usage={usage} onExport={items.length ? exportSession : undefined}
        postmortem={{ off: postmortemOff ?? (canChat ? undefined : tr('AI 会话未就绪')), run: () => void postmortem() }} title={sessionTitle ?? ''} onRename={onRename} onNew={onNew} models={canChat ? models : undefined}
        preview={activeSessionId ? { on: preview.on, onToggle: () => preview.set(!preview.on) } : undefined} />

      {/* 时间线：按轮分组，中间步骤收进【执行过程】容器，用户消息+最终回复留容器外 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {findOpen && <ChatFind root={contentRef} tick={`${items.length}:${startIdx}:${items.at(-1)?.text.length ?? 0}`} onQuery={onFindQuery}
        onClose={() => { setFindOpen(false); rootRef.current?.focus() }} />}
      <ChatRuler scrollRef={scrollRef} contentRef={contentRef} msgs={userMsgs} onGo={scrollToEl} />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-2">
       {/* 空会话时撑满高度，欢迎页才能上下居中 */}
       <div ref={contentRef} className={items.length === 0 ? 'h-full' : undefined}>
        {items.length === 0 && sessionPhase.phase === 'ready' && (
          <EmptyState onPick={(text) => setInput(text)} />
        )}
        {hasMore && (
          <div className="flex justify-center py-2">
            <button onClick={loadMore}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:text-[var(--color-text-secondary)]">
              <ChevronUp className="h-3 w-3" />{tr('加载更早的消息（还有 {n} 条）', { n: startIdx })}
            </button>
          </div>
        )}
        <MsgActionsContext.Provider value={msgActions}><ToolSessionContext.Provider value={activeSessionId || null}><ToolFocusContext.Provider value={toolFocus}>
        {(() => {
          const turns = groupTurns(shown)
          return turns.map((turn, i) => {
            // 中途追问把同一轮分成了几组：本轮的耗时 / 改动条等只挂在最后一组
            if (turn.turnId && turns[i + 1]?.turnId === turn.turnId) return <TurnBlock key={turn.key} turn={turn} active={false} last={false} />
            const fc = turn.turnId && !(busy && i === turns.length - 1) ? turnChanges.changes.get(turn.turnId) : undefined
            const hc = turn.turnId && !(busy && i === turns.length - 1) ? hostChanges.get(turn.turnId) : undefined
            // 「生成复盘」那一轮结束后：最后一条 AI 回复下方「保存为文件」
            const pm = isPostmortemRequest(turn.userMsg?.text) && !(busy && i === turns.length - 1) ? turn.final.filter((x) => x.kind === 'agent_message' && x.text.trim()).at(-1)?.text : undefined
            // 预演模式：最后一轮回复末尾的「方案步骤」（可勾选执行）
            const pv = i === turns.length - 1 && !busy ? previewPlanOfTurn(turn, preview.on) : undefined
            // 追问开头的这一组：本轮的「开始回答」时间早于追问，不显示（只留结束时间）
            const tt = turn.turnId ? turnTimes?.get(turn.turnId) : undefined
            return <TurnBlock key={turn.key} turn={turn} active={busy && i === turns.length - 1} last={i === turns.length - 1} times={turn.userMsg?.steered && tt ? { endedAt: tt.endedAt } : tt}
              end={(fc || hc || pm || pv) && <>{pm && <PostmortemSaveBar text={pm} title={titleOf(sessionTitle)} />}{fc && <TurnChangesBar sessionId={activeSessionId} data={fc} onChanged={turnChanges.refresh} />}{hc && <TurnHostChangesBar data={hc} />}{pv && <PreviewPlanCard key={turn.key} sessionId={activeSessionId} plan={pv} busy={busy} onSend={send} />}</>} />
          })
        })()}
        </ToolFocusContext.Provider></ToolSessionContext.Provider></MsgActionsContext.Provider>
        {busy && <WorkingIndicator />}
        {/* 待发送：本轮进行中补发的消息，不进时间线（否则本轮后续步骤会被归到它名下），真正发出时才入 items */}
        {steering.length > 0 && <SteeringMessages items={steering} authWaiting={busy && items.some((x) => (x.kind === 'auth_request' || x.kind === 'plan_request' || x.kind === 'ask_request') && x.status === 'in_progress')}
          onWithdraw={(k) => void withdrawSteer(k).then((r) => { if (r) { setInput((v) => (v.trim() ? `${v}
${r.text}` : r.text)); taRef.current?.focus() } })} />}
        {queued.length > 0 && <QueuedMessages texts={queued} onWithdraw={(i) => {
          const item = withdrawQueued(i)
          if (item) setInput((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${item.text}` : item.text))
        }} />}
       </div>
      </div>
      {/* 离开底部时显示「回到底部」 */}
      {!atBottom && (
        <button onClick={toBottom} title={tr('回到底部')}
          className="absolute bottom-3 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)] shadow-lg transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:text-[var(--color-accent)]">
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
      </div>

      {/* 上下文超线：横幅常驻（收起弹窗后仍在），弹窗问是否重置 */}
      {context && <ContextBanner state={context} onDismiss={dismissContextPrompt} />}
      {context?.stage === 'suggest' && (
        <ContextResetDialog state={context} busy={busy} onReset={(s) => resetContext(s)} onCancel={dismissContextPrompt} />
      )}

      {/* 输入区 */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] p-2.5">
        {skill && (
          <div className="mb-1.5 flex">
            <span data-skill-tag={skill} title={tr('本条消息会让 AI 先加载这个 Skill 的完整指令')}
              className="flex items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-[var(--color-accent)]">
              <Sparkles className="h-3 w-3" /><span className="font-mono">{skill}</span>
              <button onClick={() => setSkill(undefined)} title={tr('移除 Skill')} className="flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--color-bg-hover)]"><X className="h-3 w-3" /></button>
            </span>
          </div>
        )}
        {/* 附件 tag（统一一行高）：小缩略图 / 文件、目录图标 + 名称，hover 看完整路径，× 移除，点击预览或打开 */}
        {preview.on && <PreviewBanner onOff={() => preview.set(false)} />}
        <AttachmentChips items={att.items} onRemove={att.remove} onError={att.setHint} noImage={!models.current?.multimodal} className="mb-1.5 pt-1.5" />
        {att.hint && <div data-attach-hint className="mb-1.5 text-[11.5px] text-[var(--color-warn)]">{att.hint}</div>}
        {shellBusy && <div data-shell-busy className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]"><Loader2 className="h-3 w-3 animate-spin-slow text-[var(--color-accent)]" />{tr('正在终端「{title}」执行…', { title: shellBusy })}</div>}
        <div {...att.dropProps} className={`relative flex items-end gap-1.5 rounded-lg border bg-[var(--color-bg-base)] px-2.5 py-1.5 transition-colors ${bang !== null ? 'border-[color:color-mix(in_srgb,var(--color-warn)_60%,transparent)]' : 'border-[var(--color-border-default)] focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'}`}>
          <AtMenuPopup m={atMenu} />
          {/* 「+」菜单：工作目录（会话绑定，本地终端 cwd / AI 默认工作区）/ Skills ▸ / 常用任务 ▸ / 运维手册 ▸。
              二级菜单选中后交给后面两个 picker（不显示自己的按钮，经 preset 打开）：模板填入输入框不自动发送；手册填参数 + 选终端后发出。
              三者包在一个 flex 项里：两个 picker 是 0 宽的空壳，单独作为 flex 项会各吃一份 gap，「+」和输入区就隔得很远 */}
          <div className="flex shrink-0">
            <InputActionsMenu workDir={workDir} canChat={canChat} hasSession={!!activeSessionId} onPickWorkDir={onPickWorkDir}
              onTemplate={(id) => setTplPreset((p) => ({ id, n: (p?.n ?? 0) + 1 }))} onRunbook={(id) => setRbPreset((p) => ({ id, n: (p?.n ?? 0) + 1 }))}
              onManageTemplates={onManageTemplates} onManageRunbooks={onManageRunbooks}
              skills={{ onPick: (n) => { setSkill(n); requestAnimationFrame(() => taRef.current?.focus()) }, onManage: onManageSkills }}
              attach={{ multimodal: !!models.current?.multimodal, onFiles: att.pickFiles, onDirs: att.pickDirs }} />
            <TemplatePicker hideTrigger disabled={!canChat} onManage={onManageTemplates} preset={tplPreset}
              onPick={(t) => { setInput(t); requestAnimationFrame(() => taRef.current?.focus()) }} />
            <RunbookPicker hideTrigger disabled={!canChat} onManage={onManageRunbooks} onRun={(p) => { send(p) }} preset={rbPreset} />
          </div>
          {/* `!` 开头：终端模式标记（回车在当前终端执行，不发给 AI） */}
          {bang !== null && (
            <span data-bang-badge title={tr('! 开头的内容会在当前终端执行（不发给 AI），结果作为「终端块」标签放进输入框')}
              className="mb-[3px] flex h-[22px] shrink-0 items-center gap-1 rounded border border-[color:color-mix(in_srgb,var(--color-warn)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-1.5 text-[11px] font-medium text-[var(--color-warn)]">
              <Terminal className="h-3 w-3" />{tr('终端')}
            </span>
          )}
          <textarea
            ref={taRef} data-chat-input
            value={input}
            onChange={(e) => { setInput(e.target.value); setCaret(e.target.selectionStart) }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (atMenu.onKey(e)) return
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e.altKey ? { queue: true } : undefined) }
            }}
            onPaste={att.onPaste}
            disabled={!canChat}
            rows={1}
            placeholder={canChat ? (busy ? tr('追问…（Enter 在下一步前插入，Alt+Enter 本轮结束后再发）') : tr('跟 AI 对话…（Enter 发送，@ 引用，! 开头跑命令）')) : tr('等待引擎就绪…')}
            className="flex-1 resize-none overflow-y-auto bg-transparent py-[3px] text-[13px] leading-[22px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] disabled:opacity-50"
          />
          {/* 跑着的时候也留发送按钮（有内容才出现）：补发的消息排队，本轮结束自动送出 */}
          {busy && (
            <button
              onClick={interrupt}
              title={tr('停止')}
              className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-danger)] text-[var(--color-bg-base)] transition-all hover:opacity-80"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          )}
          {(!busy || !!input.trim() || !!skill || att.items.length > 0) && (
            <button
              onClick={() => submit()}
              disabled={!canChat || (!input.trim() && !skill && !att.items.length)}
              title={bang !== null ? tr('在当前终端执行（不发给 AI）') : busy ? tr('追问：当前步骤结束后、AI 下一次请求前插入（Alt+Enter：本轮结束后再发）') : tr('发送')}
              className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-[var(--color-bg-base)] transition-all hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-30"
            >
              {bang !== null ? <Terminal className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>
      {/* `!命令` 的确认：与撰写栏 / 终端粘贴同一个确认框（危险行标红、隐藏字符显示占位） */}
      <PasteConfirmDialog open={!!shellAsk} title={shellAsk?.plan.hidden ? tr('命令含隐藏字符') : shellAsk?.plan.prod.length ? tr('在生产终端执行') : tr('dialog|危险命令确认')} confirmText={tr('确认执行')}
        message={tr('将在终端「{title}」执行{prod}{danger}{hidden}：', {
          title: shellAsk?.plan.sends[0]?.title ?? '',
          prod: shellAsk?.plan.prod.length ? tr('（生产终端）') : '',
          danger: shellAsk?.plan.dangerous.length ? tr('，其中 {n} 行是危险命令（红色）', { n: shellAsk.plan.dangerous.length }) : '',
          hidden: shellAsk?.plan.hidden ? tr('，含隐藏 / 控制字符（以 ⟨…⟩ 标出）') : '',
        })}
        lines={shellAsk?.plan.lines.map(pasteLine) ?? []}
        onCancel={() => { setShellAsk(null); taRef.current?.focus() }}
        onConfirm={() => { const a = shellAsk; setShellAsk(null); if (a) void execBang(a.tid, a.plan.sends[0]?.title ?? '', a.cmd) }} />
    </div>
  )
}

// 上下文提示条（不阻塞对话）：正在自动压缩 / 压缩失败
function ContextBanner({ state, onDismiss }: { state: ContextState; onDismiss: () => void }) {
  if (state.stage === 'suggest') return null   // 建议开新会话走弹窗
  return (
    <div className="flex items-center gap-2 border-t border-[color:color-mix(in_srgb,var(--color-warn)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-secondary)]">
      {state.stage === 'compacting' ? (
        <>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin-slow text-[var(--color-warn)]" />
          <span>{tr('上下文超过阈值，正在自动压缩较早的对话…（任务会继续）')}</span>
        </>
      ) : (
        <>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span className="min-w-0 flex-1 truncate" title={state.error}>{tr('自动压缩失败（会话照常继续，下一步会再试）：{error}', { error: state.error ?? '' })}</span>
          <button onClick={onDismiss} title={tr('关闭')} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3.5 w-3.5" /></button>
        </>
      )}
    </div>
  )
}

// 建议开新会话：会话已跑了很多步且压缩过——检查点越叠越多，细节会逐步丢失。用最近一次压缩摘要当交接总结（可改）
function ContextResetDialog({ state, busy, onReset, onCancel }: {
  state: Extract<ContextState, { stage: 'suggest' }>
  busy: boolean
  onReset: (summary: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(state.summary)
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[75vh] w-[560px] flex-col rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <AlertTriangle className="h-4 w-4 text-[var(--color-warn)]" />
          {tr('会话已执行 {steps} 步、自动压缩 {n} 次，要开个新会话吗？', { steps: state.steps, n: state.compactions })}
        </div>
        <p className="mb-2.5 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
          {tr('当前任务没有中断，可以继续。但压缩次数多了，较早的细节会逐步丢失。开新会话会清空对话历史（工作目录、终端、授权都保留）， 下面这份最近一次压缩生成的摘要会作为新会话的第一条消息发出，可先改。')}
        </p>
        {!state.summary && (
          <p className="mb-2.5 rounded-md bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--color-warn)]">
            {tr('没有拿到压缩摘要。可以自己写几句要点，或留空直接开新会话（从零开始）。')}
          </p>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tr('例：目标是排查 nginx 502；已确认 upstream 端口 8080 未监听；下一步看应用日志 /var/log/app.log')} 
          className="min-h-[200px] flex-1 resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-2.5 text-[12.5px] leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]"
        />
        <div className="mt-3.5 flex items-center justify-end gap-2">
          {busy && <span className="mr-auto text-[11.5px] text-[var(--color-warn)]">{tr('本会话还在执行，结束后才能开新会话')}</span>}
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">{tr('继续当前会话')}</button>
          <button disabled={busy} onClick={() => onReset(draft)} className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:pointer-events-none disabled:opacity-40">{draft.trim() ? tr('用摘要开新会话') : tr('开新会话（不带摘要）')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}

// 一轮：用户消息 → 【执行过程】容器（中间步骤）→ 最终 AI 回复。
// steps 为空时不渲染容器（如纯问答无工具调用），避免空壳。
// AI 部分整体一个机器人头像放在最前（执行过程之前；没有执行过程就在正文前），回合内各块不再各带头像，
// 都排在头像右侧同一内容列里，看起来是一条连续的回复。
// 时间：回合头部「开始回答 HH:mm:ss」（有执行过程时放在它的标题行右侧，否则在正文上方一行）；执行过程后面是整轮耗时
// last：最后一轮——它最后一条 AI 回复上出「重新生成」（按本轮用户消息重跑）；end：回合末附加内容（改动汇总条）
function TurnBlock({ turn, active, last, times, end }: { turn: Turn; active: boolean; last: boolean; times?: TurnTimes; end?: React.ReactNode }) {
  const regenFrom = last ? turn.userMsg?.msgId : undefined
  const hasAi = turn.steps.length > 0 || turn.final.length > 0
  const focus = useContext(ToolFocusContext)   // 要定位的工具卡在本轮的执行过程里 → 展开
  const openTick = focus && turn.steps.some((s) => s.itemId === focus.callId) ? focus.n : 0
  if (turn.notice) return <SystemNotice text={turn.notice.text} />
  const first = <FirstAnswer times={times} askedAt={turn.userMsg?.at} />
  return (
    <>
      {turn.userMsg?.steered && <div data-steered className="flex justify-end px-3 pr-[46px] pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('本轮中途追问')}</div>}
      {turn.userMsg && (turn.userMsg.text || !turn.userMsg.attachments?.length) && <TimelineItem item={turn.userMsg} />}
      {turn.userMsg?.attachments?.length ? <UserAttachments items={turn.userMsg.attachments} /> : null}
      {hasAi && (
        <div data-ai-turn className="flex pl-3">
          {/* 对齐首块顶部：执行过程按钮 4px，正文气泡 8px */}
          <div data-ai-avatar className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)] text-[var(--color-accent)] ${turn.steps.length ? 'mt-1' : 'mt-2'}`}>
            <Bot className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            {turn.steps.length > 0 ? (
              <TurnSteps active={active} openTick={openTick} count={turn.steps.length} duration={<TurnElapsed times={times} active={active} />} extra={first}>
                {turn.steps.map((item) => <TimelineItem key={item.itemId} item={item} active={active} />)}
              </TurnSteps>
            ) : times?.firstAt && <div className="px-5 pt-1.5 leading-none">{first}</div>}
            {turn.final.map((item, i) => <TimelineItem key={item.itemId} item={item} regenFrom={i === turn.final.length - 1 ? regenFrom : undefined} />)}
            {end}
          </div>
        </div>
      )}
    </>
  )
}

// 用户消息气泡下方的附件（右对齐到气泡下沿，点击可查看；打不开时在下面给一行原因）
function UserAttachments({ items }: { items: MsgAttachment[] }) {
  const [err, setErr] = useState('')
  return (
    <div data-user-attachments className="flex flex-col items-end px-3 pb-1 pr-[46px]">
      <AttachmentChips items={items} onError={setErr} className="justify-end" />
      {err && <div className="mt-1 text-[11px] text-[var(--color-warn)]">{err}</div>}
    </div>
  )
}

// 按 item.kind 路由到对应卡片。外包一层带 id / 类型的 div：Ctrl+↑↓ 找「我的提问」、跨会话搜索跳到命中那条都按它定位
function TimelineItem(props: { item: ConvItem; active?: boolean; regenFrom?: string }) {
  return <div data-item-id={props.item.itemId} data-item-kind={props.item.kind} {...(props.item.msgId ? { 'data-msg-id': props.item.msgId } : {})}><TimelineItemBody {...props} /></div>
}
function TimelineItemBody({ item, active = false, regenFrom }: { item: ConvItem; active?: boolean; regenFrom?: string }) {
  const streaming = item.status === 'in_progress'
  switch (item.kind) {
    case 'user_message':
    case 'agent_message':
      return <MessageItem item={item} streaming={streaming && item.kind === 'agent_message'} regenFrom={regenFrom} />
    case 'agent_reasoning':
      return <ReasoningItem item={item} streaming={streaming} live={active} />
    case 'tool_call':
      return isProposalCard(item) ? <ProposalItem item={item} /> : <ToolItem item={item} live={active} />
    case 'todo':
      return <TodoItem item={item} />
    case 'auth_request':
      return <AuthRequestItem item={item} />
    case 'plan_request':
      return <PlanRequestItem item={item} />
    case 'host_note':
      return <KnowledgeItem item={item} />
    case 'ask_request':
      return <AskRequestItem item={item} />
    default:
      return <MessageItem item={item} streaming={false} />
  }
}

// 会话标题显示：默认标题（新会话）存的是中文原文，显示时翻译；空标题显示「会话」
const titleOf = (t?: string) => (t ? tr(t) : tr('会话'))

// 空会话欢迎区：图标 + 欢迎语 + 能力提示卡片（点击填入输入框引导上手）
const SUGGESTIONS = [
  { icon: Terminal, title: tk('执行终端命令'), prompt: tk('在本地终端执行 `git status`，告诉我当前仓库状态') },
  { icon: Bug, title: tk('排查问题'), prompt: tk('帮我看看这个项目最近的报错日志，定位是什么原因') },
  { icon: ListChecks, title: tk('规划任务'), prompt: tk('帮我制定一个把这个项目部署到服务器的分步计划') },
  { icon: Server, title: tk('操作远程主机'), prompt: tk('连上我的 SSH 主机，检查磁盘使用情况和运行中的服务') },
]

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[color:color-mix(in_srgb,var(--color-accent)_25%,transparent)] to-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] ring-1 ring-[color:color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
        <Sparkles className="h-7 w-7 text-[var(--color-accent)]" />
      </div>
      <div className="mt-4 text-[15px] font-semibold text-[var(--color-text-primary)]">{tr('开始和 AI 对话')}</div>
      <div className="mt-1.5 max-w-[280px] text-center text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        {tr('它能调用工具、规划任务、操作本地和 SSH 终端。试试下面的例子，或直接输入你的问题。')}
      </div>
      <div className="mt-6 grid w-full max-w-[520px] grid-cols-2 gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button key={s.title} onClick={() => onPick(tr(s.prompt))}
            className="group flex flex-col gap-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-3 text-left transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--color-bg-hover)]">
            <div className="flex items-center gap-2">
              <s.icon className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
              <span className="text-[12.5px] font-medium text-[var(--color-text-primary)]">{tr(s.title)}</span>
            </div>
            <span className="line-clamp-2 text-[11px] leading-snug text-[var(--color-text-muted)]">{tr(s.prompt).replace(/`/g, '')}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// 上下文用量：让用户自己判断何时开新会话，而不是干到一半被自动总结打断
// 本会话累计 tokens（用量统计）：每次请求后 contextUsage 变 → 重新取一次；改了单价也重取（花费跟着变）
// 头部用量小标签：「本会话累计 tokens · 上下文进度条 %」合成一个，悬停看明细，点击打开用量统计。
// 累计 tokens 每次请求后（contextUsage 变）重取；改了单价也重取（花费跟着变）
function UsageChip({ sessionId, usage }: { sessionId: string; usage?: { inputTokens: number; limit: number } }) {
  const [t, setT] = useState<(UsageTotals & { currency: UsageCurrency }) | null>(null)
  const [priceTick, setPriceTick] = useState(0)
  const tick = usage?.inputTokens ?? 0
  useEffect(() => {
    const on = () => setPriceTick((n) => n + 1)
    window.addEventListener(USAGE_PRICES_EVENT, on)
    return () => window.removeEventListener(USAGE_PRICES_EVENT, on)
  }, [])
  useEffect(() => {
    setT(null)   // 切会话先清，晚到的上一个会话用量不能显示到这个会话上
    let alive = true
    client.usage.session(sessionId).then((r) => { if (alive) setT(r) }, () => { if (alive) setT(null) })
    return () => { alive = false }
  }, [sessionId, tick, priceTick])
  if (!t?.requests && !usage) return null
  const K = (n: number) => `${Math.round(n / 1000)}K`
  const pct = usage && usage.limit > 0 ? Math.min(100, Math.round((usage.inputTokens / usage.limit) * 100)) : undefined
  const color = pct === undefined ? '' : pct >= 95 ? 'var(--color-danger)' : pct >= 80 ? 'var(--color-warn)' : 'var(--color-accent)'
  const tip = [
    usage && (usage.limit > 0
      ? tr('上下文 {used} / {limit}（{pct}%），达到上限会自动压缩后继续', { used: K(usage.inputTokens), limit: K(usage.limit), pct: pct ?? 0 })
      : tr('上下文 {used}（未设上限）', { used: K(usage.inputTokens) })),
    t?.requests && tr('本会话 {n} 次请求，共 {total} tokens\n输入 {input}（未命中缓存）\n命中缓存 {cache}（{rate}%）\n输出 {output}\n花费 {cost}', {
      n: t.requests, total: fmtTokens(totalTokens(t)), input: t.input.toLocaleString(), cache: t.cacheRead.toLocaleString(),
      rate: (cacheHitRate(t) * 100).toFixed(1), output: t.output.toLocaleString(), cost: fmtCost(t.cost, t.currency),
    }),
    tr('点击打开用量统计'),
  ].filter(Boolean).join('\n\n')
  return (
    <button data-usage-chip onClick={() => openUsage('session')} title={tip}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] tabular-nums text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]">
      {t?.requests ? <span>{fmtTokens(totalTokens(t))}</span> : null}
      {pct !== undefined && (
        <>
          {/* 圆弧：从 12 点钟顺时针走 pct% */}
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90" aria-hidden>
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" style={{ stroke: 'var(--color-bg-hover)' }} />
            <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(pct, 1)} 100`} style={{ stroke: color }} className="transition-[stroke-dasharray]" />
          </svg>
          <span style={{ color: pct >= 80 ? color : undefined }}>{pct}%</span>
        </>
      )}
      {usage && pct === undefined && !t?.requests && <span>{K(usage.inputTokens)}</span>}
    </button>
  )
}

type SessionModel = ModelMenuProps & { pending: boolean; note?: { ok: boolean; text: string } }
// 当前会话所用模型配置 + 切换。回合进行中切换的标 pending（下一回合生效），回合结束（busy 变化）后重取
function useSessionModel(sessionId: string, busy: boolean, onManage?: () => void): SessionModel {
  const mp = useModelProfiles()
  const [st, setSt] = useState<{ profileId?: string; pending: boolean }>({ pending: false })
  const [note, setNote] = useState<{ ok: boolean; text: string }>()
  const stSid = useRef(sessionId)
  useEffect(() => {
    if (!sessionId) return
    // 切会话先清掉上一个会话的模型 / pending，晚到的响应也不能覆盖新会话
    if (stSid.current !== sessionId) { stSid.current = sessionId; setSt({ pending: false }) }
    let alive = true
    client.modelProfiles.sessionModel(sessionId).then((r) => { if (alive) setSt(r) }, () => { if (alive) setSt({ pending: false }) })
    return () => { alive = false }
  }, [sessionId, busy])
  useEffect(() => { setNote(undefined) }, [sessionId])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(undefined), 4000); return () => clearTimeout(t) }, [note])
  const onPick = (id: string) => {
    const name = mp.profiles.find((p) => p.id === id)?.name ?? id
    client.modelProfiles.setSessionModel(sessionId, id)
      .then((r) => { setSt({ profileId: id, pending: r.pending }); setNote({ ok: true, text: r.pending ? tr('本回合结束后改用「{name}」', { name }) : tr('已切换到「{name}」', { name }) }) })
      .catch((e) => { log.warn('switch model failed', { err: String(e) }); setNote({ ok: false, text: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }) })
  }
  return { profiles: mp.profiles, defaultId: mp.defaultId, current: profileOf(mp, st.profileId), pending: st.pending, note, onPick, onManage }
}

function SessionHeader({ hasSession, sessionId, usage, onExport, postmortem, title, onRename, onNew, models, preview }: {
  preview?: { on: boolean; onToggle: () => void }   // 预演模式（只说不做），会话级
  models?: SessionModel
  postmortem?: PostmortemAction
  hasSession: boolean
  sessionId?: string | null
  usage?: { inputTokens: number; limit: number }
  onExport?: (mode: ExportMode, redact: boolean) => void
  title: string
  onRename?: (t: string) => void
  onNew?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = () => { onRename?.(draft.trim() || title); setEditing(false) }
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2 pl-3">
      {/* 无会话：标题区显示占位，仅保留 新建/历史 入口（其余按钮依赖会话，隐藏） */}
      {!hasSession ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-muted)]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />{tr('暂无会话')}
        </span>
      ) : editing ? (
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false) }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--color-text-primary)] outline-none" />
      ) : (
        <div className="group flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-primary)]">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="truncate" title={titleOf(title)}>{titleOf(title)}</span>
          {/* 只有点铅笔图标才进入编辑，点标题文字不触发（避免误触） */}
          {onRename && (
            <button onClick={() => { setDraft(title); setEditing(true) }} title={tr('重命名')}
              className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-accent)] group-hover:opacity-100">
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {onExport && <ExportMenu onExport={onExport} postmortem={postmortem} />}
        </div>
      )}
      {hasSession && models?.note && <span className={`max-w-[160px] shrink-0 truncate text-[11px] ${models.note.ok ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]'}`} title={models.note.text}>{models.note.text}</span>}
      {hasSession && models && <ModelChip profile={models.current} pending={models.pending} profiles={models.profiles} defaultId={models.defaultId} onPick={models.onPick} onManage={models.onManage} />}
      {hasSession && sessionId && <UsageChip sessionId={sessionId} usage={usage} />}
      {hasSession && preview && (
        <button data-preview-toggle onClick={preview.onToggle} aria-pressed={preview.on}
          title={tr('预演模式（只说不做）：{state}\n开启后本会话的 AI 只做只读排查、把要改的列成方案，不执行任何写操作；回复末尾可勾选步骤再执行', { state: preview.on ? tr('已开') : tr('关') })}
          className={`flex h-7 shrink-0 items-center justify-center gap-1 rounded-md transition-colors ${preview.on ? 'bg-[var(--color-accent-bg)] px-2 text-[11px] font-medium text-[var(--color-accent)]' : 'w-7 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'}`}>
          {/* 烧瓶 = 试运行 / 预演（dry run 的常见图标）；开着时带「预演中」字样，状态一眼能看出 */}
          <FlaskConical className="h-4 w-4" />{preview.on && tr('预演中')}
        </button>
      )}
      <HdrBtn title={tr('新建会话')} onClick={onNew}><Plus className="h-4 w-4" /></HdrBtn>
      {/* 历史会话 / 资源管理器 / 授权 已移到左侧活动栏（App） */}
    </div>
  )
}
type ExportMode = 'chat' | 'report' | 'html'
type PostmortemAction = { off?: string; run: () => void }   // off = 禁用原因
// 导出菜单：仅对话 / 完整报告（Markdown、HTML）/ 故障复盘报告（AI 生成）+ 脱敏开关（默认开）
function ExportMenu({ onExport, postmortem }: { onExport: (mode: ExportMode, redact: boolean) => void; postmortem?: PostmortemAction }) {
  const [open, setOpen] = useState(false)
  const [redact, setRedact] = useState(true)
  const pick = (m: ExportMode) => { setOpen(false); onExport(m, redact) }
  const item = 'block w-full rounded px-2 py-1 text-left hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'
  return (
    <span className="relative flex shrink-0">
      <button onClick={() => setOpen((o) => !o)} title={tr('导出会话')}
        className={`flex h-5 w-5 items-center justify-center text-[var(--color-text-muted)] transition-opacity hover:text-[var(--color-accent)] group-hover:opacity-100 ${open ? 'opacity-100' : 'opacity-0'}`}>
        <Download className="h-3 w-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-5 z-50 w-52 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] p-1 text-[12px] font-normal text-[var(--color-text-secondary)] shadow-lg">
            <button className={item} onClick={() => pick('chat')}>{tr('仅对话（Markdown）')}</button>
            <button className={item} onClick={() => pick('report')} title={tr('概要 + 对话 + 执行记录 + 文件改动 + 授权记录')}>{tr('完整报告（Markdown）')}</button>
            <button className={item} onClick={() => pick('html')}>{tr('完整报告（HTML）')}</button>
            {postmortem && (
              <button data-export-postmortem className={`${item} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-secondary)]`} disabled={!!postmortem.off}
                onClick={() => { setOpen(false); postmortem.run() }}
                title={postmortem.off ?? tr('由 AI 按复盘模板（影响、时间线、根因、处理过程、恢复验证、改进项）整理本会话；时间线取自执行记录的真实时间。生成后在回复下方「保存为文件」')}>
                {tr('故障复盘报告（Markdown）')}
              </button>
            )}
            <label className="mt-1 flex cursor-pointer items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2 pt-1.5 text-[11px] text-[var(--color-text-muted)]" title={tr('密码、令牌、私钥、sk-/AKIA 密钥等替换为 [已脱敏]')}>
              <Checkbox checked={redact} onCheckedChange={setRedact} />{tr('脱敏敏感信息')}
            </label>
          </div>
        </>
      )}
    </span>
  )
}

function HdrBtn({ title, onClick, children }: { title: string; onClick?: () => void; children: React.ReactNode }) {
  return <button title={title} onClick={onClick} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">{children}</button>
}

// 等待插入的追问：已交给 AI，当前步骤结束后、下一次请求前送达；送达前可撤回（文字放回输入框）
// ponytail: 撤回只放回文字，附件不回填（追问很少带附件）；要回填再接 att 的恢复
function SteeringMessages({ items, authWaiting, onWithdraw }: { items: { key: string; sent: boolean; text: string }[]; authWaiting: boolean; onWithdraw: (key: string) => void }) {
  return (
    <div data-steering className="mx-3 mt-1 rounded-md border border-dashed border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] px-3 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
        <CornerDownRight className="h-3 w-3 text-[var(--color-accent)]" />{tr('等待插入（当前步骤结束后送达，AI 接着这一轮处理）')}
      </div>
      {items.map((t) => (
        <div key={t.key} data-steer-item className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-secondary)]" title={t.text}>{t.text}</div>
          <button data-steer-withdraw onClick={() => onWithdraw(t.key)} title={tr('撤回：不发了，文字放回输入框')} className="shrink-0 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]">{tr('撤回')}</button>
        </div>
      ))}
      {authWaiting && <div data-steer-auth-hint className="mt-1 text-[11px] text-[var(--color-warn)]">{tr('AI 正在等你处理上面的卡片，追问要等它处理完才送达；要阻止那条命令请直接点「拒绝」。')}</div>}
    </div>
  )
}

function QueuedMessages({ texts, onWithdraw }: { texts: string[]; onWithdraw: (i: number) => void }) {
  return (
    <div className="mx-3 mt-1 rounded-md border border-dashed border-[var(--color-border-default)] px-3 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
        <Clock className="h-3 w-3" />{tr('待发送（本轮结束后依次发出，可撤回）')}
      </div>
      {texts.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-secondary)]" title={t}>{t}</div>
          <button onClick={() => onWithdraw(i)} title={tr('撤回：不发了，文字放回输入框')} className="shrink-0 rounded px-1.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]">{tr('撤回')}</button>
        </div>
      ))}
    </div>
  )
}

function WorkingIndicator() {
  return (
    <div className="flex items-center gap-2 px-5 py-1.5 text-[12px] text-[var(--color-text-muted)]">
      <Loader2 className="h-3 w-3 animate-spin-slow text-[var(--color-accent)]" />
      <span className="animate-pulse-dim">{tr('AI 工作中…')}</span>
    </div>
  )
}

// 系统提示：居中的一行说明，不挂在 AI 回合下，也不是错误气泡
function SystemNotice({ text }: { text: string }) {
  return (
    <div data-system-notice className="mx-4 my-2 flex items-start gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="min-w-0 break-all">{text}</span>
    </div>
  )
}

// 覆盖层从 header 下面开始（top-10 = header 高度）：出错/加载时「新建会话」「历史会话」等入口仍可点，不会把人困住
function Overlay({ phase, onOpenSettings, onRetry, onNew, onBack, onOpenHistory }: { phase: { phase: string; message?: string }; onOpenSettings?: () => void; onRetry: () => void; onNew?: () => void; onBack?: () => void; onOpenHistory?: () => void }) {
  const btn = 'rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]'
  return (
    <div className="absolute inset-x-0 bottom-0 top-10 z-10 flex flex-col items-center justify-center bg-[color:color-mix(in_srgb,var(--color-bg-panel)_95%,transparent)] backdrop-blur-sm">
      {phase.phase === 'starting' && (
        <>
          <Loader2 className="h-7 w-7 animate-spin-slow text-[var(--color-accent)]" />
          <div className="mt-3.5 text-[13px] text-[var(--color-text-primary)]">{tr('正在加载会话…')}</div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('读取对话历史并连接终端工具')}</div>
        </>
      )}
      {phase.phase === 'no-key' && (
        <>
          <KeyRound className="h-7 w-7 text-[var(--color-warn)]" />
          <div className="mt-3 text-[13px] text-[var(--color-text-primary)]">{tr('还没配置 API Key')}</div>
          <button onClick={onOpenSettings} className="mt-4 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)]">{tr('打开设置')}</button>
        </>
      )}
      {phase.phase === 'error' && (
        <>
          <AlertTriangle className="h-7 w-7 text-[var(--color-danger)]" />
          <div className="mt-3 max-w-xs px-4 text-center text-[12px] text-[var(--color-danger)]">{phase.message}</div>
          <div className="mt-4 flex flex-wrap justify-center gap-2 px-4">
            <button onClick={onRetry} className={btn}>{tr('重试')}</button>
            {onNew && <button onClick={onNew} className={btn}>{tr('新建会话')}</button>}
            {onBack && <button onClick={onBack} className={btn}>{tr('返回上一个会话')}</button>}
            {onOpenHistory && <button onClick={onOpenHistory} className={btn}>{tr('历史会话')}</button>}
          </div>
        </>
      )}
    </div>
  )
}
