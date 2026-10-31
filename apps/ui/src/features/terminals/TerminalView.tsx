import { useEffect, useRef, useState } from 'react'
import { TerminalSquare, Plus, X, Server, MonitorDot, RotateCw, History, FolderTree, AlertTriangle, Columns2, Columns3, Rows2, Grid2x2, Radio, Circle, Square } from 'lucide-react'
import { FileText, Container, Pin, BellRing, Cpu, EthernetPort } from 'lucide-react'
import { ActivityBar, ActBtn, ActSep } from '../../components/ActivityBar.js'
import { ConfirmDialog } from '../common/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { dockerSupported, processSupported, portsSupported, tk, tr } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'
import { PortsDrawer } from './drawers/PortsDrawer.js'
import { HostCheckDrawer } from '../hostcheck/index.js'
import { Stethoscope } from 'lucide-react'
import { hostCheckSupported } from '@lingshell/shared'
import { DockerDrawer } from './drawers/DockerDrawer.js'
import { ProcessDrawer } from './drawers/ProcessDrawer.js'
import { ServiceDrawer } from './drawers/ServiceDrawer.js'
import { ServerCog } from 'lucide-react'
import { systemdSupported, cdCommand } from '@lingshell/shared'
import { TableViewerHost } from '../table/index.js'
import type { AppLayout, TerminalInfo, HostSummary, TabMeta, SplitMode } from '@lingshell/shared'
import { ComposeBar, ComposeToggle, toggleCompose } from './ComposeBar.js'
import { shellKind, moveTab, pinFirst, clampTabDrop, pinnedLabel, termEnvLabel, statsSummary, tabAccent, toLayoutItem, EMPTY_VIEW, activate, assign, dropTerm, setMode, restoreView, toSplitLayout, neighborPane, paneCell, paneCount, splitTracks, dividerAxis, clampDivider, defaultSizes, focusedId, type PaneView } from '@lingshell/shared'
import { TabMenu, TabTitleInput } from './TabMenu.js'
import { TmuxCloseDialog } from './TmuxParts.js'
import { client } from '../../client/index.js'
import { keyHint, keyLabel } from '../../lib/keybindings.js'
import { TerminalPane } from './pane/TerminalPane.js'
import { SshConnectDialog } from './ssh/SshConnectDialog.js'
import { SavedHostList, ProdBadge, EncodingBadge, HostGroups } from '../../components/sshParts.js'
import { TerminalDrawer } from './drawers/TerminalDrawer.js'
import { CommandHistoryDrawer } from './drawers/CommandHistoryDrawer.js'
import { ExplorerDrawer } from '../explorer/index.js'
import { DualPane } from '../explorer/index.js'
import { getLastDir } from '../explorer/index.js'
import { UploadDialog } from '../explorer/index.js'
import { loadTermPrefs, useTermPrefs, useTermBadges, BADGE_CLS } from '../../lib/termPrefs.js'
import { copyBuffer, saveBuffer } from './pane/BufferExport.js'
import { useTerminalShortcuts } from './useTerminalShortcuts.js'
import { QuickCommandBar } from './quick/QuickCommandBar.js'
import { onPalette, type PaletteCmd } from '../../lib/paletteBus.js'
import { TransferButton, TransferPanel } from '../transfer/index.js'
import { HostStatsTags, useHostStats, useWatchStats } from './HostStatsStrip.js'
import { LocalShellItems } from './LocalShellItems.js'
import { GitBashMissing } from './GitBashMissing.js'
import { FileCompareButton, FileCompareDialog } from './batch/FileCompareDialog.js'
import { BatchExecButton, BatchExecDialog } from './batch/BatchExecDialog.js'
import { openLayoutItems, recordRecentHost } from '../hosts/index.js'
import type { WorkspaceLayout } from '@lingshell/shared'
import { getTermCwd, onTermCwd, clearTermCwd, shellQuotePaths } from '../../lib/termCwd.js'
import { LogButton, LogViewerHost } from '../logs/index.js'
import { MultiLogDialog } from '../logs/index.js'
import { ConnProbeDialog } from './batch/ConnProbeDialog.js'
import { getActiveTerminal } from '../../lib/activeTerminal.js'
import { ReplayButton, ReplayHost } from './pane/InstantReplay.js'
import { AlertsDrawer } from './drawers/AlertsDrawer.js'
import { useAlertHits } from './alertHits.js'
import { Siren } from 'lucide-react'
import { MoreViewsButton, isOpsView, opsViewsFor, type OpsView } from '../opsviews/index.js'
import { DatabaseDrawer } from '../database/index.js'
import { DiskUsageDrawer } from '../opsviews/index.js'
import { VscodeRemoteHost } from '../../components/VscodeRemote.js'
import { CronDrawer } from '../opsviews/index.js'
import { FirewallDrawer } from '../opsviews/index.js'
import { TopologyDrawer } from '../opsviews/index.js'
import { BookOpenText, ClipboardCheck } from 'lucide-react'
import { openRunbookView } from '../runbooks/index.js'
import { openDeployReview } from '../deployReview/index.js'
import { GitBranch } from 'lucide-react'
import { GitDrawer } from '../git/index.js'
import { ApiDebugButton, ApiDebugDialog } from '../apidebug/index.js'
import { K8sDrawer } from '../k8s/index.js'

// 从系统拖进来的文件取本地路径（preload 里 webUtils.getPathForFile）
const pathForFile = (f: File) => (window as unknown as { electronAPI?: { pathForFile?: (f: File) => string } }).electronAPI?.pathForFile?.(f) ?? ''
// 拖标签：自定义 MIME，与系统拖进来的文件（'Files'）区分
const TAB_MIME = 'application/x-lingshell-tab'
const isTabDrag = (ev: React.DragEvent) => ev.dataTransfer.types.includes(TAB_MIME)

// 终端标签展示：名称（类型）。SSH 的 title 已是 user@host，类型显示 SSH。
const TYPE_LABEL: Record<string, string> = { local: tk('本地终端'), ssh: 'SSH' }
function termLabel(t: TerminalInfo) { return tr('{name}（{detail}）', { name: t.title, detail: tr(TYPE_LABEL[t.type] ?? t.type) }) }
// IPC 错误去掉 Electron 包的前缀，只留后端原始错因（如 bash_not_found: 需要安装 Git for Windows…）
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

// 分屏模型见 @lingshell/shared split.ts：单屏 / 左右 2 / 上下 2 / 三列 / 四宫格。
// 「当前终端」= 焦点窗格里的终端（键盘、资源管理器、命令历史、录像、快捷命令都跟它走）。
const MODES: [SplitMode, string, typeof Square][] = [
  ['single', tk('单屏'), Square], ['cols2', tk('左右分屏'), Columns2], ['rows2', tk('上下分屏'), Rows2], ['cols3', tk('三列分屏'), Columns3], ['grid4', tk('四宫格'), Grid2x2],
]

