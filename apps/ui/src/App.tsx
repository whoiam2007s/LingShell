import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, History, ShieldCheck } from 'lucide-react'
import { ActivityBar, ActBtn } from './components/ActivityBar.js'
import { ChatPanel, errToPhase, logSessionFailure, needsApiKeySetup } from './features/chat/index.js'
import { SessionDrawer } from './features/sessions/index.js'
import { HistoryDrawer } from './features/sessions/index.js'
import { AuthDrawer } from './features/auth/index.js'
import { ExplorerDrawer } from './features/explorer/index.js'
import { getLastDir } from './features/explorer/index.js'
import { UploadDialog } from './features/explorer/index.js'
import { DirSyncDialog } from './features/explorer/index.js'
import { UsageModal } from './features/usage/index.js'
import { openUsage } from './features/usage/index.js'
import { ConfirmDialog } from './features/common/index.js'
import { TransferToast } from './features/transfer/index.js'
import { TerminalView } from './features/terminals/index.js'
import { HostKeyDialogs } from './features/terminals/index.js'
import { SshUrlHandler } from './features/terminals/index.js'
import { SettingsModal, type SettingsTab, type SettingsFocus } from './features/settings/index.js'
import { TitleBar } from './features/shell/index.js'
import { CommandPalette, isPaletteKey } from './features/shell/index.js'
import { HelpModal, isHelpKey } from './features/help/index.js'
import type { HelpTarget } from './features/help/index.js'
import { HostPanel, type HostPanelTab } from './features/hosts/index.js'
import { SessionProvider, useSession } from './lib/sessionContext.js'
import { useResizable } from './lib/useResizable.js'
import { isAction, loadKeybindings } from './lib/keybindings.js'
import { closePalette, paletteCtx, paletteSend } from './lib/paletteBus.js'
import { onSendToChat, onSendToNewChat, takeNewChatSend, sendToChat } from './lib/sendToChat.js'
import type { SessionPhase } from './features/chat/index.js'
import { tr, type SessionMeta } from '@lingshell/shared'
import { client } from './client/index.js'
import { logger } from './lib/logger.js'
import { BookMarked } from 'lucide-react'
import { KnowledgeModal } from './features/knowledge/index.js'
import { openKnowledge } from './features/knowledge/index.js'
import { DashboardModal } from './features/dashboard/index.js'
import { closeDashboard, openDashboard } from './features/dashboard/index.js'
import { RunbookViewModal } from './features/runbooks/index.js'
import { ComplianceBatchModal } from './features/hostcheck/index.js'
import { DeployReviewModal } from './features/deployReview/index.js'
import { RUNBOOK_VIEW_EVENT } from './features/runbooks/index.js'
import { COMPLIANCE_BATCH_EVENT } from './features/hostcheck/index.js'
import { TrayBridge } from './features/shell/index.js'

const MIN_PANE = 500          // 会话面板/终端各自最小宽度
const DEFAULT_CHAT_WIDTH = 560 // 会话面板默认宽度（未持久化时）

const log = logger.scope('app')

export function App() {
  return (
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  )
}

