import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown, Upload, Download, Trash2, FilePlus, FolderPlus, ArrowUp, ArrowLeft, ArrowRight, Search, Bookmark, LocateFixed, Link2, Filter, Columns2, FolderSymlink, FileSymlink, SlidersHorizontal, AlertCircle, Check, ArrowDown, FolderX } from 'lucide-react'
import {
  nameFilter, filterTree, filterHighlight, nameError, isWinPath, parentPath, rangeSelect, topLevelPaths, deleteConfirmText, archiveKind, attrsTooltip, formatSize, modeOctal,
  sortEntries, isHiddenName, breadcrumbs, fsErrorText, typeAheadTarget, moveCursor, shortTime,
  SEARCH_LIMIT, SEARCH_MAX_DEPTH, type DeletePlan, type DirEntry, type FsScope, type SearchHit, type SortSpec, type SortKey,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ConfirmDialog } from '../common/index.js'
import { FileEditor } from './FileEditor.js'
import { ChmodDialog } from './ChmodDialog.js'
import { openDirSync } from './DirSyncDialog.js'
import { openLogViewer } from '../logs/index.js'
import { previewKind } from '@lingshell/shared'
import { FilePreview } from './FilePreview.js'
import { openDirInVscode } from '../../components/VscodeRemote.js'
import { attachPathsToChat, LOCAL_PATHS_MIME } from '../../lib/localPaths.js'
import { setLastDir } from './explorerMemory.js'
import { useClip, setClip, PasteConflictDialog, PropsDialog, ChownDialog, SudoDialog } from './ExplorerDialogs.js'
import { baseName, isInside, SUDO_NEED_PW, tk, tr, type ConflictPolicy, type ContentHit } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
// 从系统拖进来的文件取本地路径（preload 里 webUtils.getPathForFile；File.path 已废弃）
const pathForFile = (f: File) => (window as unknown as { electronAPI?: { pathForFile?: (f: File) => string } }).electronAPI?.pathForFile?.(f) ?? ''

type Draft = { kind: 'file' | 'dir'; dir: string } | { kind: 'rename'; entry: DirEntry }
const SEL = 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]'

// 目录书签：按主机存 localStorage（hostKey → 路径列表）；「显示详细信息」开关同样记在 localStorage
const BM_KEY = 'lingshell.explorerBookmarks', DETAILS_KEY = 'lingshell.explorerDetails', FOLLOW_KEY = 'lingshell.explorerFollowCwd', BM_MAX = 50
const SORT_KEY = 'lingshell.explorerSort', HIDDEN_KEY = 'lingshell.explorerShowHidden', HIST_MAX = 50
const loadSort = (): SortSpec => {
  try { const v = JSON.parse(localStorage.getItem(SORT_KEY) ?? ''); if (['name', 'size', 'mtime'].includes(v?.key)) return { key: v.key, desc: !!v.desc } } catch { /* 用默认 */ }
  return { key: 'name', desc: false }
}
const SORT_LABEL: Record<SortKey, string> = { name: tk('名称'), size: tk('大小'), mtime: tk('修改时间') }   // 显示处 tr
// 应用内拖动的行：dragover 时读不到 getData，所以来源记在这里（同一时刻只会有一次拖动）
const DRAG_TYPE = 'application/x-lingshell-paths'
let dragSrc: { scopeKey: string; paths: string[] } | null = null

