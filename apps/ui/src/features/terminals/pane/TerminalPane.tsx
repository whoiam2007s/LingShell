import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Bot, Square, MessageSquareQuote, ChevronUp, ChevronDown, X, CaseSensitive, Zap, Sparkles, Loader2, AlertTriangle } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { IMarker, IDecoration } from '@xterm/xterm'
import type { AlertHit, CompletionMatch, PasteCheck, ShellCommand, TerminalInfo } from '@lingshell/shared'
import { ShellMarkTracker, adjacentLine, bellAction, cleanOutput, commandQuote, completionInsert, createAlertScanner, createHighlightStream, dangerCheck, fmtDuration, isSecretPrompt, matchCompletions, nlErrorText, onShellMarks, pasteCheck, pasteCheckTitle, readBufferRange, redactSecrets, shouldComplete, stripHidden, termSafeLine, typedBeforeCursor } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { sendToChat } from '../../../lib/sendToChat.js'
import { dismissKey, failCommandLabel, shouldOfferFix } from './failHint.js'
import { PasteConfirmDialog } from '../../../components/PasteConfirm.js'
import { paletteSend } from '../../../lib/paletteBus.js'
import { AddToRunbookDialog } from '../../runbooks/index.js'
import { recordTermAlert } from '../../dashboard/index.js'
import { fontFamilyOf, getAlerts, getHighlight, getTermBadge, getTermPrefs, setTermBadge, subscribeTermPrefs, themeOf, useTermPrefs, xtermOptionsOf, type TermBadge } from '../../../lib/termPrefs.js'
import { bufferText, registerBufferReader } from './termBuffer.js'
import { actionOf, isAction, termShouldIntercept } from '../../../lib/keybindings.js'
import { claimActiveTerminal } from '../../../lib/activeTerminal.js'
import { ReconnectBanner } from './ReconnectBanner.js'
import { getTermCwd, setTermCwd } from '../../../lib/termCwd.js'
import { withVscodeRemote } from '../../../components/VscodeRemote.js'
import { findFileLinks, type FileLink, type FileLinkReq } from '@lingshell/shared'
import { CompletionPopup, completionPool, deleteCompletion, staleCompletions } from './CompletionPopup.js'
import { Table2, Braces } from 'lucide-react'
import { commandKind, parseJsonOutput, tr } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'
import { openTableView } from '../../table/index.js'
import { ReplayBuffer, replayCapOf } from '@lingshell/shared'
import { openReplay, registerReplay } from './InstantReplay.js'
import { QuickSelectOverlay, collectQuickSelect, type QsItem } from './QuickSelect.js'
import { RULER_WIDTH, clipLabel, installRulerClick, markColors } from './scrollMarks.js'
import { PredictThrottle } from '@lingshell/shared'
import { addAiMark, focusToolCard, sessionTitle, tracker as aiExecs, watchAiExec, type AiExecPending } from '../aiMarks.js'
import { findHitLine, recordAlertHit } from '../alertHits.js'
import { attachTermBlock, clipBlock, TERM_BLOCK_MIME } from '../../../lib/termBlock.js'

// AI 预测下一条命令：全局节流（同一提示符一次、每分钟最多 6 次）
const predictThrottle = new PredictThrottle()
import { emitTermCommand, registerPromptProbe } from '../../../lib/termCommands.js'
import { AlertAiToast } from './AlertAiToast.js'
import { askAiTroubleshoot } from '../../../lib/askAi.js'

// 搜索高亮（addon 要求 #RRGGBB）；带 decorations 才会触发 onDidChangeResults 给出计数
const SEARCH_DECO: ISearchOptions['decorations'] = {
  matchBackground: '#5c4a12', matchOverviewRuler: '#d29922', activeMatchBackground: '#b36b00', activeMatchColorOverviewRuler: '#ff9f1a',
}
// 浅底配色（白底深字）用浅黄高亮，深底那套褐色会把深色字盖住
const SEARCH_DECO_LIGHT: ISearchOptions['decorations'] = {
  matchBackground: '#fff1a8', matchOverviewRuler: '#bf8700', activeMatchBackground: '#ffc94d', activeMatchColorOverviewRuler: '#9a6700',
}
const isLightBg = (c?: string) => { const n = parseInt((c ?? '').replace('#', '').slice(0, 6), 16); return Number.isFinite(n) && ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 }