// 会话生命周期 + 三栏布局。放 SessionProvider 内以便用 useSession 同步活动会话给授权弹窗。
function AppShell() {
  const { setSessionId: setCtxSession } = useSession()
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('model')   // 打开设置时的初始页（模板/巡检入口直达）
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>()   // 命令面板搜到的设置项：打开后定位到它
  const [sshNewHostSeq, setSshNewHostSeq] = useState(0)   // 主机面板「+」：设置打开到主机页后直接进新建表单
  const openSettingsAt = (tab: SettingsTab, focus?: Omit<SettingsFocus, 'n'>) => { setSettingsTab(tab); setSettingsFocus(focus && { ...focus, n: Date.now() }); setShowSettings(true) }
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  // 事件订阅只挂一次：通知点击 / 托盘动作里要用最新的会话列表和当前会话
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions
  const activeRef = useRef('');
  const [activeId, setActiveIdState] = useState('')
  const [phase, setPhase] = useState<SessionPhase>({ phase: 'starting' })
  const [drawer, setDrawer] = useState<'history' | 'auth' | 'explorer' | null>(null)
  const [explorerWide, setExplorerWide] = useState(false)   // 资源管理器开着详细信息列时抽屉加宽
  const [delTarget, setDelTarget] = useState<{ id: string; title: string } | null>(null)
  const [historyQuery, setHistoryQuery] = useState<string>()   // 命令面板「搜索历史会话内容」带进历史抽屉的词
  useEffect(() => { if (drawer !== 'history') setHistoryQuery(undefined) }, [drawer])
  const [uploadPaths, setUploadPaths] = useState<string[] | null>(null)   // 会话侧资源管理器（本地 FS）要上传的项，同终端本地侧逻辑

  const setActiveId = (id: string) => { setActiveIdState(id); setCtxSession(id) }
  activeRef.current = activeId
  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? ''
  const activeWorkDir = sessions.find((s) => s.id === activeId)?.workDir
  // 资源管理器：这个对话上次停在的目录，没有就用工作目录（每次打开 / 切对话时取一次）
  const explorerRoot = useMemo(() => (drawer === 'explorer' ? getLastDir(`session:${activeId}`) ?? activeWorkDir : undefined), [drawer, activeId, activeWorkDir])

  // 会话面板 ↔ 终端 可拖拽分割。宽度从持久化恢复（chatWidth），拖动松手后回存。
  const bodyRef = useRef<HTMLDivElement>(null)
  const [initialChatWidth, setInitialChatWidth] = useState(DEFAULT_CHAT_WIDTH)
  const { width: chatWidth, onMouseDown: onSplitDrag } = useResizable({
    initial: initialChatWidth,
    min: MIN_PANE,
    containerRef: bodyRef,
    onCommit: (w) => client.layout.save({ chatWidth: w }).catch(() => {}),
  })

  const refreshSessions = async () => {
    const list = await client.agent.listPersisted().catch(() => [] as SessionMeta[])
    setSessions(list)
    return list
  }

  // 重连历史会话（懒加载：只重连选中的）。切换即收起抽屉。
  // 快速连点 A→B：A 的重连晚到时不能覆盖 B 的 phase/layout → 只认最后一次请求
  const selectSeq = useRef(0)
  // 最近一个成功打开的会话：重连失败时「返回上一个会话」回到它
  const lastReady = useRef('')
  const selectSession = async (id: string) => {
    const seq = ++selectSeq.current
    setActiveId(id)
    setDrawer(null)
    setPhase({ phase: 'starting' })
    try {
      await client.agent.reconnectSession(id)
      if (seq !== selectSeq.current) return
      setPhase({ phase: 'ready' })
      lastReady.current = id
      client.layout.save({ activeSessionId: id }).catch(() => {})
    } catch (e) {
      log.error('reconnect failed', { id, e: String(e) })
      if (seq === selectSeq.current) setPhase(errToPhase(e))
    }
  }

  // 选工作目录 → setWorkDir（后端重启会话应用）。重启期间前端设 starting 显 loading。
  const pickWorkDir = async () => {
    if (!activeId) return
    const sid = activeId, seq = selectSeq.current   // 选目录期间切了会话 → 别改新会话的 phase
    const dir = await client.system.pickDirectory().catch(() => undefined)
    if (!dir) return
    setPhase({ phase: 'starting' })
    try {
      await client.agent.setWorkDir(sid, dir)
      await refreshSessions()
      if (seq !== selectSeq.current) return
      setPhase({ phase: 'ready' })
    } catch (e) { log.error('setWorkDir failed', { e: String(e) }); if (seq === selectSeq.current) setPhase(errToPhase(e)) }
  }

  const newSession = async (title = '新会话' /* i18n-ignore 存盘的默认标题，下面按它判断是否自动命名；显示处 tr() */): Promise<string | undefined> => {
    const seq = ++selectSeq.current   // 作废在途的 selectSession，免得它晚到后覆盖新会话的 phase
    setPhase({ phase: 'starting' })
    try {
      const s = await client.agent.createSession({ title })
      await refreshSessions()
      // 期间用户已经在历史里选了别的会话：新会话照建，但不要把它抢成当前会话（以前会抢，还盖掉对方的 phase）
      if (seq !== selectSeq.current) return s.id
      setActiveId(s.id)
      setPhase({ phase: 'ready' })
      lastReady.current = s.id
      client.layout.save({ activeSessionId: s.id }).catch(() => {})
      return s.id
    } catch (e) { logSessionFailure(log, e); if (seq === selectSeq.current) setPhase(errToPhase(e)) }
  }

  // 删除会话（二次确认后调用）。确认由 ConfirmDialog 触发，delTarget 携带待删会话。
  const confirmDelete = async () => {
    if (!delTarget) return
    const id = delTarget.id
    setDelTarget(null)
    // 确认框开着时外部事件（通知 / 巡检）可能切了会话：当前会话在列表里本来就不给删，这里再确认一次
    if (id === activeId) return
    await client.agent.deleteSession(id).catch(() => {})
    await refreshSessions()
  }

  const renameSession = async (id: string, title: string) => {
    await client.agent.renameSession(id, title).catch(() => {})
    refreshSessions()
  }

  // 首条消息自动命名会话：仅当标题仍是默认「新会话」时，用消息前 20 字作标题
  const onFirstUserMessage = (sid: string, text: string) => {
    const cur = sessions.find((s) => s.id === sid)
    // 列表里还没有（如刚分叉出的会话，回调闭包里的列表是旧的）也不改：只给标题仍是「新会话」的命名
    if (!cur || cur.title !== '新会话') return   // i18n-ignore 默认标题判断
    const title = text.replace(/\s+/g, ' ').slice(0, 20)
    renameSession(sid, title)
  }

  // 启动恢复：拉持久化列表 → 选 layout.activeSessionId（或第一个）重连 → 无历史则新建
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return   // StrictMode 双跑守卫：启动恢复只做一次，否则会重复建会话/重连进程
    bootstrapped.current = true
    ;(async () => {
      try {
        const list = await refreshSessions()
        const layout = await client.layout.get().catch(() => ({ terminals: [] as never[] }))
        const cw = (layout as { chatWidth?: number }).chatWidth
        if (cw && cw >= MIN_PANE) setInitialChatWidth(cw)
        const wanted = (layout as { activeSessionId?: string }).activeSessionId
        const target = wanted && list.find((s) => s.id === wanted) ? wanted : list[0]?.id
        if (target) await selectSession(target)
        else {
          // 没配 Key 是正常的首次启动状态：界面显示配置引导，不去建会话（否则只会在日志里留一条失败）
          const s = await client.settings.get().catch(() => undefined)
          if (s && needsApiKeySetup(s)) setPhase({ phase: 'no-key' })
          else await newSession()
        }
      } catch (e) { setPhase(errToPhase(e)) }
    })()
  }, [])

  // 命令面板：捕获阶段监听，赶在 xterm 之前；Ctrl+K 在终端里不拦（见 isPaletteKey）
  // 锁定中不响应且收起面板：应用层被 LockGate 藏起时快捷键仍会到这里，打开的面板看不见、拉数据的 IPC 被拒，解锁后会冒出一个空面板
  // 使用帮助同理：F1（焦点在终端时放给终端程序，见 isHelpKey）
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState<boolean | HelpTarget>(false)   // HelpTarget = 从命令面板的帮助结果打开并定位
  // 主机面板（标题栏「主机」按钮 / Ctrl+Shift+H）：浮层盖在会话面板左上，不改三栏布局
  const [hostPanel, setHostPanel] = useState<{ tab: HostPanelTab; save?: boolean } | null>(null)
  // 锁定应用快捷键：捕获阶段拦（终端有焦点也生效、不漏给 shell）；未启用应用锁时放行给终端。
  // 是否启用缓存在这里：启动、锁状态变化、关设置弹窗（应用锁在设置里开关）时刷新
  const lockOn = useRef(false)
  const refreshLockOn = () => { client.lock.status().then((s) => { lockOn.current = s.enabled }).catch(() => {}) }
  useEffect(() => { if (!showSettings) refreshLockOn() }, [showSettings])
  useEffect(() => {
    let locked = false
    loadKeybindings()
    const offLock = client.on((ev) => { if (ev.type === 'app:lock') { locked = ev.locked; refreshLockOn(); if (locked) { setPalette(false); setHelp(false); setHostPanel(null) } } })
    // 已经有任意弹层时不要再往上叠（否则新弹层在下面、焦点被抢走，看不见的输入框会吃掉按键）
    const anyOverlay = () => !!document.querySelector('.fixed.inset-0')
    const onKey = (e: KeyboardEvent) => {
      if (locked) return
      if (lockOn.current && isAction(e, 'app.lock')) {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) client.lock.lock().catch(() => {})
        return
      }
      if (isHelpKey(e)) {
        e.preventDefault()
        if (!e.repeat) { if (document.querySelector(`[aria-label="${tr('使用帮助')}"]`)) setHelp(false); else if (!anyOverlay()) setHelp(true) }
        return
      }
      if (isAction(e, 'settings')) {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) { if (document.querySelector('[data-settings-scroll]')) setShowSettings(false); else if (!anyOverlay()) setShowSettings(true) }
        return
      }
      if (isAction(e, 'focus.chat')) {
        e.preventDefault(); e.stopPropagation()
        if (!anyOverlay()) document.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.focus()
        return
      }
      if (isAction(e, 'hostPanel')) {
        e.preventDefault(); e.stopPropagation()
        if (!e.repeat) {
          if (document.querySelector(`[role=dialog][aria-label="${tr('主机面板')}"]`)) setHostPanel(null)
          else if (!anyOverlay()) setHostPanel({ tab: 'hosts' })
        }
        return
      }
      if (!isPaletteKey(e)) return
      e.preventDefault(); e.stopPropagation()
      if (e.repeat) return
      if (document.querySelector(`[aria-label="${tr('命令面板')}"]`)) closePalette()   // 面板自己关：焦点还给原处
      else if (!anyOverlay()) setPalette(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { offLock(); window.removeEventListener('keydown', onKey, true) }
  }, [])
  // 面板里选了东西：先收起设置弹窗（否则会挡住要去的地方），抽屉直接打开而非切换
  // 面板里选了东西：先收起会挡住的弹层（设置 / 帮助 / 仪表盘），抽屉直接打开而非切换
  const fromPalette = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => { setShowSettings(false); setHelp(false); closeDashboard(); f(...a) }

  // 定时巡检：新建了巡检会话 → 刷新会话列表；点了巡检通知 → 打开那个会话
  // 新一轮开始：「最近活动」变了（发送时主进程 touch），刷新列表让会话时间跟上
  useEffect(() => client.on((ev) => {
    if (ev.type === 'inspection:run' || ev.type === 'agent:turnStarted') void refreshSessions()
    else if (ev.type === 'inspection:openSession') {
      // 通知 / 托盘点击：先收起挡在前面的弹窗，再切会话
      setShowSettings(false); setHelp(false); setPalette(false); closeDashboard()
      // 会话可能已经被删（Action Center 里的旧通知 / 托盘缓存）：不要切过去触发「会话不存在」错误页
      if (!sessionsRef.current.some((s) => s.id === ev.sessionId)) { void refreshSessions(); return }
      if (ev.sessionId !== activeRef.current) void selectSession(ev.sessionId)
    }
  }), [])

  // 终端「让 AI 排查」要直接发到对话：没有会话（且不在启动 / 新建中）就新建一个，消息排着等它就绪（见 sendToChat.ts）
  const liveRef = useRef({ activeId, phase }); liveRef.current = { activeId, phase }
  useEffect(() => onSendToChat(() => {
    const { activeId: a, phase: p } = liveRef.current
    if (!a && p.phase !== 'starting') void newSession()
  }), [])
  // 手册视图 / 批量合规检查从设置里打开：先收起设置（它盖在上面）
  useEffect(() => {
    const f = () => setShowSettings(false)
    window.addEventListener(RUNBOOK_VIEW_EVENT, f); window.addEventListener(COMPLIANCE_BATCH_EVENT, f)
    return () => { window.removeEventListener(RUNBOOK_VIEW_EVENT, f); window.removeEventListener(COMPLIANCE_BATCH_EVENT, f) }
  }, [])
  // 告警「用 AI 排查」：新建会话（标题 = 排查：主机 告警），新会话就绪后再转入发送队列（早了会被旧会话收走）。
  // 按会话 id 分别排队：连着点几个告警、几个新会话同时在建时，先建好的那条不能被后一条顶掉
  const newChatQueue = useRef(new Map<string, string>())
  const [newChatTick, setNewChatTick] = useState(0)
  useEffect(() => onSendToNewChat(() => {
    const next = takeNewChatSend()
    if (!next) return
    setShowSettings(false)
    void newSession(next.title).then((sid) => { if (sid) { newChatQueue.current.set(sid, next.text); setNewChatTick((n) => n + 1) } })
  }), [])
  useEffect(() => {
    if (!activeId || phase.phase !== 'ready') return
    const text = newChatQueue.current.get(activeId)
    if (text === undefined) return
    newChatQueue.current.delete(activeId)
    setTimeout(() => sendToChat(text), 0)
  }, [activeId, phase, newChatTick])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg-base)] text-[var(--color-text-primary)] animate-fade-in">
      <TitleBar onOpenSettings={() => setShowSettings(true)} onOpenPalette={() => setPalette(true)} onOpenHelp={() => setHelp(true)} onOpenUsage={() => openUsage()}
        hostsOpen={!!hostPanel} onToggleHosts={() => setHostPanel((p) => (p ? null : { tab: 'hosts' }))} onOpenDashboard={() => { setHostPanel(null); openDashboard() }} />
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {hostPanel && <HostPanel key={`${hostPanel.tab}:${hostPanel.save ?? ''}`} initialTab={hostPanel.tab} saveWorkspace={hostPanel.save}
          onClose={() => setHostPanel(null)} onEditHosts={() => openSettingsAt('ssh')}
          onNewHost={() => { setSettingsTab('ssh'); setSettingsFocus(undefined); setSshNewHostSeq(Date.now()); setShowSettings(true) }} />}
        {/* 会话面板（对话 + header 都在 ChatPanel 内）。宽度可拖拽（含左侧活动栏），抽屉浮层贴活动栏右侧滑出 */}
        <div className="flex h-full shrink-0 overflow-hidden" style={{ width: chatWidth }}>
        <ActivityBar side="left">
          {/* 顺序与右侧终端活动栏一致：资源管理器 → 历史；资源管理器/授权依赖当前会话，无会话时隐藏 */}
          {activeId && <ActBtn title={tr('资源管理器（会话工作目录）')} active={drawer === 'explorer'} onClick={() => setDrawer((d) => (d === 'explorer' ? null : 'explorer'))}><FolderTree className="h-4 w-4" /></ActBtn>}
          <ActBtn title={tr('历史会话')} active={drawer === 'history'} onClick={() => setDrawer((d) => (d === 'history' ? null : 'history'))}><History className="h-4 w-4" /></ActBtn>
          {activeId && <ActBtn title={tr('会话授权 / 执行记录')} active={drawer === 'auth'} onClick={() => setDrawer((d) => (d === 'auth' ? null : 'auth'))}><ShieldCheck className="h-4 w-4" /></ActBtn>}
          <ActBtn title={tr('知识库（主机 / 分组 / 全局知识卡）')} onClick={() => openKnowledge()}><BookMarked className="h-4 w-4" /></ActBtn>
        </ActivityBar>
        <div className="relative h-full min-w-0 flex-1 overflow-hidden">
          <ChatPanel
            activeSessionId={activeId}
            sessionPhase={phase}
            sessionTitle={activeTitle}
            workDir={activeWorkDir}
            onPickWorkDir={pickWorkDir}
            onRename={(t) => renameSession(activeId, t)}
            onNew={() => { void newSession() }}
            onOpenHistory={() => setDrawer((d) => (d === 'history' ? null : 'history'))}
            onOpenSettings={() => setShowSettings(true)}
            onManageTemplates={() => openSettingsAt('templates')}
            onManageRunbooks={() => openSettingsAt('runbooks')}
            onManageModels={() => openSettingsAt('model')}
            onManageSkills={() => openSettingsAt('skills')}
            onRetry={() => (activeId ? selectSession(activeId) : newSession())}
            onBack={lastReady.current && lastReady.current !== activeId && sessions.some((s) => s.id === lastReady.current) ? () => selectSession(lastReady.current) : undefined}
            onFirstUserMessage={onFirstUserMessage}
            onOpenSession={async (id) => { await refreshSessions(); await selectSession(id) }}
          />
          {/* 右滑抽屉（历史/授权）：绝对定位浮层，覆盖会话面板右侧，不占布局 */}
          <SessionDrawer open={drawer !== null} onClose={() => setDrawer(null)} widthClass={drawer === 'explorer' && explorerWide ? 'w-[520px]' : undefined}>
            {drawer === 'history' && (
              <HistoryDrawer
                sessions={sessions}
                activeId={activeId}
                onSelect={selectSession}
                onRename={renameSession}
                onDelete={(id, title) => setDelTarget({ id, title })}
                onClose={() => setDrawer(null)}
                initialQuery={historyQuery}
              />
            )}
            {drawer === 'auth' && <AuthDrawer onClose={() => setDrawer(null)} />}
            {drawer === 'explorer' && (
              <ExplorerDrawer scope="local" rootPath={explorerRoot} memKey={`session:${activeId}`} onWide={setExplorerWide} onUpload={setUploadPaths} onClose={() => setDrawer(null)} />
            )}
          </SessionDrawer>
        </div>
        </div>
        {/* 可拖拽分割线：调整会话面板 ↔ 终端 宽度 */}
        <div onMouseDown={onSplitDrag} title={tr('拖动调整宽度')}
          className="group relative w-px shrink-0 cursor-col-resize bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent)]">
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>
        {/* 终端 */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <TerminalView />
        </div>
        {showSettings && (
          <SettingsModal
            initialTab={settingsTab}
            focus={settingsFocus}
            sshNewHost={sshNewHostSeq}
            onClose={() => { setShowSettings(false); setSettingsTab('model'); setSettingsFocus(undefined); setSshNewHostSeq(0) }}
            onOpenSession={(sid) => { setShowSettings(false); setSettingsTab('model'); void selectSession(sid) }}
            // 关于页的「使用帮助」：帮助弹窗在设置之后渲染，会盖在设置上面；Esc 关掉帮助后仍回到设置
            onOpenHelp={() => setHelp(true)}
            // 只有此前没有可用会话（缺 key / 启动出错）时才重试；正常会话里改设置不新建、不切换
            onSaved={() => { if (phase.phase === 'no-key' || phase.phase === 'error') { if (activeId) selectSession(activeId); else newSession() } }}
          />
        )}
        {/* 放在设置之后：两者都开时帮助盖在上面；「去设置」先收起帮助 */}
        {help && <HelpModal target={help === true ? undefined : help} onClose={() => setHelp(false)} onOpenSettings={(tab) => { setHelp(false); openSettingsAt(tab) }}
          // 正文链接：关掉帮助（和设置弹窗），再直达对应功能。终端区动作走命令面板同一通道
          onAction={(a) => {
            setHelp(false)
            if (a.kind === 'settings') { openSettingsAt(a.tab); return }
            setShowSettings(false)
            if (a.kind === 'drawer') setDrawer(a.drawer)
            else if (a.kind === 'openPalette') setPalette(true)
            else if (a.kind === 'usage') openUsage()
            else if (a.kind === 'explorer') { if (paletteCtx.term) paletteSend({ type: 'termDrawer', drawer: 'explorer' }); else setDrawer('explorer') }
            else paletteSend(a.cmd)
          }} />}
        <ConfirmDialog
          open={!!delTarget}
          title={tr('删除会话')}
          message={tr('确定删除会话 {title}？此操作不可恢复，该会话的对话历史将永久删除。', { title: tr(delTarget?.title ?? '') })}
          onConfirm={confirmDelete}
          onCancel={() => setDelTarget(null)}
        />
        {uploadPaths && <UploadDialog localPaths={uploadPaths} onClose={() => setUploadPaths(null)} />}
        <TransferToast />
        <HostKeyDialogs />
        <SshUrlHandler />
        <DirSyncDialog />
        {/* 用量统计弹窗：openUsage() 打开；点会话名 → 收起设置并切到该会话 */}
        <UsageModal onOpenSession={(sid) => { setShowSettings(false); void selectSession(sid) }} />
        <KnowledgeModal />
        <DashboardModal />
        <RunbookViewModal />
        <ComplianceBatchModal />
        <DeployReviewModal />
        <TrayBridge onNewSession={() => { setHelp(false); setPalette(false); closeDashboard(); void newSession() }} onOpenSettings={() => openSettingsAt('general')}
          onCloseOverlays={() => { setShowSettings(false); setHelp(false); setPalette(false); closeDashboard() }} />
        {palette && (
          <CommandPalette sessions={sessions} activeSessionId={activeId} onClose={() => setPalette(false)}
            onSelectSession={fromPalette((id: string) => { void selectSession(id) })}
            onOpenSettings={fromPalette((tab: SettingsTab, focus?: Omit<SettingsFocus, 'n'>) => setTimeout(() => openSettingsAt(tab, focus), 0))}
            onOpenHelp={(t?: HelpTarget) => { setShowSettings(false); closeDashboard(); setHelp(t ?? true) }}
            onOpenHosts={fromPalette((tab: HostPanelTab, save?: boolean) => setHostPanel({ tab, save }))}
            onDrawer={fromPalette(setDrawer)} onNewSession={fromPalette(() => { void newSession() })}
            onSearchHistory={fromPalette((q: string) => { setHistoryQuery(q); setDrawer('history') })} />
        )}
      </div>
    </div>
  )
}