// 右键菜单：Portal 到 body（抽屉面板有 transform，fixed 定位会被拽偏）；量一下自身大小，超出窗口就往回挪
function FloatMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  // Esc 只关菜单（捕获阶段拦下，免得抽屉跟着关）
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])
  return createPortal(
    <div ref={ref} data-ctx-menu style={pos} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose() }} onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] max-h-[calc(100vh-8px)] w-52 overflow-y-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
      {children}
    </div>, document.body)
}
function MI({ onClick, kbd, danger, children, ...rest }: { onClick: () => void; kbd?: string; danger?: boolean; children: React.ReactNode; [k: `data-${string}`]: unknown }) {
  return (
    <button {...rest} onClick={onClick} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] ${danger ? 'hover:text-[var(--color-danger)]' : ''}`}>
      <span className="min-w-0 flex-1 truncate">{children}</span>{kbd && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{kbd}</span>}
    </button>
  )
}
// 相邻 / 首尾的分隔线用 CSS 去掉（条件项缺席时不会出现两条线）
const Sep = () => <div className="my-1 border-t border-[var(--color-border-subtle)] first:hidden last:hidden [&+&]:hidden" />

// 悬浮提示：属性 + 链接指向
const entryTip = (e: DirEntry) => attrsTooltip(e) + (e.isLink ? `\n${tr('链接到：{target}', { target: e.linkTarget ?? tr('（读不到）') })}${e.linkBroken ? tr('（目标不存在）') : ''}` : '')
const loadAllBm = (): Record<string, string[]> => {
  try { const v = JSON.parse(localStorage.getItem(BM_KEY) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
const saveBm = (hostKey: string, list: string[]) => {
  try { localStorage.setItem(BM_KEY, JSON.stringify({ ...loadAllBm(), [hostKey]: list })) } catch { /* 存不了就只在本次有效 */ }
}

// 资源管理器抽屉。scope: 'local'（本地 FS）或 { terminalId }（远程 via sftp）。rootPath: 初始根路径（本地会话侧传 workDir，终端本地侧传 undefined→'/'，远程传 '/' 或终端 pwd）。
// 多选：Ctrl 点选切换、Shift 范围选；Delete 删除、F2 重命名。远程目录可直接从系统拖文件进来上传（onDropUpload）。
// 远程另有：权限/大小列与悬浮属性、修改权限、压缩/解压、按名称搜索（服务器命令都走独立 exec channel）。书签本地远程都有，按 hostKey 存。
// 快速过滤（Ctrl+F）：纯前端过滤已展开的条目，与服务器 find 的「按名称搜索」互补。
// 终端侧另有：「跟随终端目录」开关（终端 cd 后自动跳过去）与「转到终端当前目录」按钮；远程文件右键「用本地编辑器打开」（保存自动回传）。
// 浏览：后退/前进（Alt+←/→）、可点的面包屑（点空白处或 Ctrl+L 改路径）、排序、隐藏文件开关、详细信息列（开着时抽屉加宽，onWide 通知外层）、
// 键盘（↑↓ 移动、Shift+↑↓ 扩选、→/← 展开/折叠、Enter 打开、Backspace 上一级、Ctrl+A 全选、F5 刷新、直接打字跳到同名开头的项）。
// 文件操作：复制 / 剪切 / 粘贴（Ctrl+C / X / V，同名可选覆盖 / 跳过 / 保留两者）、复制一份、复制路径、属性（大小统计 + 校验和）、远程改属主、本地远程都能按名称 / 内容搜索。
export function ExplorerDrawer({ scope: scope0, rootPath, hostKey, prod, termCwd, onGotoCwd, onUpload, onDownload, onDropUpload, onDiskUsage, onWide, onCdHere, onOpenDual, memKey, pane, onClose }: {
  scope: FsScope
  rootPath?: string
  hostKey?: string                                  // 书签按主机分组；缺省本地 'local'、远程按终端
  prod?: boolean                                    // 生产主机：删除/改权限确认标红
  termCwd?: string                                  // 所属终端的当前目录（shell 集成上报，随 cd 变化）
  onGotoCwd?: () => Promise<string>                 // 取终端当前目录（有它才显示跟随开关与转到按钮）
  onUpload?: (localPaths: string[]) => void       // 本地：上传到服务器（可多选）
  onDownload?: (remotePaths: string[]) => void
  onDropUpload?: (localPaths: string[], remoteDir: string) => void
  onDiskUsage?: (dir: string) => void              // 目录右键「分析磁盘占用」（终端侧才有）
  onWide?: (wide: boolean) => void                  // 详细信息列开关：外层据此加宽抽屉
  onCdHere?: (dir: string) => void                  // 「在终端中打开」：所属终端 cd 过去（终端侧才有）
  onOpenDual?: () => void                           // 打开双栏窗口（远程才有）
  memKey?: string                                   // 记住最后停在的目录（见 explorerMemory.ts）：session:<id> / term:<id>
  // ── 双栏窗口里当一栏用 ──
  pane?: { title: string; active: boolean; onActivate: () => void; refreshSignal: number; onSelChange: (paths: string[], root: string) => void
    onCrossDrop: (paths: string[], dir: string) => void      // 从另一栏拖进来的项：上传 / 下载到 dir
    sendLabel: string; onSend: (paths: string[]) => void }   // 右键「上传到右栏 / 下载到左栏」：送到另一栏的当前目录
  onClose: () => void
}) {
  const isRemote = scope0 !== 'local'
  // sudo 模式（远程）：之后的列目录 / 读写 / 增删改都经 sudo 在服务器上做；scope 带上 sudo 传给主进程
  const [sudoMode, setSudoMode] = useState(false)
  const [sudoAsk, setSudoAsk] = useState(false)
  const [sudoTick, setSudoTick] = useState(0)   // 验证完密码 +1：编辑器据此重读
  const scope: FsScope = scope0 !== 'local' && sudoMode ? { ...scope0, sudo: true } : scope0
  // 主进程报「需要 sudo 密码」（带标记）就弹密码框；显示的文字去掉标记
  const errOf = (e: unknown) => { const m = errMsg(e); if (m.includes(SUDO_NEED_PW)) { setSudoAsk(true); return m.replace(SUDO_NEED_PW, '') } return m }
  const denied = (m?: string) => !!m && isRemote && !sudoMode && !winHost && /没有权限|Permission denied|EACCES/i.test(m)   // i18n-ignore 匹配报错文本
  const [root, setRoot] = useState(rootPath ?? '/')
  const [hist, setHist] = useState<{ list: string[]; i: number }>(() => ({ list: [rootPath ?? '/'], i: 0 }))
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})   // 列目录失败的原因（按目录），显示在该目录下并可重试
  const [sort, setSort] = useState<SortSpec>(loadSort)
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) !== '0')
  const [viewOpen, setViewOpen] = useState(false)
  const [editPath, setEditPath] = useState(false)
  const [cursor, setCursor] = useState<string>()   // 键盘焦点所在项（Shift 扩选时与 anchor 分开）
  const listRef = useRef<HTMLDivElement>(null)
  const crumbRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ paths: string[]; plan: DeletePlan } | null>(null)
  const [chmodFor, setChmodFor] = useState<{ paths: string[]; mode: number; anyDir: boolean } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)   // 正在查看/编辑的文件路径
  const [previewing, setPreviewing] = useState<string | null>(null)   // 正在预览的图片 / Markdown / CSV / PDF
  const openFile = (p: string) => (previewKind(p) ? setPreviewing(p) : setEditing(p))   // 双击：能预览的预览，其余进编辑器
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string>()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftErr, setDraftErr] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')                          // 压缩/解压/改权限进行中的提示
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [details, setDetails] = useState(() => localStorage.getItem(DETAILS_KEY) === '1')
  // search=null：不在搜索；有值：搜索栏打开（result 有值时列表区显示结果代替目录树）
  // kind：按名称 / 按内容；内容搜索的结果在 content 里（带行号和那一行）
  const [search, setSearch] = useState<{ query: string; kind?: 'name' | 'content'; running: boolean; root?: string; result?: { hits: SearchHit[]; content?: ContentHit[]; truncated: boolean; timedOut: boolean } } | null>(null)

  // 依赖原始值 scopeKey 而非 scope 对象：调用方每次渲染新建 { terminalId } 会让 load/effect 重跑、每次重渲染都 listDir
  const scopeKey = scope === 'local' ? 'local' : scope.terminalId
  const bmKey = hostKey ?? (scope === 'local' ? 'local' : `term:${scope.terminalId}`)
  const [bookmarks, setBookmarks] = useState<string[]>(() => loadAllBm()[bmKey] ?? [])
  const [bmOpen, setBmOpen] = useState(false)
  const toggleBm = (p: string) => {
    const next = bookmarks.includes(p) ? bookmarks.filter((b) => b !== p) : [...bookmarks, p].slice(-BM_MAX)
    setBookmarks(next); saveBm(bmKey, next)
  }

  // 出错不再当成空目录：记下原因，该目录下显示原因 + 重试
  // 同一目录连着读几次（刷新、切 sudo）时，只认最后一次的结果：慢的旧请求晚到不能盖掉新的
  const loadSeq = useRef<Record<string, number>>({})
  const load = useCallback((path: string) => {
    const n = (loadSeq.current[path] = (loadSeq.current[path] ?? 0) + 1)
    setErrors((x) => { if (!(path in x)) return x; const c = { ...x }; delete c[path]; return c })
    client.fs.listDir(scope, path).then((ents) => { if (loadSeq.current[path] === n) setChildren((c) => ({ ...c, [path]: ents })) })
      .catch((e) => {
        if (loadSeq.current[path] !== n) return
        setErrors((x) => ({ ...x, [path]: fsErrorText(errOf(e)) }))
        setChildren((c) => { const m = { ...c }; delete m[path]; return m })
      })
  }, [scopeKey, sudoMode])

  useEffect(() => { load(root) }, [load, root])
  // 切换 sudo：换了身份，之前读到的列表都作废（不能拿 root 读到的内容冒充普通用户看到的），展开的目录全部按新身份重读
  const sudo0 = useRef(sudoMode)
  useEffect(() => {
    if (sudo0.current === sudoMode) return
    sudo0.current = sudoMode
    setChildren({}); setErrors({})
    load(root); expanded.forEach((p) => load(p))
  }, [sudoMode])
  useEffect(() => { onWide?.(details) }, [details])
  // 面包屑太长时滚到最右（当前目录那一段始终可见）
  useEffect(() => { const el = crumbRef.current; if (el) el.scrollLeft = el.scrollWidth }, [root, editPath])

  // 常用位置（书签面板顶部）：打开面板时取一次
  // 远程一打开就取：顺带知道是不是 Windows 自带 OpenSSH（没有 sh，权限 / 压缩 / 内容搜索 / sudo 等用不了，菜单里就不出现）
  const [places, setPlaces] = useState<{ home?: string; items: { label: string; path: string }[]; windows?: boolean }>()
  useEffect(() => { if ((bmOpen || isRemote) && !places) client.fs.places(scope0).then(setPlaces).catch(() => setPlaces({ items: [] })) }, [bmOpen])
  const winHost = !!places?.windows

  // 右键菜单：打开后点任意处关闭。用 mousedown 全局关。
  // 延迟一帧挂监听：否则打开菜单的那次右键(contextmenu/mousedown/mouseup)可能被立即捕获，菜单闪现即关。
  useEffect(() => {
    if (!menu) return
    const onDown = () => setMenu(null)
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown) }
  }, [menu])

  // 快速过滤（Ctrl+F 聚焦、Esc 清空）：只过滤已加载、已展开的条目，纯前端；换目录即清空
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setFilter('') }, [root])
  const match = nameFilter(filter)
  const ft = match ? filterTree(children, root, expanded, match) : undefined
  const shown = (e: DirEntry) => !ft || ft.show.has(e.path)

  const byPath = new Map(Object.values(children).flat().map((e) => [e.path, e]))
  // 某目录下实际显示的项：隐藏文件开关 + 快速过滤 + 排序（展示、范围选、键盘移动都用这一份顺序）
  const kids = (path: string) => sortEntries((children[path] ?? []).filter((e) => (showHidden || !isHiddenName(e.name)) && shown(e)), sort)
  const visible = (path: string): string[] => kids(path).flatMap((e) => [e.path, ...(e.isDir && expanded.has(e.path) ? visible(e.path) : [])])
  // 父目录；比根还短（'/a'→'/'、根是 /home/u）说明父目录就是根
  const dirOf = (p: string) => { const d = parentPath(p); return d.length < root.length ? root : d }
  const winNames = !isRemote && isWinPath(root)

  // 换根（上一级 / 进入目录 / 书签 / 搜索结果定位）：select 为换根后要选中的项；记入后退/前进历史
  const goTo = (raw: string, select?: string, fromHist = false) => {
    if (!raw) return
    // ~ 开头：换成主目录
    if (/^~([\\/]|$)/.test(raw)) { client.fs.places(scope).then((pl) => (pl.home ? goTo(pl.home + raw.slice(1), select) : setErr(tr('取不到主目录')))).catch((e) => setErr(errOf(e))); return }
    // 去掉末尾的斜杠（根目录 / 和 D:\ 除外）；本地 Windows 路径统一成反斜杠，和列出来的路径一致（选中、上一级才对得上）
    let p = !isRemote && isWinPath(raw) ? raw.replace(/\//g, '\\') : raw
    if (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:\\$/.test(p)) p = p.replace(/[\\/]+$/, '') || '/'
    if (/^[A-Za-z]:$/.test(p)) p += '\\'
    if (!fromHist && p !== root) setHist((h) => { const list = [...h.list.slice(0, h.i + 1), p].slice(-HIST_MAX); return { list, i: list.length - 1 } })
    setRoot(p); setSel(new Set(select ? [select] : [])); setAnchor(select); setCursor(select); setDraft(null); setBmOpen(false); setEditPath(false)
  }
  const goHist = (d: -1 | 1) => {
    const i = hist.i + d
    if (i < 0 || i >= hist.list.length) return
    setHist({ ...hist, i }); goTo(hist.list[i], undefined, true)
  }
  // 上一级：选中刚离开的目录，方便接着往下走
  const goUp = () => { const up = parentPath(root); if (up !== root) goTo(up, root) }
  // 记住停在的目录（下次打开回到这里）；只记打得开的
  useEffect(() => { if (memKey && children[root]) setLastDir(memKey, root) }, [memKey, root, !!children[root]])
  // 外层给的根变了（打开时取到终端 pwd、从别处「定位」过来）：重新开始，不算一步可后退的历史
  useEffect(() => { setHist({ list: [rootPath ?? '/'], i: 0 }); goTo(rootPath ?? '/', undefined, true) }, [rootPath])
  // 刷新：根和所有已展开的目录就地重读（不清空，避免闪「加载中」、不丢展开状态）
  const refreshAll = () => { load(root); expanded.forEach((p) => { if (children[p] || errors[p]) load(p) }) }
  // 双栏：选中项 / 当前目录告诉外层；外层传完东西后递增 refreshSignal 让这一栏刷新
  useEffect(() => { pane?.onSelChange([...sel], root) }, [sel, root])
  const sig0 = useRef(pane?.refreshSignal)
  useEffect(() => { if (pane && pane.refreshSignal !== sig0.current) { sig0.current = pane.refreshSignal; refreshAll() } }, [pane?.refreshSignal])

  // 跟随终端目录：开着时终端每次 cd（提示符上报的目录变了）就把根切过去；开关记在 localStorage
  const [follow, setFollow] = useState(() => localStorage.getItem(FOLLOW_KEY) === '1')
  useEffect(() => { if (onGotoCwd && follow && termCwd) goTo(termCwd) }, [follow, termCwd])
  const toggleFollow = () => setFollow((f) => { localStorage.setItem(FOLLOW_KEY, f ? '0' : '1'); return !f })
  const gotoCwd = () => { onGotoCwd?.().then((p) => (p ? goTo(p) : setErr(tr('取不到终端当前目录（终端忙或未连接）')))).catch((e) => setErr(errOf(e))) }

  // 用本地编辑器打开（远程）：下载到临时目录并唤起编辑器，之后每次保存由主进程自动回传
  const [note, setNote] = useState('')   // 短暂的成功提示
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(''), 6000); return () => clearTimeout(t) }, [note])
  const editExternal = (p: string) => {
    setErr(''); setBusy(tr('正在下载并用本地编辑器打开…'))
    client.fs.editExternal(scope, p)
      .then(() => { setBusy(''); setNote(tr('已用本地编辑器打开 {name}，保存后自动上传（关闭此终端即停止）', { name: p.split('/').pop() ?? p })) })
      .catch((e) => { setBusy(''); const m = errOf(e); if (m !== '已取消') setErr(m) })   // i18n-ignore 主进程用这个原文表示「用户取消」
  }

  const expand = (path: string) => {
    if (path === root) return
    setExpanded((s) => new Set(s).add(path))
    if (!children[path]) load(path)
  }
  const toggle = (e: DirEntry) => {
    if (!e.isDir) return
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(e.path)) n.delete(e.path)
      else { n.add(e.path); if (!children[e.path]) load(e.path) }
      return n
    })
  }
  const refresh = (path: string) => { setChildren((c) => { const n = { ...c }; delete n[path]; return n }); load(path) }

  const onRowClick = (ev: React.MouseEvent, e: DirEntry) => {
    setCursor(e.path)
    if (ev.ctrlKey || ev.metaKey) {
      setSel((s) => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n })
      setAnchor(e.path)
    } else if (ev.shiftKey) {
      setSel(new Set(rangeSelect(visible(root), anchor, e.path)))
    } else {
      setSel(new Set([e.path])); setAnchor(e.path); toggle(e)
    }
  }

  // 键盘操作（焦点在列表上）
  const typed = useRef({ buf: '', at: 0 })
  useEffect(() => { if (cursor) listRef.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' }) }, [cursor])
  const onListKey = (ev: React.KeyboardEvent) => {
    if (draft || search?.result || ev.altKey) return
    const order = visible(root)
    const cur = cursor && order.includes(cursor) ? cursor : undefined
    const one = cur ? byPath.get(cur) : undefined
    const moveTo = (p: string | undefined, extend = false) => {
      if (!p) return
      ev.preventDefault(); setCursor(p)
      if (extend) setSel(new Set(rangeSelect(order, anchor ?? cur ?? p, p)))
      else { setSel(new Set([p])); setAnchor(p) }
    }
    const k = ev.key
    if (k === 'ArrowDown' || k === 'ArrowUp') return moveTo(moveCursor(order, cur, k === 'ArrowDown' ? 1 : -1), ev.shiftKey)
    if (k === 'Home' || k === 'End') return moveTo(k === 'Home' ? order[0] : order[order.length - 1], ev.shiftKey)
    if (k === 'ArrowRight' && one?.isDir) {
      ev.preventDefault()
      if (!expanded.has(one.path)) toggle(one)
      else moveTo(kids(one.path)[0]?.path)
      return
    }
    if (k === 'ArrowLeft' && one) {
      ev.preventDefault()
      if (one.isDir && expanded.has(one.path)) toggle(one)
      else { const up = dirOf(one.path); if (up !== root) moveTo(up) }
      return
    }
    if (k === 'Enter' && one) { ev.preventDefault(); if (one.isDir) toggle(one); else openFile(one.path); return }
    if (k === 'Backspace') { ev.preventDefault(); goUp(); return }
    if (k === 'F5') { ev.preventDefault(); refreshAll(); return }
    if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyA') { ev.preventDefault(); setSel(new Set(order)); return }
    if ((ev.ctrlKey || ev.metaKey) && (ev.code === 'KeyC' || ev.code === 'KeyX') && sel.size) { ev.preventDefault(); toClip(ev.code === 'KeyC' ? 'copy' : 'move', [...sel]); return }
    if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyV' && clip) { ev.preventDefault(); askPaste(newTarget()); return }
    // Esc 在这里有用途时不再往外传（抽屉自己也监听 Esc 关闭）
    if (k === 'Escape' && cutSet.size) { ev.stopPropagation(); setClip(null); setNote(''); return }
    if (k === 'Delete' && sel.size) { askDelete([...sel]); return }
    const sone = sel.size === 1 ? byPath.get([...sel][0]) : undefined
    if (k === 'F2' && sone) { setDraft({ kind: 'rename', entry: sone }); setDraftErr(''); return }
    // 直接打字：跳到名称以此开头的项（停顿 0.8 秒后重新开始）
    if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && k !== ' ') {
      const now = Date.now()
      typed.current = { buf: (now - typed.current.at < 800 ? typed.current.buf : '') + k, at: now }
      moveTo(typeAheadTarget(order.map((p) => ({ path: p, name: byPath.get(p)?.name ?? '' })), cur, typed.current.buf))
    }
  }
  // 右键作用对象：点在已选中的多项之一上 → 整个选区；否则改选这一项
  const targets = (e: DirEntry) => (sel.has(e.path) && sel.size > 1 ? [...sel] : [e.path])

  // 新建目标目录：选中单个目录 → 它；选中单个文件 → 其所在目录；否则根
  const newTarget = () => {
    const one = sel.size === 1 ? byPath.get([...sel][0]) : undefined
    return one ? (one.isDir ? one.path : dirOf(one.path)) : root
  }
  const startNew = (kind: 'file' | 'dir', dir = newTarget()) => { expand(dir); setDraft({ kind, dir }); setDraftErr('') }

  const submitDraft = (raw: string) => {
    if (!draft) return
    const name = raw.trim()
    if (draft.kind === 'rename' && name === draft.entry.name) { setDraft(null); return }
    const bad = nameError(name, winNames)
    if (bad) { setDraftErr(bad); return }
    const job = draft.kind === 'rename'
      ? client.fs.rename(scope, draft.entry.path, name).then((p) => { refresh(dirOf(draft.entry.path)); return p })
      : client.fs.create(scope, draft.dir, name, draft.kind).then((p) => { refresh(draft.dir); return p })
    job.then((p) => { setDraft(null); setSel(new Set([p])); setAnchor(p) }).catch((e) => setDraftErr(errOf(e)))
  }

  const askDelete = (paths: string[]) => {
    const tops = topLevelPaths(paths)
    setErr('')
    client.fs.deletePlan(scope, tops).then((plan) => {
      // 远程超上限：直接说明，不给确认按钮
      if (isRemote && plan.over) setErr(deleteConfirmText(plan, false))
      else setConfirmDel({ paths: tops, plan })
    }).catch((e) => setErr(errOf(e)))
  }
  const doDelete = async (paths: string[]) => {
    setConfirmDel(null)
    const fails: string[] = []
    for (const p of paths) await client.fs.remove(scope, p).catch((e) => fails.push(errOf(e)))
    new Set(paths.map(dirOf)).forEach(refresh)
    setSel(new Set())
    if (fails.length) setErr(fails.join('\n'))
  }

  // 压缩/解压/改权限：服务器上跑，可能较久，期间底部显示进行中
  const runBusy = (label: string, job: Promise<unknown>) => {
    setErr(''); setBusy(label)
    job.catch((e) => setErr(errOf(e))).finally(() => setBusy(''))
  }
  const askChmod = (paths: string[]) => {
    const ents = paths.map((p) => byPath.get(p))
    setChmodFor({ paths, mode: ents[0]?.mode ?? 0o644, anyDir: ents.some((e) => e?.isDir) })
  }
  const doChmod = (mode: number, recursive: boolean) => {
    const c = chmodFor
    setChmodFor(null)
    if (c) runBusy(tr('正在修改权限…'), client.fs.chmod(scope, c.paths, mode, recursive).finally(() => new Set(c.paths.map(dirOf)).forEach(refresh)))
  }
  const doPack = (paths: string[]) => runBusy(tr('正在压缩…'), client.fs.pack(scope, topLevelPaths(paths)).then((out) => {
    refresh(dirOf(out)); setSel(new Set([out])); setAnchor(out)
  }))
  const doUnpack = (path: string) => runBusy(tr('正在解压…'), client.fs.unpack(scope, path).finally(() => refresh(dirOf(path))))

  const runSearch = (query: string, kind: 'name' | 'content' = search?.kind ?? 'name') => {
    if (!query.trim()) return
    const at = root
    setSearch({ query, kind, running: true, root: at })
    const job = kind === 'content'
      ? client.fs.searchContent(scope, at, query).then((r) => ({ hits: [], content: r.hits, truncated: r.truncated, timedOut: r.timedOut }))
      : client.fs.search(scope, at, query)
    job.then((result) => setSearch((s) => (s && s.root === at && s.query === query ? { ...s, running: false, result } : s)))
      .catch((e) => { setSearch((s) => (s ? { ...s, running: false } : s)); setErr(errOf(e)) })
  }

  // ── 复制 / 剪切 / 粘贴 ──
  const clip = useClip()
  const clipHere = !!clip && clip.scopeKey === scopeKey
  const cutSet = new Set(clipHere && clip!.mode === 'move' ? clip!.paths : [])
  // 粘贴（剪贴板）和拖动移动（同一栏里把项拖到文件夹上）共用：先查冲突，有就让用户选
  type Job = { mode: 'copy' | 'move'; paths: string[]; fromClip: boolean }
  const [conflict, setConflict] = useState<{ dir: string; names: string[]; total: number; job: Job } | null>(null)
  const toClip = (mode: 'copy' | 'move', paths: string[]) => {
    const tops = topLevelPaths(paths)
    setClip({ scopeKey, mode, paths: tops })
    setNote(mode === 'copy' ? tr('已复制 {n} 项：到目标文件夹右键「粘贴」或按 Ctrl+V', { n: tops.length }) : tr('已剪切 {n} 项：到目标文件夹右键「粘贴」或按 Ctrl+V', { n: tops.length }))
  }
  const doPaste = (dir: string, policy: ConflictPolicy, c: Job) => {
    setConflict(null)
    runBusy(c.mode === 'copy' ? tr('正在复制…') : tr('正在移动…'), client.fs.paste(scope, c.paths, dir, c.mode, policy).then((r) => {
      refresh(dir)
      if (c.mode === 'move') { new Set(c.paths.map(dirOf)).forEach((d) => d !== dir && refresh(d)); if (c.fromClip) setClip(null) }
      if (dir !== root) expand(dir)
      if (r.done.length) { setSel(new Set(r.done.map((x) => x.to))); setAnchor(r.done[0].to); setCursor(r.done[0].to) }
      setNote((c.mode === 'copy' ? tr('已复制 {n} 项', { n: r.done.length }) : tr('已移动 {n} 项', { n: r.done.length })) + (r.skipped.length ? tr('，跳过 {n} 项', { n: r.skipped.length }) : ''))
    }))
  }
  const runJob = (dir: string, c: Job) => {
    setErr('')
    client.fs.pastePlan(scope, c.paths, dir).then((p) => {
      const names = p.items.filter((i) => i.conflict).map((i) => i.name)
      if (names.length) setConflict({ dir, names, total: p.items.length, job: c })
      else doPaste(dir, 'skip', c)
    }).catch((e) => setErr(errOf(e)))
  }
  const askPaste = (dir: string) => {
    if (!clip) return
    if (!clipHere) { setErr(tr('剪贴板里是另一台主机（或本地）的文件；跨主机请用上传 / 下载')); return }
    runJob(dir, { mode: clip.mode, paths: clip.paths, fromClip: true })
  }
  // 复制一份：同目录粘贴，自动改名「名称 (1)」
  const duplicate = (paths: string[]) => runBusy(tr('正在复制…'), client.fs.paste(scope, topLevelPaths(paths), dirOf(paths[0]), 'copy', 'rename').then((r) => {
    refresh(dirOf(paths[0])); setSel(new Set(r.done.map((x) => x.to))); if (r.done[0]) { setAnchor(r.done[0].to); setCursor(r.done[0].to) }
  }))
  // done：复制成功后的提示（整句，调用方 tr）
  const copyText = (t: string, done: string) => navigator.clipboard.writeText(t).then(() => setNote(done), () => setErr(tr('复制失败')))
  const [propsFor, setPropsFor] = useState<DirEntry[] | null>(null)
  const [chownFor, setChownFor] = useState<DirEntry[] | null>(null)
  const entriesOf = (paths: string[]) => paths.map((p) => byPath.get(p) ?? { name: baseName(p) || p, path: p, isDir: true })
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!bgMenu) return
    const onDown = () => setBgMenu(null)
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown) }
  }, [bgMenu])
  // 定位：根切到它所在目录并选中
  const locate = (h: SearchHit) => { setSearch(null); goTo(parentPath(h.path), h.path) }

  const download = (paths: string[]) => onDownload?.(topLevelPaths(paths))

  // 拖放：① 系统拖来的文件（types 含 Files）→ 远程上传；② 本应用里拖的行：同一栏 = 移动到该文件夹，另一栏（双栏窗口）= 上传 / 下载。
  // 落在文件上 = 它所在的目录
  const canTake = (ev: React.DragEvent, dir: string): 'files' | 'move' | 'cross' | undefined => {
    const t = ev.dataTransfer.types
    if (t.includes(DRAG_TYPE) && dragSrc) {
      if (dragSrc.scopeKey !== scopeKey) return pane ? 'cross' : undefined
      if (dragSrc.paths.some((p) => isInside(dir, p)) || dragSrc.paths.every((p) => dirOf(p) === dir)) return undefined   // 拖到自己身上 / 里面 / 原地
      return 'move'
    }
    return t.includes('Files') && isRemote && onDropUpload ? 'files' : undefined
  }
  const dropProps = (dir: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      const k = canTake(ev, dir)
      if (!k) return
      ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = k === 'move' ? 'move' : 'copy'; setDropDir(dir)
    },
    onDrop: (ev: React.DragEvent) => {
      const k = canTake(ev, dir)
      if (!k) return
      ev.preventDefault(); ev.stopPropagation(); setDropDir(null)
      if (k !== 'files') {
        const src = dragSrc!; dragSrc = null
        if (k === 'cross') pane?.onCrossDrop(src.paths, dir)
        else runJob(dir, { mode: 'move', paths: src.paths, fromClip: false })
        return
      }
      const paths = [...ev.dataTransfer.files].map(pathForFile).filter(Boolean)
      if (paths.length) onDropUpload!(paths, dir)
      else setErr(tr('拖入的不是本地文件，无法上传'))
    },
  })
  const dragProps = (e: DirEntry) => ({
    draggable: true,
    onDragStart: (ev: React.DragEvent) => {
      const paths = topLevelPaths(sel.has(e.path) ? [...sel] : [e.path])
      if (!sel.has(e.path)) { setSel(new Set([e.path])); setAnchor(e.path); setCursor(e.path) }
      dragSrc = { scopeKey, paths }
      ev.dataTransfer.setData(DRAG_TYPE, paths.join('\n'))
      if (!isRemote) ev.dataTransfer.setData(LOCAL_PATHS_MIME, paths.join('\n'))   // 本机的还能拖进对话框当附件
      ev.dataTransfer.effectAllowed = 'copyMove'
    },
    onDragEnd: () => { dragSrc = null; setDropDir(null) },
  })

  const draftInput = (initial: string, depth: number) => (
    <div style={{ paddingLeft: depth * 12 + 6 }} className="px-1 py-0.5">
      <input autoFocus defaultValue={initial} spellCheck={false}
        onFocus={(ev) => { const dot = initial.lastIndexOf('.'); ev.target.setSelectionRange(0, dot > 0 ? dot : initial.length) }}
        onKeyDown={(ev) => { if (ev.key === 'Enter') submitDraft(ev.currentTarget.value); if (ev.key === 'Escape') setDraft(null); ev.stopPropagation() }}
        onBlur={() => setDraft(null)}
        onChange={() => setDraftErr('')}
        placeholder={draft?.kind === 'dir' ? tr('文件夹名') : tr('文件名')}
        className="w-full rounded border border-[var(--color-accent)] bg-[var(--color-bg-base)] px-1 py-0.5 text-[12px] text-[var(--color-text-primary)] outline-none" />
      {draftErr && <div className="mt-0.5 text-[11px] text-[var(--color-danger)]">{draftErr}</div>}
    </div>
  )

  // 过滤命中项：名称里匹配的部分高亮（通配模式整名高亮）
  const nameText = (e: DirEntry) => {
    const r = ft?.hits.has(e.path) ? filterHighlight(e.name, filter) : undefined
    if (!r) return e.name
    return <>{e.name.slice(0, r[0])}<mark data-filter-hit className="rounded-sm bg-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-inherit">{e.name.slice(r[0], r[1])}</mark>{e.name.slice(r[1])}</>
  }
  // 查看设置：都记在 localStorage
  const setSortKey = (key: SortKey) => setSort((s) => { const n = { key, desc: s.key === key ? !s.desc : key !== 'name' }; localStorage.setItem(SORT_KEY, JSON.stringify(n)); return n })
  const toggleHidden = () => setShowHidden((v) => { localStorage.setItem(HIDDEN_KEY, v ? '0' : '1'); return !v })
  const toggleDetails = () => setDetails((d) => { localStorage.setItem(DETAILS_KEY, d ? '0' : '1'); return !d })
  const focusFilter = () => { setSearch(null); setTimeout(() => { filterRef.current?.focus(); filterRef.current?.select() }, 0) }

  // 详细信息列：大小 / 修改时间 / 权限（Windows 本地没有）/ 属主（远程）；表头与行共用列宽
  const hasMode = Object.values(children).some((l) => l.some((e) => e.mode !== undefined))
  const hasOwner = isRemote
  const COL = { size: 'w-14 text-right', mtime: 'w-[66px]', mode: 'w-8', owner: 'w-14 truncate' }
  const hiddenCount = (path: string) => (showHidden ? 0 : (children[path] ?? []).filter((e) => isHiddenName(e.name)).length)
  const emptyText = (path: string) => (ft ? tr('（无匹配项）') : hiddenCount(path) ? tr('（只有 {n} 个隐藏项）', { n: hiddenCount(path) }) : tr('（空）'))
  const loadErr = (path: string, depth: number) => (
    <div style={{ paddingLeft: depth * 12 + 6 }} data-load-error className="flex items-center gap-1 px-1 py-0.5 text-[11px] text-[var(--color-danger)]">
      <AlertCircle className="h-3 w-3 shrink-0" /><span className="min-w-0 truncate" title={errors[path]}>{errors[path]}</span>
      <button onClick={() => load(path)} className="shrink-0 text-[var(--color-accent)] hover:underline">{tr('重试')}</button>
      {denied(errors[path]) && <button data-sudo-open onClick={() => setSudoMode(true)} className="shrink-0 text-[var(--color-danger)] hover:underline">{tr('用 sudo')}</button>}
    </div>
  )

  const renderLevel = (path: string, depth: number) => (
    <>
      {draft && draft.kind !== 'rename' && draft.dir === path && draftInput('', depth)}
      {kids(path).map((e) => (
        <div key={e.path}>
          {draft?.kind === 'rename' && draft.entry.path === e.path ? draftInput(e.name, depth) : (
            <div style={{ paddingLeft: depth * 12 + 6 }} data-path={e.path}
              title={entryTip(e)}
              onClick={(ev) => onRowClick(ev, e)}
              onDoubleClick={() => (e.isDir ? goTo(e.path) : openFile(e.path))}
              onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setCursor(e.path); if (!sel.has(e.path)) { setSel(new Set([e.path])); setAnchor(e.path) } setMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }}
              {...dropProps(e.isDir ? e.path : dirOf(e.path))} {...(draft ? {} : dragProps(e))}
              className={`group flex cursor-pointer select-none items-center gap-1 rounded px-1 py-0.5 text-[12px] hover:bg-[var(--color-bg-hover)] ${sel.has(e.path) ? SEL : ''} ${dropDir === e.path || (cursor === e.path && (sel.size > 1 || !sel.has(e.path))) ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''} ${cutSet.has(e.path) ? 'opacity-40' : isHiddenName(e.name) ? 'opacity-60' : ''}`} {...(cutSet.has(e.path) ? { 'data-cut': '' } : {})}>
              {e.isDir ? (expanded.has(e.path) ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" /> : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />) : <span className="w-3 shrink-0" />}
              {e.isLink
                ? (e.isDir ? <FolderSymlink className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <FileSymlink className={`h-3.5 w-3.5 shrink-0 ${e.linkBroken ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`} />)
                : e.isDir ? (expanded.has(e.path) ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />) : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
              <span className={`min-w-0 flex-1 truncate ${e.linkBroken ? 'text-[var(--color-danger)] line-through' : 'text-[var(--color-text-primary)]'}`}>
                {nameText(e)}
                {e.isLink && e.linkTarget && <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">→ {e.linkTarget}</span>}
              </span>
              {/* 详细信息列；hover 时让位给行内操作 */}
              {details && (
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)] group-hover:hidden">
                  <span className={COL.size}>{e.isDir || e.size === undefined ? '' : formatSize(e.size)}</span>
                  <span className={COL.mtime}>{shortTime(e.mtime)}</span>
                  {hasMode && <span className={COL.mode}>{e.mode !== undefined ? modeOctal(e.mode) : ''}</span>}
                  {hasOwner && <span className={COL.owner} title={e.owner}>{e.owner ?? ''}</span>}
                </span>
              )}
              {/* 行内悬浮操作：hover 该行才显示，不占位。stopPropagation 避免触发行的展开/折叠 */}
              <div className="hidden shrink-0 items-center gap-1 group-hover:flex">
                {!isRemote && onUpload && (
                  <button title={tr('上传到服务器')} onClick={(ev) => { ev.stopPropagation(); onUpload([e.path]) }} className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Upload className="h-3.5 w-3.5" /></button>
                )}
                {isRemote && onDownload && (
                  <button title={tr('下载到本地')} onClick={(ev) => { ev.stopPropagation(); download([e.path]) }} className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Download className="h-3.5 w-3.5" /></button>
                )}
                <button title={tr('删除')} onClick={(ev) => { ev.stopPropagation(); askDelete([e.path]) }} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          )}
          {e.isDir && expanded.has(e.path) && (errors[e.path] ? loadErr(e.path, depth + 1)
            : children[e.path] === undefined
              ? <div style={{ paddingLeft: (depth + 1) * 12 + 6 }} className="px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
              : kids(e.path).length === 0 && !(draft && draft.kind !== 'rename' && draft.dir === e.path)
                ? <div style={{ paddingLeft: (depth + 1) * 12 + 6 }} className="px-1 py-0.5 text-[11px] text-[var(--color-text-muted)]">{emptyText(e.path)}</div>
                : renderLevel(e.path, depth + 1))}
        </div>
      ))}
    </>
  )

  const renderHits = () => {
    const r = search?.result
    if (search?.running) return <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('搜索中…（最深 {depth} 层，最多 {limit} 条）', { depth: SEARCH_MAX_DEPTH, limit: SEARCH_LIMIT })}</div>
    if (!r) return null
    const base = search.root ?? root
    const rel = (p: string) => parentPath(p).slice(base.length).replace(/^[\\/]/, '') || '.'
    const n = r.content ? r.content.length : r.hits.length
    const summary = `${n ? (r.content ? tr('找到 {n} 个文件', { n }) : tr('找到 {n} 项', { n })) : tr('没有找到')}${r.truncated ? tr('（只显示前 {n} 条）', { n: SEARCH_LIMIT }) : ''}${r.timedOut ? tr('（超时，只显示已找到的部分）') : ''}${tr(' · 单击定位，双击打开')}`
    if (r.content) return (
      <>
        <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">{summary}</div>
        {r.content.map((h) => (
          <div key={h.path} data-content-hit title={`${h.path}\n${tr('第 {n} 行', { n: h.line })}`} onClick={() => locate({ name: h.name, path: h.path, isDir: false })} onDoubleClick={() => openFile(h.path)}
            className="cursor-pointer select-none rounded px-1.5 py-0.5 text-[12px] hover:bg-[var(--color-bg-hover)]">
            <div className="flex items-center gap-1">
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span className="shrink-0 text-[var(--color-text-primary)]">{h.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-muted)]">{rel(h.path)}</span>
            </div>
            <div className="truncate pl-[18px] font-mono text-[10.5px] text-[var(--color-text-secondary)]"><span className="text-[var(--color-text-muted)]">{h.line}:</span> {h.text}</div>
          </div>
        ))}
      </>
    )
    return (
      <>
        <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">{summary}</div>
        {r.hits.map((h) => (
          <div key={h.path} title={h.path} onClick={() => locate(h)} onDoubleClick={() => { if (h.isDir) { setSearch(null); goTo(h.path) } else openFile(h.path) }}
            className="flex cursor-pointer select-none items-center gap-1 rounded px-1.5 py-0.5 text-[12px] hover:bg-[var(--color-bg-hover)]">
            {h.isDir ? <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
            <span className="shrink-0 text-[var(--color-text-primary)]">{h.name}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-muted)]">{rel(h.path)}</span>
          </div>
        ))}
      </>
    )
  }

  const menuItem = 'flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-[var(--color-bg-hover)]'
  const iconBtn = 'flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
  const m = menu && targets(menu.entry)
  const delNames = confirmDel?.paths.map((p) => byPath.get(p)?.name ?? p) ?? []
  const sameDir = !!m && m.every((p) => parentPath(p) === parentPath(m[0]))

  return (
    <div className={`relative flex h-full flex-col ${pane ? `rounded-md border ${pane.active ? 'border-[var(--color-accent)]' : 'border-[var(--color-border-subtle)]'}` : ''}`}
      onMouseDownCapture={pane?.onActivate} onFocusCapture={pane?.onActivate} data-pane={pane ? (isRemote ? 'remote' : 'local') : undefined}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape' && (viewOpen || bmOpen)) { ev.stopPropagation(); setViewOpen(false); setBmOpen(false); return }
        const mod = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
        if (mod && ev.code === 'KeyF') { ev.preventDefault(); focusFilter() }
        if (mod && ev.code === 'KeyL') { ev.preventDefault(); setEditPath(true) }
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); goHist(-1) }
          if (ev.key === 'ArrowRight') { ev.preventDefault(); goHist(1) }
          if (ev.key === 'ArrowUp') { ev.preventDefault(); goUp() }
        }
      }}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-3">
        <span className="mr-auto truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{pane ? pane.title : isRemote ? tr('资源管理器 · SSH') : tr('资源管理器 · 本地')}</span>
        {sudoMode && <button data-sudo-badge onClick={() => setSudoMode(false)} title={tr('sudo 模式：列目录、编辑、新建、改名、删除等都以 root 身份执行（会记执行记录）\n点击退出 sudo 模式')} className="rounded bg-[var(--color-danger)] px-1.5 text-[10px] font-semibold leading-[18px] text-[var(--color-on-danger)]">sudo</button>}
        {onOpenDual && <button data-open-dual title={tr('双栏文件管理\n左边本机、右边这台服务器，拖过去就上传 / 下载')} onClick={onOpenDual} className={iconBtn}><Columns2 className="h-3.5 w-3.5" /></button>}
        <button title={tr('新建文件')} onClick={() => startNew('file')} className={iconBtn}><FilePlus className="h-3.5 w-3.5" /></button>
        <button title={tr('新建文件夹')} onClick={() => startNew('dir')} className={iconBtn}><FolderPlus className="h-3.5 w-3.5" /></button>
        <button title={tr('搜索\n在当前目录下按名称或按文件内容搜索（含子目录）')} onClick={() => setSearch((s) => (s ? null : { query: '', kind: 'name', running: false }))} className={`${iconBtn} ${search ? 'text-[var(--color-accent)]' : ''}`}><Search className="h-3.5 w-3.5" /></button>
        <button title={isRemote ? tr('书签与常用位置\n收藏的目录，以及主目录、根目录、临时目录') : tr('书签与常用位置\n收藏的目录，以及主目录、根目录、临时目录、各个盘符')} onClick={() => setBmOpen((o) => !o)} className={`${iconBtn} ${bmOpen ? 'text-[var(--color-accent)]' : ''}`}><Bookmark className="h-3.5 w-3.5" /></button>
        <button data-view-menu title={tr('查看\n排序方式、显示隐藏文件、显示详细信息列')} onClick={() => setViewOpen((o) => !o)} className={`${iconBtn} ${viewOpen ? 'text-[var(--color-accent)]' : ''}`}><SlidersHorizontal className="h-3.5 w-3.5" /></button>
        <button title={tr('刷新（F5）\n重新读取当前目录和所有已展开的目录')} onClick={refreshAll} className={iconBtn}><RefreshCw className="h-3.5 w-3.5" /></button>
        {!pane && <button title={tr('关闭')} onClick={onClose} className={iconBtn}><X className="h-3.5 w-3.5" /></button>}
      </div>
      {viewOpen && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setViewOpen(false)} />
          <div data-view-panel className="absolute right-3 top-10 z-20 w-48 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
            <div className="px-2 pb-0.5 pt-1 text-[10px] text-[var(--color-text-muted)]">{tr('排序（文件夹始终在前）')}</div>
            {(['name', 'size', 'mtime'] as SortKey[]).map((k) => (
              <button key={k} onClick={() => { setSortKey(k); setViewOpen(false) }} className={menuItem}>
                <Check className={`h-3 w-3 ${sort.key === k ? 'text-[var(--color-accent)]' : 'invisible'}`} />{tr(SORT_LABEL[k])}
                {sort.key === k && <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{sort.desc ? tr('降序') : tr('升序')}</span>}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--color-border-subtle)]" />
            <button onClick={() => { toggleHidden(); setViewOpen(false) }} className={menuItem}><Check className={`h-3 w-3 ${showHidden ? 'text-[var(--color-accent)]' : 'invisible'}`} />{tr('显示隐藏文件（. 开头）')}</button>
            <button onClick={() => { toggleDetails(); setViewOpen(false) }} className={menuItem}><Check className={`h-3 w-3 ${details ? 'text-[var(--color-accent)]' : 'invisible'}`} />{tr('显示详细信息列')}</button>
            {isRemote && !winHost && <><div className="my-1 border-t border-[var(--color-border-subtle)]" /><button data-sudo-toggle title={tr('以 root 身份操作：没权限的目录 / 文件（如 /etc 下的配置）也能看、能改\n密码只在需要时问一次，只存在本机内存里')} onClick={() => { setSudoMode((v) => !v); setViewOpen(false) }} className={menuItem}><Check className={`h-3 w-3 ${sudoMode ? 'text-[var(--color-danger)]' : 'invisible'}`} />{tr('以 root 身份操作（sudo）')}</button></>}
          </div>
        </>
      )}
      {bmOpen && (
        <>
          <div className="absolute inset-0 z-10" onClick={() => setBmOpen(false)} />
          <div data-bm-panel className="absolute right-3 top-10 z-20 max-h-96 w-64 overflow-auto rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
            <div className="px-2 pb-0.5 pt-1 text-[10px] text-[var(--color-text-muted)]">{tr('常用位置')}</div>
            {!places && <div className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>}
            {places?.items.map((x) => (
              <button key={x.label + x.path} title={x.path} onClick={() => goTo(x.path)} className={`${menuItem} ${x.path === root ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
                <span className="shrink-0">{tr(x.label)}</span><span className="min-w-0 flex-1 truncate text-right text-[10px] text-[var(--color-text-muted)]">{x.path}</span>
              </button>
            ))}
            <div className="my-1 border-t border-[var(--color-border-subtle)]" />
            <div className="px-2 pb-0.5 pt-1 text-[10px] text-[var(--color-text-muted)]">{tr('书签')}</div>
            <button onClick={() => toggleBm(root)} className={`${menuItem} text-[var(--color-accent)]`}>{bookmarks.includes(root) ? tr('取消收藏当前目录') : tr('收藏当前目录')}</button>
            {bookmarks.length === 0 && <div className="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{tr('还没有书签。也可在目录上右键「加入书签」')}</div>}
            {bookmarks.map((b) => (
              <div key={b} className="group flex items-center rounded hover:bg-[var(--color-bg-hover)]">
                <button title={b} onClick={() => goTo(b)} className={`min-w-0 flex-1 truncate px-2 py-1 text-left ${b === root ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>{b}</button>
                <button title={tr('移除书签')} onClick={() => toggleBm(b)} className="hidden px-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] group-hover:block"><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-1.5 py-0.5">
        <button title={tr('后退（Alt+←）')} disabled={hist.i <= 0} onClick={() => goHist(-1)} className={`${iconBtn} disabled:opacity-30 disabled:hover:bg-transparent`}><ArrowLeft className="h-3 w-3" /></button>
        <button title={tr('前进（Alt+→）')} disabled={hist.i >= hist.list.length - 1} onClick={() => goHist(1)} className={`${iconBtn} disabled:opacity-30 disabled:hover:bg-transparent`}><ArrowRight className="h-3 w-3" /></button>
        <button title={tr('上一级（Backspace / Alt+↑）')} disabled={parentPath(root) === root} onClick={goUp} className={`${iconBtn} disabled:opacity-30 disabled:hover:bg-transparent`}><ArrowUp className="h-3 w-3" /></button>
        {/* 路径栏：平时是可点的面包屑，点空白处或 Ctrl+L 改成输入框，回车跳转、Esc 取消 */}
        {editPath ? (
          <input data-path-input autoFocus defaultValue={root} spellCheck={false} onFocus={(ev) => ev.target.select()}
            onKeyDown={(ev) => { if (ev.key === 'Enter') { const v = ev.currentTarget.value.trim(); if (v && v !== root) goTo(v); else setEditPath(false) } if (ev.key === 'Escape') setEditPath(false); ev.stopPropagation() }}
            onBlur={() => setEditPath(false)}
            className="h-6 min-w-0 flex-1 rounded border border-[var(--color-accent)] bg-[var(--color-bg-base)] px-1 text-[11px] text-[var(--color-text-primary)] outline-none" />
        ) : (
          <div ref={crumbRef} data-crumbs title={`${root}\n${tr('点空白处或按 Ctrl+L 输入路径（支持 ~）')}`} onClick={(ev) => { if (ev.target === ev.currentTarget) setEditPath(true) }}
            className="flex h-6 min-w-0 flex-1 cursor-text items-center overflow-x-auto whitespace-nowrap px-0.5 text-[11px] [scrollbar-width:none]">
            {breadcrumbs(root).map((c, i, all) => (
              <span key={c.path} className="flex shrink-0 items-center">
                {i > 0 && i > 1 - (isWinPath(root) ? 1 : 0) && <ChevronRight className="h-2.5 w-2.5 text-[var(--color-text-muted)]" />}
                <button onClick={() => goTo(c.path)} title={c.path}
                  className={`rounded px-0.5 hover:bg-[var(--color-bg-hover)] ${i === all.length - 1 ? 'font-medium text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}>{c.label}</button>
              </span>
            ))}
            <span className="h-full min-w-[16px] flex-1" onClick={() => setEditPath(true)} />
          </div>
        )}
        {onGotoCwd && (
          <>
            <button title={tr('转到终端当前目录')} onClick={gotoCwd} className={iconBtn}><LocateFixed className="h-3 w-3" /></button>
            <button title={follow ? tr('跟随终端目录：开（终端 cd 后自动跳过去），点击关闭') : tr('跟随终端目录：关，点击开启')} onClick={toggleFollow}
              className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] hover:bg-[var(--color-bg-hover)] ${follow ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>
              <Link2 className="h-3 w-3" />{tr('跟随')}
            </button>
          </>
        )}
      </div>
      {!search && (
        <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-2 py-1">
          <div className="flex items-center gap-1">
            <Filter className={`h-3 w-3 shrink-0 ${filter ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} />
            <input ref={filterRef} value={filter} spellCheck={false} onChange={(ev) => setFilter(ev.target.value)}
              placeholder={tr('过滤已展开的内容（Ctrl+F，支持 * ?）')} title={tr('快速过滤：只过滤已加载、已展开的条目，不访问服务器；Esc 清空')}
              onKeyDown={(ev) => { if (ev.key === 'Escape') { if (filter) setFilter(''); else ev.currentTarget.blur() } ev.stopPropagation() }}
              className="min-w-0 flex-1 bg-transparent px-1 text-[11px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
            {filter && <button title={tr('清空过滤（Esc）')} onClick={() => setFilter('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>}
          </div>
          {ft && (
            <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
              {trx('匹配 {n} 项 · 仅过滤已展开的内容 ，搜索整个目录请用{btn}', {
                btn: <button onClick={() => setSearch({ query: filter, kind: 'name', running: false })} className="text-[var(--color-accent)] hover:underline">{tr('「搜索」')}</button>,
              }, { n: ft.hits.size })}
            </div>
          )}
        </div>
      )}
      {search && (
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-subtle)] px-2 py-1">
          <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border-default)] text-[11px]">
            {(['name', 'content'] as const).map((k) => (
              <button key={k} data-search-kind={k} disabled={k === 'content' && winHost}
                title={k === 'name' ? tr('按文件名搜索（支持 * ?）') : winHost ? tr('Windows 服务器（没有 grep）不支持按内容搜索') : tr('按文件内容搜索（跳过二进制和 .git / node_modules，每个文件显示第一处）')}
                onClick={() => { const q = (document.querySelector('[data-search-input]') as HTMLInputElement | null)?.value ?? ''; if (q.trim()) runSearch(q, k); else setSearch((s) => (s ? { ...s, kind: k, result: undefined } : s)) }}
                className={`px-1.5 py-0.5 disabled:opacity-40 ${(search.kind ?? 'name') === k ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>{k === 'name' ? tr('名称') : tr('内容')}</button>
            ))}
          </div>
          <input data-search-input autoFocus defaultValue={search.query} spellCheck={false} placeholder={(search.kind ?? 'name') === 'name' ? tr('文件名（支持 * ?，不区分大小写）') : tr('要找的文字（不区分大小写）')}
            onKeyDown={(ev) => { if (ev.key === 'Enter') runSearch(ev.currentTarget.value); if (ev.key === 'Escape') setSearch(null); ev.stopPropagation() }}
            className="min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
          <button onClick={() => setSearch(null)} title={tr('关闭搜索')} className={iconBtn}><X className="h-3 w-3" /></button>
        </div>
      )}
      {sel.size > 1 && !search?.result && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
          {tr('已选 {n} 项', { n: sel.size })}
          {isRemote && onDownload && <button onClick={() => download([...sel])} className="text-[var(--color-accent)] hover:underline">{tr('下载')}</button>}
          {!isRemote && onUpload && <button onClick={() => onUpload(topLevelPaths([...sel]))} className="text-[var(--color-accent)] hover:underline">{tr('上传到服务器')}</button>}
          <button onClick={() => askDelete([...sel])} className="text-[var(--color-danger)] hover:underline">{tr('删除')}</button>
          <button onClick={() => setSel(new Set())} className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">{tr('取消选择')}</button>
        </div>
      )}
      {details && !(search && (search.running || search.result)) && (
        <div data-col-header className="flex shrink-0 select-none items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
          {([['name', 'min-w-0 flex-1 pl-7 text-left'], ['size', COL.size], ['mtime', COL.mtime]] as [SortKey, string][]).map(([k, cls]) => (
            <button key={k} title={tr('按{label}排序，再点一次反向', { label: tr(SORT_LABEL[k]) })} onClick={() => setSortKey(k)} className={`flex items-center gap-0.5 hover:text-[var(--color-text-primary)] ${cls} ${k === 'size' ? 'justify-end' : ''} ${sort.key === k ? 'text-[var(--color-text-primary)]' : ''}`}>
              <span className="truncate">{k === 'mtime' ? tr('col|修改时间') : tr(SORT_LABEL[k])}</span>{sort.key === k && (sort.desc ? <ArrowDown className="h-2.5 w-2.5 shrink-0" /> : <ArrowUp className="h-2.5 w-2.5 shrink-0" />)}
            </button>
          ))}
          {hasMode && <span className={COL.mode}>{tr('col|权限')}</span>}
          {hasOwner && <span className={COL.owner}>{tr('属主')}</span>}
        </div>
      )}
      <div ref={listRef} tabIndex={-1} data-tree {...dropProps(root)}
        onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropDir(null) }}
        onKeyDown={onListKey}
        onContextMenu={(ev) => { if (search?.result) return; ev.preventDefault(); setMenu(null); setBgMenu({ x: ev.clientX, y: ev.clientY }) }}
        className={`min-h-0 flex-1 overflow-auto p-1.5 outline-none ${dropDir === root ? 'ring-1 ring-inset ring-[var(--color-accent)]' : ''}`}>
        {search && (search.running || search.result)
          ? renderHits()
          : errors[root]
            ? (
              <div data-root-error className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <FolderX className="h-8 w-8 text-[var(--color-danger)] opacity-70" />
                <div className="text-[12px] text-[var(--color-text-primary)]">{tr('打不开这个目录')}</div>
                <div className="break-all text-[11px] text-[var(--color-text-muted)]">{root}<br />{errors[root]}</div>
                <div className="flex gap-3 text-[11px]">
                  <button onClick={() => load(root)} className="text-[var(--color-accent)] hover:underline">{tr('重试')}</button>
                  {denied(errors[root]) && <button data-sudo-open onClick={() => setSudoMode(true)} className="text-[var(--color-danger)] hover:underline">{tr('用 sudo 打开')}</button>}
                  {hist.i > 0 && <button onClick={() => goHist(-1)} className="text-[var(--color-accent)] hover:underline">{tr('返回')}</button>}
                  {parentPath(root) !== root && <button onClick={goUp} className="text-[var(--color-accent)] hover:underline">{tr('上一级')}</button>}
                </div>
              </div>
            )
            : children[root] === undefined
              ? <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
              : kids(root).length === 0 && !draft
                ? ft
                  ? <div className="px-2 py-3 text-[11px] text-[var(--color-text-muted)]">{tr('没有匹配「{q}」的项（只在已展开的目录里找）', { q: filter.trim() })}</div>
                  : (
                    <div data-empty className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                      <FolderOpen className="h-8 w-8 text-[var(--color-text-muted)] opacity-50" />
                      <div className="text-[12px] text-[var(--color-text-secondary)]">{hiddenCount(root) ? tr('只有 {n} 个隐藏项', { n: hiddenCount(root) }) : tr('空目录')}</div>
                      {hiddenCount(root)
                        ? <button onClick={toggleHidden} className="text-[11px] text-[var(--color-accent)] hover:underline">{tr('显示隐藏文件')}</button>
                        : <div className="text-[11px] text-[var(--color-text-muted)]">{isRemote && onDropUpload ? tr('可用上方按钮新建文件 / 文件夹，或从系统拖文件进来上传') : tr('可用上方按钮新建文件 / 文件夹')}</div>}
                    </div>
                  )
                : renderLevel(root, 0)}
      </div>
      {busy && <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-accent)]">{busy}</div>}
      {note && !busy && <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-accent)]">{note}</div>}
      {isRemote && onDropUpload && !busy && <div className="shrink-0 px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">{tr('可从系统拖文件/文件夹到目录上上传')}</div>}
      {err && (
        <div className="flex shrink-0 items-start gap-2 border-t border-[var(--color-border-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--color-danger)]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{err}</span>
          <button onClick={() => setErr('')} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* 右键菜单（分组 + 快捷键提示；贴着窗口边缘时自动挪回窗口内） */}
      {menu && m && (
        <FloatMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {m.length > 1 ? (
            <>
              {pane && <MI data-menu-send onClick={() => pane.onSend(m)}>{tr('{label}（{n} 项）', { label: pane.sendLabel, n: m.length })}</MI>}
              {!isRemote && <MI data-menu-chat onClick={() => attachPathsToChat(topLevelPaths(m))}>{tr('添加到对话（{n} 项）', { n: m.length })}</MI>}
              <MI onClick={() => toClip('move', m)} kbd="Ctrl+X">{tr('剪切 {n} 项', { n: m.length })}</MI>
              <MI onClick={() => toClip('copy', m)} kbd="Ctrl+C">{tr('复制 {n} 项', { n: m.length })}</MI>
              {sameDir && <MI onClick={() => duplicate(m)}>{tr('复制一份')}</MI>}
              <MI onClick={() => copyText(m.join('\n'), tr('已复制 {n} 个路径', { n: m.length }))}>{tr('复制路径')}</MI>
              <Sep />
              {!isRemote && onUpload && <MI onClick={() => onUpload(topLevelPaths(m))}>{tr('上传 {n} 项到服务器…', { n: m.length })}</MI>}
              {isRemote && onDownload && <MI onClick={() => download(m)}>{tr('下载 {n} 项到本地…', { n: m.length })}</MI>}
              {isRemote && !winHost && <MI onClick={() => askChmod(m)}>{tr('修改权限…')}</MI>}
              {isRemote && !winHost && <MI onClick={() => setChownFor(entriesOf(m))}>{tr('修改属主…')}</MI>}
              {isRemote && !winHost && sameDir && <MI onClick={() => doPack(m)}>{tr('压缩为 tar.gz')}</MI>}
              <MI onClick={() => askDelete(m)} kbd="Del" danger>{tr('删除 {n} 项', { n: m.length })}</MI>
              <Sep />
              <MI onClick={() => setPropsFor(entriesOf(m))}>{tr('属性')}</MI>
            </>
          ) : (() => {
            const e = menu.entry
            return (
              <>
                {!e.isDir && previewKind(e.name) && <MI onClick={() => setPreviewing(e.path)}>{tr('预览')}</MI>}
                {!e.isDir && <MI onClick={() => setEditing(e.path)} kbd="Enter">{tr('查看 / 编辑')}</MI>}
                {isRemote && !e.isDir && <MI onClick={() => editExternal(e.path)}>{tr('用本地编辑器打开')}</MI>}
                {isRemote && !winHost && !e.isDir && <MI onClick={() => { openLogViewer(scopeKey, { kind: 'file', path: e.path }); onClose() }}>{tr('实时查看（tail -f）')}</MI>}
                {!isRemote && !e.isDir && <MI onClick={() => client.fs.openLocal(e.path)}>{tr('用系统程序打开')}</MI>}
                {e.isDir && <MI onClick={() => goTo(e.path)} kbd={tr('双击')}>{tr('进入此目录')}</MI>}
                {!isRemote && <MI data-menu-chat onClick={() => attachPathsToChat([e.path])}>{tr('添加到对话')}</MI>}
                {e.isDir && onCdHere && <MI onClick={() => onCdHere(e.path)}>{tr('在终端中打开（cd 过去）')}</MI>}
                {pane && <MI data-menu-send onClick={() => pane.onSend([e.path])}>{pane.sendLabel}</MI>}
                <Sep />
                <MI onClick={() => toClip('move', [e.path])} kbd="Ctrl+X">{tr('剪切')}</MI>
                <MI onClick={() => toClip('copy', [e.path])} kbd="Ctrl+C">{tr('复制')}</MI>
                {e.isDir && clip && <MI onClick={() => askPaste(e.path)} kbd="Ctrl+V">{tr('粘贴到此文件夹')}</MI>}
                <MI onClick={() => duplicate([e.path])}>{tr('复制一份')}</MI>
                <MI onClick={() => copyText(e.path, tr('已复制路径'))}>{tr('复制路径')}</MI>
                <MI onClick={() => copyText(e.name, tr('已复制名称'))}>{tr('复制名称')}</MI>
                <Sep />
                {e.isDir && <MI onClick={() => startNew('file', e.path)}>{tr('新建文件')}</MI>}
                {e.isDir && <MI onClick={() => startNew('dir', e.path)}>{tr('新建文件夹')}</MI>}
                <MI onClick={() => { setDraft({ kind: 'rename', entry: e }); setDraftErr('') }} kbd="F2">{tr('重命名')}</MI>
                <MI onClick={() => askDelete([e.path])} kbd="Del" danger>{tr('删除')}</MI>
                {isRemote && !winHost && <Sep />}
                {isRemote && !winHost && <MI onClick={() => askChmod([e.path])}>{tr('修改权限…')}</MI>}
                {isRemote && !winHost && <MI onClick={() => setChownFor([e])}>{tr('修改属主…')}</MI>}
                {isRemote && !winHost && <MI onClick={() => doPack([e.path])}>{tr('压缩为 tar.gz')}</MI>}
                {isRemote && !winHost && !e.isDir && archiveKind(e.name) && <MI onClick={() => doUnpack(e.path)}>{tr('解压到此处')}</MI>}
                <Sep />
                {!isRemote && onUpload && <MI onClick={() => onUpload([e.path])}>{tr('上传到服务器…')}</MI>}
                {isRemote && onDownload && <MI onClick={() => download([e.path])}>{tr('下载到本地…')}</MI>}
                {isRemote && e.isDir && <MI onClick={() => openDirSync({ terminalId: scopeKey, remotePath: e.path })}>{tr('与本地目录比较 / 同步…')}</MI>}
                {e.isDir && onDiskUsage && <MI data-menu-disk onClick={() => onDiskUsage(e.path)}>{tr('分析磁盘占用')}</MI>}
                {isRemote && e.isDir && <MI data-menu-vscode onClick={() => openDirInVscode(scopeKey, e.path)}>{tr('用 VS Code Remote 打开')}</MI>}
                {e.isDir && <MI onClick={() => toggleBm(e.path)}>{bookmarks.includes(e.path) ? tr('移出书签') : tr('加入书签')}</MI>}
                <Sep />
                <MI onClick={() => setPropsFor([e])}>{tr('属性')}</MI>
              </>
            )
          })()}
        </FloatMenu>
      )}
      {/* 空白处右键：针对当前目录 */}
      {bgMenu && (
        <FloatMenu x={bgMenu.x} y={bgMenu.y} onClose={() => setBgMenu(null)}>
          <MI onClick={() => startNew('file', root)}>{tr('新建文件')}</MI>
          <MI onClick={() => startNew('dir', root)}>{tr('新建文件夹')}</MI>
          {clip && <MI onClick={() => askPaste(root)} kbd="Ctrl+V">{tr('粘贴')}</MI>}
          <Sep />
          <MI onClick={refreshAll} kbd="F5">{tr('刷新')}</MI>
          <MI onClick={() => copyText(root, tr('已复制当前路径'))}>{tr('复制当前路径')}</MI>
          {onCdHere && <MI onClick={() => onCdHere(root)}>{tr('在终端中打开（cd 过去）')}</MI>}
          <MI onClick={() => toggleBm(root)}>{bookmarks.includes(root) ? tr('取消收藏当前目录') : tr('收藏当前目录')}</MI>
          <Sep />
          <MI onClick={() => setPropsFor(entriesOf([root]))}>{tr('属性')}</MI>
        </FloatMenu>
      )}
      {conflict && <PasteConflictDialog names={conflict.names} total={conflict.total} mode={conflict.job.mode} prod={prod} onPick={(p) => doPaste(conflict.dir, p, conflict.job)} onCancel={() => setConflict(null)} />}
      {propsFor && <PropsDialog scope={scope} entries={propsFor} onClose={() => setPropsFor(null)} />}
      {chownFor && <ChownDialog scope={scope} entries={chownFor} prod={prod} onCancel={() => setChownFor(null)}
        onDone={() => { const ps = chownFor.map((e) => e.path); setChownFor(null); new Set(ps.map(dirOf)).forEach(refresh); setNote(tr('已修改属主')) }} />}
      <ConfirmDialog open={!!confirmDel}
        title={!isRemote ? tr('移到回收站') : prod ? tr('删除生产主机上的文件') : tr('删除远程文件')}
        message={tr('{names}：{detail}', {
          names: delNames.length > 3 ? tr('{names} 等 {n} 项', { names: delNames.slice(0, 3).join(tr('、')), n: delNames.length }) : delNames.join(tr('、')),
          detail: confirmDel ? deleteConfirmText(confirmDel.plan, !isRemote) : '',
        })}
        confirmText={isRemote ? tr('删除') : tr('移到回收站')}
        onConfirm={() => confirmDel && doDelete(confirmDel.paths)} onCancel={() => setConfirmDel(null)}>
        {isRemote && prod && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 text-[12px] font-medium text-[var(--color-danger)]">
            {tr('这是生产主机，删除后无法恢复，请再确认一遍路径。')}
          </div>
        )}
      </ConfirmDialog>
      {chmodFor && (
        <ChmodDialog names={chmodFor.paths.map((p) => byPath.get(p)?.name ?? p)} initial={chmodFor.mode} anyDir={chmodFor.anyDir} prod={prod}
          onConfirm={doChmod} onCancel={() => setChmodFor(null)} />
      )}
      {editing && <FileEditor key={editing} scope={scope} path={editing} onClose={() => setEditing(null)} retry={sudoTick}
        onSudo={isRemote && !sudoMode ? () => setSudoMode(true) : undefined} onNeedPw={() => setSudoAsk(true)} />}
      {sudoAsk && scope0 !== 'local' && <SudoDialog terminalId={scope0.terminalId} title={pane?.title} onCancel={() => setSudoAsk(false)}
        onDone={() => { setSudoAsk(false); setSudoTick((n) => n + 1); refreshAll(); setNote(tr('sudo 已验证：目录已按 root 身份刷新，刚才没做成的操作请再做一次')) }} />}
      {previewing && <FilePreview key={previewing} scope={scope} path={previewing} onClose={() => setPreviewing(null)} onEdit={() => { setEditing(previewing); setPreviewing(null) }}
        onDownload={isRemote && onDownload ? () => download([previewing]) : undefined} />}
    </div>
  )
}