export function TerminalView() {
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [hydrated, setHydrated] = useState<Set<string>>(new Set())   // 渲染页重载时接管的终端（回填滚动区）
  const [view, setView] = useState<PaneView>(EMPTY_VIEW)
  const activeId = focusedId(view)
  const multi = view.panes.length > 1
  const badges = useTermBadges()   // 后台标签的长命令完成 / 告警角标
  const [layoutOpen, setLayoutOpen] = useState(false)   // 分屏布局选择下拉
  const [ready, setReady] = useState(false)        // 布局恢复完成前不回写，免得半途的列表覆盖已存布局
  const splitRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sshOpen, setSshOpen] = useState(false)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  // 终端 id → hostId（仅来自「已保存主机」的 SSH 有），用于布局持久化以便重启重连
  const hostIds = useRef<Map<string, string>>(new Map())
  const [gitWide, setGitWide] = useState(false)   // Git 面板在「历史」页时抽屉加宽
  const [explorerWide, setExplorerWide] = useState(false)   // 资源管理器开着详细信息列时抽屉加宽
  const [dual, setDual] = useState<{ terminalId: string; root: string } | null>(null)   // 双栏文件管理（SSH 终端）
  const openDual = (id: string) => { setDrawer(null); setDual({ terminalId: id, root: getTermCwd(id) || '/' }) }
  const [drawer, setDrawer] = useState<'history' | 'explorer' | 'docker' | 'processes' | 'ports' | 'hostcheck' | 'systemd' | 'alerts' | 'git' | OpsView | null>(null)
  const alertUnread = useAlertHits().unread   // 告警汇总未读数（活动栏角标）
  const opsView = isOpsView(drawer) ? drawer : null   // 「更多视图」里的抽屉
  const [diskPath, setDiskPath] = useState<string | undefined>()   // 磁盘占用抽屉预填的目录（体检「分析占用」/ 资源管理器右键）
  const [uploadPaths, setUploadPaths] = useState<string[] | null>(null)
  const [dropUpload, setDropUpload] = useState<{ paths: string[]; dir: string; hostId?: string; terminalId: string; title: string; prod: boolean } | null>(null)   // 拖拽上传（资源管理器 / 终端）
  const [termError, setTermError] = useState<string | null>(null)   // 终端操作失败的提示横幅（本地终端起不来、开录失败等）
  const [bashMissing, setBashMissing] = useState(false)   // Windows 没检测到 Git Bash：无终端时显示引导卡片
  // 正在录像的终端（用户手动开始/停止）：初始值向主进程要，之后跟 terminal:recording 事件
  const [recIds, setRecIds] = useState<Set<string>>(new Set())
  const { recordingEnabled, sessionLogEnabled } = useTermPrefs()
  // SSH 标签 hover：有主机状态数据时加一行摘要
  const hostStats = useHostStats()
  useWatchStats(view.panes)   // 只采可见窗格里的终端
  const statsLine = (id: string) => { const s = hostStats[id]?.samples.at(-1); return s ? statsSummary(s) : '' }
  useEffect(() => {
    client.recordings.active().then((ids) => setRecIds(new Set(ids))).catch(() => {})
    return client.on((ev) => {
      if (ev.type !== 'terminal:recording') return
      setRecIds((s) => { const n = new Set(s); if (ev.recording) n.add(ev.terminalId); else n.delete(ev.terminalId); return n })
    })
  }, [])
  const [explorerRoot, setExplorerRoot] = useState<string | null>(null)   // 资源管理器默认根：取当前终端 pwd，空则回退默认
  const [explorerReady, setExplorerReady] = useState(false)   // pwd 取到（或放弃）后才挂资源管理器：否则晚到的 pwd 会把用户已经点开的目录拽回去
  // 各终端当前目录（shell 集成上报，见 termCwd.ts）：资源管理器「跟随终端目录」用
  const [cwds, setCwds] = useState<Record<string, string>>({})
  useEffect(() => onTermCwd((id, cwd) => setCwds((c) => ({ ...c, [id]: cwd }))), [])
  const [dropOn, setDropOn] = useState<string | null>(null)   // 拖文件悬停中的终端（高亮用）
  // 拖文件到终端：SSH → 上传弹窗，目标目录预填该终端当前目录；本地 → 插入带引号的路径（不回车）
  const dropOnTerm = async (t: TerminalInfo, ev: React.DragEvent) => {
    const paths = [...ev.dataTransfer.files].map(pathForFile).filter(Boolean)
    if (!paths.length) { setTermError(tr('拖入的不是本地文件')); return }
    if (t.type !== 'ssh') { client.terminal.write(t.id, shellQuotePaths(paths, t.shell)).catch(() => {}); return }
    // 临时连接的主机也能传：直传走这个终端的 SFTP（加密上传要已保存主机）
    const hostId = hostIds.current.get(t.id) ?? t.hostId
    const dir = getTermCwd(t.id) || await client.terminal.pwd(t.id).catch(() => '') || '/'
    setDropUpload({ paths, dir, hostId, terminalId: t.id, title: t.title, prod: t.env === 'prod' })
  }
  const revealRoot = useRef<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)   // +号菜单容器，用于点外部关闭
  // 广播输入：null = 关；否则为组内终端 id。不持久化，每次启动都是关。
  const [bcast, setBcast] = useState<Set<string> | null>(null)
  // 标签自定义（颜色 / 重命名，随布局持久化）、右键菜单、正在重命名的标签
  const [tabMeta, setTabMeta] = useState<Record<string, TabMeta>>({})
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const patchMeta = (id: string, p: TabMeta) => setTabMeta((m) => ({ ...m, [id]: { ...m[id], ...p } }))
  // 布局里的标签自定义 → 标签状态（恢复 / 打开工作区共用）
  const metaFromItem = (id: string, item: TabMeta) => { if (item.color || item.title || item.pinned) patchMeta(id, { color: item.color, title: item.title, pinned: item.pinned }) }
  // 固定标签：排在最前（显示 / 拖拽 / 切换 / 存布局都按这个顺序）
  const isPinned = (id: string) => !!tabMeta[id]?.pinned
  const tabs = pinFirst(terms, (t) => isPinned(t.id))
  const pinnedCount = tabs.filter((t) => isPinned(t.id)).length
  // 标签拖拽：拖动中的标签、插入位（0..n，画指示线）、悬停的分屏窗格（松开即放进该窗格）
  // 固定区与普通区不能互相拖：插入位限制在被拖标签所在的区内（见 clampTabDrop）
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [dropAt, setDropAtRaw] = useState<number | null>(null)
  const setDropAt = (at: number) => { const c = clampTabDrop(pinnedCount, tabs.length, !!dragTab && isPinned(dragTab), at); if (c !== dropAt) setDropAtRaw(c) }
  const [paneOver, setPaneOver] = useState<number | null>(null)
  const endTabDrag = () => { setDragTab(null); setDropAtRaw(null); setPaneOver(null) }
  const dragFrom = dragTab ? tabs.findIndex((t) => t.id === dragTab) : -1
  // 落点等于原位（自己前后）不画指示线
  const showDropAt = dropAt !== null && dragFrom >= 0 && dropAt !== dragFrom && dropAt !== dragFrom + 1 ? dropAt : null

  // +号菜单打开时：点菜单外部（含 +号按钮外的任意处）关闭。用 mousedown 抢在 click 前，避免点其它按钮时闪一下。
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // 终端列表 / 活动终端 / 分屏变化即存布局（local 总能重开；ssh 仅有 hostId 的能重连，临时 ssh 跳过）。
  // 持久化列表过滤掉临时 ssh，下标按过滤后的列表算；分屏任一窗格不可持久化则不存分屏。
  // 防抖：拖分割线时 sizes 每帧变，只落最后一次。
  useEffect(() => {
    if (!ready) return
    const h = setTimeout(() => {
      const persisted = tabs.filter((t) => t.type === 'local' || hostIds.current.has(t.id))   // 按显示顺序（固定的在前）
      const items = persisted.map((t) => toLayoutItem(t.type, hostIds.current.get(t.id), tabMeta[t.id], t.tmux, t.shell,
        t.type === 'local' ? getTermCwd(t.id) : undefined, t.title))   // 本地终端记住目录；默认标题用于重载后对齐标签
      const idx = (id: string) => persisted.findIndex((t) => t.id === id)
      const a = idx(activeId)
      client.layout.save({ terminals: items, activeTerminalIndex: a >= 0 ? a : 0, terminalSplit: toSplitLayout(view, idx) }).catch(() => {})
    }, 300)
    return () => clearTimeout(h)
  }, [ready, terms, view, tabMeta, cwds])

  // 点工具栏按钮 / 标签后把键盘交还终端：否则焦点留在按钮或 body 上，敲字不进 shell（空格还会再触发按钮）
  const focusTerm = () => requestAnimationFrame(() => getActiveTerminal()?.focus())
  // 点标签：切到该终端（规则见 activate）
  const selectTerm = (id: string) => { setView((v) => activate(v, id)); focusTerm() }

  // 切布局：焦点终端 + 后续标签依次填格；终端不够就新建本地终端补空位（新终端经 activate 填进空位）
  const pickMode = (m: SplitMode) => {
    setLayoutOpen(false)
    if (!activeId) return
    setView((v) => setMode(v, m, terms.map((t) => t.id)))
    for (let k = terms.length; k < paneCount(m); k++) newLocal()
    focusTerm()
  }

  // 拖第 k 条分割线：按容器尺寸换算位置，两侧窗格各至少 120px（容器过窄时退化为均分上限），避免被拖到 0 尺寸
  const onDividerDown = (k: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    const box = splitRef.current?.getBoundingClientRect()
    if (!box) return
    const vertical = dividerAxis(view.mode, k) === 'y'
    const total = Math.max(vertical ? box.height : box.width, 1)
    const lim = Math.min(view.mode === 'cols3' ? 0.3 : 0.45, 120 / total)
    const onMove = (ev: MouseEvent) => {
      const p = (vertical ? ev.clientY - box.top : ev.clientX - box.left) / total
      setView((v) => ({ ...v, sizes: clampDivider(v.mode, v.sizes, k, p, lim) }))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
  }

  // 启动恢复布局：本地重开 / SSH 用 hostId 重连。无布局则建一个本地终端。
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return   // StrictMode 双跑守卫：终端布局只恢复一次，否则会建双倍终端
    restored.current = true
    ;(async () => {
      const layout: AppLayout = await client.layout.get().catch(() => ({ terminals: [] }))
      // 渲染页重载（主进程还活着）：接管已有终端，不再按布局新建（否则旧终端成了看不见的孤儿，AI 还会在上面执行）
      const existing = await client.terminal.list().catch(() => [] as TerminalInfo[])
      if (existing.length) {
        for (const t of existing) if (t.hostId) hostIds.current.set(t.id, t.hostId)
        // terminal:list 是创建顺序，布局里存的是用户拖过的显示顺序（固定的在前）：按主机 / shell 匹配，
        // 不能按下标硬套 —— 否则重载后标签名 / 颜色 / 分屏格子会串到别的终端上
        const pool = [...existing]
        const ids: string[] = []
        const ordered: TerminalInfo[] = []
        for (const item of layout.terminals) {
          const i = pool.findIndex((t) => (item.kind === 'ssh'
            ? t.type === 'ssh' && !!item.hostId && t.hostId === item.hostId
            : t.type === 'local' && (!item.shell || t.shell === item.shell))
            && (!item.baseTitle || t.title === item.baseTitle))
          if (i < 0) { ids.push(''); continue }   // 布局里的终端已经不在了：占位保持分屏下标
          const [t] = pool.splice(i, 1)
          ordered.push(t); ids.push(t.id); metaFromItem(t.id, item)
        }
        ordered.push(...pool)   // 布局里没有的（临时 ssh / 新建的）按原顺序放最后
        setHydrated(new Set(ordered.map((t) => t.id)))   // 这些是活着的旧会话：用主进程缓冲回填滚动区
        setTerms(ordered)
        const active = ids[layout.activeTerminalIndex ?? 0] || ordered[0]?.id || ''
        setView(restoreView(layout.terminalSplit, [...ids, ...pool.map((t) => t.id)], active))
        setReady(true)
        return
      }
      // Windows 没检测到 Git Bash：不自动建 Git Bash 终端（会直接报错），终端区改显示引导卡片（GitBashMissing）
      const gb = await client.gitBash.status().catch(() => null)
      const noBash = !!gb?.required && !gb.path
      if (noBash) setBashMissing(true)
      if (!layout.terminals.length) { setReady(true); if (!noBash) addLocal(); return }
      const restoredIds: string[] = []
      const msgs: string[] = []   // 恢复失败 / 需要告知的提示（以前 SSH 失败是静默丢标签）
      for (const item of layout.terminals) {
        try {
          let info: TerminalInfo | undefined
          if (item.kind === 'local' && noBash && shellKind(item.shell) === 'bash') {
            restoredIds.push(''); continue   // 缺 Git Bash：跳过，其它（SSH / PowerShell 等）照常恢复
          }
          if (item.kind === 'local') {
            // 按原 shell / 上次所在目录重开（WSL 的 cwd 可能是 pty 起不了的 \\wsl 路径，不传）
            const cwd = item.cwd && shellKind(item.shell) !== 'wsl' ? item.cwd : undefined
            info = await client.terminal.createLocal({ ...(item.shell ? { shell: item.shell } : {}), ...(cwd ? { cwd } : {}) })
          } else if (item.kind === 'ssh' && item.hostId) {
            info = await client.terminal.createSsh({ hostId: item.hostId, ...(item.tmux ? { tmuxSession: item.tmux } : {}) })   // 保持会话：接回同一 tmux 会话
            hostIds.current.set(info.id, item.hostId)
          }
          if (info) {
            restoredIds.push(info.id); const added = info; setTerms((t) => [...t, added])
            metaFromItem(info.id, item)
            if (info.notice) msgs.push(tr('{title}：{msg}', { title: info.title, msg: info.notice }))
          }
        } catch (e) {
          restoredIds.push('') /* 单个终端恢复失败(如 SSH 连不上)：占位以保持下标对齐 */
          msgs.push(item.kind === 'ssh' ? tr('SSH 终端恢复失败：{msg}', { msg: errText(e) }) : tr('本地终端恢复失败：{msg}', { msg: errText(e) }))
        }
      }
      if (msgs.length) setTermError(msgs.join(tr('list|；')))
      // 恢复活动终端选中态（按持久化的下标；越界则回退第一个）
      const wantIdx = layout.activeTerminalIndex ?? 0
      const activeRestored = restoredIds[wantIdx] || restoredIds.find(Boolean) || ''
      // 恢复分屏：恢复失败的窗格去掉，不足则降级（4→3→2→单屏）
      setView(restoreView(layout.terminalSplit, restoredIds, activeRestored))
      setReady(true)
    })()
  }, [])

  // agent 开始在某终端执行（terminal:locked）→ 自动切到那个终端；
  // terminal:status → 同步本地标签的连接状态（断线变灰、重连成功恢复）
  useEffect(() => {
    const off = client.on((ev) => {
      if (ev.type === 'terminal:locked') {
        if (ev.locked) setView((v) => activate(v, ev.terminalId))
        setTerms((t) => t.map((x) => x.id === ev.terminalId ? { ...x, locked: ev.locked } : x))   // 广播据此跳过 AI 占用的终端
      }
      if (ev.type === 'terminal:status') {
        setTerms((t) => t.map((x) => x.id === ev.terminalId ? { ...x, status: ev.status, ...(ev.os ? { os: ev.os } : {}) } : x))   // 重连后系统重测
      }
      if (ev.type === 'terminal:created') {
        setTerms((t) => t.some((x) => x.id === ev.info.id) ? t : [...t, ev.info])
        setView((v) => activate(v, ev.info.id))
      }
    })
    return off
  }, [])

  // 资源管理器抽屉打开（或切终端）时，取当前终端 pwd 作为默认根；取不到则置 null 回退默认根。
  useEffect(() => {
    if (drawer !== 'explorer' || !activeId) { setExplorerRoot(null); setExplorerReady(false); return }
    const want = revealRoot.current   // 传输面板「在资源管理器中定位」指定的目录优先
    revealRoot.current = null
    if (want) { setExplorerRoot(want); setExplorerReady(true); return }
    // 这个终端上次停在的目录（用户自己点过去的）优先；第一次打开才取终端当前目录
    const mem = getLastDir(`term:${activeId}`)
    if (mem) { setExplorerRoot(mem); setExplorerReady(true); return }
    let alive = true
    setExplorerRoot(null); setExplorerReady(false)
    // 终端忙 / 连不上时 pwd 可能很久：最多等 3 秒，取不到就用默认根。
    // 超时后必须「作废」这个请求，否则晚到的 pwd 会在用户已经点开别的目录后把它拽回终端目录
    const timer = setTimeout(() => { if (alive) { alive = false; setExplorerReady(true) } }, 3000)
    client.terminal.pwd(activeId).then((p) => {
      if (!alive) return
      clearTimeout(timer); if (p) setExplorerRoot(p); setExplorerReady(true)
    }, () => { if (!alive) return; clearTimeout(timer); setExplorerReady(true) })
    return () => { alive = false; clearTimeout(timer) }
  }, [drawer, activeId])

  // SSH 连接成功：把新终端加进标签并立即切到它（hostId 有则记录，供布局持久化）
  // 保持会话：没用上 tmux 时提示一次；用上了且服务器上还有别的保留会话 → 提示可在右键菜单接回
  const onSshConnected = (info: TerminalInfo, hostId?: string) => {
    if (hostId) { hostIds.current.set(info.id, hostId); void recordRecentHost(hostId) }   // 连成功才记「最近连接」

    setTerms((t) => [...t, info])
    setView((v) => activate(v, info.id))
    if (info.notice) setTermError(tr('{title}：{msg}', { title: info.title, msg: info.notice }))
    else if (info.tmux && hostId) client.terminal.tmuxSessions(info.id).then((s) => { if (s.length) setTermError(tr('{title}：服务器上有 {n} 个保留的会话，可在标签右键菜单里接回', { title: info.title, n: s.length })) }).catch(() => {})
  }

  // 从「已保存主机」直接连接：用 hostId 建 SSH 终端，成功后交给 onSshConnected（记录 hostId 供布局持久化）。tmuxSession：接回保留的会话
  const connectHost = async (hostId: string, tmuxSession?: string) => {
    setMenuOpen(false)
    try {
      const info = await client.terminal.createSsh({ hostId, ...(tmuxSession ? { tmuxSession } : {}) })
      onSshConnected(info, hostId)
      return true
    } catch (e) { setTermError(tr('连接失败：{msg}', { msg: errText(e).replace(/^credential_unreadable:\s*/, '') })); return false }   // 终端还没建出来（凭据解不开、主机不存在等），不提示就是「点了没反应」
  }

  // 新终端：有空窗格先填空位，否则换掉焦点窗格（见 activate）
  const newLocal = async (shell?: string) => {
    setMenuOpen(false)
    let info: TerminalInfo
    try { info = await client.terminal.createLocal(shell ? { shell } : undefined) }
    catch (e) {
      const m = errText(e)
      if (m.startsWith('bash_not_found')) setBashMissing(true)   // 没终端时由引导卡片说明，不再叠横幅
      setTermError(m.startsWith('bash_not_found') && !terms.length ? null : tr('本地终端启动失败：{msg}', { msg: m }))
      return
    }
    setTermError(null)
    if (shellKind(shell) === 'bash') setBashMissing(false)
    setTerms((t) => [...t, info])
    setView((v) => activate(v, info.id))
  }
  const addLocal = () => newLocal()
  // 保持会话的终端：后台有任务在跑先问（结束 / 留在服务器 / 取消），空闲直接结束远端会话
  const [tmuxAsk, setTmuxAsk] = useState<{ id: string; jobs: string[]; unknown?: boolean } | null>(null)
  // 关闭前确认：正被 AI 执行 / 固定标签。所有入口（X / 中键 / Ctrl+Shift+W）共用
  const [closeAsk, setCloseAsk] = useState<{ id: string; title: string; locked: boolean; pinned: boolean } | null>(null)
  // 关标签时清掉这个终端的所有界面状态（以前只删 hostId，重开终端复用 id 时会继承旧的固定 / 改名 / 颜色）
  const forgetTerm = (id: string) => {
    hostIds.current.delete(id); clearTermCwd(id)
    setTabMeta((m) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n })
    setBcast((b) => b && b.has(id) ? new Set([...b].filter((x) => x !== id)) : b)
  }
  const closeTerm = async (id: string, tmux?: 'kill' | 'keep', force = false) => {
    const t = terms.find((x) => x.id === id)
    const pinned = isPinned(id)
    // 正被 AI 执行 / 固定标签：所有关闭入口（X / 中键 / Ctrl+Shift+W）都要确认，不能只有右键菜单确认
    if ((t?.locked || pinned) && !force) {
      setCloseAsk({ id, title: tabMeta[id]?.title || t?.title || '', locked: !!t?.locked, pinned }); return
    }
    if (!tmux && t?.tmux && t.status === 'running') {
      // 查不到任务（超时 / 连接忙）不能当成「没有任务」直接 kill 远端会话，改为询问
      const jobs = await client.terminal.tmuxJobs(id).catch(() => null)
      if (jobs === null) { setTmuxAsk({ id, jobs: [], unknown: true }); return }
      if (jobs.length) { setTmuxAsk({ id, jobs }); return }
      tmux = 'kill'
    }
    client.terminal.close(id, tmux).catch(() => {})
    forgetTerm(id)
    const next = terms.filter((x) => x.id !== id)
    setTerms((t) => t.filter((x) => x.id !== id))
    setView((v) => dropTerm(v, id, next.map((x) => x.id)))
    focusTerm()
  }
  // 批量关闭（关闭其他 / 右侧 / 全部）：被关的窗格换上剩下的终端或降级，keep 成为当前终端（keep 自己也被关 → 剩下的第一个）
  const closeMany = (ids: string[], keep: string) => {
    for (const id of ids) { client.terminal.close(id).catch(() => {}); forgetTerm(id) }
    const rest = tabs.filter((x) => !ids.includes(x.id)).map((x) => x.id)
    const k = ids.includes(keep) ? rest[0] : keep
    setTerms((t) => t.filter((x) => !ids.includes(x.id)))
    setView((v) => { const n = ids.reduce((acc, id) => dropTerm(acc, id, rest), v); return k ? activate(n, k) : n })
  }
  // 复制会话：后端按原终端的建连参数 / cwd 新开，插在原标签右侧，沿用 hostId（布局可持久化）与标签色
  const duplicateTerm = async (id: string) => {
    try {
      const info = await client.terminal.duplicate(id)
      const hid = hostIds.current.get(id)
      if (hid) hostIds.current.set(info.id, hid)
      if (tabMeta[id]?.color) patchMeta(info.id, { color: tabMeta[id].color })
      setTerms((t) => { const n = [...t], i = n.findIndex((x) => x.id === id); n.splice(i < 0 ? n.length : i + 1, 0, info); return n })
      setView((v) => activate(v, info.id))
    } catch (e) { setTermError(tr('复制会话失败：{msg}', { msg: errText(e) })) }
  }
  // 广播：开启时默认勾上所有在线的非生产终端（生产终端必须手动勾）；组内断开 / AI 占用的静默跳过
  const toggleBroadcast = () => { setBcast((b) => b || !terms.length ? null : new Set(terms.filter((t) => t.env !== 'prod' && t.status !== 'disconnected').map((t) => t.id))); focusTerm() }
  const toggleMember = (id: string) => setBcast((b) => {
    if (!b) return b
    const n = new Set(b)
    if (!n.delete(id)) n.add(id)
    return n
  })
  const group = bcast ? terms.filter((t) => bcast.has(t.id)) : []
  const skipped = (t: TerminalInfo) => t.status === 'disconnected' || t.locked
  const skippedCount = group.filter(skipped).length
  const prodCount = group.filter((t) => t.env === 'prod').length
  // 来源终端已由 TerminalPane 照常写入，这里只发给组内其它可写的终端
  const fanout = (from: string, d: string) => {
    for (const t of group) if (t.id !== from && !skipped(t)) client.terminal.write(t.id, d).catch(() => {})
  }

  // 快捷键：Ctrl+Shift+T 新建本地终端 / Ctrl+Shift+W 关闭当前终端 / Ctrl+(Shift+)Tab 循环切标签 / Ctrl+Shift+B 开关广播 / Alt+方向键 切窗格
  useEffect(() => { loadTermPrefs() }, [])
  useTerminalShortcuts({
    broadcast: toggleBroadcast,
    pane: (d) => setView((v) => ({ ...v, focus: neighborPane(v.mode, v.focus, d) })),
    duplicate: () => { if (activeId) duplicateTerm(activeId) },
    compose: toggleCompose,
    explorer: () => { if (terms.length) setDrawer((d) => d === 'explorer' ? null : 'explorer') },
    newTerm: addLocal,
    closeTerm: () => { if (activeId) closeTerm(activeId) },
    cycle: (d) => {
      if (tabs.length < 2) return
      const i = tabs.findIndex((t) => t.id === activeId)
      selectTerm(tabs[(i + d + tabs.length) % tabs.length].id)
    },
  })
  // 命令面板发来的终端区动作（ref 取最新闭包，订阅只挂一次）
  const paletteRef = useRef<(c: PaletteCmd) => void>(() => {})
  paletteRef.current = (c) => {
    if (c.type === 'connectHost') connectHost(c.hostId)
    else if (c.type === 'newLocal') addLocal()
    else if (c.type === 'newSsh') setSshOpen(true)
    else if (c.type === 'split') pickMode(c.mode)
    else if (c.type === 'termDrawer') { if (c.drawer === 'disk') setDiskPath(undefined); setDrawer(c.drawer) }
    else if (c.type === 'diskUsage') { setDiskPath(c.path); setDrawer('disk') }
    else if (c.type === 'focusTerm') selectTerm(c.id)
    else if (c.type === 'openWorkspace') void openWorkspace(c.ws)
    else if (c.type === 'explorerAt') {
      const t = terms.find((x) => (hostIds.current.get(x.id) ?? x.hostId) === c.hostId)
      if (!t) { setTermError(tr('该主机当前没有打开的终端，请先连接它再定位')); return }
      if (drawer === 'explorer' && t.id === activeId) { setExplorerRoot(c.path); return }   // 抽屉已开在这台：effect 不会重跑
      revealRoot.current = c.path
      selectTerm(t.id); setDrawer('explorer')
    }
    else if (c.type === 'hostDrawer') {
      const t = terms.find((x) => (hostIds.current.get(x.id) ?? x.hostId) === c.hostId && x.status !== 'disconnected')
      if (t) { selectTerm(t.id); setDrawer(c.drawer) }
      else void connectHost(c.hostId).then((ok) => { if (ok) setDrawer(c.drawer) })
    }
  }
  // 打开工作区 / 整组打开（主机面板、命令面板）：各终端追加为新标签，再按工作区的分屏摆放；开失败的列在提示条里
  const openWorkspace = async (ws: WorkspaceLayout) => {
    const { ids, errors } = await openLayoutItems(ws.terminals, (info, item) => {
      if (item.hostId) { hostIds.current.set(info.id, item.hostId); void recordRecentHost(item.hostId) }
      setTerms((t) => [...t, info])
      metaFromItem(info.id, item)
    })
    const first = ids[ws.activeTerminalIndex ?? 0] || ids.find(Boolean)
    if (first) setView(restoreView(ws.terminalSplit, ids, first))
    setTermError(errors.length ? tr('{n} 个终端未打开：{list}', { n: errors.length, list: errors.join(tr('list|；')) }) : null)
  }
  useEffect(() => onPalette((c) => paletteRef.current(c)), [])
  // 全局热键呼出（见 desktop/main/app/globalHotkey.ts）：窗口到前台后把键盘焦点交给当前终端（等一帧，窗口刚还原时焦点还没落定）
  useEffect(() => client.on((ev) => { if (ev.type === 'app:summon') setTimeout(() => getActiveTerminal()?.focus(), 50) }), [])
  // SSH 断线重连：成功后后端发 terminal:status running，由上面的订阅更新标签状态。
  const reconnectTerm = async (id: string) => {
    try { await client.terminal.reconnect(id); setTermError(null) }
    catch (e) { setTermError(tr('重连失败：{msg}', { msg: errText(e) })) }   // 以前静默：点了像没反应
  }

  // 活动终端所属主机 key，供命令历史分组用：本地统一 'local'；SSH 优先用已存主机 hostId，
  // 否则退化用 detail（user@host:port）里的 host:port 段。
  const activeTerm = terms.find((t) => t.id === activeId)
  const tracks = splitTracks(view.mode, view.sizes)
  const activeHostKey = !activeTerm ? 'local'
    : activeTerm.type === 'local' ? 'local'
    : hostIds.current.get(activeId) ?? (activeTerm.detail?.split('@')[1] ?? activeId)
  // 命令历史清空提示用的可读主机名：本地统一「本地终端」；SSH 用「标签（user@host:port）」，detail 缺省时退化用标题。
  const activeHostLabel = !activeTerm || activeTerm.type === 'local'
    ? tr('本地终端')
    : activeTerm.detail ? tr('{name}（{detail}）', { name: activeTerm.title, detail: activeTerm.detail }) : activeTerm.title

  const dBtn = (k: NonNullable<typeof drawer>) => ({ active: drawer === k, onClick: () => setDrawer((d) => d === k ? null : k) })
  return (
    <div className="flex h-full">
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-[var(--color-bg-base)]">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5">
        {/* tab 列表：横向滚动，隐藏滚动条；tab 不压缩 */}
        {/* 拖标签排序：标签上按左右半边定插入位，标签后的空白处 = 末尾；松开时按插入位重排（顺序随布局持久化） */}
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 self-stretch overflow-x-auto"
          onDragOver={(e) => { if (!isTabDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (e.target === e.currentTarget) setDropAt(tabs.length) }}
          onDrop={(e) => {
            if (!isTabDrag(e)) return
            e.preventDefault()
            const id = e.dataTransfer.getData(TAB_MIME), at = dropAt
            if (at !== null) setTerms((ts) => { const o = pinFirst(ts, (t) => isPinned(t.id)); return moveTab(o, o.findIndex((x) => x.id === id), at) })
            endTabDrag()
          }}>
          {tabs.map((t, ti) => {
            const pinned = isPinned(t.id), name = tabMeta[t.id]?.title || termLabel(t)
            return (
            // 标签色（用户选色；未选时生产主机自动红色）作用在文字和图标上；固定标签只显示图钉 + 图标 + 短名
            <div key={t.id} onClick={() => selectTerm(t.id)} title={[pinned ? tr('{name}（已固定）', { name }) : '', t.detail ?? t.title, termEnvLabel(t), t.type === 'ssh' ? statsLine(t.id) : ''].filter(Boolean).join('\n')} style={{ color: tabAccent(tabMeta[t.id]?.color, t.env) }}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ id: t.id, x: e.clientX, y: e.clientY }) }}
              onDoubleClick={() => setRenaming(t.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTerm(t.id) } }}   // 中键关闭（固定的 / AI 执行中的先确认）
              draggable={renaming !== t.id}
              onDragStart={(e) => { e.dataTransfer.setData(TAB_MIME, t.id); e.dataTransfer.effectAllowed = 'move'; setDragTab(t.id) }}
              onDragEnd={endTabDrag}
              onDragOver={(e) => {
                if (!isTabDrag(e)) return
                const r = e.currentTarget.getBoundingClientRect()
                setDropAt(e.clientX < r.left + r.width / 2 ? ti : ti + 1)
              }}
              // 焦点终端：主题色底 + 主题色字；分屏时其它窗格里的终端只提亮文字（不加底色，否则四宫格时全都一样亮）
              className={`relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ${t.id === activeId ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]' : view.panes.includes(t.id) ? 'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'} ${bcast?.has(t.id) ? 'ring-1 ring-inset ring-orange-500' : ''} ${dragTab === t.id ? 'opacity-50' : ''}`}>
              {/* 拖拽插入指示线：插在本标签前（或最后一个标签之后） */}
              {(showDropAt === ti || (showDropAt === tabs.length && ti === tabs.length - 1)) && (
                <span className={`pointer-events-none absolute inset-y-0.5 w-0.5 rounded bg-[var(--color-accent)] ${showDropAt === ti ? 'left-0' : 'right-0'}`} />
              )}
              {pinned && <Pin className="h-3 w-3 shrink-0 -rotate-45 opacity-70" />}
              {/* 广播模式：每个标签前一个勾选框决定是否在组内 */}
              {bcast && (
                <Checkbox checked={bcast.has(t.id)} onClick={(e) => e.stopPropagation()} onCheckedChange={() => toggleMember(t.id)}
                  title={t.env === 'prod' ? tr('生产终端：勾选后输入也会广播到这台生产机') : tr('加入 / 移出广播组')}
                  tone={t.env === 'prod' ? 'danger' : 'accent'}
                  className={t.env === 'prod' ? undefined : 'data-[state=checked]:border-orange-500 data-[state=checked]:bg-orange-500'} />
              )}
              {/* 图标不单独着色，跟随标签文字色（标签色在外层 style 上） */}
              {t.type === 'ssh' ? <Server className="h-3.5 w-3.5 shrink-0" /> : <TerminalSquare className="h-3.5 w-3.5 shrink-0" />}
              {renaming === t.id
                ? <TabTitleInput value={tabMeta[t.id]?.title || t.title} onDone={(v) => { setRenaming(null); if (v !== null) patchMeta(t.id, { title: v || undefined }) }} />
                : <span className={`whitespace-nowrap ${t.status === 'disconnected' ? 'text-[var(--color-text-muted)] line-through' : ''}`}>{pinned ? pinnedLabel(tabMeta[t.id]?.title || t.title) : name}</span>}
              {t.env === 'prod' && <ProdBadge />}
              {t.encoding && !pinned && <EncodingBadge enc={t.encoding} />}
              {recIds.has(t.id) && <span title={tr('录像中')} className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-danger)]" />}
              {badges.get(t.id)?.kind === 'bell'
                ? <span title={badges.get(t.id)!.text} className="shrink-0 text-[var(--color-warn)]"><BellRing className="h-3 w-3" /></span>
                : badges.get(t.id) && <span title={badges.get(t.id)!.text} className={`h-1.5 w-1.5 shrink-0 rounded-full ${BADGE_CLS[badges.get(t.id)!.kind]}`} />}
              {t.status === 'disconnected' && t.type === 'ssh' && (
                <button onClick={(e) => { e.stopPropagation(); reconnectTerm(t.id) }} title={tr('重连')} className="shrink-0 text-[var(--color-accent)] hover:text-[var(--color-accent-dim)]"><RotateCw className="h-3 w-3" /></button>
              )}
              {!pinned && <button onClick={(e) => { e.stopPropagation(); closeTerm(t.id) }} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><X className="h-3 w-3" /></button>}
            </div>
            )
          })}
        </div>
        {/* 右侧图标区顺序：+号(带下拉) → 资源管理器 → 命令历史 */}
        {/* +号菜单向左下展开（right-0），右侧还有两个按钮+内边距，不会超窗口右缘 */}
        <div ref={menuRef} className="relative shrink-0">
          <button title={tr('新建终端：本地 / SSH / 已保存主机{key}', { key: keyHint('tab.new') })} onClick={() => { setMenuOpen((o) => !o); client.hosts.list().then(setHosts).catch(() => {}) }} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><Plus className="h-3.5 w-3.5" /></button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-20 w-56 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 text-[12px] shadow-lg">
              <LocalShellItems onPick={(shell) => newLocal(shell)} />
              <button onClick={() => { setMenuOpen(false); setSshOpen(true) }} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 hover:bg-[var(--color-bg-hover)]"><Plus className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('新建 SSH 连接…')}</button>
              <div className="my-1 h-px bg-[var(--color-border-subtle)]" />
              <div className="px-2.5 pb-1 pt-0.5 text-[10px] text-[var(--color-text-muted)]">{tr('已保存主机（点击直接连）')}</div>
              <SavedHostList hosts={hosts} onConnect={connectHost} />
            </div>
          )}
        </div>
        {/* 录制/广播/分屏依赖有活动终端，无终端时隐藏（+号始终留着好新建）；面板与工具类按钮在右侧活动栏 */}
        {terms.length > 0 && (
          <>
            {recordingEnabled && activeId && (
              <button
                title={recIds.has(activeId) ? tr('停止录制当前终端') : tr('开始录制当前终端')}
                onClick={() => {
                  const op = recIds.has(activeId) ? client.recordings.stop(activeId) : client.recordings.start(activeId)
                  op.catch((e) => setTermError(tr('录屏失败：{msg}', { msg: errText(e) })))
                  focusTerm()
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] ${recIds.has(activeId) ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-danger)]'}`}>
                {recIds.has(activeId)
                  ? <Square className="h-3 w-3 animate-pulse fill-current" />
                  : <Circle className="h-3 w-3 fill-current" />}
              </button>
            )}
            <button title={bcast ? tr('退出广播输入{key}', { key: keyHint('tab.broadcast') }) : tr('广播输入：键入同时发到多个终端{key}', { key: keyHint('tab.broadcast') })} onClick={toggleBroadcast}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] ${bcast ? 'bg-orange-500/15 text-orange-500' : 'text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'}`}><Radio className="h-3.5 w-3.5" /></button>
            <LayoutPicker mode={view.mode} open={layoutOpen} setOpen={setLayoutOpen} onPick={pickMode} />
          </>
        )}
      </div>
      {bcast && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-orange-500/40 bg-orange-500/15 px-3 py-1 text-[12px] text-orange-500">
          <span className="flex items-center gap-1.5 font-medium"><Radio className="h-3.5 w-3.5" />{tr('广播中：{n} 个终端', { n: group.length })}</span>
          <span className="text-[11px] opacity-80">{tr('在组内任一终端键入或粘贴，都会同时发给组内所有终端；勾选标签加入 / 移出')}</span>
          {skippedCount > 0 && <span className="text-[11px] opacity-80">{tr('已跳过 {n} 个（断开 / AI 执行中）', { n: skippedCount })}</span>}
          {prodCount > 0 && (
            <span className="flex items-center gap-1 font-medium text-[var(--color-danger)]"><AlertTriangle className="h-3.5 w-3.5" />{tr('含 {n} 个生产终端，输入会同时打到生产机', { n: prodCount })}</span>
          )}
          <button onClick={() => { setBcast(null); focusTerm() }} title={keyLabel('tab.broadcast')}
            className="ml-auto flex items-center gap-1 rounded border border-orange-500/50 px-2 py-0.5 hover:bg-orange-500/20"><X className="h-3 w-3" />{tr('退出广播')}</button>
        </div>
      )}
      {termError && (
        <div className="flex shrink-0 items-start gap-1.5 border-b border-[color:color-mix(in_srgb,var(--color-danger)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{termError}</span>
          <button onClick={() => setTermError(null)} title={tr('关闭')} className="shrink-0 hover:opacity-70"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {/* 所有 TerminalPane 平铺在同一 grid 下（换窗格不重挂载 xterm），按窗格下标放进网格格子；
          轨道按 sizes 占比，分割线是绝对定位的覆盖层；尺寸变化由 TerminalPane 内的 ResizeObserver 重新 fit */}
      <div ref={splitRef} className="relative grid min-h-0 flex-1"
        style={{ gridTemplateColumns: tracks.cols.map((f) => `minmax(0,${f}fr)`).join(' '), gridTemplateRows: tracks.rows.map((f) => `minmax(0,${f}fr)`).join(' ') }}>
        {terms.length === 0 && bashMissing && (
          <div className="min-w-0">
            <GitBashMissing onReady={() => { setBashMissing(false); addLocal() }} onPowerShell={() => newLocal('powershell')} />
          </div>
        )}
        {terms.length === 0 && !bashMissing && (
          <div className="min-w-0">
            <TerminalEmptyState
              hosts={hosts}
              onAddLocal={addLocal}
              onNewSsh={() => setSshOpen(true)}
              onConnectHost={connectHost}
              onLoadHosts={() => client.hosts.list().then(setHosts).catch(() => {})}
            />
          </div>
        )}
        {terms.map((t) => {
          const i = view.panes.indexOf(t.id)
          const [r, c] = paneCell(view.mode, Math.max(i, 0))
          // display:contents 的外层只用来接系统拖来的文件 / 拖来的标签（不产生盒子，不影响网格布局）；悬停时同格叠一层高亮提示
          // 拖标签到可见窗格：该终端放进这个窗格（它已在别的窗格 → 两窗格互换，同右键「在当前窗格显示」）
          return (
            <div key={t.id} className="contents"
              onDragOver={(ev) => {
                if (isTabDrag(ev) && i >= 0) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; if (paneOver !== i) setPaneOver(i); return }
                if (!ev.dataTransfer.types.includes('Files')) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; if (dropOn !== t.id) setDropOn(t.id)
              }}
              onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) { setDropOn(null); setPaneOver(null) } }}
              onDrop={(ev) => {
                if (isTabDrag(ev)) { ev.preventDefault(); const id = ev.dataTransfer.getData(TAB_MIME); if (id && i >= 0) setView((v) => assign(v, i, id)); endTabDrag(); return }
                if (!ev.dataTransfer.types.includes('Files')) return; ev.preventDefault(); setDropOn(null); void dropOnTerm(t, ev)
              }}>
              <TerminalPane info={t} active={i >= 0}
                focused={multi ? t.id === activeId : undefined}
                style={{ gridRow: r + 1, gridColumn: c + 1 }}
                onFocus={multi && i >= 0 ? () => setView((v) => activate(v, t.id)) : undefined}
                hydrate={hydrated.has(t.id)}
                broadcast={!!bcast?.has(t.id)}
                // 来源自身被跳过（断开 / AI 占用）时也不往外发，免得自己没回显、别的终端却收到了
                onInput={bcast?.has(t.id) && !skipped(t) ? (d) => fanout(t.id, d) : undefined} />
              {dropOn === t.id && i >= 0 && (
                <div style={{ gridRow: r + 1, gridColumn: c + 1 }}
                  className="pointer-events-none z-20 flex items-center justify-center bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] ring-2 ring-inset ring-[var(--color-accent)]">
                  <span className="rounded-md bg-[var(--color-bg-panel)] px-3 py-1.5 text-[12px] text-[var(--color-accent)] shadow">
                    {t.type === 'ssh' ? tr('松开上传到 {dir}', { dir: getTermCwd(t.id) ?? tr('终端当前目录') }) : tr('松开插入文件路径')}
                  </span>
                </div>
              )}
              {dragTab && paneOver === i && i >= 0 && dragTab !== t.id && (
                <div style={{ gridRow: r + 1, gridColumn: c + 1 }}
                  className="pointer-events-none z-20 flex items-center justify-center bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] ring-2 ring-inset ring-[var(--color-accent)]">
                  <span className="rounded-md bg-[var(--color-bg-panel)] px-3 py-1.5 text-[12px] text-[var(--color-accent)] shadow">{tr('松开把该终端放到这个窗格')}</span>
                </div>
              )}
            </div>
          )
        })}
        {view.sizes.map((p, k) => {
          const y = dividerAxis(view.mode, k) === 'y'
          return (
            <div key={k} onMouseDown={onDividerDown(k)} onDoubleClick={() => setView((v) => ({ ...v, sizes: defaultSizes(v.mode) }))} title={tr('拖动调整大小，双击均分')}
              style={y ? { top: `${p * 100}%` } : { left: `${p * 100}%` }}
              className={`absolute z-10 bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent)] ${y ? 'inset-x-0 h-px cursor-row-resize' : 'inset-y-0 w-px cursor-col-resize'}`}>
              <div className={y ? 'absolute inset-x-0 -top-1 -bottom-1' : 'absolute inset-y-0 -left-1 -right-1'} />
            </div>
          )
        })}
      </div>
      {/* 撰写栏（Alt+C 开关）在 footer 之上；底部常驻 footer：快速命令 + 撰写栏开关 + 最右主机状态标签 */}
      <ComposeBar terms={terms} activeId={activeId} bcast={bcast} />
      <QuickCommandBar terms={terms} activeId={activeId} bcast={bcast} lead={<ComposeToggle />} trailing={<HostStatsTags active={activeTerm} />} />
      <SshConnectDialog open={sshOpen} onClose={() => setSshOpen(false)} onConnected={onSshConnected} />
      <TerminalDrawer open={drawer !== null} onClose={() => setDrawer(null)} xwide={drawer === 'database' || drawer === 'k8s'} widthClass={drawer === 'git' && gitWide ? 'w-[600px] max-w-full' : drawer === 'explorer' && explorerWide ? 'w-[560px] max-w-full' : undefined} wide={drawer === 'docker' || drawer === 'processes' || drawer === 'ports' || drawer === 'hostcheck' || drawer === 'systemd' || drawer === 'git' || !!opsView}>
        {drawer === 'git' && <GitDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} onWide={setGitWide} />}
        {drawer === 'hostcheck' && <HostCheckDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'cron' && <CronDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'disk' && <DiskUsageDrawer key={`${activeId}:${diskPath ?? ''}`} term={activeTerm} initialPath={diskPath} onClose={() => setDrawer(null)}
          onReveal={(p) => { revealRoot.current = activeTerm?.type === 'ssh' || !/^[A-Za-z]:/.test(p) ? p : p.replace(/\//g, '\\'); setDrawer('explorer') }} />}
        {drawer === 'firewall' && <FirewallDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'topology' && <TopologyDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'database' && <DatabaseDrawer key={activeHostKey} hostKey={activeHostKey} onClose={() => setDrawer(null)} />}
        {drawer === 'k8s' && <K8sDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'docker' && <DockerDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'systemd' && <ServiceDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'processes' && <ProcessDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'ports' && <PortsDrawer key={activeId} term={activeTerm} onClose={() => setDrawer(null)} />}
        {drawer === 'alerts' && <AlertsDrawer onClose={() => setDrawer(null)} />}
        {drawer === 'history' && <CommandHistoryDrawer hostKey={activeHostKey} hostLabel={activeHostLabel} activeTerminalId={activeId} onClose={() => setDrawer(null)} />}
        {drawer === 'explorer' && !explorerReady && <div className="px-3 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('正在读取终端当前目录…')}</div>}
        {drawer === 'explorer' && explorerReady && (
          <ExplorerDrawer
            // 切主机/终端类型即重挂载：否则会先显示上一台主机缓存的目录树
            key={activeTerm?.type === 'ssh' ? activeId : 'local'}
            scope={activeTerm?.type === 'ssh' ? { terminalId: activeId } : 'local'}
            rootPath={explorerRoot ?? (activeTerm?.type === 'ssh' ? '/' : undefined)}
            hostKey={activeHostKey}
            onWide={setExplorerWide}
            memKey={`term:${activeId}`}
            // 在终端中打开：往这个终端发 cd，按 shell 用各自的写法（cmd 跨盘要 /d；WSL 要换成 /mnt/盘符）
            onOpenDual={activeTerm?.type === 'ssh' ? () => openDual(activeId) : undefined}
            onCdHere={(dir) => { client.terminal.write(activeId, cdCommand(dir, activeTerm?.type === 'ssh' ? undefined : activeTerm?.shell ?? 'bash') + '\r').catch(() => {}); setDrawer(null) }}
            termCwd={cwds[activeId]}
            onGotoCwd={async () => getTermCwd(activeId) || await client.terminal.pwd(activeId).catch(() => '')}
            onUpload={activeTerm?.type === 'ssh' ? undefined : setUploadPaths}
            prod={activeTerm?.env === 'prod'}
            onDownload={activeTerm?.type === 'ssh' ? async (remotePaths) => {
              const dir = await client.system.pickDirectory()
              if (dir) client.transfer.downloadMany({ terminalId: activeId }, remotePaths, dir).catch(() => {})
            } : undefined}
            // 拖拽上传：弹上传窗口（预填本终端 + 目标目录）；直传复用本终端的 SFTP，临时连接的主机也能传
            onDropUpload={activeTerm?.type === 'ssh' ? (paths, dir) => {
              setDropUpload({ paths, dir, hostId: hostIds.current.get(activeId) ?? activeTerm.hostId, terminalId: activeId, title: activeTerm.title, prod: activeTerm.env === 'prod' })
            } : undefined}
            onDiskUsage={(dir) => { setDiskPath(dir); setDrawer('disk') }}
            onClose={() => setDrawer(null)}
          />
        )}
      </TerminalDrawer>
      {uploadPaths && <UploadDialog localPaths={uploadPaths} onClose={() => setUploadPaths(null)} />}
      {dropUpload && <UploadDialog localPaths={dropUpload.paths} terminalId={dropUpload.terminalId} terminalTitle={dropUpload.title} terminalProd={dropUpload.prod} initialHostId={dropUpload.hostId} initialTarget={dropUpload.dir} onClose={() => setDropUpload(null)} />}
      <FileCompareDialog />
      <VscodeRemoteHost />
      <BatchExecDialog />
      <MultiLogDialog />
      <ConnProbeDialog />
      <ApiDebugDialog terms={terms} />
      <LogViewerHost terms={terms} />
      <ReplayHost />
      {/* 传输队列：终端区底部抽屉 */}
      <TransferPanel />
      {dual && (() => { const t = terms.find((x) => x.id === dual.terminalId); return t ? <DualPane key={dual.terminalId} terminalId={dual.terminalId} title={t.title} hostKey={activeHostKey} prod={t.env === 'prod'} remoteRoot={dual.root} onClose={() => setDual(null)} /> : null })()}
      <TableViewerHost />
      {tabMenu && (
        <TabMenu {...tabMenu} terms={tabs} meta={tabMeta[tabMenu.id]} onClose={() => setTabMenu(null)} isPinned={isPinned}
          onPin={() => patchMeta(tabMenu.id, { pinned: !isPinned(tabMenu.id) || undefined })}
          onDuplicate={() => duplicateTerm(tabMenu.id)} onRename={() => setRenaming(tabMenu.id)}
          onSaveBuffer={() => saveBuffer(tabMenu.id, tabMeta[tabMenu.id]?.title || tabs.find((t) => t.id === tabMenu.id)?.title || '', setTermError)}
          onCopyBuffer={() => copyBuffer(tabMenu.id, setTermError)}
          // 分屏时把该终端放进焦点窗格；它已在别的窗格 → 两窗格互换
          onShowHere={multi && tabMenu.id !== activeId ? () => setView((v) => assign(v, v.focus, tabMenu.id)) : undefined}
          onColor={(color) => patchMeta(tabMenu.id, { color })} onCloseMany={(ids) => closeMany(ids, tabMenu.id)}
          onCloseThis={() => closeTerm(tabMenu.id)}
          onAttachTmux={hostIds.current.has(tabMenu.id) ? (name) => connectHost(hostIds.current.get(tabMenu.id)!, name) : undefined} />
      )}
      <ConfirmDialog open={!!closeAsk} title={tr('关闭终端')} confirmText={tr('关闭')}
        message={tr('「{title}」{why}。确认关闭？', {
          title: closeAsk?.title ?? '',
          why: [closeAsk?.locked ? tr('正被 AI 执行命令，关闭会中断执行') : '', closeAsk?.pinned ? tr('是固定标签') : ''].filter(Boolean).join(tr('list|；')),
        })}
        onCancel={() => setCloseAsk(null)}
        onConfirm={() => { const id = closeAsk?.id; setCloseAsk(null); if (id) void closeTerm(id, undefined, true) }} />
      {tmuxAsk && (
        <TmuxCloseDialog jobs={tmuxAsk.jobs} unknown={tmuxAsk.unknown} onCancel={() => setTmuxAsk(null)}
          onKill={() => { closeTerm(tmuxAsk.id, 'kill'); setTmuxAsk(null) }} onKeep={() => { closeTerm(tmuxAsk.id, 'keep'); setTmuxAsk(null) }} />
      )}
    </div>
    {/* 右侧活动栏：打开侧边面板（抽屉从活动栏左侧滑出）+ 终端工具；依赖活动终端的无终端时隐藏。
        分四组：文件（资源管理器 / 命令历史）→ 主机视图（体检 / 进程 / 服务 / 容器 / 端口 / 更多，仅支持的主机）
        → 告警与记录（告警 / 日志 / 会话日志 / 即时回放）→ 多机工具（批量执行 / 文件比对 / 运维手册）；传输固定在最下 */}
    <ActivityBar side="right" bottom={<TransferButton />}>
      {terms.length > 0 && (() => {
        const sup = (f: (type: TerminalInfo['type'], os: TerminalInfo['os']) => boolean) => !!activeTerm && f(activeTerm.type, activeTerm.os)
        const loc = activeTerm?.type === 'local'   // 本机视图：本地终端也有进程 / 容器 / 端口（看的是本机）
        const views = [
          sup(hostCheckSupported) && <ActBtn key="hc" title={tr('主机体检')} {...dBtn('hostcheck')}><Stethoscope className="h-4 w-4" /></ActBtn>,
          (loc || sup(processSupported)) && <ActBtn key="ps" title={loc ? tr('进程（本机）') : tr('进程')} {...dBtn('processes')}><Cpu className="h-4 w-4" /></ActBtn>,
          sup(systemdSupported) && <ActBtn key="sd" title={tr('服务（systemd）')} {...dBtn('systemd')}><ServerCog className="h-4 w-4" /></ActBtn>,
          (loc || sup(dockerSupported)) && <ActBtn key="dk" title={loc ? tr('容器视图（本机 Docker）') : tr('容器视图（Docker）')} {...dBtn('docker')}><Container className="h-4 w-4" /></ActBtn>,
          (loc || sup(portsSupported)) && <ActBtn key="pt" title={loc ? tr('监听端口（本机：谁占了端口）') : tr('监听端口（转发到本机）')} {...dBtn('ports')}><EthernetPort className="h-4 w-4" /></ActBtn>,
          opsViewsFor(activeTerm).length > 0 && <MoreViewsButton key="more" term={activeTerm} active={opsView} onPick={(v) => { if (v === 'disk') setDiskPath(undefined); setDrawer(v) }} />,
        ].filter(Boolean)
        return (
          <>
            <ActBtn title={tr('资源管理器')} {...dBtn('explorer')}><FolderTree className="h-4 w-4" /></ActBtn>
            {activeTerm?.type === 'ssh' && <ActBtn title={tr('双栏文件管理\n左边本机、右边这台服务器，拖过去就上传 / 下载')} onClick={() => openDual(activeId)}><Columns2 className="h-4 w-4" /></ActBtn>}
            <ActBtn title={tr('命令历史')} {...dBtn('history')}><History className="h-4 w-4" /></ActBtn>
            {!(activeTerm?.type === 'ssh' && activeTerm.os === 'windows') && <ActBtn title={tr('Git（改动 / 分支 / 历史 / 储藏 / 同步）')} {...dBtn('git')}><GitBranch className="h-4 w-4" /></ActBtn>}
            {views.length > 0 && <><ActSep />{views}</>}
            <ActSep />
            <ActBtn title={alertUnread ? tr('告警（{n} 条未读）', { n: alertUnread }) : tr('告警：关键字告警命中的行')} {...dBtn('alerts')}>
              <Siren className="h-4 w-4" />
              {alertUnread > 0 && <span data-alert-unread className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-[var(--color-warn)] px-1 text-center text-[9px] font-semibold leading-[14px] text-[var(--color-bg-base)]">{alertUnread > 99 ? '99+' : alertUnread}</span>}
            </ActBtn>
            <LogButton term={activeTerm} />
            {sessionLogEnabled && activeId && (
              <ActBtn title={tr('打开本终端的会话日志')} onClick={() => client.sessionLogs.openTerminal(activeId).catch((e) => setTermError(tr('打开日志失败：{msg}', { msg: errText(e) })))}><FileText className="h-4 w-4" /></ActBtn>
            )}
            {activeTerm && <ReplayButton id={activeTerm.id} />}
            <ActSep />
            <BatchExecButton />
            <FileCompareButton />
            <ActBtn title={tr('运维手册（逐条执行到当前终端）')} onClick={() => openRunbookView()}><BookOpenText className="h-4 w-4" /></ActBtn>
            <ActBtn title={tr('部署评审：解读部署文档、找风险、目标主机预检、出评审报告')} onClick={() => openDeployReview()}><ClipboardCheck className="h-4 w-4" /></ActBtn>
            <ApiDebugButton />
          </>
        )
      })()}
    </ActivityBar>
    </div>
  )
}

// 分屏布局选择：按钮显示当前布局图标，点开选 单屏 / 左右 / 上下 / 三列 / 四宫格
function LayoutPicker({ mode, open, setOpen, onPick }: { mode: SplitMode; open: boolean; setOpen: (o: boolean) => void; onPick: (m: SplitMode) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const Cur = MODES.find((m) => m[0] === mode)![2]
  return (
    <div ref={ref} className="relative shrink-0">
      <button title={tr('分屏布局{key}', { key: keyHint('pane.left', 'pane.right', 'pane.up', 'pane.down') })} onClick={() => setOpen(!open)}
        className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] ${mode !== 'single' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}><Cur className="h-3.5 w-3.5" /></button>
      {open && (
        <div className="absolute right-0 top-7 z-20 flex gap-0.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 shadow-lg">
          {MODES.map(([m, label, Icon]) => (
            <button key={m} title={tr(label)} onClick={() => onPick(m)}
              className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--color-bg-hover)] ${m === mode ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'}`}><Icon className="h-3.5 w-3.5" /></button>
          ))}
        </div>
      )}
    </div>
  )
}