// xterm 自己经 onData 回给程序的应答（光标位置/设备属性/DSR/焦点/鼠标/OSC/DCS/DECRPM），不是用户输入，广播时不转发。
// 代价：Shift+F3 这类 \x1b[1;2R 会被误判为光标位置应答，只发本终端。
// eslint-disable-next-line no-control-regex
const TERM_REPLY = /^\x1b(\[\??\d+(;\d+)*R|\[[?>=]?[\d;]*c|\[\??\d*n|\[[IO]|\[M[\s\S]{3}|\[<[\d;]+[Mm]|\[\??[\d;]*\$y|\][\s\S]*|P[\s\S]*)$/

// active = 显示在某个窗格；focused 仅分屏时传（焦点窗格顶部高亮）；style 由 TerminalView 给分屏的 order/flex；
// onFocus：在窗格内按下鼠标即把焦点切到本窗格（捕获阶段，抢在 xterm 之前）
// onInput：广播模式下本终端在组内时传，用户输入（键入/粘贴）除照常写本终端外再交给它转发到组内其它终端；broadcast 控制橙色边框
export function TerminalPane({ info, active, focused, style, onFocus, onInput, broadcast, hydrate }: {
  info: TerminalInfo; active: boolean; focused?: boolean; style?: React.CSSProperties; onFocus?: () => void
  onInput?: (d: string) => void; broadcast?: boolean
  hydrate?: boolean   // 渲染页重载后接管的已有终端：用主进程缓冲回填滚动区（新建终端不用）
}) {
  const inputRef = useRef(onInput)   // onData 只在挂载时注册一次，经 ref 读最新回调
  inputRef.current = onInput
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)   // 终端区域（浮层的定位容器）
  const fitRef = useRef<FitAddon | null>(null)
  const [locked, setLocked] = useState(false)
  const lockedRef = useRef(false)   // 同步判断用（effect 里的闭包读不到最新 state）
  const envRef = useRef(info.env); envRef.current = info.env   // 同上：生产标记可能在终端打开后才补上
  const splitRef = useRef(focused !== undefined); splitRef.current = focused !== undefined   // 分屏中（focused 只在分屏时传）
  const activeRef = useRef(active); activeRef.current = active   // 同上：标签是否显示在某个窗格（通知 / 角标用）
  const titleRef = useRef(info.title); titleRef.current = info.title
  const osRef = useRef(info.os); osRef.current = info.os
  // 命令自动补全浮层（compRef 供 xterm 键盘回调同步读）；compPick = 鼠标点选
  const [comp, setComp] = useState<CompState | null>(null)
  const compRef = useRef<CompState | null>(null)
  const compPick = useRef<(i: number) => void>(() => {})
  const [pasteAsk, setPasteAsk] = useState<{ text: string; check: PasteCheck } | null>(null)   // 粘贴待确认（危险命令 / 隐藏字符 / 生产多行）
  const pasteRef = useRef<(t: string) => void>(() => {})
  // 选中文本后浮出的「问 AI」按钮（坐标相对终端区域）
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null)
  // 点命令成败点弹出的操作菜单；confirm = 生产终端上重新执行危险命令的二次确认
  const [menu, setMenu] = useState<{ x: number; y: number; cmd: Cmd; confirm?: boolean } | null>(null)
  const [rbCmd, setRbCmd] = useState<string | null>(null)   //「加入运维手册」弹窗
  const [qs, setQs] = useState<QsItem[] | null>(null)   // 快速选择模式中：候选与提示字母（见 QuickSelect.tsx）
  // 鼠标悬停在可识别的命令块（df / ps / docker ps… 或输出是 JSON）上时，块右上角的「⊞ 表格」按钮（y 相对终端区域）
  const [tblBtn, setTblBtn] = useState<{ y: number; cmd: Cmd; json: boolean } | null>(null)
  // 命令失败横幅「让 AI 排查」（见 failHint.ts）：新命令开始 / AI 接管时收起；按 × 关过的命令记在 failDismissed
  const [fail, setFail] = useState<Cmd | null>(null)
  const failDismissed = useRef(new Set<string>())
  // 自然语言写命令（默认 Ctrl+I）：光标处的小输入框；loading 时只读，Esc 丢弃结果
  const [nl, setNl] = useState<{ x: number; y: number; up: boolean; text: string; phase: 'input' | 'loading' | 'error'; error?: string } | null>(null)
  const [danger, setDanger] = useState<{ x: number; y: number; up: boolean } | null>(null)   // 插入的命令危险：红色提示，回车 / Ctrl+C 或删掉命令后消失
  const dangerOn = useRef(false)   // 同 danger，供 xterm 回调里同步读
  const nlSeq = useRef(0)   // 每次提交 / 取消递增，过期的结果丢弃
  // effect 里建的、渲染期要调的：停在空提示符？（返回不能插入的原因）/ 当前目录 / 写入并提示
  const promptHint = useRef<() => string | null>(() => null)
  const cwdRef = useRef<string | undefined>(undefined)
  const insertCmd = useRef<(cmd: string) => void>(() => {})
  const termRef = useRef<Terminal | null>(null)
  const prefs = useTermPrefs()
  // AI 预测下一条命令：提示符后的灰色幽灵字（坐标相对终端区域，h = 行高）；ghostRef 供键盘回调同步读
  const [ghost, setGhost] = useState<{ x: number; y: number; h: number; text: string } | null>(null)
  const ghostRef = useRef<string | null>(null)
  // 终端内搜索（默认 Ctrl+F，与对话区会话内搜索按焦点区分）
  const searchRef = useRef<SearchAddon | null>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findTick, setFindTick] = useState(0)   // 每次按搜索键递增：已打开时也重新聚焦/全选输入框
  const [query, setQuery] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [result, setResult] = useState<{ i: number; n: number } | null>(null)
  // 自动应答的短暂提示（右下角，几秒后消失）
  const [autoNote, setAutoNote] = useState<{ text: string; warn: boolean } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flash = (text: string, warn = false, ms = 2500) => {
    setAutoNote({ text, warn }); clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setAutoNote(null), ms)
  }
  // 终端里 Ctrl+点击「文件:行号」：本地终端直接用编辑器打开；SSH 终端先弹小菜单选「下载到本地编辑器」或「VS Code Remote」
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; link: FileLink } | null>(null)
  const openFileLink = (l: FileLink, how?: 'download' | 'vscode') => {
    setLinkMenu(null)
    const cwd = getTermCwd(info.id)
    const req: FileLinkReq = { path: l.path, line: l.line, ...(l.col ? { col: l.col } : {}), ...(cwd ? { cwd } : {}), ...(how ? { how } : {}) }
    if (how === 'vscode') { withVscodeRemote(info.id, () => client.fileLinks.open(info.id, req)); return }
    flash(tr('正在打开 {path}…', { path: `${l.path}:${l.line}` }))
    client.fileLinks.open(info.id, req).then((r) => flash(tr('已用编辑器打开 {path}', { path: `${r.path}:${l.line}` })))
      .catch((e) => flash(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true, 6000))
  }
  const fileLinkRef = useRef<(l: FileLink, e: MouseEvent) => void>(() => {})
  fileLinkRef.current = (l, e) => {
    if (info.type !== 'ssh') { openFileLink(l); return }
    const r = ref.current?.getBoundingClientRect()
    setLinkMenu({ x: Math.min(e.clientX - (r?.left ?? 0), (r?.width ?? 400) - 250), y: e.clientY - (r?.top ?? 0) + 6, link: l })
  }
  useEffect(() => {
    if (!linkMenu) return
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.('[data-link-menu]')) setLinkMenu(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setLinkMenu(null) } }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [linkMenu])
  // 关键字告警提示（带「用 AI 排查」）；pendingAlert = 不在看时命中的，切回本终端再提示
  const [alertAsk, setAlertAsk] = useState<string | null>(null)
  const pendingAlert = useRef<string | null>(null)
  useEffect(() => {
    const show = () => { if (activeRef.current && pendingAlert.current) { setAlertAsk(pendingAlert.current); pendingAlert.current = null } }
    show()
    window.addEventListener('focus', show)   // 窗口不在前台时命中的：回到窗口再提示
    return () => window.removeEventListener('focus', show)
  }, [active])
  const askAlert = (text: string) => {
    setAlertAsk(null)
    // 终端最近 40 行（去行尾空白、连续空行并成一行）
    const ctx = termRef.current ? bufferText(termRef.current.buffer.normal).split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n').trim().split('\n').slice(-40).join('\n') : ''
    askAiTroubleshoot({ host: titleRef.current, ...(info.hostId ? { hostId: info.hostId } : {}), terminalId: info.id, alert: `关键字告警「${text.trim().slice(0, 80)}」`, context: `终端最近输出：\n${ctx}` })   // i18n-ignore 发给 AI 的话（同 shared/ai/troubleshoot.ts）
  }

  useEffect(() => {
    if (!ref.current) return
    const p0 = getTermPrefs()
    // ignoreBracketedPasteMode：粘贴不包 bracketed paste 标记，多行逐行立即执行（同 Xshell）；否则 bash 5.1+ 会把整段塞进一行、等回车才一起跑
    // overviewRuler：滚动条上的概览标尺，画命令成败 / 搜索命中 / 告警标记（见 scrollMarks.ts）
    const term = new Terminal({ ...xtermOptionsOf(p0), allowProposedApi: true, ignoreBracketedPasteMode: true, overviewRuler: { width: RULER_WIDTH } })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(ref.current)
    fitRef.current = fit
    // Unicode 11 字符宽度表：中文 / emoji 按两格算，光标不错位（unicode 是 proposed API，构造时已开 allowProposedApi）
    term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'
    // 链接：悬停显示下划线，按住 Ctrl（mac 为 ⌘）点击才打开，免得选文字时误开。只放行 http/https，
    // window.open 由主进程 setWindowOpenHandler 转系统浏览器（那边同样只放行 http/https）
    term.loadAddon(new WebLinksAddon((e, uri) => {
      if ((e.ctrlKey || e.metaKey) && /^https?:\/\//i.test(uri)) window.open(uri, '_blank')
    }, {
      hover: () => { ref.current?.setAttribute('title', tr('Ctrl+点击打开链接')) },
      leave: () => { ref.current?.removeAttribute('title') },
    }))
    // 「文件:行号」与常见堆栈行（见 shared/files/fileLinks.ts）：悬停下划线，按住 Ctrl 点击用编辑器跳到该行（SSH 终端先选打开方式）
    const offLinks = term.registerLinkProvider({
      provideLinks: (y, cb) => {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        // 逐格拼文本并记下每个字符所在的列（中文占两格，第二格宽度 0 跳过）
        let text = ''
        const colOf: number[] = []
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x)
          if (!c || c.getWidth() === 0) continue
          const s = c.getChars() || ' '
          for (let k = 0; k < s.length; k++) colOf.push(x)
          text += s
        }
        const found = findFileLinks(text)
        if (!found.length) return cb(undefined)
        cb(found.map((l) => {
          const last = colOf[l.end - 1]
          return {
            range: { start: { x: colOf[l.start] + 1, y }, end: { x: last + (line.getCell(last)?.getWidth() || 1), y } },
            text: text.slice(l.start, l.end),
            decorations: { underline: true, pointerCursor: true },
            hover: () => { ref.current?.setAttribute('title', tr('Ctrl+点击在编辑器中打开 {path}', { path: `${l.path}:${l.line}${l.col ? `:${l.col}` : ''}` })) },
            leave: () => { ref.current?.removeAttribute('title') },
            activate: (e: MouseEvent) => { if (e.ctrlKey || e.metaKey) fileLinkRef.current(l, e) },
          }
        }))
      },
    })
    const search = new SearchAddon(); term.loadAddon(search); searchRef.current = search
    search.onDidChangeResults(({ resultIndex, resultCount }) => setResult({ i: resultIndex, n: resultCount }))
    // 返回 false = xterm 不处理（不发给 shell）。搜索键开搜索框；应用级快捷键放行冒泡给 useTerminalShortcuts
    term.attachCustomKeyEventHandler((e) => {
      // 预测的幽灵字：→ 接受（写进提示符，不回车）；其它键（单按修饰键除外）收起后照常处理
      if (ghostRef.current && e.type === 'keydown' && !e.isComposing && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        const g = ghostRef.current
        ghostSet(null)
        if (e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); insertCmd.current(termSafeLine(g)); return false }
      }
      // 补全浮层开着时才拦：↑↓ 选择 / Tab、→ 接受 / Esc 关闭 / Shift+Delete 删历史；其余键（含回车）照常给 shell
      const c = compRef.current
      if (c && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const k = e.key, plain = !e.shiftKey
        const act = plain && (k === 'ArrowUp' || k === 'ArrowDown') ? 'nav' : plain && (k === 'Tab' || k === 'ArrowRight') ? 'accept'
          : plain && k === 'Escape' ? 'close' : e.shiftKey && k === 'Delete' ? 'delete' : null
        if (act) {
          if (e.type === 'keydown') {
            e.preventDefault()
            if (act === 'nav') compSet({ ...c, sel: (c.sel + (k === 'ArrowUp' ? -1 : 1) + c.matches.length) % c.matches.length })
            else if (act === 'accept') compAccept(c.sel)
            else if (act === 'close') { compDismissed = c.input; compSet(null) }
            else compDelete(c.sel)
          }
          return false
        }
      }
      // 按键由快捷键注册表 + 用户覆盖决定（lib/keybindings.ts），以下三类只对焦点终端
      const a = actionOf(e)
      if (a === 'term.find') {
        if (e.type === 'keydown') {
          e.preventDefault()
          const s = term.getSelection()
          if (s && !s.includes('\n')) setQuery(s)
          setFindOpen(true); setFindTick((t) => t + 1)
        }
        return false
      }
      // 跳到上一条 / 下一条命令的提示符（需 shell integration 标记，见 shellMarks.ts）
      if (a === 'term.prevCmd' || a === 'term.nextCmd') {
        if (e.type === 'keydown') { e.preventDefault(); jumpCmd(a === 'term.prevCmd' ? -1 : 1) }
        return false
      }
      // 自然语言写命令（默认 Ctrl+I，同 VS Code 终端内联 AI；Tab 键是单独的键码，补全不受影响）
      if (a === 'term.nl') {
        if (e.type === 'keydown' && !e.repeat) { e.preventDefault(); openNl() }
        return false
      }
      // 快速选择（默认 Alt+S）/ 即时回放（默认 Ctrl+Alt+R）
      if (a === 'term.quickSelect' || a === 'term.replay') {
        if (e.type === 'keydown' && !e.repeat) { e.preventDefault(); if (a === 'term.replay') openReplay(info.id); else openQs() }
        return false
      }
      // 没分屏时切窗格的键（默认 Alt+方向键）照常给 shell：fish / zsh 等用它按词移动、切目录
      if (a?.startsWith('pane.') && !splitRef.current) return true
      // 其它绑定了「全局 / 焦点在终端时」动作的键不发给 shell，冒泡给 useTerminalShortcuts / App 处理
      return !termShouldIntercept(e)
    })
    // 外观（字号/配色/字体/行距/光标/回滚行数）变化即时应用（不重建 xterm），只改变了的项；下一帧按新字符尺寸重新 fit
    let applied = xtermOptionsOf(p0)
    // 即时回放：原始输出（高亮前）按时间进内存环形缓冲（见 InstantReplay.tsx），上限随设置即时调整
    const replay = new ReplayBuffer(replayCapOf(p0.replayMB))
    const offReplay = registerReplay(info.id, replay, () => titleRef.current)
    const offPrefs = subscribeTermPrefs(() => {
      replay.setCap(replayCapOf(getTermPrefs().replayMB))
      const next = xtermOptionsOf(getTermPrefs())
      for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] !== applied[k]) term.options[k] = next[k] as never
      applied = next
      requestAnimationFrame(() => { if (termRef.current === term && el.clientWidth > 0 && el.clientHeight > 0) fit.fit() })
    })
    // WebGL 渲染器：默认 DOM 渲染器每帧重排 DOM，输入/滚动明显卡顿；WebGL 走 GPU。
    // 上下文丢失(如 GPU 重置)时 addon 自弃，xterm 回退 DOM 渲染，不致白屏。
    // 回退后立即整屏重绘：WebGL 上下文数有上限（同页约 16 个，开发时热更新会累积），超限时最早的上下文被收走，
    // 不重绘的话那个终端会停在空白、看起来像不能输入。
    try { const webgl = new WebglAddon(); webgl.onContextLoss(() => { webgl.dispose(); term.refresh(0, term.rows - 1) }); term.loadAddon(webgl) } catch { /* 无 GPU 时回退 DOM */ }
    const el = ref.current
    // ResizeObserver 覆盖所有尺寸变化：窗口 resize、分屏拖动、以及隐藏(hidden→0)的后台标签切到前台后
    // 容器从 0 变为实际尺寸——切标签不发 window.resize，仅靠它才能把停在 0/旧尺寸的 xterm 重新 fit。
    // fit 后总同步一次：fit 结果恰好等于 xterm 默认 80x24 时 onResize 不触发，而后端 PTY 起始是 80x30
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) { fit.fit(); client.terminal.resize(info.id, term.cols, term.rows).catch(() => {}) }
    })
    ro.observe(el)
    // 选中即复制：仅在选择结束(mouseup)时写剪贴板，避免拖选过程中每次 selectionChange 都触发异步 clipboard 写，拖选卡顿
    const onSelCopy = (e: MouseEvent) => {
      const s = term.getSelection()
      if (!s.trim()) { setAsk(null); return }
      navigator.clipboard?.writeText(s).catch(() => {})
      const r = el.getBoundingClientRect()
      setAsk({ x: Math.min(e.clientX - r.left + 8, r.width - 90), y: Math.max(e.clientY - r.top - 34, 4), text: s })
    }
    term.onSelectionChange(() => { if (!term.hasSelection()) setAsk(null) })
    termRef.current = term
    el.addEventListener('mouseup', onSelCopy)
    // 右键粘贴走 xterm 自己的 paste（和 Ctrl+V 同一条路）：把 \r\n / \n 统一成回车（Windows 复制来的多行文本
    // 原样写会让 \r、\n 各当一次回车，多出空命令行）。先 focus 让 onData 里的广播判断（焦点在本终端）成立
    // 粘贴前检查（见 pasteCheck）：生产终端带换行（会逐行立即执行）、任何终端含危险命令或隐藏 / 控制字符 → 先弹确认。
    // Ctrl+V 在捕获阶段拦下，抢在 xterm 前
    const checkPaste = (t: string) => pasteCheck(t, envRef.current, getTermPrefs().pasteCheck !== false)
    const doPaste = (t: string) => {
      const check = checkPaste(t)
      if (check) { setPasteAsk({ text: t, check }); return }
      term.focus(); term.paste(t)
    }
    pasteRef.current = (t) => { term.focus(); term.paste(t) }
    const onCtx = (e: MouseEvent) => { e.preventDefault(); navigator.clipboard?.readText().then((t) => { if (t) doPaste(t) }).catch(() => {}) }
    el.addEventListener('contextmenu', onCtx)
    const onPaste = (e: ClipboardEvent) => {
      const t = e.clipboardData?.getData('text/plain') ?? ''
      if (!checkPaste(t)) return   // 不用确认：交给 xterm 照常粘贴
      e.preventDefault(); e.stopPropagation(); doPaste(t)
    }
    el.addEventListener('paste', onPaste, true)
    // 关键字高亮只在这里改喂给 xterm 的数据（录屏/AI 捕获在主进程，读的是原始输出）；
    // 块尾扣留的半行 50ms 内等不到下一块就原样补出
    const hl = createHighlightStream()
    let hlTimer: ReturnType<typeof setTimeout> | undefined
    const writeOut = (chunk: string) => {
      replay.push(Date.now(), chunk, term.cols, term.rows)
      const hits = scanAlerts(chunk)
      term.write(hl.push(chunk, getHighlight()))
      if (hits.length) term.write('', () => placeHits(hits))   // 写完再在缓冲里找到命中行打 marker
      clearTimeout(hlTimer)
      if (hl.pending) hlTimer = setTimeout(() => term.write(hl.flush(getHighlight())), 50)
    }
    // 提醒（长命令完成 / 关键字告警）：标签不可见 → 标签角标；窗口不在前台或标签不可见 → 系统通知。
    // 返回 true = 用户正看着（窗口在前台且标签可见），调用方自己决定要不要在终端里提示
    const remind = (badge: TermBadge, title: string, body: string) => {
      const visible = activeRef.current, focused = document.hasFocus()
      if (!visible) setTermBadge(info.id, badge)
      if (!visible || !focused) client.system.notify(title, body).catch(() => {})
      return visible && focused
    }
    // 响铃（\a，如远端 `长任务; printf '\a'`）：后台标签 → 铃铛角标（不盖掉已有的告警 / 完成角标）；窗口不在前台 → 系统通知（10 秒一次）
    let bellAt = 0
    term.onBell(() => {
      const now = Date.now()
      const a = bellAction(getTermPrefs().bell, activeRef.current, document.hasFocus(), bellAt, now)
      if (a.badge && !getTermBadge(info.id)) setTermBadge(info.id, { kind: 'bell', text: tr('响铃') })
      if (a.notify) { bellAt = now; client.system.notify(tr('「{title}」响铃', { title: titleRef.current }), tr('终端发出了响铃（\\a）')).catch(() => {}) }
    })
    // 关键字告警：勾了「告警」的高亮规则命中输出（每条规则 30 秒最多一次）。AI 执行中、全屏程序里不算；
    // 停在提示符时的输出是提示符和键入回显（如 grep ERROR），也不算——只扫命令开始（133;C）之后的部分
    const alerts = createAlertScanner()
    const collect = createAlertScanner(0)   // 告警汇总面板：每行都收（通知那边每条规则 30 秒一次）
    const scanAlerts = (chunk: string): AlertHit[] => {
      const c = getAlerts()
      if (!c || lockedRef.current || term.buffer.active.type !== 'normal') { alerts.reset(); collect.reset(); return [] }
      let s = chunk
      if (tracker.promptState().kind === 'idle') {
        alerts.reset(); collect.reset()
        const k = chunk.lastIndexOf(']133;C')
        if (k < 0) return []
        s = chunk.slice(Math.max(0, k - 1))   // 连 ESC 一起留，序列整段被剥掉（否则命中行开头带着「]133;C」）
      }
      for (const h of alerts.scan(s, c)) {
        recordTermAlert(info.id, h.line.slice(0, 200))   // 主机仪表盘「最近告警」
        addAlertMark()
        // 正看着：右下角提示带「用 AI 排查」；没看着：记下，切回这个终端时再提示（系统通知 / 标签角标照旧）
        pendingAlert.current = h.line.slice(0, 200)
        if (remind({ kind: 'alert', text: tr('告警：{text}', { text: h.line.slice(0, 200) }) }, tr('「{title}」输出命中告警', { title: titleRef.current }), h.line)) { setAlertAsk(pendingAlert.current); pendingAlert.current = null }
      }
      return collect.scan(s, c).slice(0, 20)   // 一块输出最多记 20 条，防刷屏
    }
    // 命中行 → marker（从光标往上找含该文本的行），登记到告警汇总；行被回滚缓冲裁掉后 goto / context 失效
    const placeHits = (hits: AlertHit[]) => {
      const b = term.buffer.normal, cur = b.baseY + b.cursorY
      for (const h of hits) {
        const y = findHitLine((i) => b.getLine(i)?.translateToString(true), cur, h.line)
        const m = y === undefined ? undefined : term.registerMarker(y - cur)
        recordAlertHit({
          terminalId: info.id, terminalTitle: titleRef.current, rule: h.pattern, line: h.line.slice(0, 500),
          goto: () => !!m && !m.isDisposed && revealLine(m),
          context: (n) => {
            if (!m || m.isDisposed) return null
            const out: string[] = []
            for (let i = Math.max(0, m.line - n); i <= m.line + n; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)) }
            return out.join('\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
          },
        })
      }
    }
    // 切到本终端并把 marker 那行滚到视口上方第 2 行、闪一下（切标签后等一帧，隐藏中的 xterm 不好滚）
    const revealLine = (m: IMarker) => {
      paletteSend({ type: 'focusTerm', id: info.id })
      setTimeout(() => {
        if (m.isDisposed || termRef.current !== term) return
        term.scrollToLine(Math.max(0, m.line - 1))
        const d = term.registerDecoration({ marker: m, width: term.cols })
        d?.onRender((el) => { if (!el.classList.contains('ai-flash')) { el.style.pointerEvents = 'none'; el.classList.add('ai-flash') } })
        setTimeout(() => d?.dispose(), 1700)
      }, 60)
      return true
    }
    // 缓冲区导出（工具栏按钮经 termBuffer 的登记表来取）：主屏缓冲，含回滚
    const offBuf = registerBufferReader(info.id, () => bufferText(term.buffer.normal))
    // 命令成败标记：bash 钩子打的 OSC 133（见 terminal-core/promptNewline.ts）→ 每条用户命令在行首左侧一个绿/红点。
    // 位置 = xterm marker（随滚动/scrollback 裁剪自动更新，裁掉即 dispose，装饰随之消失）。只留最近 MAX_CMDS 条
    const cmds: Cmd[] = []
    // 告警命中：滚动条标尺右道一个橙点（同一行只标一次，留最近 MAX_CMDS 个）
    const alertMarks: IDecoration[] = []
    const addAlertMark = () => {
      if (term.buffer.active.type !== 'normal') return
      const m = term.registerMarker(0)
      if (alertMarks.some((d) => d.marker.line === m.line)) { m.dispose(); return }
      const d = term.registerDecoration({ marker: m, overviewRulerOptions: { color: markColors().alert, position: 'right' } })
      if (!d) { m.dispose(); return }
      d.onDispose(() => m.dispose())
      alertMarks.push(d)
      while (alertMarks.length > MAX_CMDS) alertMarks.shift()!.dispose()
    }
    // 标尺上的标记：悬停看命令 / 告警行的前部分，点击跳过去（命令看提示符行，告警看命中行）
    const offRuler = installRulerClick(term, el, () => [
      ...cmds.filter((c) => !(c.input ?? c.prompt ?? c.output).m.isDisposed).map((c) => ({
        line: (c.input ?? c.prompt ?? c.output).m.line,
        label: `${c.exitCode === undefined ? '' : c.exitCode === 0 ? '✓ ' : tr('✗ 退出码 {code} · ', { code: c.exitCode })}${clipLabel(c.text) || tr('（未取到命令行）')}`,
      })),
      ...alertMarks.filter((d) => !d.isDisposed).map((d) => ({
        line: d.marker.line,
        label: tr('告警：{text}', { text: clipLabel(term.buffer.active.getLine(d.marker.line)?.translateToString(true) ?? '') }),
      })),
    ])
    // 快速选择：读可见区域、标字母（见 QuickSelect.tsx）
    const openQs = () => {
      if (!boxRef.current) return
      const items = collectQuickSelect(term, el, boxRef.current)
      if (!items.length) { flash(tr('屏幕上没有可快速选择的内容（IP / URL / 路径 / 哈希 / 端口 / 数字）')); return }
      setMenu(null); setAsk(null); compSet(null)
      // 让终端输入框失焦：中文输入法只在可输入的元素上组字，焦点留在 xterm 的 textarea 上时按提示字母会变成拼音（d'd），
      // 浏览器收到的已是 Process 键、拦不住。失焦后字母原样到达 QuickSelectOverlay；退出 / 复制后再 focus 回来
      term.blur()
      setQs(items)
    }
    const offQsScroll = term.onScroll(() => setQs(null))   // 内容滚动了，提示位置对不上
    const posNow = (): Pos => ({ m: term.registerMarker(0), col: term.buffer.active.cursorX })
    const tracker = new ShellMarkTracker<Pos>({ onCommand: (c) => addCmd(c), onDrop: (p) => p.m.dispose() })
    const offProbe = registerPromptProbe(info.id, () => tracker.promptState().kind)   // 运维手册视图：没见过提示符时先补一个回车
    // 只认主屏：备用屏（vim/less）里没有 scrollback，marker 无意义
    onShellMarks(term, (m) => {
      if (term.buffer.active.type !== 'normal') return
      if (m.kind === 'cwd') { cwdRef.current = m.cwd; setTermCwd(info.id, m.cwd, info.type === 'local') }   // 上抛给资源管理器跟随 / 拖文件上传
      if (m.kind === 'C') setFail(null)   // 新命令开始：上一条的失败横幅收起
      tracker.feed(m, posNow)
    })
    // 能否往提示符里插命令：全屏程序 / AI 占用 / 有命令在跑 / 输入行已有字 → 不能（返回原因）。
    // 没有标记（非 bash、刚被 reset）时放宽：只要不在全屏程序里就允许
    // 提示符后已输入的文字（读屏幕缓冲：从 133;B 标记到光标所在行末）；不在提示符 / 没有标记时 undefined
    const typedInput = (): string | undefined => {
      const b = term.buffer.active
      const st = tracker.promptState()
      if (b.type !== 'normal' || st.kind !== 'idle' || !st.input || st.input.m.isDisposed) return undefined
      return readBufferRange(b, { line: st.input.m.line, col: st.input.col }, { line: b.baseY + b.cursorY, col: term.cols })
    }
    promptHint.current = () => {
      const b = term.buffer.active
      if (b.type !== 'normal') return tr('全屏程序（vim / less 等）里不能插入命令')
      if (lockedRef.current) return tr('AI 正在使用这个终端')
      const st = tracker.promptState()
      if (st.kind === 'busy') return tr('有命令正在运行，等它结束后再试')
      if (typedInput()?.trim()) return tr('输入行已有内容，先清空（Ctrl+U）再试')
      return null
    }
    // 危险提示跟着输入行走：每次画面更新后重读输入行，命令被删掉 / 改得不危险了就收起（回车 / Ctrl+C 另在 onData 里收）
    term.onWriteParsed(() => {
      ghostSet(null); predSchedule()   // 画面变了：幽灵字作废；安静 800ms 后再看要不要预测
      if (compRef.current || Date.now() - typedAt < 1000) compSchedule()   // 键入回显到了：重读输入行、重新过滤
      if (!dangerOn.current) return
      const typed = typedInput()
      if (typed !== undefined && dangerCheck(typed) !== 'dangerous') { dangerOn.current = false; setDanger(null) }
    })
    // 光标所在格的位置（相对终端区域）：放输入框 / 危险提示 / 补全浮层（w / h = 浮层大致宽高，col = 改用这一列的横坐标）。下方放不下就放到光标行上方
    const cursorAnchor = (w = 340, h = 40, col?: number) => {
      const scr = el.querySelector('.xterm-screen')?.getBoundingClientRect(), box = boxRef.current?.getBoundingClientRect()
      if (!scr || !box) return { x: 8, y: 8, up: false }
      const cw = scr.width / term.cols, ch = scr.height / term.rows, b = term.buffer.active
      const top = scr.top - box.top + b.cursorY * ch
      const up = top + ch + h > box.height && top > h
      return { x: Math.max(4, Math.min(scr.left - box.left + (col ?? b.cursorX) * cw, box.width - w)), y: up ? top - 4 : top + ch + 4, up }
    }
    // 命令自动补全：键入回显后（onWriteParsed）读提示符后的输入、过滤候选；只在 OSC 133 判定停在提示符、光标在输入末尾时弹。
    // 全屏程序 / AI 执行中 / 有命令在跑（含密码提示）/ 输入为空都不弹。Esc 关掉后输入不变就不再弹
    let typedAt = 0, compTimer: ReturnType<typeof setTimeout> | undefined, compDismissed: string | undefined
    const compSet = (c: CompState | null) => { if (c) ghostSet(null); if (c || compRef.current) { compRef.current = c; setComp(c) } }   // 补全浮层开着时不显示预测
    const compUpdate = () => {
      const b = term.buffer.active, st = tracker.promptState()
      if (!getTermPrefs().autoComplete || !el.contains(document.activeElement) || b.type !== 'normal' || lockedRef.current
        || st.kind !== 'idle' || !st.input || st.input.m.isDisposed) { compSet(null); return }
      const input = typedBeforeCursor(b, { line: st.input.m.line, col: st.input.col }, { line: b.baseY + b.cursorY, col: b.cursorX }, term.cols)
      if (!shouldComplete(input) || input === compDismissed) { compSet(null); return }
      compDismissed = undefined
      const pool = completionPool(info.id, osRef.current, () => { if (Date.now() - typedAt < 5000) compUpdate() })
      const matches = pool ? matchCompletions(pool, input) : []
      if (!matches.length) { compSet(null); return }
      const prev = compRef.current, keep = prev ? matches.findIndex((m) => m.item.text === prev.matches[prev.sel]?.item.text) : -1
      compSet({ ...cursorAnchor(380, matches.length * 22 + 22, st.input.m.line === b.baseY + b.cursorY ? st.input.col : 0), input, matches, sel: Math.max(0, keep) })
    }
    const compSchedule = () => { clearTimeout(compTimer); compTimer = setTimeout(compUpdate, 30) }   // 一批回显只算一次
    // 接受：写差额（或退格后整条）。走 term.input → onData，和手敲同一条路（广播照常）
    const compAccept = (i: number) => {
      const c = compRef.current, m = c?.matches[i]
      if (!c || !m) return
      compSet(null); typedAt = Date.now()
      term.input(completionInsert(c.input, m.item.text), true)
      term.focus()
    }
    compPick.current = compAccept
    const compDelete = (i: number) => {
      const c = compRef.current, m = c?.matches[i]
      if (!c || !m) return
      if (m.item.kind !== 'history') { flash(m.item.kind === 'quick' ? tr('这是快速命令，到快速命令里删除') : tr('内置常用命令不能删除'), true); return }
      const matches = c.matches.filter((_, j) => j !== i)
      compSet(matches.length ? { ...c, matches, sel: Math.min(c.sel, matches.length - 1) } : null)
      deleteCompletion(info.id, m.item.text).then(() => flash(tr('已从命令历史删除')), () => flash(tr('删除失败'), true))
    }
    const onBlur = () => { compSet(null); ghostSet(null) }
    term.textarea?.addEventListener('blur', onBlur)
    // 光标停在密码 / 口令提示上（不在 shell 提示符）：这时敲的不进命令历史
    const secretNow = () => {
      const b = term.buffer.active
      if (tracker.promptState().kind === 'idle') return false
      return isSecretPrompt(b.getLine(b.baseY + b.cursorY)?.translateToString(false, 0, b.cursorX) ?? '')
    }
    const openNl = () => {
      const hint = promptHint.current()
      if (hint) { flash(hint, true); return }
      nlSeq.current++
      setMenu(null); setAsk(null); setDanger(null); dangerOn.current = false
      setNl({ ...cursorAnchor(), text: '', phase: 'input' })
    }
    // 结果写进提示符、不回车（不走广播：这是给本终端的，用户看过再回车）。危险命令给红色提示
    insertCmd.current = (cmd) => {
      dangerOn.current = dangerCheck(cmd) === 'dangerous'
      setDanger(dangerOn.current ? cursorAnchor() : null)   // 写之前取：贴在命令开头那一格的下方
      client.terminal.write(info.id, cmd).catch(() => {})
      term.focus()
    }
    const addCmd = (c: ShellCommand<Pos>) => {
      const at = (c.input ?? c.prompt)!   // 点放在输入行（多行 PS1 时是 $ 那行）；没有 B 时退回提示符行。tracker 保证至少有一个
      // 命令行 = 输入开始到输出开始（没有 B 时连 PS1 一起，AI 也看得懂）；缓冲里本就是纯文本，无 ANSI
      const text = readBufferRange(term.buffer.normal, { line: at.m.line, col: at.col }, { line: c.output.m.line, col: c.output.col }).trim()
      // 同一个装饰顺带在滚动条标尺左道画成败色（见 scrollMarks.ts）
      const mc = markColors(), color = c.exitCode === undefined ? mc.unknown : c.exitCode !== 0 ? mc.fail : mc.ok
      const cmd: Cmd = { ...c, text, dot: term.registerDecoration({ marker: at.m, overviewRulerOptions: { color, position: 'left' } }) }
      cmd.dot?.onRender((d) => renderDot(d, cmd))
      cmds.push(cmd)
      while (cmds.length > MAX_CMDS) disposeCmd(cmds.shift()!)
      emitTermCommand({ terminalId: info.id, text, exitCode: c.exitCode, durationMs: c.durationMs, at: Date.now() })   // 运维手册视图等退出码 / 耗时
      // 失败横幅：只对用户自己敲的命令（AI 哨兵命令不成 Cmd；锁定中的也排除）
      if (shouldOfferFix({ exitCode: c.exitCode, command: text, enabled: getTermPrefs().failHint !== false, aiBusy: lockedRef.current, dismissed: failDismissed.current })) setFail(cmd)
      // 长命令完成通知（只算用户命令：AI 接管期间的不提醒）
      const n = getTermPrefs().notifySec ?? 0
      if (n > 0 && c.durationMs >= n * 1000 && !lockedRef.current) {
        const failed = c.exitCode !== undefined && c.exitCode !== 0
        const head = failed ? tr('命令失败（退出码 {code}）', { code: c.exitCode ?? '' }) : tr('命令完成')
        const body = tr('{cmd} · 耗时 {dur}', { cmd: text.split('\n')[0].slice(0, 100) || tr('（未取到命令行）'), dur: fmtDuration(c.durationMs) })
        remind({ kind: failed ? 'failed' : 'done', text: tr('{head}：{body}', { head, body }) }, tr('「{title}」{head}', { title: titleRef.current, head }), body)
      }
    }
    const disposeCmd = (c: Cmd) => { c.dot?.dispose(); for (const p of [c.prompt, c.input, c.output, c.end]) p?.m.dispose() }
    // 装饰元素宽一格、在行首；点画在它左侧的内边距里（行元素才 overflow:hidden，装饰层不裁），不挡提示符文字。
    // onRender 每次重绘都触发，只建一次
    const renderDot = (d: HTMLElement, c: Cmd) => {
      if (d.firstChild) return
      const failed = c.exitCode !== undefined && c.exitCode !== 0   // 无退出码（别家的 133;D）= 灰点，不算失败
      d.style.pointerEvents = 'none'   // 装饰本体透明不吃鼠标，不妨碍选中行首文字
      const hit = document.createElement('div')
      hit.title = tr('退出码 {code} · 耗时 {dur}\n点击：复制 / 重新执行 / 问 AI / 存为快速命令…', { code: c.exitCode ?? tr('未知'), dur: fmtDuration(c.durationMs) })
      hit.style.cssText = 'position:absolute;left:-11px;top:0;width:10px;height:100%;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer'
      const dot = document.createElement('div')
      dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${c.exitCode === undefined ? 'var(--color-text-muted)' : failed ? 'var(--color-danger)' : 'var(--color-success)'}`
      hit.appendChild(dot)
      // 不冒泡给 xterm（否则开始选区/清选区）和外层 mouseup（选中即复制会把气泡关掉）
      hit.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault() })
      hit.addEventListener('mouseup', (e) => e.stopPropagation())
      hit.addEventListener('click', (e) => {
        e.stopPropagation()
        const r = boxRef.current?.getBoundingClientRect(), b = hit.getBoundingClientRect()
        if (!r) return
        setAsk(null)
        // 菜单约 255px 高：下方放不下就往上翻
        setMenu({ x: Math.min(b.right - r.left + 4, r.width - 200), y: b.top - r.top + 255 > r.height ? Math.max(4, b.bottom - r.top - 255) : b.top - r.top, cmd: c })
      })
      d.appendChild(hit)
    }
    // AI 执行的命令：行首紫色菱形（区别于用户命令的绿 / 红点），悬停「AI 执行 · 会话标题 · 时间」，点击 → 对话滚到对应工具卡片。
    // 关联只在内存里（aiMarks.ts）；marker 随回滚缓冲裁掉即失效，卡片上的「在终端中定位」随之提示输出已不在缓冲里
    watchAiExec()
    const aiOffs = new Set<() => void>()
    const addAiExecMark = (p: AiExecPending) => {
      if (termRef.current !== term || term.buffer.active.type !== 'normal') return
      const m = term.registerMarker(0)
      const deco = term.registerDecoration({ marker: m })
      const time = new Date(p.at).toLocaleTimeString()
      deco?.onRender((d) => {
        if (d.firstChild) return
        d.style.pointerEvents = 'none'
        const hit = document.createElement('div')
        hit.dataset.aiMark = p.callId
        hit.title = tr('AI 执行 · {time}\n{cmd}\n点击：在对话里找到这一步', { time, cmd: p.command.slice(0, 200) })
        void sessionTitle(p.sessionId).then((t) => { hit.title = tr('AI 执行 · {session} · {time}\n{cmd}\n点击：在对话里找到这一步', { session: t, time, cmd: p.command.slice(0, 200) }) })
        hit.style.cssText = 'position:absolute;left:-11px;top:0;width:10px;height:100%;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer'
        const dia = document.createElement('div')
        dia.style.cssText = 'width:6px;height:6px;transform:rotate(45deg);background:var(--color-reasoning)'
        hit.appendChild(dia)
        hit.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault() })
        hit.addEventListener('mouseup', (e) => e.stopPropagation())
        hit.addEventListener('click', (e) => { e.stopPropagation(); focusToolCard({ sessionId: p.sessionId, callId: p.callId }) })
        d.appendChild(hit)
      })
      const off = addAiMark({ callId: p.callId, terminalId: info.id, sessionId: p.sessionId, at: p.at, goto: () => !m.isDisposed && termRef.current === term && revealLine(m) })
      aiOffs.add(off)
      m.onDispose(() => { off(); aiOffs.delete(off); deco?.dispose() })
    }
    // ── AI 预测下一条命令：停在空提示符 800ms → 问一次模型 → 光标后灰色幽灵字 ──
    let predTimer: ReturnType<typeof setTimeout> | undefined
    const ghostSet = (g: { x: number; y: number; h: number; text: string } | null) => { if (g || ghostRef.current) { ghostRef.current = g?.text ?? null; setGhost(g) } }
    const predSchedule = () => { clearTimeout(predTimer); if (getTermPrefs().predict) predTimer = setTimeout(predCheck, 800) }
    // 能预测吗：开关开、焦点在本终端、不在全屏程序 / AI 执行中、停在提示符且输入为空、补全浮层没开、本终端有过命令。返回这个提示符（节流的 key）
    const predReady = () => {
      const st = tracker.promptState()
      if (!getTermPrefs().predict || !el.contains(document.activeElement) || lockedRef.current || compRef.current || term.buffer.active.type !== 'normal'
        || st.kind !== 'idle' || !st.input || st.input.m.isDisposed || typedInput()?.trim() || !cmds.length) return undefined
      return st.input
    }
    const predCheck = () => {
      const key = predReady()
      const commands = cmds.slice(-5).map((c) => c.text).filter((t) => t && !t.includes('\n'))   // 多行（续行 / 多行 PS1）的不要
      if (!key || !commands.length || !predictThrottle.allow(key)) return
      const last = cmds[cmds.length - 1]
      const prod = envRef.current === 'prod'
      const tail = prod ? undefined : cleanOutput(cmdOutput(term, last, 200) ?? '', 4000).text   // 主进程再按脱敏设置处理
      client.aiLink.predictCommand({ os: osRef.current, cwd: cwdRef.current, prod, commands, outputTail: tail })
        .then((cmd) => {
          if (!cmd || predReady() !== key) return   // 等待期间敲了字 / 提示符变了
          const scr = el.querySelector('.xterm-screen')?.getBoundingClientRect(), bx = boxRef.current?.getBoundingClientRect()
          if (!scr || !bx) return
          const cw = scr.width / term.cols, ch = scr.height / term.rows, b = term.buffer.active
          if (b.viewportY !== b.baseY) return   // 往上翻着看：光标不在视口里
          ghostSet({ x: scr.left - bx.left + b.cursorX * cw, y: scr.top - bx.top + b.cursorY * ch, h: ch, text: termSafeLine(cmd) })
        }, () => {})   // 无 API / 出错：静默
    }
    // ── 选中的文字拖进对话输入框 → 终端块（只有输出文本）。鼠标在选区所在行上按下时不交给 xterm（否则会清掉选区），改由外层 div 原生拖拽 ──
    const overSel = (e: MouseEvent) => {
      const p = term.hasSelection() ? term.getSelectionPosition() : undefined
      const scr = el.querySelector('.xterm-screen')?.getBoundingClientRect()
      if (!p || !scr || e.clientY < scr.top || e.clientY >= scr.bottom) return false
      const row = term.buffer.active.viewportY + Math.floor((e.clientY - scr.top) / (scr.height / term.rows))
      return row >= Math.min(p.start.y, p.end.y) - 1 && row <= Math.max(p.start.y, p.end.y)   // 行号基准各版本不一，放宽一行
    }
    let selDown = false
    const onSelMove = (e: MouseEvent) => { if (e.buttons === 0) el.draggable = overSel(e) }
    const onSelDown = (e: MouseEvent) => { if (e.button === 0 && el.draggable && overSel(e)) { selDown = true; e.stopPropagation() } }
    const onSelUp = () => { if (selDown) { selDown = false; el.draggable = false; term.clearSelection(); setAsk(null) } }   // 按下没拖：同普通单击，清掉选区
    const onDragStart = (e: DragEvent) => {
      const s = term.getSelection()
      if (!s.trim() || !e.dataTransfer) { e.preventDefault(); return }
      selDown = false
      e.dataTransfer.setData(TERM_BLOCK_MIME, JSON.stringify({ terminalTitle: titleRef.current, output: s }))
      e.dataTransfer.setData('text/plain', s)
      e.dataTransfer.effectAllowed = 'copy'
    }
    const onDragEnd = () => { el.draggable = false }
    el.addEventListener('mousemove', onSelMove); el.addEventListener('mousedown', onSelDown, true); el.addEventListener('mouseup', onSelUp, true)
    el.addEventListener('dragstart', onDragStart); el.addEventListener('dragend', onDragEnd)
    const jumpCmd = (dir: -1 | 1) => {
      const b = term.buffer.active
      if (b.type !== 'normal') return
      const l = adjacentLine(cmds.map((c) => (c.prompt ?? c.output).m.line), b.viewportY, dir)
      if (l !== undefined) term.scrollToLine(l)
      else if (dir > 0) term.scrollToBottom()
    }
    // 命令块悬停「⊞ 表格」：按鼠标所在的缓冲行找命令块（输入行到结束标记），命令可识别或输出是 JSON 才显示；每条命令只判断一次
    const tblOf = (c: Cmd) => {
      if (c.tbl === undefined) {
        const out = cmdOutput(term, c, 5000)
        c.tbl = out !== null && parseJsonOutput(cleanOutput(out, 5_000_000).text) !== undefined ? 'json' : commandKind(c.text) ? 'table' : null
      }
      return c.tbl
    }
    const box = boxRef.current
    let hovRaf = 0, hovX = 0, hovY = 0
    const hovUpdate = () => {
      hovRaf = 0
      const scr = el.querySelector('.xterm-screen')?.getBoundingClientRect(), bx = box?.getBoundingClientRect(), b = term.buffer.active
      const none = () => setTblBtn((p) => (p ? null : p))
      if (!scr || !bx || b.type !== 'normal' || !cmds.length || hovY < scr.top || hovY >= scr.bottom) { none(); return }
      const ch = scr.height / term.rows, line = b.viewportY + Math.floor((hovY - scr.top) / ch)
      const start = (k: Cmd) => (k.input ?? k.prompt ?? k.output).m.line
      let c: Cmd | undefined
      for (let i = cmds.length - 1; i >= 0; i--) {
        const k = cmds[i]
        if (k.output.m.isDisposed || k.end.m.isDisposed || start(k) > line) continue
        if (line < k.end.m.line || (line === k.end.m.line && k.end.col > 0)) c = k   // 结束标记那行是下一个提示符，不算
        break
      }
      const kind = c ? tblOf(c) : null
      if (!c || !kind) { none(); return }
      const y = scr.top - bx.top + Math.max(0, start(c) - b.viewportY) * ch, hit = c
      setTblBtn((p) => (p && p.cmd === hit && p.y === y ? p : { y, cmd: hit, json: kind === 'json' }))
    }
    const onHover = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-tbl-btn]')) return
      hovX = e.clientX; hovY = e.clientY
      if (!hovRaf && hovX >= 0) hovRaf = requestAnimationFrame(hovUpdate)
    }
    const onLeave = () => setTblBtn(null)
    box?.addEventListener('mousemove', onHover); box?.addEventListener('mouseleave', onLeave)
    const offScroll = term.onScroll(() => { setTblBtn(null); ghostSet(null) })
    // 快照回填前到达的实时输出先攒着：等快照写完再按顺序补上（直接写会让历史跑到新输出后面）
    let snapDone = false
    const pending: string[] = []
    const off = client.on((ev) => {
      if (ev.type === 'terminal:data' && ev.terminalId === info.id) {
        if (snapDone) writeOut(ev.chunk); else pending.push(ev.chunk)
      }
      if (ev.type === 'terminal:locked' && ev.terminalId === info.id) {
        setLocked(ev.locked); lockedRef.current = ev.locked
        if (ev.locked) { tracker.reset(); compSet(null); setFail(null); ghostSet(null) }   // AI 接管：丢掉进行中的用户命令，AI 命令结束的 D 不记到它头上
        const p = ev.locked ? aiExecs.take(info.id) : undefined   // 对话里刚开始执行的工具 → 这次加锁就是它
        if (p) term.write('', () => addAiExecMark(p))   // 等之前的输出写完，标在命令回显那一行
      }
      if (ev.type === 'terminal:autoReply' && ev.terminalId === info.id) {
        if (ev.disabled) flash(tr('自动应答「{rule}」1 分钟内触发过多，已在此终端停用', { rule: ev.rule }), true, 8000)
        else flash(tr('自动应答：{rule}', { rule: ev.rule }))
      }
    })
    // 渲染页重载（Ctrl+R / 开发热重载）：主进程里的会话还活着，把最近 2000 行输出回填到滚动区，
    // 否则界面一片空白、历史全丢。回填期间到达的实时输出等回填完再按顺序写。
    const flush = (text: string) => {
      if (termRef.current !== term) return
      if (text) term.write(text.replace(/\n/g, '\r\n'))
      for (const c of pending) writeOut(c)
      pending.length = 0
    }
    if (hydrate) client.terminal.snapshot(info.id, 2000).then((text) => { snapDone = true; flush(text) },
      () => { snapDone = true; flush('') })
    else snapDone = true
    // 广播：只转发用户输入——焦点在本终端（排除后台终端的自动应答）且不是 xterm 应答序列
    term.onData((d) => {
      setAsk(null); setMenu(null); ghostSet(null); predSchedule()
      // eslint-disable-next-line no-control-regex
      if (/[\r\x03]/.test(d)) { setDanger(null); dangerOn.current = false; compSet(null) }   // 回车 / Ctrl+C：危险提示完成使命，补全收起
      if (d.includes('\r')) staleCompletions(info.id)   // 可能多了一条历史
      const reply = TERM_REPLY.test(d)
      if (!reply) {
        // 打字 / 退格才触发补全；方向键、Tab、Ctrl 组合（翻 shell 历史、shell 自己的补全）收起浮层，不在其后弹出
        // eslint-disable-next-line no-control-regex
        if (/^[^\x00-\x1f\x7f]+$|^[\x7f\x08]+$|^\x7f+[^\x00-\x1f\x7f]+$/.test(d)) typedAt = Date.now()
        else { typedAt = 0; compSet(null) }
      }
      client.terminal.write(info.id, d, !reply && secretNow() ? { noHistory: true } : undefined).catch(() => {})
      if (inputRef.current && el.contains(document.activeElement) && !reply) inputRef.current(d)
    })
    // fit 改了行列 → 同步给后端 PTY（之前从没接上，PTY 一直停在 80x30）
    term.onResize(({ cols, rows }) => { client.terminal.resize(info.id, cols, rows).catch(() => {}) })
    return () => {
      offReplay(); offRuler(); offLinks.dispose(); offQsScroll.dispose(); for (const d of alertMarks) d.dispose()
      clearTimeout(predTimer); aiOffs.forEach((f) => f())
      el.removeEventListener('mousemove', onSelMove); el.removeEventListener('mousedown', onSelDown, true); el.removeEventListener('mouseup', onSelUp, true)
      el.removeEventListener('dragstart', onDragStart); el.removeEventListener('dragend', onDragEnd)
      cancelAnimationFrame(hovRaf); offScroll.dispose(); box?.removeEventListener('mousemove', onHover); box?.removeEventListener('mouseleave', onLeave); clearTimeout(hlTimer); clearTimeout(compTimer); term.textarea?.removeEventListener('blur', onBlur); clearTimeout(noteTimer.current); ro.disconnect(); offPrefs(); offBuf(); offProbe(); setTermBadge(info.id, null); fitRef.current = null; termRef.current = null; searchRef.current = null; el.removeEventListener('mouseup', onSelCopy); el.removeEventListener('contextmenu', onCtx); el.removeEventListener('paste', onPaste, true); off(); term.dispose() }
  }, [info.id])

  // 切到前台时补一次 fit：ResizeObserver 在容器由 hidden 变可见的同一帧不一定触发，显式兜底
  // 同时清掉本标签的角标（用户看到了）
  useEffect(() => {
    if (active) setTermBadge(info.id, null)
    if (active && ref.current && ref.current.clientWidth > 0) fitRef.current?.fit()
    // 隐藏期间滚动条按 0 高度算过；行列没变时 fit 不触发重算，滚动条滑块会一直是旧的（空终端也显示长滑块）。
    // ponytail: 调 xterm 6 内部 viewport.queueSync 重算滚动区，没有公开 API；xterm 升级后若改名，这里只是失效不报错
    if (active) requestAnimationFrame(() => (termRef.current as unknown as { _core?: { _viewport?: { queueSync?: () => void } } } | null)?._core?._viewport?.queueSync?.())
  }, [active, info.id])

  // 「聚焦终端」快捷键（默认 Ctrl+`）：显示中且是焦点窗格（单屏时 focused 不传）的终端接过键盘焦点
  useEffect(() => {
    if (!active || focused === false) return
    const onKey = (e: KeyboardEvent) => {
      if (!isAction(e, 'focus.terminal') || document.querySelector('.fixed.inset-0')) return
      e.preventDefault(); termRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, focused])
  // 登记为「当前终端」：对话里代码块的「插入终端 / 执行」发到这里（见 lib/activeTerminal.ts）
  useEffect(() => (active && focused !== false ? claimActiveTerminal({ id: info.id, focus: () => termRef.current?.focus() }) : undefined), [active, focused, info.id])

  // 成为焦点窗格（快捷键新建/切换/关闭标签后）时把键盘焦点给 xterm；
  // 只在焦点原本就在某个终端或无焦点时接管，不抢聊天输入框等的焦点
  useEffect(() => {
    if (!active || focused === false) return
    const h = requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body || a.closest('.xterm')) termRef.current?.focus()
    })
    return () => cancelAnimationFrame(h)
  }, [active, focused])

  // 命令点菜单：点外面 / Esc 关（点成败点本身在原生 mousedown 就停止冒泡，不会关了又开）
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey) }
  }, [menu])

  // 搜索框：打开/再次按搜索键时聚焦全选；输入或切大小写即增量搜索
  useEffect(() => { if (findOpen) { findInput.current?.focus(); findInput.current?.select() } }, [findOpen, findTick])
  // 搜索命中在滚动条标尺上用主题的警告色（黄，中道；告警是更偏红的橙，在右道）
  const opts = (incremental = false): ISearchOptions => {
    const y = markColors().search
    const base = isLightBg(themeOf(getTermPrefs().theme).background) ? SEARCH_DECO_LIGHT : SEARCH_DECO
    return { caseSensitive: matchCase, incremental, decorations: { ...base!, matchOverviewRuler: y, activeMatchColorOverviewRuler: y } }
  }
  useEffect(() => {
    if (!findOpen) return
    if (!query) { searchRef.current?.clearDecorations(); setResult(null); return }
    searchRef.current?.findNext(query, opts(true))
  }, [query, matchCase, findOpen])
  const findStep = (back: boolean) => {
    if (!query) return
    if (back) searchRef.current?.findPrevious(query, opts())
    else searchRef.current?.findNext(query, opts())
  }
  const closeFind = () => { searchRef.current?.clearDecorations(); setFindOpen(false); setResult(null); termRef.current?.focus() }
  // 红点菜单「附加到对话」：命令块做成终端块附件（输出按「发给 AI 前脱敏」处理，超 8KB 留末尾）
  const attachBlock = async (c: Cmd) => {
    const out = cmdOutput(termRef.current, c, 100_000)
    const s = await client.settings.get().catch(() => undefined)
    const text = out === null ? '（输出已滚出终端缓冲）' : cleanOutput(out).text   // i18n-ignore 发给 AI 的终端块
    attachTermBlock(clipBlock({ terminalTitle: info.title, command: c.text, exitCode: c.exitCode, cwd: c.cwd, output: s?.system?.aiRedact === false ? text : redactSecrets(text) }))
    flash(tr('已附加到对话输入框'))
  }
  // 表格查看：读这条命令的输出（最多 2 万行）交给表格弹窗
  const openTable = (c: Cmd) => {
    const out = cmdOutput(termRef.current, c, 20_000)
    if (out === null) { flash(tr('输出已滚出终端缓冲'), true); return }
    setTblBtn(null)
    openTableView({ title: info.title, command: c.text, output: cleanOutput(out, 5_000_000).text })
  }

  return (
    <div onMouseDownCapture={onFocus} style={active ? style : undefined}
      className={active ? `relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${focused === false ? 'opacity-70' : ''}` : 'hidden'}>
      {/* 分屏焦点窗格：内描边浮层（盖在内容上、不占布局，不会被分割线/相邻窗格挡住）；其余窗格调暗 */}
      {/* 往里缩 2px：贴边会和分割线（在窗格边界上）、窗口边缘重叠；落在终端内边距里，不挡字、不压命令成败点 */}
      {focused && <div className="pointer-events-none absolute inset-[2px] z-30 rounded-sm ring-1 ring-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)]" />}
      {/* 广播组内：橙色描边盖在最上层（落在 xterm 的 p-1.5 内边距里，不挡字），不吃鼠标 */}
      {broadcast && <div className="pointer-events-none absolute inset-0 z-30 ring-2 ring-inset ring-orange-500" />}
      {locked && (
        <div className="flex items-center justify-between border-b border-[color:color-mix(in_srgb,var(--color-warn)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] px-3 py-1 text-[12px] text-[var(--color-warn)]">
          <span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" />{tr('agent 执行中…')}</span>
          <button onClick={() => client.terminal.interrupt(info.id)} className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-[color:color-mix(in_srgb,var(--color-warn)_20%,transparent)]"><Square className="h-3 w-3" />{tr('打断')}</button>
        </div>
      )}
      <ReconnectBanner info={info} />
      <div ref={boxRef} className="relative min-h-0 flex-1">
        {/* 内边距放外层：FitAddon 按 xterm 父元素的尺寸算行列，border-box 下父元素自带内边距会被算进可用宽度；
            左边留宽一点给命令成败点（装饰画在 xterm 左外侧），避开焦点描边 / 广播描边 */}
        <div className="h-full py-1.5 pl-4 pr-1.5" style={{ background: themeOf(prefs.theme).background }}>
          <div ref={ref} className="h-full w-full" />
        </div>
        {pasteAsk && (() => {
          const c = pasteAsk.check, multi = /[\r\n]/.test(pasteAsk.text)
          const msg = [
            c.prodMulti ? tr('「{title}」是生产终端，粘贴的内容', { title: info.title }) : tr('粘贴到「{title}」的内容', { title: info.title }),
            c.dangerous ? tr('含 {n} 行危险命令（红色）；', { n: c.dangerous }) : '',
            c.hidden ? tr('含隐藏 / 控制字符（以 ⟨…⟩ 标出，网页上复制的命令可能藏有看不见的内容）；') : '',
            multi ? tr('带换行，下面 {n} 行会逐行立即执行：', { n: c.lines.length }) : tr('下面这行会填进命令行（不会自动回车）：'),
          ].join('')
          const done = (t?: string) => { setPasteAsk(null); if (t) pasteRef.current(t); else termRef.current?.focus() }
          return (
            <PasteConfirmDialog open title={pasteCheckTitle(c)} message={msg} lines={c.lines}
              confirmText={multi ? tr('确认粘贴并执行') : tr('仍然粘贴')}
              onCancel={() => done()} onConfirm={() => done(pasteAsk.text)}
              onStrip={c.hidden ? () => done(stripHidden(pasteAsk.text)) : undefined} />
          )
        })()}
        {autoNote && (
          <div className={`pointer-events-none absolute bottom-2 right-3 z-20 flex items-center gap-1 rounded-md border bg-[var(--color-bg-panel)] px-2 py-1 text-[11px] shadow-lg ${autoNote.warn ? 'border-[color:color-mix(in_srgb,var(--color-warn)_50%,transparent)] text-[var(--color-warn)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)]'}`}>
            <Zap className="h-3 w-3" />{autoNote.text}
          </div>
        )}
        {linkMenu && (
          <div data-link-menu style={{ left: Math.max(4, linkMenu.x), top: linkMenu.y }}
            className="absolute z-30 w-[240px] rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
            <div className="truncate px-2 pb-1 pt-0.5 font-mono text-[10.5px] text-[var(--color-text-muted)]" title={`${linkMenu.link.path}:${linkMenu.link.line}`}>{linkMenu.link.path}:{linkMenu.link.line}{linkMenu.link.col ? `:${linkMenu.link.col}` : ''}</div>
            <button data-link-download onClick={() => openFileLink(linkMenu.link, 'download')} className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-[var(--color-bg-hover)]">
              <span className="text-[var(--color-text-primary)]">{tr('用本地编辑器打开')}</span>
              <span className="text-[10.5px] text-[var(--color-text-muted)]">{tr('下载到临时目录，跳到该行，保存自动回传')}</span>
            </button>
            <button data-link-vscode onClick={() => openFileLink(linkMenu.link, 'vscode')} className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-[var(--color-bg-hover)]">
              <span className="text-[var(--color-text-primary)]">{tr('用 VS Code Remote 打开')}</span>
              <span className="text-[10.5px] text-[var(--color-text-muted)]">{tr('直接编辑服务器上的文件（需装 Remote - SSH 扩展）')}</span>
            </button>
          </div>
        )}
        {alertAsk && !autoNote && <AlertAiToast text={alertAsk} onAsk={() => askAlert(alertAsk)} onClose={() => setAlertAsk(null)} />}
        {fail && (() => {
          const label = failCommandLabel(fail.text)
          // 组装同红点菜单「问 AI」（命令 / 退出码 / 目录 / 输出尾部），按「发给 AI 前脱敏」处理后直接发到当前对话
          const askFix = async () => {
            setFail(null)
            const q = cmdQuote(info.title, termRef.current, fail)
            const s = await client.settings.get().catch(() => undefined)
            sendToChat(s?.system?.aiRedact === false ? q : redactSecrets(q))
          }
          const dismiss = () => { failDismissed.current.add(dismissKey(fail.text)); setFail(null); termRef.current?.focus() }
          return (
            <div data-fail-hint onMouseDown={(e) => e.preventDefault()}
              className="absolute bottom-2 left-4 z-20 flex max-w-[calc(100%-32px)] items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[var(--color-bg-panel)] py-0.5 pl-2 pr-0.5 text-[11.5px] text-[var(--color-text-secondary)] shadow-lg">
              <X className="h-3 w-3 shrink-0 text-[var(--color-danger)]" />
              <span className="min-w-0 truncate" title={fail.text}>
                {label
                  ? trx('命令 {cmd} 失败（退出码 {code}）', { cmd: <code className="font-mono text-[var(--color-text-primary)]">{label}</code> }, { code: fail.exitCode ?? '' })
                  : tr('命令失败（退出码 {code}）', { code: fail.exitCode ?? '' })}
              </span>
              <span className="shrink-0 text-[var(--color-text-muted)]">—</span>
              <button onClick={() => void askFix()} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                <Sparkles className="h-3 w-3" />{tr('让 AI 排查')}
              </button>
              <button title={tr('关闭（这条命令之后不再提示）')} onClick={dismiss}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
            </div>
          )
        })()}
        {findOpen && (
          // 点按钮不抢走输入框焦点，Enter/Esc 继续可用
          <div onMouseDown={(e) => { if (e.target !== findInput.current) e.preventDefault() }}
            className="absolute right-3 top-1.5 z-20 flex items-center gap-0.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg">
            <input ref={findInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('查找')}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return   // 中文输入法选词的回车 / Esc 不是搜索操作
                if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey) }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind() }
                else if (e.ctrlKey && e.code === 'KeyF') { e.preventDefault(); e.currentTarget.select() }
              }}
              className="w-40 rounded border border-transparent bg-[var(--color-bg-base)] px-2 py-0.5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]" />
            <span className="min-w-[44px] px-1 text-center text-[11px] text-[var(--color-text-muted)]">
              {!query || !result ? '' : result.n === 0 ? tr('无结果') : result.i < 0 ? `${result.n}+` : `${result.i + 1}/${result.n}`}
            </span>
            <button title={tr('区分大小写')} onClick={() => setMatchCase((x) => !x)}
              className={`flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-bg-hover)] ${matchCase ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}><CaseSensitive className="h-3.5 w-3.5" /></button>
            <button title={tr('上一个（Shift+Enter）')} onClick={() => findStep(true)} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><ChevronUp className="h-3.5 w-3.5" /></button>
            <button title={tr('下一个（Enter）')} onClick={() => findStep(false)} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><ChevronDown className="h-3.5 w-3.5" /></button>
            <button title={tr('关闭（Esc）')} onClick={closeFind} className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        {ask && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              quoteToChat(formatQuote(info.title, ask.text))
              termRef.current?.clearSelection(); setAsk(null)
            }}
            style={{ left: ask.x, top: ask.y }}
            className="absolute z-10 flex items-center gap-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] shadow-lg transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <MessageSquareQuote className="h-3.5 w-3.5" />{tr('问 AI')}
          </button>
        )}
        {tblBtn && !menu && (
          <button data-tbl-btn onMouseDown={(e) => e.preventDefault()} onClick={() => openTable(tblBtn.cmd)} style={{ top: tblBtn.y, right: 12 }}
            title={tblBtn.json ? tr('这条命令输出的是 JSON：按可折叠的树查看') : tr('把这条命令的输出整理成表格：排序、过滤、复制 CSV')}
            className="absolute z-10 flex h-[18px] items-center gap-1 rounded border border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-bg-panel)] px-1.5 text-[11px] text-[var(--color-accent)] opacity-90 shadow hover:opacity-100">
            {tblBtn.json ? <Braces className="h-3 w-3" /> : <Table2 className="h-3 w-3" />}{tblBtn.json ? 'JSON' : tr('表格')}
          </button>
        )}
        {menu && (() => {
          const c = menu.cmd, line = c.text.includes('\n') ? '' : termSafeLine(c.text)   // 多行命令（续行 / 多行 PS1）不重放
          const risky = info.env === 'prod' && !!line && dangerCheck(line) === 'dangerous'
          const done = () => { setMenu(null); termRef.current?.focus() }
          const copy = (s: string, note: string) => { navigator.clipboard?.writeText(s).then(() => flash(note), () => flash(tr('复制失败'), true)); done() }
          const rerun = () => {
            const hint = promptHint.current()
            if (hint) { flash(hint, true); done(); return }
            if (risky && !menu.confirm) { setMenu({ ...menu, confirm: true }); return }
            client.terminal.write(info.id, `${line}\r`).catch(() => {}); done()
          }
          return (
            <div style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
              className="absolute z-30 w-48 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 text-[12px] text-[var(--color-text-primary)] shadow-lg">
              <div className="truncate px-2.5 pb-1 pt-0.5 font-mono text-[11px] text-[var(--color-text-muted)]" title={c.text}>{c.text || tr('（未取到命令行）')}</div>
              {menu.confirm ? (
                <>
                  <div className="flex items-start gap-1 px-2.5 py-1 text-[var(--color-danger)]"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tr('危险命令，将在生产终端上执行')}</div>
                  <button onClick={rerun} className={`${MENU_BTN} text-[var(--color-danger)]`}>{tr('确认重新执行')}</button>
                  <button onClick={done} className={MENU_BTN}>{tr('取消')}</button>
                </>
              ) : (
                <>
                  <button disabled={!c.text} onClick={() => copy(c.text, tr('已复制命令'))} className={MENU_BTN}>{tr('复制命令')}</button>
                  <button onClick={() => {
                    const out = cmdOutput(termRef.current, c, 100_000)
                    if (out === null) { flash(tr('输出已滚出终端缓冲'), true); done(); return }
                    const r = cleanOutput(out)
                    copy(r.text, r.truncated ? tr('已复制输出（超长，只留最后 200KB）') : tr('已复制输出'))
                  }} className={MENU_BTN}>{tr('复制输出')}</button>
                  <button onClick={() => { openTable(c); setMenu(null) }} className={MENU_BTN}>{tr('表格查看')}</button>
                  <button disabled={!line || locked} title={!line ? tr('多行命令不支持重新执行') : undefined} onClick={rerun} className={MENU_BTN}>{tr('重新执行')}</button>
                  <button onClick={() => { quoteToChat(cmdQuote(info.title, termRef.current, c)); setMenu(null) }} className={MENU_BTN}>{tr('问 AI')}</button>
                  <button data-attach-block title={tr('把这条命令（命令、退出码、目录、输出 ≤8KB）作为「终端块」附件放进对话输入框，可附多块')}
                    onClick={() => { void attachBlock(c); done() }} className={MENU_BTN}>{tr('附加到对话')}</button>
                  <button disabled={!c.text} onClick={() => { paletteSend({ type: 'quickAdd', command: c.text }); setMenu(null) }} className={MENU_BTN}>{tr('存为快速命令')}</button>
                  <button disabled={!c.text} onClick={() => { setRbCmd(c.text); setMenu(null) }} className={MENU_BTN}>{tr('加入运维手册')}</button>
                </>
              )}
            </div>
          )
        })()}
        {nl && (
          <div style={{ left: nl.x, top: nl.y }}
            className={`absolute z-30 w-[336px] rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] bg-[var(--color-bg-panel)] p-1 text-[12px] shadow-lg ${nl.up ? '-translate-y-full' : ''}`}>
            <div className="flex items-center gap-1.5">
              {nl.phase === 'loading' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin-slow text-[var(--color-accent)]" /> : <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />}
              <input autoFocus value={nl.text} readOnly={nl.phase === 'loading'} placeholder={tr('描述你想做的事，如：查谁占了 8080 端口')}
                onChange={(e) => setNl({ ...nl, text: e.target.value, phase: 'input' })}
                onBlur={() => { if (nl.phase !== 'loading') { nlSeq.current++; setNl(null) } }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nlSeq.current++; setNl(null); termRef.current?.focus(); return }
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing || nl.phase === 'loading' || !nl.text.trim()) return
                  e.preventDefault()
                  const seq = ++nlSeq.current, text = nl.text
                  setNl({ ...nl, phase: 'loading' })
                  client.agent.suggestCommand({ description: text, os: info.os, cwd: cwdRef.current, prod: info.env === 'prod' }).then((cmd) => {
                    if (seq !== nlSeq.current) return
                    const hint = promptHint.current()   // 等待期间提示符可能变了（命令跑起来 / AI 接管）
                    if (hint) { setNl((p) => p && { ...p, phase: 'error', error: hint }); return }
                    setNl(null); insertCmd.current(termSafeLine(cmd))
                  }, (err) => {
                    if (seq === nlSeq.current) setNl((p) => p && { ...p, phase: 'error', error: nlErrorText(String((err as Error)?.message ?? err)) })
                  })
                }}
                className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
              <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{nl.phase === 'loading' ? tr('生成中… Esc 取消') : tr('Enter 生成')}</span>
            </div>
            {nl.phase === 'error' && <div className="px-1 pt-1 text-[11px] text-[var(--color-danger)]">{nl.error}</div>}
          </div>
        )}
        {qs && (
          <QuickSelectOverlay items={qs}
            onExit={() => { setQs(null); termRef.current?.focus() }}
            onPick={(it, paste) => {
              setQs(null)
              navigator.clipboard?.writeText(it.text).then(() => flash(paste ? tr('已复制并粘贴：{text}', { text: it.text.slice(0, 60) }) : tr('已复制：{text}', { text: it.text.slice(0, 60) })), () => flash(tr('复制失败'), true))
              if (paste) pasteRef.current(it.text); else termRef.current?.focus()
            }} />
        )}
        {ghost && !comp && (
          <div data-predict-ghost style={{ left: ghost.x, top: ghost.y, height: ghost.h, lineHeight: `${ghost.h}px`, fontFamily: fontFamilyOf(prefs.fontFamily), fontSize: prefs.fontSize }}
            className="pointer-events-none absolute z-10 flex max-w-[70%] items-center gap-2 whitespace-pre text-[var(--color-text-muted)]">
            <span className="truncate opacity-80">{ghost.text}</span>
            <span className="shrink-0 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-1 font-sans text-[10px] leading-[14px]">{tr('→ 接受')}</span>
          </div>
        )}
        {comp && (
          <CompletionPopup x={comp.x} y={comp.y} up={comp.up} matches={comp.matches} sel={comp.sel}
            onPick={(i) => compPick.current(i)}
            onSel={(i) => { if (compRef.current && compRef.current.sel !== i) { compRef.current = { ...compRef.current, sel: i }; setComp(compRef.current) } }} />
        )}
        {danger && (
          <div style={{ left: danger.x, top: danger.y }}
            className={`pointer-events-none absolute z-20 flex items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)] bg-[var(--color-bg-panel)] px-2 py-0.5 text-[11px] text-[var(--color-danger)] shadow-lg ${danger.up ? '-translate-y-full' : ''}`}>
            <AlertTriangle className="h-3 w-3" />{tr('危险命令，请确认后再回车')}
          </div>
        )}
      </div>
      {rbCmd !== null && <AddToRunbookDialog command={rbCmd} onClose={() => setRbCmd(null)} />}
    </div>
  )
}

// 命令成败标记：位置 = marker + 列；Cmd 额外带读出的命令行和装饰
type Pos = { m: IMarker; col: number }
type Cmd = ShellCommand<Pos> & { text: string; dot?: IDecoration; tbl?: 'table' | 'json' | null }
const MAX_CMDS = 200
// 补全浮层：位置（相对终端区域）、当时的输入、候选、选中项
type CompState = { x: number; y: number; up: boolean; input: string; matches: CompletionMatch[]; sel: number }

// 用到时才从缓冲读 C…D 之间的输出（可能很长，不在每条命令结束时读）；已滚出缓冲 → null
function cmdOutput(term: Terminal | null, c: Cmd, maxRows?: number): string | null {
  if (!term || c.output.m.isDisposed || c.end.m.isDisposed) return null
  return readBufferRange(term.buffer.normal, { line: c.output.m.line, col: c.output.col }, { line: c.end.m.line, col: c.end.col }, maxRows)
}
function cmdQuote(title: string, term: Terminal | null, c: Cmd): string {
  return commandQuote({ title, command: c.text, exitCode: c.exitCode, cwd: c.cwd, output: cmdOutput(term, c) ?? '（输出已滚出终端缓冲）' })   // i18n-ignore 发给 AI 的话
}
const MENU_BTN = 'block w-full rounded px-2.5 py-1 text-left hover:bg-[var(--color-bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent'

// 引用格式：标明来自哪个终端，便于 AI 知道去哪个终端接着查。超长只留末尾（报错通常在最后）。
const QUOTE_MAX = 8000
function formatQuote(title: string, text: string): string {
  const body = text.length > QUOTE_MAX ? `…（前面省略 ${text.length - QUOTE_MAX} 字）\n${text.slice(-QUOTE_MAX)}` : text   // i18n-ignore 发给 AI 的话
  const fence = '```'
  return `终端「${title}」的输出：\n${fence}\n${body.replace(/\s+$/, '')}\n${fence}\n`   // i18n-ignore 发给 AI 的话
}
