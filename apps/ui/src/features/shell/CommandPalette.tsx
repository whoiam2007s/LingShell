import { useEffect, useRef, useState } from 'react'
import { Search, Server, History, BookOpen, Zap, ClipboardList, Settings, MonitorDot, Plus, Sparkles, FolderTree, ShieldCheck, Lock, Columns2, Rows2, Columns3, Grid2x2, Square, TerminalSquare, CircleHelp, type LucideIcon, Container } from 'lucide-react'
import { paletteSections, parsePaletteQuery, pushRecent, resolveQuickCommand, osLabel, PALETTE_KIND_LABEL, tr, tk, getLocale, type PaletteItem, type PaletteKind, type SessionMeta, type HostSummary, type Runbook, type PromptTemplate, type QuickCommandsData, type SplitMode } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { paletteSend, paletteCtx, onPaletteClose } from '../../lib/paletteBus.js'
import { TITLES, type SettingsTab } from '../settings/index.js'
import { SETTINGS_INDEX } from '../settings/index.js'
import { ProdBadge } from '../../components/sshParts.js'
import { GitCompare, Layers, LayoutGrid } from 'lucide-react'
import { workspaceSummary } from '@lingshell/shared'
import { useHostPrefs } from '../hosts/index.js'
import { openWorkspace } from '../hosts/index.js'
import type { HostPanelTab } from '../hosts/index.js'
import { FolderSync } from 'lucide-react'
import { openDirSync } from '../explorer/index.js'
import { HELP_INDEX, HELP_SECTIONS_FULL, Highlight } from '../help/index.js'
import { searchHelp, helpTokens, type HelpTarget } from '../help/index.js'
import { BarChart3, Stethoscope } from 'lucide-react'
import { openUsage } from '../usage/index.js'
import { isAction, keyLabel } from '../../lib/keybindings.js'
import { sessionTime } from '@lingshell/shared'
import { useNow } from '../../lib/useNow.js'
import { BookMarked, Network } from 'lucide-react'
import { openKnowledge } from '../knowledge/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { LayoutDashboard, CalendarClock } from 'lucide-react'
import { openDashboard } from '../dashboard/index.js'
import { Monitor, Moon, Sun, CircleDot } from 'lucide-react'
import { UI_THEMES, themeLabel, type UiTheme } from '@lingshell/shared'
import { getLook, saveLook } from '../../lib/appearance.js'
import { BookOpenText, ClipboardCheck } from 'lucide-react'
import { Radar, GitBranch, EthernetPort, Cpu, Send, Database, Boxes, HardDrive, FileKey2, ListTree } from 'lucide-react'
import { quickScopeMatch } from '@lingshell/shared'
import { openRunbookView } from '../runbooks/index.js'
import { openComplianceBatch } from '../hostcheck/index.js'
import { openDeployReview } from '../deployReview/index.js'

// 命令面板：一个搜索框直达主机 / 会话 / 手册 / 快速命令 / 模板 / 设置页 / 动作。
// 打开：Ctrl+Shift+P（任何时候）/ Ctrl+K（焦点不在终端时）/ 标题栏搜索按钮。最近选过的记 localStorage 加权
const RECENT_KEY = 'lingshell.palette.recent'
const loadRecent = (): string[] => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }

interface Entry extends PaletteItem { icon?: LucideIcon; prod?: boolean; disabled?: string; hl?: string[]; run: () => void }   // hl = 帮助结果要高亮的词
// 帮助结果条数：混在全部结果里只给 5 条（排在最后一组，不挤占主机 / 会话 / 命令）；? 前缀只搜帮助时放宽
const HELP_LIMIT = 5, HELP_ONLY_LIMIT = 50
// 设置页的额外搜索词（页里的主要操作，搜「导出诊断包」也能找到所在页）
const SETTINGS_KEYWORDS: Partial<Record<SettingsTab, string>> = {
  maintenance: '导出配置 导入配置 备份 诊断包 数据目录 日志目录 export import diagnostics logs backup',   // i18n-ignore 搜索关键词（中英都有）
  about: '版本 检查更新 version update',   // i18n-ignore 搜索关键词
  general: '外观 主题 浅色 深色 跟随系统 界面缩放 图标大小 theme zoom appearance language',   // i18n-ignore 搜索关键词
  terminal: '终端 字体 字号 光标 滚动 回滚 编码 shell font size cursor scrollback encoding',   // i18n-ignore 搜索关键词
  shortcuts: '快捷键 按键 自定义 shortcut shortcut keys keybinding key',   // i18n-ignore 搜索关键词
  ssh: '主机 连接 密钥 凭据 host connection ssh key credential',   // i18n-ignore 搜索关键词
  ai: 'AI 安全 授权 审批 脱敏 security approval redact',   // i18n-ignore 搜索关键词
  network: '代理 网络 proxy network http socks',   // i18n-ignore 搜索关键词
  model: '模型 API Key provider model api key',   // i18n-ignore 搜索关键词
  mcp: 'MCP 工具 服务 tool server',   // i18n-ignore 搜索关键词
}
const KIND_ICON: Record<PaletteKind, LucideIcon> = { action: Sparkles, host: Server, session: History, runbook: BookOpen, quick: Zap, template: ClipboardList, settings: Settings, workspace: LayoutGrid, help: CircleHelp }
/** 动作打开了弹层但它自己没聚焦时，把键盘焦点送进最上层弹层（弹窗可能晚一两帧挂载，重试几次） */
function focusTopModal(tries = 4) {
  const top = [...document.querySelectorAll<HTMLElement>('.fixed.inset-0')].filter((e) => e.offsetParent !== null).at(-1)
  if (!top) { if (tries > 0) setTimeout(() => focusTopModal(tries - 1), 120); return }
  if (top.contains(document.activeElement)) return
  const el = top.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])')
  ;(el ?? top).focus()
}
const SPLITS: [SplitMode, string, LucideIcon][] = [['single', tk('单屏'), Square], ['cols2', tk('左右分屏'), Columns2], ['rows2', tk('上下分屏'), Rows2], ['cols3', tk('三列分屏'), Columns3], ['grid4', tk('四宫格'), Grid2x2]]
/** 动作条目：标题 / 副标题（tk() 标的中文原文）换成译文显示；非中文界面把原文并进关键词，中文也搜得到 */
function localize(e: Entry): Entry {
  const title = tr(e.title), subtitle = e.subtitle && tr(e.subtitle)
  if (getLocale() === 'zh-CN') return { ...e, title, subtitle }
  return { ...e, title, subtitle, keywords: [e.keywords, title !== e.title && e.title, subtitle !== e.subtitle && e.subtitle].filter(Boolean).join(' ') || undefined }
}

/** 打开快捷键判定（按键可在「设置 → 快捷键」改）：命令面板全局；备用键（默认 Ctrl+K）只在焦点不在终端时（终端里留给 shell 删到行尾） */
export function isPaletteKey(e: KeyboardEvent) {
  return isAction(e, 'palette') || isAction(e, 'palette.alt')
}
/** 副标题里的快捷键提示：读当前生效按键，未设置时不显示 */
const withKey = (id: string, rest?: string) => [keyLabel(id), rest].filter(Boolean).join(' · ') || undefined