// 无终端时的空状态：引导 + 一键入口（本地终端 / 新建 SSH / 已保存主机点击直连）。
function TerminalEmptyState({ hosts, onAddLocal, onNewSsh, onConnectHost, onLoadHosts }: {
  hosts: HostSummary[]
  onAddLocal: () => void
  onNewSsh: () => void
  onConnectHost: (hostId: string) => void
  onLoadHosts: () => void
}) {
  useEffect(() => { onLoadHosts() }, [])   // 挂载即拉主机列表，供直连按钮
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[color:color-mix(in_srgb,var(--color-accent)_25%,transparent)] to-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] ring-1 ring-[color:color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
        <TerminalSquare className="h-7 w-7 text-[var(--color-accent)]" />
      </div>
      <div className="mt-4 text-[15px] font-semibold text-[var(--color-text-primary)]">{tr('还没有打开的终端')}</div>
      <div className="mt-1.5 max-w-[300px] text-center text-[12px] leading-relaxed text-[var(--color-text-muted)]">
        {trx('选择下面的方式打开一个终端开始。也可以点右上角的 {plus} 号随时新建。', { plus: <Plus className="mb-0.5 inline h-3 w-3" /> })}
      </div>
      <div className="mt-6 w-full max-w-[360px] space-y-2">
        <button onClick={onAddLocal}
          className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5 text-left transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--color-bg-hover)]">
          <MonitorDot className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{tr('本地终端')}</span>
          <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('在本机打开')}</span>
        </button>
        <button onClick={onNewSsh}
          className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5 text-left transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--color-bg-hover)]">
          <Plus className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{tr('新建 SSH 连接…')}</span>
        </button>
        {hosts.length > 0 && (
          <>
            <div className="px-1 pt-2 text-[11px] text-[var(--color-text-muted)]">{tr('已保存主机（点击直接连）')}</div>
            <HostGroups hosts={hosts} className="space-y-2" render={(h) => (
              <button key={h.id} onClick={() => onConnectHost(h.id)}
                title={`${h.label} — ${h.username}@${h.host}:${h.port}`}
                className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-2.5 text-left transition-colors hover:border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] hover:bg-[var(--color-bg-hover)]">
                <Server className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                <span className="shrink-0 max-w-[45%] truncate text-[13px] font-medium text-[var(--color-text-primary)]">{h.label}</span>
                {h.env === 'prod' && <ProdBadge />}
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{h.username}@{h.host}:{h.port}</span>
              </button>
            )} />
          </>
        )}
      </div>
    </div>
  )
}
