import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Save, Sparkles, Search, Pilcrow, ScanEye, WrapText, Eraser, ChevronUp, ChevronDown, CaseSensitive, WholeWord, Replace, ReplaceAll, AlertTriangle } from 'lucide-react'
import { configKind, syntaxLangOf, highlightText, HIGHLIGHT_MAX, SUDO_NEED_PW, tk, tr, type ExplainItem, type FsScope, type TokKind } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { DiffView } from '../../components/DiffView.js'
import { ConfigExplainPanel } from './ConfigExplainPanel.js'
import {
  findSuspects, trailingSpaces, indentInfo, eolInfo, cleanText, findAll, replaceAll, lineCol, lineStart, indentLines, outdentLines, newlineKeepIndent,
  toggleComment, commentToken, moveLines, duplicateLines, deleteLines, checkSyntax, SUSPECT_LABEL, type Sel, type EditResult, type SyntaxProblem,
} from './editorOps.js'

// 高亮颜色取主题变量（深浅主题都跟着变）；只改颜色不改粗细 / 斜体，否则字宽变了会和光标错位
const TOK_CLS: Record<TokKind, string> = {
  comment: 'text-[var(--color-text-muted)]',
  string: 'text-[var(--color-success)]',
  number: 'text-[var(--color-warn)]',
  key: 'text-[var(--color-accent)]',
  keyword: 'text-[var(--color-reasoning)]',
  section: 'text-[var(--color-warn)]',
  variable: 'text-[var(--color-user)]',
  tag: 'text-[var(--color-accent)]',
}
const LANG_LABEL: Record<string, string> = { shell: 'Shell', ini: tk('配置（ini）'), nginx: 'nginx', yaml: 'YAML', json: 'JSON', xml: 'XML', dockerfile: 'Dockerfile', sql: 'SQL', code: tk('代码'), python: 'Python', plain: tk('纯文本') }
const LS = { ws: 'lingshell.editor.showWs', inv: 'lingshell.editor.showInv', wrap: 'lingshell.editor.wrap', indent: 'lingshell.editor.indent' }
const lsBool = (k: string, d: boolean) => { const v = localStorage.getItem(k); return v === null ? d : v === '1' }

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

// 装饰层：每个字符一个装饰档（越大越优先），同档连续的合成一段
const enum D { None, Space, Tab, TrailSp, TrailTab, Zw, Bad, Match, Cur }
const DECO_CLS: Record<number, string> = { [D.Space]: 'ed-sp', [D.Tab]: 'ed-tab', [D.TrailSp]: 'ed-sp ed-trail', [D.TrailTab]: 'ed-tab ed-trail', [D.Zw]: 'ed-zw', [D.Bad]: 'ed-bad', [D.Match]: 'ed-match', [D.Cur]: 'ed-cur' }