export function CommandPalette({ sessions, activeSessionId, onSelectSession, onOpenSettings, onOpenHelp, onOpenHosts, onDrawer, onNewSession, onClose, onSearchHistory }: {
  onSearchHistory?: (q: string) => void
  sessions: SessionMeta[]
  activeSessionId: string
  onSelectSession: (id: string) => void
  onOpenSettings: (tab: SettingsTab, focus?: { label: string; kind: 'row' | 'section'; section?: string }) => void
  onOpenHelp: (target?: HelpTarget) => void
  onOpenHosts: (tab: HostPanelTab, save?: boolean) => void
  onDrawer: (d: 'history' | 'auth' | 'explorer') => void
  onNewSession: () => void
  onClose: () => void
}) {
  const now = useNow(60_000)   // 会话结果的相对时间
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [runbooks, setRunbooks] = useState<Runbook[]>([])
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [quick, setQuick] = useState<QuickCommandsData | null>(null)
  const [lockOn, setLockOn] = useState(false)
  const { workspaces = [] } = useHostPrefs()
  const [recent, setRecent] = useState(loadRecent)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const prevFocus = useRef(document.activeElement as HTMLElement | null)   // 关闭时还焦点（多半是终端）

  useEffect(() => {
    inputRef.current?.focus()
    client.hosts.list().then(setHosts).catch(() => {})
    client.runbooks.list().then(setRunbooks).catch(() => {})
    client.templates.list().then(setTemplates).catch(() => {})
    client.quickCommands.get().then(setQuick).catch(() => {})
    client.lock.status().then((s) => setLockOn(s.enabled)).catch(() => {})
  }, [])

  const zh = getLocale() === 'zh-CN'
  // 英文界面「help xxx」等同于「帮助 xxx」：只搜帮助（shared 的 parsePaletteQuery 只认中文前缀）
  const query = zh ? q : q.replace(/^(\s*)help\s+/i, '$1帮助 ')   // i18n-ignore 转成 shared 认的前缀
  const term = paletteCtx.term
  const notReady = paletteCtx.chatReady ? undefined : tk('AI 会话未就绪')   // 显示处 tr()
  const curTerm = (rest: string) => tr(rest, { name: term?.title ?? '' })   // i18n-ignore 转发「当前终端：{name}…」的键
  const entries: Entry[] = [
    { id: 'act:newLocal', kind: 'action', title: tk('新建本地终端'), subtitle: withKey('tab.new'), keywords: 'terminal local', icon: MonitorDot, common: true, run: () => paletteSend({ type: 'newLocal' }) },
    { id: 'act:newSsh', kind: 'action', title: tk('新建 SSH 连接…'), keywords: 'ssh connect', icon: Plus, common: true, run: () => paletteSend({ type: 'newSsh' }) },
    { id: 'act:newSession', kind: 'action', title: tk('新建会话'), keywords: 'session chat', icon: Sparkles, common: true, run: onNewSession },
    { id: 'act:history', kind: 'action', title: tk('打开历史会话列表'), keywords: 'history session', icon: History, run: () => onDrawer('history') },
    { id: 'act:explorer', kind: 'action', title: tk('打开资源管理器'), subtitle: term ? tr('当前终端：{name}', { name: term.title }) : tk('本地文件'), keywords: 'explorer files', icon: FolderTree, common: true,
      run: () => term ? paletteSend({ type: 'termDrawer', drawer: 'explorer' }) : onDrawer('explorer') },
    { id: 'act:audit', kind: 'action', title: tk('打开执行记录'), subtitle: tk('会话授权 / AI 执行过的命令'), keywords: 'audit auth', icon: ShieldCheck, common: true, run: () => onDrawer('auth') },
    { id: 'act:compareFiles', kind: 'action', title: tk('比对多台主机的文件'), subtitle: tk('只读，如 nginx.conf / sshd_config'), keywords: 'compare diff config 配置 对比', icon: GitCompare, run: () => paletteSend({ type: 'compareFiles' }) },   // i18n-ignore 搜索关键词
    { id: 'act:configKeys', kind: 'action', title: tk('配置按键对比'), subtitle: tk('.env / yaml / json / ini / properties 按键对齐比较两份配置（本机或远程任意路径）'), keywords: 'config diff env yaml json properties ini toml 配置 对比 差异 环境 按键', icon: ListTree, run: () => paletteSend({ type: 'compareFiles', mode: 'keys' }) },   // i18n-ignore 搜索关键词
    { id: 'act:certs', kind: 'action', title: tk('证书与域名巡检'), subtitle: tk('查 HTTPS 证书到期、证书链、域名匹配，每天自动检查（设置 → 定时巡检）'), keywords: 'cert certificate ssl tls https 证书 到期 过期 域名 巡检', icon: FileKey2, run: () => onOpenSettings('schedules') },   // i18n-ignore 搜索关键词
    { id: 'act:batchExec', kind: 'action', title: tk('批量执行'), subtitle: tk('多台主机跑同一条命令，结果汇总成表'), keywords: 'batch exec 批量 多台 命令 并发', icon: Layers, run: () => paletteSend({ type: 'batchExec' }) },   // i18n-ignore 搜索关键词
    { id: 'act:multiLog', kind: 'action', title: tk('多主机日志'), subtitle: tk('多台主机的日志按时间合成一个流，每行标出主机'), keywords: 'log logs tail merge 日志 合流 聚合 多台 多主机', icon: Layers, run: () => paletteSend({ type: 'multiLog', mode: 'follow' }) },   // i18n-ignore 搜索关键词
    { id: 'act:logSearch', kind: 'action', title: tk('日志历史检索'), subtitle: tk('按时间段 / 关键字检索多台的历史日志（含 .gz 轮转、journalctl）'), keywords: 'log search grep zgrep journalctl history 日志 检索 搜索 历史 轮转', icon: Layers, run: () => paletteSend({ type: 'multiLog', mode: 'search' }) },   // i18n-ignore 搜索关键词
    { id: 'act:connProbe', kind: 'action', title: tk('连通性探测'), subtitle: tk('多台源主机 × 多个目标，测 DNS / TCP / HTTP'), keywords: 'probe ping connectivity network dns tcp http port 连通 探测 网络 端口 不通 矩阵', icon: Radar, run: () => paletteSend({ type: 'connProbe' }) },   // i18n-ignore 搜索关键词
    { id: 'act:dirSync', kind: 'action', title: tk('目录同步'), subtitle: tk('本地 ⇄ 远程目录比较与同步（SFTP）'), keywords: 'sync synchronize compare 同步 比较 镜像 上传 下载 目录', icon: FolderSync, run: () => openDirSync() },   // i18n-ignore 搜索关键词
    { id: 'act:apiDebug', kind: 'action', title: tk('接口调试'), subtitle: tk('类似 REST Client：从本机或某台主机发 HTTP 请求'), keywords: 'api http rest postman curl request 接口 请求 调试', icon: Send, run: () => paletteSend({ type: 'apiDebug' }) },   // i18n-ignore 搜索关键词
  ]
  if (term) {
    entries.push({ id: 'act:cmdHistory', kind: 'action', title: tk('打开命令历史'), subtitle: curTerm(tk('当前终端：{name}')), keywords: 'history command', icon: TerminalSquare, run: () => paletteSend({ type: 'termDrawer', drawer: 'history' }) })
    entries.push({ id: 'act:docker', kind: 'action', title: tk('容器视图'), subtitle: curTerm(tk('当前终端：{name}（本地终端看本机 Docker）')), keywords: 'docker container compose 容器', icon: Container, run: () => paletteSend({ type: 'termDrawer', drawer: 'docker' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:git', kind: 'action', title: tk('Git 助手'), subtitle: curTerm(tk('当前终端：{name} · 改动 / 分支 / 历史 / 储藏 / 推送 / AI 审查')), keywords: 'git commit diff stage branch push stash rebase merge 提交 暂存 分支 推送 冲突 变基', icon: GitBranch, run: () => paletteSend({ type: 'termDrawer', drawer: 'git' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:ports', kind: 'action', title: tk('监听端口'), subtitle: curTerm(tk('当前终端：{name}（本地终端看本机：谁占了端口）')), keywords: 'ports listen netstat 端口 占用 监听', icon: EthernetPort, run: () => paletteSend({ type: 'termDrawer', drawer: 'ports' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:processes', kind: 'action', title: tk('进程'), subtitle: curTerm(tk('当前终端：{name}（本地终端看本机进程）')), keywords: 'process ps tasklist kill 进程 结束', icon: Cpu, run: () => paletteSend({ type: 'termDrawer', drawer: 'processes' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:hostcheck', kind: 'action', title: tk('主机体检'), subtitle: curTerm(tk('当前终端：{name}（仅 Linux SSH）')), keywords: 'health check profile drift 体检 巡检 漂移 档案 和上次比', icon: Stethoscope, run: () => paletteSend({ type: 'termDrawer', drawer: 'hostcheck' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:cron', kind: 'action', title: tk('定时任务'), subtitle: curTerm(tk('当前终端：{name}（仅 Linux SSH）· crontab / systemd timer')), keywords: 'cron crontab timer schedule 定时 计划任务 周期', icon: CalendarClock, run: () => paletteSend({ type: 'termDrawer', drawer: 'cron' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:firewall', kind: 'action', title: tk('防火墙规则'), subtitle: curTerm(tk('当前终端：{name}（仅 Linux SSH）· 只读')), keywords: 'firewall iptables nftables ufw firewalld 防火墙 端口 规则', icon: ShieldCheck, run: () => paletteSend({ type: 'termDrawer', drawer: 'firewall' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:database', kind: 'action', title: tk('数据库快查'), subtitle: tk('MySQL / PostgreSQL / Redis / MongoDB：会话、锁等待、慢查询归并、只读查询、表结构、Redis Key 浏览'), keywords: 'database db mysql postgres postgresql pg psql redis mongo mongodb mongosh nosql sql slow explain processlist query schema table ddl key scan 数据库 慢查询 慢日志 会话 锁 大key 查询 表结构 建表语句 切换库', icon: Database, run: () => paletteSend({ type: 'termDrawer', drawer: 'database' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:topology', kind: 'action', title: tk('服务拓扑'), subtitle: curTerm(tk('当前终端：{name}（仅 Linux SSH）· 进程 / 容器谁连谁')), keywords: 'topology connections graph 拓扑 连接 依赖 调用关系', icon: Network, run: () => paletteSend({ type: 'termDrawer', drawer: 'topology' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:k8s', kind: 'action', title: tk('Kubernetes 视图'), subtitle: curTerm(tk('当前终端：{name}（用该机器上的 kubectl）· Pod / 日志 / 事件 / 集群体检')), keywords: 'kubernetes k8s kubectl k9s pod deployment service ingress event 集群 容器编排 体检 滚动重启', icon: Boxes, run: () => paletteSend({ type: 'termDrawer', drawer: 'k8s' }) })   // i18n-ignore 搜索关键词
    entries.push({ id: 'act:disk', kind: 'action', title: tk('磁盘空间分析'), subtitle: curTerm(tk('当前终端：{name} · 谁占了空间 / 大文件 / 已删除仍被占用（只读）')), keywords: 'disk du df space 磁盘 空间 占用 满了 大文件 lsof deleted 清理', icon: HardDrive, run: () => paletteSend({ type: 'termDrawer', drawer: 'disk' }) })   // i18n-ignore 搜索关键词
    for (const [mode, label, icon] of SPLITS) entries.push({ id: `act:split:${mode}`, kind: 'action', title: tr('切换分屏布局：{name}', { name: tr(label) }), keywords: `split layout ${label}`, icon, run: () => paletteSend({ type: 'split', mode }) })
  }
  entries.push({ id: 'act:help', kind: 'action', title: tk('使用帮助'), subtitle: withKey('help'), keywords: 'help 帮助 文档 说明', icon: CircleHelp, run: () => onOpenHelp() })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:skills', kind: 'action', title: tk('打开 Skills'), subtitle: tk('导入 / 新建 / 启停 AI 用的 Skill'), keywords: 'skill skills 技能 指令 SKILL.md 导入', icon: Sparkles, run: () => onOpenSettings('skills') })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:usage', kind: 'action', title: tk('打开用量统计'), subtitle: tk('tokens / 花费 / 按日 / 按会话 / 按模型'), keywords: 'usage token cost 用量 花费 费用 统计 单价', icon: BarChart3, run: () => openUsage() })   // i18n-ignore 搜索关键词
  // 主题：每套一条（当前用的标「当前」）
  const curTheme = getLook().look.uiTheme
  for (const t of [...UI_THEMES.map((x) => x.id), 'system'] as UiTheme[]) {
    const info = UI_THEMES.find((x) => x.id === t)
    entries.push({ id: `act:theme:${t}`, kind: 'action', title: tr('主题：{name}', { name: tr(themeLabel(t)) }), subtitle: `${t === curTheme ? tr('当前 · ') : ''}${info ? tr(info.desc) : tr('随系统深浅色切换，深 / 浅各用哪套在 设置 → 通用 → 外观 选')}`,
      keywords: `theme 主题 外观 配色 ${t} ${themeLabel(t)} ${info?.kind === 'light' ? 'light 浅色 白色' : info ? 'dark 深色 暗黑 黑色' : 'system 系统'}`,   // i18n-ignore 搜索关键词
      icon: !info ? Monitor : info.kind === 'light' ? Sun : Moon, run: () => { void saveLook({ uiTheme: t }).catch(() => {}) } })
  }
  entries.push({ id: 'act:toggleBall', kind: 'action', title: tk('显示 / 隐藏悬浮球'), subtitle: tk('桌面小球：悬停看状态，右键快捷操作（设置 → 通用 → 启动与后台）'), keywords: 'ball float 悬浮球 浮窗 小球 托盘 tray', icon: CircleDot,   // i18n-ignore 搜索关键词
    run: () => { client.background.status().then((s) => client.background.configure({ ball: !s.ball })).catch(() => {}) } })
  if (lockOn) entries.push({ id: 'act:lock', kind: 'action', title: tk('锁定应用'), subtitle: withKey('app.lock'), keywords: 'lock', icon: Lock, common: true, run: () => { client.lock.lock().catch(() => {}) } })
  for (const h of hosts) entries.push({ id: `host:${h.id}`, kind: 'host', title: h.label, subtitle: `${h.username}@${h.host}:${h.port}${h.group ? ` · ${h.group}` : ''}`, keywords: h.env === 'prod' ? '生产 prod production' : undefined, prod: h.env === 'prod', run: () => paletteSend({ type: 'connectHost', hostId: h.id }) })   // i18n-ignore 搜索关键词
  for (const s of [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))) {
    const cur = s.id === activeSessionId
    const t = sessionTime(s, now)?.text
    // 标题显示译文（默认标题「新会话」→ New session），关键词带上原文：中文也搜得到
    entries.push({ id: `session:${s.id}`, kind: 'session', title: s.title ? tr(s.title) : tr('会话'), keywords: s.title || undefined, subtitle: [cur ? tr('当前会话') : '', t, s.workDir].filter(Boolean).join(' · ') || undefined,
      run: () => { if (!cur) onSelectSession(s.id) } })   // 只有一个会话时 # 不再显示「没有匹配项」
  }
  for (const r of runbooks) entries.push({ id: `runbook:${r.id}`, kind: 'runbook', title: r.name, subtitle: r.description || tr('{n} 步', { n: r.steps.length }), disabled: notReady, run: () => paletteSend({ type: 'runbook', id: r.id }) })
  // 手册视图（手动逐条执行到当前终端）；批量合规检查
  entries.push({ id: 'act:runbookView', kind: 'action', title: tk('打开运维手册视图'), subtitle: tk('参数填一次，命令块逐条执行到当前终端，显示退出码与耗时'), keywords: 'runbook notebook 手册 运维手册 逐条 手动执行 warp', icon: BookOpenText, run: () => openRunbookView() })   // i18n-ignore 搜索关键词
  for (const r of runbooks) entries.push({ id: `runbookView:${r.id}`, kind: 'runbook', title: tr('逐条执行：{name}', { name: r.name }), subtitle: tr('手册视图 · {n} 步', { n: r.steps.length }), keywords: 'notebook 手册视图 手动', run: () => openRunbookView(r.id) })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:complianceBatch', kind: 'action', title: tk('批量合规检查'), subtitle: tk('对分组 / 多台主机跑 Linux 基线检查，出「主机 × 条目」矩阵，可导出 CSV'), keywords: 'compliance baseline 合规 基线 安全检查 等保 cis 矩阵', icon: ShieldCheck, run: () => openComplianceBatch() })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:deployReview', kind: 'action', title: tk('部署评审'), subtitle: tk('导入部署文档和产物，AI 解读成部署清单、找风险，目标主机只读预检，出评审报告'), keywords: 'deploy review 部署 上线 评审 发布 文档 检查 风险 预检 报告', icon: ClipboardCheck, run: () => openDeployReview() })   // i18n-ignore 搜索关键词
  for (const t of templates) entries.push({ id: `template:${t.id}`, kind: 'template', title: t.name, subtitle: t.prompt.replace(/\s+/g, ' ').slice(0, 80), disabled: notReady, run: () => paletteSend({ type: 'template', id: t.id }) })
  // 快速命令按当前终端的系统解析（副标题显示实际会发的命令）；该系统不可用的不列
  // 限定了主机 / 分组的（显示范围）只在匹配的终端上列
  if (term && quick) for (const set of quick.sets) for (const c of set.commands) {
    if (!quickScopeMatch(set.scope, term.scope) || !quickScopeMatch(c.scope, term.scope)) continue
    const r = resolveQuickCommand(c, term.os)
    if ('unsupported' in r) continue
    entries.push({ id: `quick:${c.id}`, kind: 'quick', title: c.label, subtitle: `${quick.sets.length > 1 ? `${set.name} · ` : ''}${r.command.split('\n')[0]}`, keywords: osLabel(term.os), run: () => paletteSend({ type: 'quick', setId: set.id, cmdId: c.id }) })
  }
  // 设置页：标题显示译文，关键词带上原文（中英文都搜得到）
  for (const [tab, title] of Object.entries(TITLES) as [SettingsTab, string][]) entries.push({ id: `settings:${tab}`, kind: 'settings', title: tr('设置：{name}', { name: tr(title) }), keywords: [title, SETTINGS_KEYWORDS[tab]].filter(Boolean).join(' '), run: () => onOpenSettings(tab) })
  // 每个设置项（从设置页源码生成的索引，键是中文原文）：搜标签 / 说明 / 分组，点了打开那一页并定位到它
  for (const e of SETTINGS_INDEX) {
    const where = [tr('设置 › {name}', { name: tr(TITLES[e.tab as SettingsTab]) }), e.kind === 'row' && e.section ? tr(e.section) : undefined].filter(Boolean).join(' › ')
    entries.push({ id: `setting:${e.tab}:${e.kind}:${e.label}`, kind: 'settings', title: tr(e.label), subtitle: e.hint ? `${where} · ${tr(e.hint)}` : where,
      keywords: [e.section && tr(e.section), e.tip && tr(e.tip), ...(zh ? [] : [e.label, e.section, e.hint, e.tip])].filter(Boolean).join(' '), icon: Settings, run: () => onOpenSettings(e.tab as SettingsTab, { label: e.label, kind: e.kind, section: e.section }) })
  }
  // 主机面板 / 工作区
  entries.push({ id: 'act:hostPanel', kind: 'action', title: tk('打开主机面板'), subtitle: withKey('hostPanel', tr('收藏 / 最近 / 分组 / 延迟')), keywords: 'hosts sidebar 主机 会话管理器 收藏', icon: Server, common: true, run: () => onOpenHosts('hosts') })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:dashboard', kind: 'action', title: tk('打开仪表盘'), subtitle: tk('所有主机的 CPU / 内存 / 磁盘 / 负载、失败服务、告警一览'), keywords: 'dashboard 仪表盘 多主机墙 监控 总览 大屏 主机状态', icon: LayoutDashboard, common: true, run: () => openDashboard() })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:saveWorkspace', kind: 'action', title: tk('保存当前布局为工作区…'), subtitle: tk('当前终端 + 分屏'), keywords: 'workspace save layout 工作区 保存', icon: LayoutGrid, run: () => onOpenHosts('workspaces', true) })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:workspaces', kind: 'action', title: tk('管理工作区'), keywords: 'workspace 工作区 重命名 删除', icon: LayoutGrid, run: () => onOpenHosts('workspaces') })   // i18n-ignore 搜索关键词
  for (const w of workspaces) entries.push({ id: `workspace:${w.id}`, kind: 'workspace', title: tr('打开工作区：{name}', { name: w.name }), subtitle: workspaceSummary(w), keywords: 'workspace 工作区', run: () => openWorkspace(w) })   // i18n-ignore 搜索关键词
  // 知识库 / 跨主机提问（预填对话输入框，由用户补完问题再发；AI 用 run_on_hosts 在整组主机上并行跑只读命令）
  entries.push({ id: 'act:knowledge', kind: 'action', title: tk('打开知识库'), subtitle: tk('主机 / 分组 / 全局知识卡：部署、日志位置、启停方式、已知问题'), keywords: 'knowledge 知识库 备注 主机备注 笔记 文档', icon: BookMarked, common: true, run: () => openKnowledge() })   // i18n-ignore 搜索关键词
  const fleetGroups = [...new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))]
  if (hosts.length) entries.push({ id: 'act:fleetAsk', kind: 'action', title: tk('跨主机提问：所有主机'), subtitle: tr('预填「{text}」，AI 并行跑只读命令后汇总对比', { text: tr('在所有主机上检查：') }), keywords: 'fleet 跨主机 多台 所有机器 对比 舰队 run_on_hosts', icon: Network, disabled: notReady, run: () => quoteToChat(tr('在所有主机上检查：')) })   // i18n-ignore 搜索关键词
  entries.push({ id: 'act:postmortem', kind: 'action', title: tk('生成故障复盘'), subtitle: tk('让 AI 把当前会话整理成复盘报告（时间线取自执行记录），回复下方可保存为 .md'), keywords: 'postmortem 复盘 故障 事故 报告 时间线 根因 incident', icon: ClipboardList, disabled: notReady ?? paletteCtx.postmortemOff, run: () => paletteSend({ type: 'postmortem' }) })   // i18n-ignore 搜索关键词
  for (const g of fleetGroups) entries.push({ id: `act:fleetAsk:${g}`, kind: 'action', title: tr('跨主机提问：{group}', { group: g }), subtitle: tr('预填「{text}」', { text: tr('在 {group} 所有主机上检查：', { group: g }) }), keywords: 'fleet 跨主机 多台 分组 对比 舰队', icon: Network, disabled: notReady, run: () => quoteToChat(tr('在 {group} 所有主机上检查：', { group: g })) })   // i18n-ignore 搜索关键词
  // 动作的标题 / 副标题多是 tk() 标的中文原文：这里换成译文显示，非中文界面把原文并进关键词（中英文都搜得到）
  const items = entries.map((e) => (e.kind === 'action' ? localize(e) : e))

  // 跨会话全文检索：带上面板里打的词打开历史会话抽屉（对话内容 / 执行过的命令 / AI 结论）
  const { kind: filter, text } = parsePaletteQuery(query)
  // 兜底项：有搜索词时不参与打分，固定放在最后一组（否则它带着搜索词总排在真正匹配的结果前面）
  const historyItem: Entry | undefined = onSearchHistory && { id: 'act:searchHistory', kind: 'action', title: tr('搜索历史会话内容'),
    subtitle: text.trim() ? tr('在所有会话的对话、命令、AI 结论里全文检索「{q}」', { q: text.trim() }) : tr('在所有会话的对话、执行过的命令、AI 结论里全文检索'), keywords: `search history 搜索 历史 会话 内容 全文 上次${zh ? '' : ' 搜索历史会话内容'}`, icon: History, run: () => onSearchHistory(text.trim()) }   // i18n-ignore 搜索关键词
  if (historyItem && !text.trim()) items.push(historyItem)

  // 帮助：运行时从帮助内容建的索引里搜（不进 paletteSections 打分），作为最后一组「帮助」追加；空查询不出，? 前缀空查询列全部章节
  const hl = helpTokens(text)
  const helpItems: Entry[] = filter && filter !== 'help' ? []
    : filter === 'help' && !hl.length ? HELP_SECTIONS_FULL.map((s) => ({ id: `help:${s.id}`, kind: 'help', title: s.title, icon: s.icon, run: () => onOpenHelp({ section: s.id }) }))
    : searchHelp(HELP_INDEX, text, filter === 'help' ? HELP_ONLY_LIMIT : HELP_LIMIT).map(({ doc, snippet }) => ({
        id: `help:${doc.section}:${doc.block}`, kind: 'help', title: doc.h ? `${doc.sectionTitle} › ${doc.h}` : doc.sectionTitle, subtitle: snippet, hl,
        run: () => onOpenHelp({ section: doc.section, block: doc.block, q: text }),
      }))
  // 分组名保持中文原文（下面按 '最近使用' 比较），显示处 tr()
  const sections = [...paletteSections(query, items, recent), ...(helpItems.length ? [{ label: tk('帮助'), items: helpItems }] : []),
    ...(historyItem && text.trim() && (!filter || filter === 'action') ? [{ label: tk('全文检索'), items: [historyItem] }] : [])]
  const flat = sections.flatMap((s) => s.items)
  const cur = Math.min(sel, Math.max(flat.length - 1, 0))

  useEffect(() => { listRef.current?.querySelector(`#pal-opt-${cur}`)?.scrollIntoView({ block: 'nearest' }) }, [cur, q])

  const close = () => { onClose(); prevFocus.current?.focus?.() }
  const closeRef = useRef(close); closeRef.current = close
  // 用快捷键（Ctrl+Shift+P / Ctrl+K）关面板也走同一个 close：焦点回到打开前的终端 / 输入框
  useEffect(() => onPaletteClose(() => closeRef.current()), [])
  const run = (it: Entry | undefined) => {
    if (!it || it.disabled) return
    if (it.kind !== 'help') {   // 帮助结果不记最近使用（随搜索词变化，记了也找不回来）
      const next = pushRecent(recent, it.id)
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* 存不了就不记 */ }
      setRecent(next)
    }
    close()
    setTimeout(() => {   // 等面板卸载、焦点归位后再执行（picker / 弹窗的 autoFocus 才不被抢）
      it.run()
      // 有些弹窗自己不聚焦：把焦点送进最上层弹层，否则按键会继续打到后面的终端 / 对话
      setTimeout(focusTopModal, 60)
    }, 0)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length) setSel((cur + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (e.key === 'Enter') { e.preventDefault(); run(flat[cur]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }   // 只关面板，不连带关掉后面的确认框
  }

  let n = 0
  return (
    <div className="fixed inset-0 z-[70] flex justify-center bg-black/40 pt-[12vh] animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>   {/* 命令面板例外：点遮罩收起（其它弹窗不点空白关闭） */}
      <div role="dialog" aria-modal="true" aria-label={tr('命令面板')} onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[min(560px,76vh)] w-[min(620px,92vw)] flex-col self-start overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3.5">
          <Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} onKeyDown={onKey}
            aria-label={tr('命令面板搜索')}
            role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-activedescendant={flat.length ? `pal-opt-${cur}` : undefined}
            placeholder={tr('搜索主机、会话、手册、快速命令、模板、设置、使用帮助…（? 开头只搜帮助）')}
            className="h-11 min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
          <kbd className="shrink-0 rounded border border-[var(--color-border-default)] px-1 text-[10px] text-[var(--color-text-muted)]">Esc</kbd>
        </div>
        {/* 提示行：空查询给前缀说明；有前缀时说明正在过滤哪一类 */}
        <div className="border-b border-[var(--color-border-subtle)] px-3.5 py-1 text-[11px] text-[var(--color-text-muted)]">
          {filter ? tr('仅显示「{kind}」· 删掉前缀搜全部', { kind: tr(PALETTE_KIND_LABEL[filter]) })
            : <>{tr('前缀过滤：')}{([['>', tr('动作')], ['@', tr('主机')], ['#', tr('会话')], ['?', tr('帮助')]] as const).map(([p, l]) => <span key={p} className="mr-3"><b className="font-mono text-[var(--color-text-secondary)]">{p}</b> {l}</span>)}</>}
        </div>
        <div ref={listRef} id="pal-list" role="listbox" aria-label={tr('搜索结果')} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!flat.length && <div role="status" aria-live="polite" className="px-3 py-6 text-center text-[12px] text-[var(--color-text-muted)]">{tr('没有匹配项')}</div>}
          {sections.map((s) => (
            <div key={s.label} role="group" aria-labelledby={`pal-g-${s.label}`}>
              <div id={`pal-g-${s.label}`} role="presentation" className="px-2.5 pb-1 pt-2 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr(s.label)}</div>
              {s.items.map((it) => {
                const i = n++
                const Icon = it.icon ?? KIND_ICON[it.kind]
                return (
                  <div key={it.id} id={`pal-opt-${i}`} role="option" aria-selected={i === cur} aria-disabled={!!it.disabled}
                    onMouseMove={() => { if (i !== cur) setSel(i) }} onClick={() => run(it)}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 ${i === cur ? 'bg-[var(--color-accent-bg)]' : ''} ${it.disabled ? 'opacity-50' : ''}`}>
                    <Icon className={`h-4 w-4 shrink-0 ${i === cur ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
                    {it.hl ? (
                      // 帮助结果两行：「章节 › 小节」+ 命中片段，命中词高亮
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[12.5px] text-[var(--color-text-primary)]"><Highlight text={it.title} tokens={it.hl} /></span>
                        {it.subtitle && <span className="truncate text-[11px] text-[var(--color-text-muted)]"><Highlight text={it.subtitle} tokens={it.hl} /></span>}
                      </span>
                    ) : <>
                    <span className="shrink-0 max-w-[55%] truncate text-[12.5px] text-[var(--color-text-primary)]">{it.title}</span>
                    {it.prod && <ProdBadge />}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{it.disabled ? tr(it.disabled) : it.subtitle}</span>
                    </>}
                    {s.label === '最近使用' /* i18n-ignore 比较原文 */ && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{tr(PALETTE_KIND_LABEL[it.kind])}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="flex gap-3 border-t border-[var(--color-border-subtle)] px-3.5 py-1.5 text-[10.5px] text-[var(--color-text-muted)]">
          <span>{tr('↑↓ 选择')}</span><span>{tr('Enter 执行')}</span><span>{tr('Esc 关闭')}</span><span className="ml-auto">{[keyLabel('palette.alt'), keyLabel('palette')].filter(Boolean).join(' / ')}</span>
        </div>
      </div>
    </div>
  )
}
