// 即时回放（同 iTerm2 Instant Replay）：TerminalPane 把每块输出记进内存环形缓冲（见 shared/terminal/replay.ts），
// 这里按终端 id 登记；回放视图 = 只读 xterm + 时间轴，拖到某时刻 = 从头重放到那一刻（含被 clear / top / vim 刷掉的画面）。
// 入口：快捷键 term.replay（默认 Ctrl+Alt+R，焦点在终端时）、右侧活动栏「即时回放」。Esc / ✕ 关闭（不点遮罩关）
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { Rewind, X, ChevronsLeft, ChevronsRight, StepBack, StepForward } from 'lucide-react'
import { chunksUpTo, tr, type ReplayBuffer, type ReplayChunk } from '@lingshell/shared'
import { ActBtn } from '../../../components/ActivityBar.js'
import { keyHint } from '../../../lib/keybindings.js'
import { fontFamilyOf, getTermPrefs, themeOf } from '../../../lib/termPrefs.js'

const bufs = new Map<string, { buf: ReplayBuffer; title: () => string }>()
let open: string | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

/** TerminalPane 挂载时登记本终端的回放缓冲，返回注销函数 */
export function registerReplay(id: string, buf: ReplayBuffer, title: () => string): () => void {
  bufs.set(id, { buf, title })
  return () => { if (bufs.get(id)?.buf === buf) bufs.delete(id); if (open === id) { open = null; emit() } }
}
export function openReplay(id: string) { open = id; emit() }
const closeReplay = () => { open = null; emit() }
const useOpen = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => open)

/** 右侧活动栏按钮 */
export function ReplayButton({ id }: { id: string }) {
  return <ActBtn title={tr('即时回放：回看本终端最近的输出{key}', { key: keyHint('term.replay') })} onClick={() => openReplay(id)}><Rewind className="h-4 w-4" /></ActBtn>
}

/** 挂在 TerminalView 里：有打开的回放就显示 */
export function ReplayHost() {
  const id = useOpen()
  const e = id ? bufs.get(id) : undefined
  if (!id || !e) return null
  return <ReplayDialog key={id} buf={e.buf} title={e.title()} onClose={closeReplay} />
}