// 资源管理器里双击文件 → 查看/编辑（用户手动，不经 AI）。保存先看 diff 确认；落盘前主进程备份原文件并记执行记录（可还原）。
// textarea 的 value 会把 CRLF 归一成 LF：编辑时按 LF，保存时按底部状态栏选的换行符（默认按原文件）写回。
// 远程没权限：onSudo 切到 sudo 模式（打不开 → 重新读；存不进 → 用 sudo 再存一次，编辑内容不丢）；sudo 要密码时 onNeedPw 让外层弹密码框，retry 变了就重读
// 辅助：显示空白（空格 · / Tab →，行尾空白标红）、可疑字符检查（BOM / 零宽 / 不换行空格 / 全角空格 / 控制字符，一键清理）、
// 查找替换（Ctrl+F / Ctrl+H）、跳到行（Ctrl+G）、自动换行、状态栏（行列 / 选中 / 缩进 / 换行符可切换）、
// Tab / Shift+Tab 缩进、回车保持缩进、Ctrl+/ 注释、Alt+↑↓ 移动行、Shift+Alt+↓ 复制行、Ctrl+Shift+K 删除行、JSON / YAML 保存前检查
export function FileEditor({ scope, path, onClose, onSudo, onNeedPw, retry = 0 }: { scope: FsScope; path: string; onClose: () => void; onSudo?: () => void; onNeedPw?: () => void; retry?: number }) {
  const sudo = scope !== 'local' && !!scope.sudo
  const fmtErr = (e: unknown) => { const m = errMsg(e); if (m.includes(SUDO_NEED_PW)) { onNeedPw?.(); return m.replace(SUDO_NEED_PW, '') } return m }
  const deniedMsg = (m?: string) => !!m && !sudo && !!onSudo && /Permission denied|没有权限|EACCES|权限不够/i.test(m)   // i18n-ignore 匹配报错文本
  const [sudoSave, setSudoSave] = useState(false)   // 点了「用 sudo 保存」：切到 sudo 后自动再存一次
  const [base, setBase] = useState<string>()      // 打开时（或上次保存后）的磁盘原文，用于并发修改检测
  const [text, setText] = useState('')
  const [loadErr, setLoadErr] = useState<string>()
  const [err, setErr] = useState<string>()
  const [note, setNote] = useState('')
  const [diff, setDiff] = useState<string>()       // 非 undefined = 显示保存确认
  const [askClose, setAskClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [syntaxWarn, setSyntaxWarn] = useState<SyntaxProblem>()
  const gutter = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const hlPre = useRef<HTMLPreElement>(null)
  const markPre = useRef<HTMLPreElement>(null)
  // 配置文件「解释」侧栏（认得出的配置才有）：hl = 高亮的行范围；gutterLine = 点了哪个行号（侧栏据此定位）
  const kind = configKind(path)
  const [explain, setExplain] = useState(false)
  const [hl, setHl] = useState<{ start: number; end: number }>()
  const [gutterLine, setGutterLine] = useState<number>()
  // 开关（记住）
  const [showWs, setShowWs] = useState(() => lsBool(LS.ws, false))
  const [showInv, setShowInv] = useState(() => lsBool(LS.inv, true))
  const [wrap, setWrap] = useState(() => lsBool(LS.wrap, false))
  const flip = (k: string, set: (f: (v: boolean) => boolean) => void) => set((v) => { localStorage.setItem(k, v ? '0' : '1'); return !v })
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(''), 5000); return () => clearTimeout(t) }, [note])

  // 换行符：默认按原文件（混用时按多的那种），状态栏可切换
  const eol0 = useMemo(() => (base === undefined ? undefined : eolInfo(base)), [base])
  const [eol, setEol] = useState<'lf' | 'crlf'>('lf')
  useEffect(() => { if (eol0) setEol(eol0.crlf > eol0.lf ? 'crlf' : 'lf') }, [eol0])
  // 原文件以换行结尾就保证保存后也以换行结尾（常见编辑器的 insert_final_newline）：
  // 用户在最后那个空行里接着打字，textarea 里就没有末尾换行了，直接存会让 cat 输出和下一行粘连、部分配置解析出错
  const finalNewline = base?.endsWith('\n') ?? false
  const toDisk = (t: string) => {
    const withNl = finalNewline && t !== '' && !t.endsWith('\n') ? `${t}\n` : t
    return eol === 'crlf' ? withNl.replace(/\n/g, '\r\n') : withNl
  }
  const dirty = base !== undefined && toDisk(text) !== base

  // 打开时读一次（父组件按 path 做 key 重挂载）；打不开的，切到 sudo 或验证完密码后再读
  useEffect(() => {
    if (base !== undefined) return
    setLoadErr(undefined)
    client.fs.readText(scope, path)
      .then((t) => { setBase(t); setText(t.replace(/\r\n/g, '\n')) })
      .catch((e: unknown) => setLoadErr(fmtErr(e)))
  }, [sudo, retry])

  // ── 保存 ──
  const requestSave = (force = false) => {
    if (base === undefined || busy || diff !== undefined) return
    if (!dirty) { setErr(tr('没有改动')); return }
    const p = force ? undefined : checkSyntax(text, path)
    if (p) { setSyntaxWarn(p); return }
    setSyntaxWarn(undefined)
    setBusy(true); setErr(undefined)
    client.fs.diffText(scope, path, base, toDisk(text))
      .then((d) => setDiff(d || tr('（内容无变化）')))
      .catch((e: unknown) => setErr(fmtErr(e)))
      .finally(() => setBusy(false))
  }
  const confirmSave = () => {
    if (base === undefined) return
    const next = toDisk(text)
    setBusy(true)
    client.fs.writeText(scope, path, base, next)
      .then(() => { setBase(next); setDiff(undefined); setErr(undefined); setSaved(true) })
      .catch((e: unknown) => { setDiff(undefined); setErr(fmtErr(e)) })
      .finally(() => setBusy(false))
  }
  const requestClose = () => (dirty ? setAskClose(true) : onClose())
  useEffect(() => { if (sudoSave && sudo) { setSudoSave(false); confirmSave() } }, [sudo, sudoSave])

  // ── 编辑：按差异写回 textarea（浏览器原生插入，Ctrl+Z 能撤销），再设选区 ──
  const sel = (): Sel => { const a = area.current!; return { start: a.selectionStart, end: a.selectionEnd } }
  const apply = (r: EditResult) => {
    const a = area.current
    if (!a) return
    const cur = a.value
    if (r.text !== cur) {
      let p = 0
      const max = Math.min(cur.length, r.text.length)
      while (p < max && cur[p] === r.text[p]) p++
      let s = 0
      while (s < max - p && cur[cur.length - 1 - s] === r.text[r.text.length - 1 - s]) s++
      a.focus()
      a.setSelectionRange(p, cur.length - s)
      const ins = r.text.slice(p, r.text.length - s)
      if (!document.execCommand(ins ? 'insertText' : 'delete', false, ins)) { setText(r.text) }   // 不支持时退回直接设值（没有撤销）
    }
    a.setSelectionRange(r.sel.start, r.sel.end)
    updateCursor()
  }
  const lang = syntaxLangOf(path)
  const ind = useMemo(() => indentInfo(text), [text])
  // Tab 键插入什么：默认插真正的 Tab；YAML 不允许 Tab 缩进，改插空格（按文件现有缩进，没有就 2 个）。
  // 状态栏点击在 Tab → 空格 2 → 空格 4 之间切换，选择记住（之后打开的文件也按它）
  const [unitPick, setUnitPick] = useState(() => { const v = localStorage.getItem(LS.indent); return v === '2' ? '  ' : v === '4' ? '    ' : '\t' })
  const yamlNoTab = lang === 'yaml' && unitPick === '\t'
  const unit = yamlNoTab ? (ind.unit === '\t' ? '  ' : ind.unit) : unitPick
  const nextUnit = () => {
    const next = unit === '\t' ? '  ' : unit === '  ' ? '    ' : '\t'
    localStorage.setItem(LS.indent, next === '\t' ? 'tab' : String(next.length))
    setUnitPick(next)
  }
  const onAreaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    const k = e.key, mod = e.ctrlKey || e.metaKey
    const t = e.currentTarget.value, s = sel()
    const run = (r: EditResult) => { e.preventDefault(); apply(r) }
    if (k === 'Tab' && !mod) {
      if (e.shiftKey) return run(outdentLines(t, s, unit))
      if (t.slice(s.start, s.end).includes('\n')) return run(indentLines(t, s, unit))
      return run({ text: t.slice(0, s.start) + unit + t.slice(s.end), sel: { start: s.start + unit.length, end: s.start + unit.length } })
    }
    if (k === 'Enter' && !mod && !e.shiftKey && !e.altKey) return run(newlineKeepIndent(t, s))
    if (mod && !e.shiftKey && (k === '/' || e.code === 'Slash')) return run(toggleComment(t, s, commentToken(lang)))
    if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) return run(e.shiftKey ? duplicateLines(t, s) : moveLines(t, s, k === 'ArrowUp' ? -1 : 1))
    if (mod && e.shiftKey && e.code === 'KeyK') return run(deleteLines(t, s))
  }

  // ── 光标位置（状态栏） ──
  const [cursor, setCursor] = useState({ pos: 0, selLen: 0 })
  const updateCursor = () => { const a = area.current; if (a) setCursor({ pos: a.selectionStart, selLen: a.selectionEnd - a.selectionStart }) }
  const lc = lineCol(text, cursor.pos)

  // ── 查找替换 / 跳到行 ──
  const [find, setFind] = useState<{ q: string; rep: string; cs: boolean; ww: boolean; replace: boolean } | null>(null)
  const [cur, setCur] = useState(0)
  const [gotoLine, setGotoLine] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => (find?.q ? findAll(text, find.q, { caseSensitive: find.cs, wholeWord: find.ww }) : []), [text, find?.q, find?.cs, find?.ww])
  const curIdx = matches.length ? Math.min(cur, matches.length - 1) : -1
  const openFind = (replace: boolean) => {
    // 焦点在编辑区才拿选中的文字当搜索词（已经在查找框里打字时按 Ctrl+H 不能把输入换掉）
    const a = area.current
    const picked = a && document.activeElement === a && a.selectionEnd > a.selectionStart && !a.value.slice(a.selectionStart, a.selectionEnd).includes('\n') ? a.value.slice(a.selectionStart, a.selectionEnd) : undefined
    setFind((f) => ({ q: picked ?? f?.q ?? '', rep: f?.rep ?? '', cs: f?.cs ?? false, ww: f?.ww ?? false, replace }))
    setGotoLine(null)
    setTimeout(() => { findRef.current?.focus(); findRef.current?.select() }, 0)
  }
  // 滚到某个位置（自动换行时按那一行的实际位置算）
  const scrollToPos = (pos: number) => {
    const a = area.current
    if (!a) return
    const { line } = lineCol(a.value, pos)
    const row = markPre.current?.children[line - 1] as HTMLElement | undefined
    const top = row ? row.offsetTop : (line - 1) * 18 + 8
    if (top < a.scrollTop || top > a.scrollTop + a.clientHeight - 36) a.scrollTop = Math.max(0, top - a.clientHeight / 2)
  }
  const goMatch = (dir: 1 | -1, from = cursor.pos) => {
    if (!matches.length) return
    let i = dir > 0 ? matches.findIndex((m) => m.start >= from + (curIdx >= 0 && matches[curIdx].start === from ? 1 : 0)) : -1
    if (dir < 0) { for (let k = matches.length - 1; k >= 0; k--) if (matches[k].start < from) { i = k; break } }
    if (i < 0) i = dir > 0 ? 0 : matches.length - 1
    setCur(i)
    const m = matches[i]
    area.current?.setSelectionRange(m.start, m.end)
    setCursor({ pos: m.start, selLen: m.end - m.start })
    scrollToPos(m.start)
  }
  const replaceOne = () => {
    if (!find || curIdx < 0) return
    const m = matches[curIdx]
    apply({ text: text.slice(0, m.start) + find.rep + text.slice(m.end), sel: { start: m.start + find.rep.length, end: m.start + find.rep.length } })
    setTimeout(() => findRef.current?.focus(), 0)
  }
  const replaceEvery = () => {
    if (!find || !matches.length) return
    const n = matches.length
    apply({ text: replaceAll(text, matches, find.rep), sel: { start: 0, end: 0 } })
    setNote(tr('已替换 {n} 处（Ctrl+Z 可撤销）', { n }))
    setTimeout(() => findRef.current?.focus(), 0)
  }
  const doGoto = (v: string) => {
    const n = Math.max(1, Math.min(text.split('\n').length, parseInt(v, 10) || 1))
    const p = lineStart(text, n)
    setGotoLine(null)
    const a = area.current
    if (!a) return
    a.focus(); a.setSelectionRange(p, p); updateCursor(); scrollToPos(p)
  }

  // ── 检查：可疑字符、行尾空白、缩进混用 ──
  const big = text.length > HIGHLIGHT_MAX
  const suspects = useMemo(() => findSuspects(text), [text])
  const trails = useMemo(() => trailingSpaces(text), [text])
  const mixedIndent = ind.tabs > 0 && ind.spaces > 0
  const nextSuspect = () => {
    if (!suspects.length) return
    const s = suspects.find((x) => x.at > cursor.pos) ?? suspects[0]
    const a = area.current
    if (!a) return
    a.focus(); a.setSelectionRange(s.at, s.at + 1); updateCursor(); scrollToPos(s.at)
    setNote(tr('第 {line} 行：{kind}（{code}）', { line: lineCol(text, s.at).line, kind: tr(SUSPECT_LABEL[s.kind]), code: s.code }))
  }
  const nextMixed = () => {
    const lines = ind.tabs <= ind.spaces ? ind.tabLines : ind.spaceLines
    const curLine = lc.line - 1
    const l = lines.find((x) => x > curLine) ?? lines[0]
    if (l === undefined) return
    const p = lineStart(text, l + 1)
    const a = area.current
    if (!a) return
    a.focus(); a.setSelectionRange(p, p); updateCursor(); scrollToPos(p)
  }
  const clean = () => {
    const n = suspects.length + trails.length
    const next = cleanText(text)
    if (next === text) return
    apply({ text: next, sel: { start: 0, end: 0 } })
    setNote(tr('已清理 {n} 处（保存前可在改动对比里核对，Ctrl+Z 可撤销）', { n }))
  }

  // ── 装饰层：空白符号、行尾空白、可疑字符、查找结果 ──
  const marks = useMemo(() => {
    if (big) return undefined
    const d = new Uint8Array(text.length)
    const put = (from: number, to: number, v: number) => { for (let i = from; i < to; i++) if (d[i] < v) d[i] = v }
    if (showWs) {
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 32) d[i] = D.Space; else if (c === 9) d[i] = D.Tab }
      for (const r of trails) for (let i = r.start; i < r.end; i++) d[i] = text.charCodeAt(i) === 9 ? D.TrailTab : D.TrailSp
    }
    if (showInv) for (const s of suspects) put(s.at, s.at + 1, s.kind === 'zw' || s.kind === 'bom' ? D.Zw : D.Bad)
    for (const [i, m] of matches.entries()) put(m.start, m.end, i === curIdx ? D.Cur : D.Match)
    const lines: React.ReactNode[] = []
    let pos = 0
    for (const [li, line] of text.split('\n').entries()) {
      const parts: React.ReactNode[] = []
      let i = 0
      while (i < line.length) {
        const v = d[pos + i]
        let j = i + 1
        // Tab 每个单独一段（箭头画在每个 Tab 开头）；其余同档连续合并
        if (v !== D.Tab && v !== D.TrailTab) while (j < line.length && d[pos + j] === v) j++
        parts.push(v ? <span key={i} className={DECO_CLS[v]}>{line.slice(i, j)}</span> : line.slice(i, j))
        i = j
      }
      lines.push(<div key={li}>{parts.length ? parts : '\n'}</div>)
      pos += line.length + 1
    }
    return lines
  }, [text, big, showWs, showInv, suspects, trails, matches, curIdx])

  // 捕获阶段拦 Ctrl+S / Ctrl+F / Ctrl+H / Ctrl+G / F3 / Esc：抢在抽屉的 Esc 关闭（window 冒泡监听）和终端之前
  const keys = useRef({ requestSave, requestClose, diff, askClose, openFind, find, gotoLine, goMatch, syntaxWarn })
  keys.current = { requestSave, requestClose, diff, askClose, openFind, find, gotoLine, goMatch, syntaxWarn }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      const mod = e.ctrlKey || e.metaKey
      const stop = () => { e.preventDefault(); e.stopPropagation() }
      if (mod && e.key.toLowerCase() === 's') { stop(); k.requestSave() }
      else if (mod && !e.shiftKey && e.code === 'KeyF') { stop(); k.openFind(false) }
      else if (mod && !e.shiftKey && e.code === 'KeyH') { stop(); k.openFind(true) }
      else if (mod && !e.shiftKey && e.code === 'KeyG') { stop(); setFind(null); setGotoLine('') }
      else if (e.key === 'F3') { stop(); k.goMatch(e.shiftKey ? -1 : 1) }
      else if (e.key === 'Escape') {
        stop()
        if (k.diff !== undefined) setDiff(undefined)
        else if (k.askClose) setAskClose(false)
        else if (k.syntaxWarn) setSyntaxWarn(undefined)
        else if (k.find || k.gotoLine !== null) { setFind(null); setGotoLine(null); area.current?.focus() }
        else k.requestClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const lines = text.split('\n').length
  // 语法高亮（认得出的文件类型、不太大时）
  const tokens = useMemo(() => (lang === 'plain' || big ? undefined : highlightText(text, lang)), [text, lang, big])
  const highlighted = !!tokens
  // 自动换行：两层装饰的宽度要和 textarea 的内容宽度一致（textarea 有滚动条），行号高度跟着每行实际高度走
  const [areaW, setAreaW] = useState<number>()
  const [rowH, setRowH] = useState<number[]>()
  useLayoutEffect(() => {
    const a = area.current
    if (!a) return
    const ro = new ResizeObserver(() => setAreaW(a.clientWidth))
    ro.observe(a)
    return () => ro.disconnect()
  }, [base])
  useLayoutEffect(() => {
    if (!wrap || !markPre.current) { setRowH(undefined); return }
    setRowH([...markPre.current.children].slice(0, lines).map((c) => (c as HTMLElement).offsetHeight))
  }, [wrap, marks, areaW, lines])
  // 内容变了（打字 / 粘贴）后装饰层可能比 textarea 晚一帧排版：再对齐一次滚动
  const syncScroll = () => {
    const a = area.current
    if (!a) return
    if (gutter.current) gutter.current.scrollTop = a.scrollTop
    for (const p of [hlPre.current, markPre.current]) if (p) { p.scrollTop = a.scrollTop; p.scrollLeft = a.scrollLeft }
  }
  useLayoutEffect(syncScroll, [tokens, marks])
  const layer = `pointer-events-none absolute left-0 top-0 m-0 h-full overflow-hidden px-2 py-2 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`
  const layerStyle = wrap && areaW ? { width: areaW } : { right: 0 }
  const btn = 'rounded-md px-3 py-1 text-[12px] transition-colors disabled:opacity-50'
  const tool = (on: boolean) => `flex h-6 w-6 items-center justify-center rounded ${on ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`
  const findIn = 'h-6 min-w-0 flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'
  const stat = 'shrink-0 rounded px-1.5 hover:bg-[var(--color-bg-hover)]'
  return createPortal((
    <div data-file-editor className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 backdrop-blur-sm" onKeyDown={(e) => e.stopPropagation()}>
      <div className="relative flex h-[85vh] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-text-primary)]" title={path}>{dirty ? '● ' : ''}{path}</span>
          {sudo && <span title={tr('以 root 身份读写（sudo）')} className="shrink-0 rounded bg-[var(--color-danger)] px-1.5 text-[10px] font-semibold leading-[18px] text-[var(--color-on-danger)]">sudo</span>}
          {saved && !dirty && <span className="shrink-0 text-[11px] text-[var(--color-success)]">{tr('已保存（原文件已备份，可在执行记录里还原）')}</span>}
          {base !== undefined && (
            <>
              <button data-ed-find title={tr('查找 / 替换（Ctrl+F / Ctrl+H）\n跳到行：Ctrl+G')} onClick={() => openFind(false)} className={tool(!!find)}><Search className="h-3.5 w-3.5" /></button>
              <button data-ed-ws title={tr('显示空白字符\n空格显示为 ·、Tab 显示为 →，行尾多余的空白标红')} onClick={() => flip(LS.ws, setShowWs)} className={tool(showWs)}><Pilcrow className="h-3.5 w-3.5" /></button>
              <button data-ed-inv title={tr('检查不可见 / 可疑字符\nBOM、零宽字符、不换行空格、全角空格、控制字符标红；部署配置里常因为这些出问题')} onClick={() => flip(LS.inv, setShowInv)} className={tool(showInv)}><ScanEye className="h-3.5 w-3.5" /></button>
              <button data-ed-wrap disabled={big} title={big ? tr('文件太大，不支持自动换行') : tr('自动换行')} onClick={() => flip(LS.wrap, setWrap)} className={`${tool(wrap)} disabled:opacity-30`}><WrapText className="h-3.5 w-3.5" /></button>
              {(suspects.length > 0 || trails.length > 0) && <button data-ed-clean title={tr('一键清理\n去掉 BOM / 零宽 / 控制字符，不换行空格和全角空格换成普通空格，去掉行尾空白（Ctrl+Z 可撤销）')} onClick={clean} className={tool(false)}><Eraser className="h-3.5 w-3.5" /></button>}
            </>
          )}
          {kind && base !== undefined && (
            <button data-explain-toggle onClick={() => { setExplain((v) => !v); setHl(undefined) }} title={tr('AI 逐段解释这个配置文件并提示风险（按内容缓存）')}
              className={`${btn} ml-1 flex items-center gap-1 border ${explain ? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}><Sparkles className="h-3.5 w-3.5" />{tr('解释')}</button>
          )}
          <button onClick={() => requestSave()} disabled={!dirty || busy} title={tr('保存（Ctrl+S）')}
            className={`${btn} flex items-center gap-1 border border-transparent bg-[var(--color-accent)] text-[var(--color-bg-base)] hover:opacity-90`}><Save className="h-3.5 w-3.5" />{tr('保存')}</button>
          <button onClick={requestClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
        </div>
        {find && (
          <div data-ed-findbar className="shrink-0 space-y-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
            <div className="flex items-center gap-1">
              <button title={find.replace ? tr('收起替换') : tr('展开替换（Ctrl+H）')} onClick={() => setFind({ ...find, replace: !find.replace })} className={tool(find.replace)}><Replace className="h-3.5 w-3.5" /></button>
              <input ref={findRef} data-ed-q value={find.q} spellCheck={false} placeholder={tr('查找')} onChange={(e) => { setFind({ ...find, q: e.target.value }); setCur(0) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goMatch(e.shiftKey ? -1 : 1) } }} className={findIn} />
              <span data-ed-count className="w-16 shrink-0 text-center text-[11px] text-[var(--color-text-muted)]">{find.q ? (matches.length ? `${curIdx + 1} / ${matches.length}` : tr('没有结果')) : ''}</span>
              <button title={tr('区分大小写')} onClick={() => setFind({ ...find, cs: !find.cs })} className={tool(find.cs)}><CaseSensitive className="h-3.5 w-3.5" /></button>
              <button title={tr('全字匹配')} onClick={() => setFind({ ...find, ww: !find.ww })} className={tool(find.ww)}><WholeWord className="h-3.5 w-3.5" /></button>
              <button title={tr('上一个（Shift+Enter）')} onClick={() => goMatch(-1)} className={tool(false)}><ChevronUp className="h-3.5 w-3.5" /></button>
              <button title={tr('下一个（Enter / F3）')} onClick={() => goMatch(1)} className={tool(false)}><ChevronDown className="h-3.5 w-3.5" /></button>
              <button title={tr('关闭（Esc）')} onClick={() => { setFind(null); area.current?.focus() }} className={tool(false)}><X className="h-3.5 w-3.5" /></button>
            </div>
            {find.replace && (
              <div className="flex items-center gap-1 pl-7">
                <input data-ed-rep value={find.rep} spellCheck={false} placeholder={tr('替换为')} onChange={(e) => setFind({ ...find, rep: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne() } }} className={findIn} />
                <button data-ed-rep1 title={tr('替换当前（Enter）')} disabled={curIdx < 0} onClick={replaceOne} className={`${tool(false)} disabled:opacity-30`}><Replace className="h-3.5 w-3.5" /></button>
                <button data-ed-repall title={tr('全部替换')} disabled={!matches.length} onClick={replaceEvery} className={`${tool(false)} disabled:opacity-30`}><ReplaceAll className="h-3.5 w-3.5" /></button>
                <span className="w-[76px] shrink-0" />
              </div>
            )}
          </div>
        )}
        {gotoLine !== null && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)]">
            {tr('跳到行')}
            <input data-ed-goto autoFocus value={gotoLine} onChange={(e) => setGotoLine(e.target.value.replace(/\D/g, ''))} placeholder={`1–${lines}`}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doGoto(gotoLine) } }} className="h-6 w-24 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('共 {n} 行，回车跳转，Esc 取消', { n: lines })}</span>
          </div>
        )}
        {syntaxWarn && (
          <div data-ed-syntax className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-warn)]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{tr('第 {line} 行：{msg}', { line: syntaxWarn.line, msg: syntaxWarn.message })}</span>
            <button onClick={() => { doGoto(String(syntaxWarn.line)) }} className="shrink-0 rounded border border-[var(--color-warn)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)]">{tr('跳到这一行')}</button>
            <button data-ed-saveanyway onClick={() => requestSave(true)} className="shrink-0 rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('仍然保存')}</button>
          </div>
        )}
        {err && (
          <div data-editor-err className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-danger)]">
            <span className="min-w-0 flex-1">{err}</span>
            {deniedMsg(err) && <button data-sudo-save onClick={() => { setErr(undefined); setSudoSave(true); onSudo!() }} className="shrink-0 rounded border border-[var(--color-danger)] px-2 py-0.5 text-[11px] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)]">{tr('用 sudo 保存')}</button>}
          </div>
        )}
        {loadErr ? (
          <div data-editor-loaderr className="p-4 text-[12.5px] text-[var(--color-danger)]">{tr('无法打开：{err}', { err: loadErr })}
            {deniedMsg(loadErr) && <button data-sudo-open onClick={onSudo} className="ml-3 rounded border border-[var(--color-danger)] px-2 py-0.5 text-[11px] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)]">{tr('用 sudo 打开')}</button>}</div>
        ) : base === undefined ? (
          <div className="p-4 text-[12px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>
        ) : (
          <div className="flex min-h-0 flex-1 bg-[var(--color-bg-base)] font-mono text-[12px] leading-[18px]">
            <div ref={gutter} className="shrink-0 select-none overflow-hidden border-r border-[var(--color-border-subtle)] py-2 text-right text-[color:color-mix(in_srgb,var(--color-text-muted)_70%,transparent)]">
              {Array.from({ length: lines }, (_, i) => {
                const on = !!hl && i + 1 >= hl.start && i + 1 <= hl.end
                return <div key={i} data-line={i + 1} style={rowH?.[i] ? { height: rowH[i] } : undefined} onClick={explain ? () => { setGutterLine(i + 1); setHl({ start: i + 1, end: i + 1 }) } : undefined}
                  className={`px-2 ${on || i + 1 === lc.line ? (on ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]') : ''} ${explain ? 'cursor-pointer hover:text-[var(--color-accent)]' : ''}`}>{i + 1}</div>
              })}
              <div className="h-4" />
            </div>
            {/* 最下：装饰层（字透明）；中：高亮层；最上：textarea（有高亮时字透明）。光标、选区、输入法、撤销都是原生的；三者滚动同步 */}
            <div className="relative min-w-0 flex-1">
              {marks && (
                <pre ref={markPre} aria-hidden data-ed-marks className={`${layer} text-transparent`} style={layerStyle}>
                  {marks}
                  <div className="h-4" />
                </pre>
              )}
              {highlighted && (
                <pre ref={hlPre} aria-hidden data-syntax={lang} className={`${layer} text-[var(--color-text-primary)]`} style={layerStyle}>
                  {tokens!.map((line, i) => <div key={i}>{line.length ? line.map((t, j) => (t.kind ? <span key={j} className={TOK_CLS[t.kind]}>{t.text}</span> : t.text)) : '\n'}</div>)}
                  <div className="h-4" />
                </pre>
              )}
              <textarea ref={area} value={text} autoFocus spellCheck={false} wrap={wrap && !big ? 'soft' : 'off'}
                onChange={(e) => { setText(e.target.value); setSaved(false); setErr(undefined); setSyntaxWarn(undefined) }}
                onKeyDown={onAreaKey} onSelect={updateCursor} onKeyUp={updateCursor} onClick={updateCursor}
                onScroll={syncScroll}
                className={`absolute inset-0 h-full w-full resize-none bg-transparent px-2 py-2 outline-none selection:bg-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] ${wrap && !big ? 'overflow-x-hidden whitespace-pre-wrap break-words' : 'whitespace-pre'} ${highlighted ? 'text-transparent caret-[var(--color-text-primary)]' : 'text-[var(--color-text-primary)]'}`} />
            </div>
            {explain && kind && <ConfigExplainPanel path={path} kind={kind} text={text} activeLine={gutterLine} onPick={pick} onClose={() => { setExplain(false); setHl(undefined) }} />}
          </div>
        )}
        {base !== undefined && (
          <div data-ed-status className="flex h-6 shrink-0 items-center gap-1 border-t border-[var(--color-border-subtle)] px-2 text-[11px] text-[var(--color-text-muted)]">
            <button title={tr('跳到行（Ctrl+G）')} onClick={() => { setFind(null); setGotoLine('') }} className={stat}>{tr('行 {line}，列 {col}', { line: lc.line, col: lc.col })}{cursor.selLen ? tr('（选中 {n} 字）', { n: cursor.selLen }) : ''}</button>
            {note && <span data-ed-note className="min-w-0 truncate px-1 text-[var(--color-accent)]">{note}</span>}
            <span className="ml-auto" />
            {suspects.length > 0 && <button data-ed-suspects title={`${[...new Set(suspects.map((s) => tr(SUSPECT_LABEL[s.kind])))].join(tr('、'))}\n${tr('点击跳到下一处')}`} onClick={nextSuspect} className={`${stat} text-[var(--color-danger)]`}>{tr('可疑字符 {n}', { n: suspects.length })}</button>}
            {trails.length > 0 && <span title={tr('行尾有多余的空格 / Tab（打开「显示空白字符」可以看到）')} className="shrink-0 px-1.5 text-[var(--color-warn)]">{tr('行尾空白 {n}', { n: trails.length })}</span>}
            {mixedIndent && <button data-ed-mixed title={tr('有 {tabs} 行用 Tab 缩进、{spaces} 行用空格缩进（YAML 不允许 Tab）\n点击跳到少数那种的下一行', { tabs: ind.tabs, spaces: ind.spaces })} onClick={nextMixed} className={`${stat} text-[var(--color-warn)]`}>{tr('缩进混用')}</button>}
            {eol0 && eol0.crlf > 0 && eol0.lf > 0 && <span title={tr('原文件 {crlf} 行 CRLF、{lf} 行 LF；保存时统一成右边选的', { crlf: eol0.crlf, lf: eol0.lf })} className="shrink-0 px-1.5 text-[var(--color-warn)]">{tr('换行符混用')}</span>}
            {text.startsWith('\uFEFF') && <span title={tr('文件开头有 BOM（有些程序读配置会出错，可一键清理）')} className="shrink-0 px-1.5 text-[var(--color-danger)]">BOM</span>}
            <button data-ed-indent title={`${tr('按 Tab 键插入什么')}${yamlNoTab ? `\n${tr('YAML 不允许 Tab 缩进，这个文件按 Tab 键插入空格')}` : ''}\n${tr('点击切换：Tab → 空格 2 → 空格 4（会记住）')}`} onClick={nextUnit} className={stat}>{unit === '\t' ? 'Tab' : tr('空格 {n}', { n: unit.length })}{yamlNoTab ? tr('（YAML）') : ''}</button>
            <button data-ed-eol title={tr('换行符：点击切换（保存时按这里写）')} onClick={() => setEol((v) => (v === 'lf' ? 'crlf' : 'lf'))} className={stat}>{eol === 'crlf' ? 'CRLF' : 'LF'}</button>
            <span className="shrink-0 px-1.5">{LANG_LABEL[lang] ? tr(LANG_LABEL[lang]) : lang}</span>
          </div>
        )}

        {diff !== undefined && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
            <div className="w-[min(900px,88vw)] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-4 shadow-2xl">
              <div className="mb-2 text-[14px] font-semibold text-[var(--color-text-primary)]">{tr('确认保存改动')}</div>
              <p className="mb-2 text-[12px] text-[var(--color-text-secondary)]">{tr('保存前会先备份原文件，之后可在「执行记录」里还原。')}</p>
              <DiffView diff={diff} maxHeight="max-h-[55vh]" />
              <div className="mt-3 flex justify-end gap-2">
                <button onClick={() => setDiff(undefined)} className={`${btn} border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>{tr('取消')}</button>
                <button onClick={confirmSave} disabled={busy} autoFocus className={`${btn} border border-transparent bg-[var(--color-accent)] font-medium text-[var(--color-bg-base)] hover:opacity-90`}>{busy ? tr('保存中…') : tr('保存')}</button>
              </div>
            </div>
          </div>
        )}
        {askClose && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
            <div className="w-[340px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
              <div className="mb-2 text-[14px] font-semibold text-[var(--color-text-primary)]">{tr('放弃未保存的改动？')}</div>
              <p className="mb-4 text-[12.5px] text-[var(--color-text-secondary)]">{tr('关闭后本次编辑的内容会丢失。')}</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setAskClose(false)} autoFocus className={`${btn} border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>{tr('继续编辑')}</button>
                <button onClick={onClose} className={`${btn} border border-transparent bg-[var(--color-danger)] font-medium text-[var(--color-on-danger)] hover:opacity-90`}>{tr('放弃并关闭')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  ), document.body)

  function pick(x: ExplainItem) {
    setHl({ start: x.start, end: x.end })
    const ta = area.current
    if (!ta) return
    const ls = ta.value.split('\n')
    const from = ls.slice(0, x.start - 1).reduce((n, l) => n + l.length + 1, 0)
    const to = ls.slice(0, x.end).reduce((n, l) => n + l.length + 1, 0) - 1
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(from, Math.max(from, to))
    scrollToPos(from)
  }
}