const fmtClock = (t: number) => new Date(t).toLocaleTimeString()
const fmtAgo = (ms: number) => (ms < 1000 ? tr('刚刚') : ms < 60_000 ? tr('{n} 秒前', { n: Math.round(ms / 1000) }) : tr('{m} 分 {s} 秒前', { m: Math.floor(ms / 60_000), s: Math.round((ms % 60_000) / 1000) }))
const fmtMB = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function ReplayDialog({ buf, title, onClose }: { buf: ReplayBuffer; title: string; onClose: () => void }) {
  const [chunks] = useState<ReplayChunk[]>(() => buf.chunks())   // 打开那一刻的快照：之后的新输出不进本次回放
  const cap = buf.capacity
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const t0 = chunks[0]?.t ?? 0, tEnd = chunks.at(-1)?.t ?? 0
  const [pos, setPos] = useState(tEnd - t0)   // 相对 t0 的毫秒；打开时在最新
  const target = useRef(chunks.length)          // 要重放到第几块（不含）
  const pump = useRef<() => void>(() => {})
  const bytes = chunks.reduce((n, c) => n + c.data.length, 0)
  const [openedAt] = useState(Date.now)   //「N 秒前」按打开回放那一刻算

  useEffect(() => {
    if (!box.current) return
    const p = getTermPrefs()
    const first = chunks[0]
    const t = new Terminal({ disableStdin: true, cursorBlink: false, fontSize: p.fontSize, theme: themeOf(p.theme), fontFamily: fontFamilyOf(p.fontFamily), lineHeight: p.lineHeight, scrollback: 2000, cols: first?.cols ?? 80, rows: first?.rows ?? 24, allowProposedApi: true })
    t.open(box.current); term.current = t
    // 铺满播放区：行列必须保持当时的（vim / top 按尺寸定位），所以缩放字号而不是 fit 行列（同录像回放）
    const fitFont = () => {
      const a = area.current
      if (!t.element || !a) return
      for (let i = 0; i < 2; i++) {
        const w = t.element.offsetWidth, h = t.element.offsetHeight
        if (!w || !h) return
        const cur = t.options.fontSize ?? 12
        const next = Math.max(6, Math.min(p.fontSize, Math.floor(cur * Math.min((a.clientWidth - 16) / w, (a.clientHeight - 16) / h) * 10) / 10))
        if (Math.abs(next - cur) < 0.1) return
        t.options.fontSize = next
      }
    }
    // 重放泵：往前拖 = 接着写；往回拖 = 清屏从头写。一次最多写 512KB、等 xterm 解析完再写下一批，拖动时不卡也不乱序
    let applied = 0, busy = false
    pump.current = () => {
      if (busy || term.current !== t) return
      const want = target.current
      if (want < applied) { t.reset(); applied = 0 }
      if (applied >= want) return
      const c0 = chunks[applied]
      if (t.cols !== c0.cols || t.rows !== c0.rows) { t.resize(c0.cols, c0.rows); requestAnimationFrame(fitFont) }
      let data = ''
      while (applied < want && data.length < 512 * 1024 && chunks[applied].cols === c0.cols && chunks[applied].rows === c0.rows) data += chunks[applied++].data
      busy = true
      t.write(data, () => { busy = false; pump.current() })
    }
    pump.current()
    requestAnimationFrame(fitFont)
    const ro = new ResizeObserver(() => requestAnimationFrame(fitFont))
    if (area.current) ro.observe(area.current)
    return () => { ro.disconnect(); term.current = null; t.dispose() }
  }, [])

  const seek = (ms: number) => {
    const v = Math.max(0, Math.min(tEnd - t0, ms))
    setPos(v); target.current = chunksUpTo(chunks, t0 + v); pump.current()
  }
  // 上一块 / 下一块输出（时间轴上一格一格地看）
  const step = (dir: -1 | 1) => {
    const n = chunksUpTo(chunks, t0 + pos)   // 当前已显示 n 块，最后一块是 n-1
    const i = dir < 0 ? Math.max(0, n - 2) : Math.min(chunks.length - 1, n)
    if (chunks[i]) seek(chunks[i].t - t0)
  }
  const stepRef = useRef(step); stepRef.current = step
  const seekRef = useRef(seek); seekRef.current = seek

  // Esc 关；← / → 上一块 / 下一块；Home / End 最早 / 最新。捕获阶段截下，别漏给背后的终端
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      if (k === 'Escape') onClose()
      else if (k === 'ArrowLeft' || k === 'ArrowRight') stepRef.current(k === 'ArrowLeft' ? -1 : 1)
      else if (k === 'Home') seekRef.current(0)
      else if (k === 'End') seekRef.current(Number.MAX_SAFE_INTEGER)
      else return
      e.preventDefault(); e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const BTN = 'flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
  return (
    <div data-replay className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="flex h-[85vh] w-[90vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 text-[12px]">
          <Rewind className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="truncate font-semibold text-[var(--color-text-primary)]">{tr('即时回放：{title}', { title })}</span>
          <span className="text-[var(--color-text-muted)]">{chunks.length ? tr('已存 {used} / {cap} · 最早 {time}', { used: fmtMB(bytes), cap: fmtMB(cap), time: fmtClock(t0) }) : ''}</span>
          <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">{tr('← / → 上一步 / 下一步 · Esc 关闭')}</span>
          <button title={tr('关闭（Esc）')} onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div ref={area} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2" style={{ background: themeOf(getTermPrefs().theme).background as string }}>
          {!chunks.length && <div className="absolute text-[12px] text-[var(--color-text-muted)]">{cap ? tr('这个终端还没有可回放的输出') : tr('即时回放已关闭：在 设置 → 终端 →「即时回放缓冲」里设一个大于 0 的值')}</div>}
          <div ref={box} className="inline-block" />
        </div>
        <div className="flex h-11 shrink-0 items-center gap-2 border-t border-[var(--color-border-subtle)] px-3 text-[12px]">
          <button title={tr('最早（Home）')} disabled={!chunks.length} onClick={() => seek(0)} className={BTN}><ChevronsLeft className="h-4 w-4" /></button>
          <button title={tr('上一步（←）')} disabled={!chunks.length} onClick={() => step(-1)} className={BTN}><StepBack className="h-4 w-4" /></button>
          <input type="range" aria-label={tr('回放时间')} min={0} max={Math.max(0, tEnd - t0)} step={10} value={pos} disabled={chunks.length < 2}
            onChange={(e) => seek(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
          <button title={tr('下一步（→）')} disabled={!chunks.length} onClick={() => step(1)} className={BTN}><StepForward className="h-4 w-4" /></button>
          <button title={tr('最新（End）')} disabled={!chunks.length} onClick={() => seek(Number.MAX_SAFE_INTEGER)} className={BTN}><ChevronsRight className="h-4 w-4" /></button>
          <span data-replay-time className="w-40 shrink-0 text-right tabular-nums text-[var(--color-text-secondary)]">
            {chunks.length ? `${fmtClock(t0 + pos)} · ${fmtAgo(openedAt - t0 - pos)}` : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
