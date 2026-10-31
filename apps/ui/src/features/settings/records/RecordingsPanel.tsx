import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Play, Pause, FolderOpen, RefreshCw, X, AlertTriangle, Trash2, Sparkles, Loader2 } from 'lucide-react'
import { ConfirmDialog } from '../../common/index.js'
import { parseCast, limitIdle, parseSize, mapChapterTime, nlErrorText, tk, tr, type CastEvent, type RecordingChapter, type RecordingInfo } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { getTermPrefs, themeOf } from '../../../lib/termPrefs.js'
import { Page, BTN2, Toolbar, EmptyState } from '../ui.js'

const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const BTN = 'flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
const TIP = tk('在「设置 → 终端 → 记录 →『允许终端录屏』」打开后，点终端标签栏的 ● 开始录制当前终端、■ 停止。录下屏幕输出和键入内容（asciicast 格式，可用 asciinema 播放），键入内容包括在 sudo / ssh 等提示下输入的密码，请妥善保管录像文件。录像不会进入诊断包；「录像保留天数」也在「设置 → 终端 → 记录」里改。')

// 「终端录像」：列出 ~/.lingshell/recordings 下的录像，可回放 / 在文件夹中定位。开关与保留天数在「设置 → 终端 → 记录」
export function RecordingsPanel() {
  const [list, setList] = useState<RecordingInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState<RecordingInfo | null>(null)
  const [deleting, setDeleting] = useState<RecordingInfo | null>(null)
  const load = () => client.recordings.list().then((l) => { setList(l); setErr(null) }).catch((e) => setErr(String(e?.message ?? e)))
  useEffect(() => { load() }, [])
  // AI 摘要：生成完直接打开回放（侧边是章节）
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const summarize = async (r: RecordingInfo) => {
    setBusy((s) => new Set(s).add(r.id)); setErr(null)
    try { await client.aiLink.summarizeRecording(r.id); setPlaying(r) }
    catch (e) { setErr(tr('AI 摘要失败：{msg}', { msg: tr(nlErrorText(String((e as Error)?.message ?? e))) })) }
    finally { setBusy((s) => { const n = new Set(s); n.delete(r.id); return n }) }
  }

  return (
    <Page>
      <Toolbar hint={list ? tr('共 {n} 个录像', { n: list.length }) : tr('加载中…')} tip={tr(TIP)}>
        <button onClick={load} className={`flex items-center gap-1 ${BTN2}`}><RefreshCw className="h-3.5 w-3.5" />{tr('刷新')}</button>
        <button onClick={() => client.recordings.openFolder().catch(() => {})} className={`flex items-center gap-1 ${BTN2}`}><FolderOpen className="h-3.5 w-3.5" />{tr('打开录像目录')}</button>
      </Toolbar>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-danger)]"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('录像含键入内容（可能有密码），请妥善保管')}</div>
      {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
      {list && list.length === 0 && <EmptyState text={tr('还没有录像')} action={<span className="text-[11px]">{tr('先在「设置 → 终端 → 记录 →『允许终端录屏』」打开，再点终端标签栏的 ● 开始')}</span>} />}
      {list && list.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3.5 py-1.5">
        <table className="w-full text-[12px]">
          <thead><tr className="text-left text-[11px] text-[var(--color-text-muted)]">
            <th className="py-1 font-normal">{tr('时间')}</th><th className="font-normal">{tr('终端')}</th><th className="font-normal">{tr('大小')}</th><th className="font-normal">{tr('时长')}</th><th />
          </tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="border-t border-[var(--color-border-subtle)] text-[var(--color-text-primary)]">
                <td className="whitespace-nowrap py-1.5 pr-2">{r.date} {new Date(r.startedAt).toLocaleTimeString()}</td>
                <td className="max-w-[160px] truncate pr-2" title={r.title}>
                  {r.active && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-danger)] align-middle" title={tr('录制中')} />}{r.title}
                </td>
                <td className="whitespace-nowrap pr-2 text-[var(--color-text-secondary)]">{fmtSize(r.size)}</td>
                <td className="whitespace-nowrap pr-2 text-[var(--color-text-secondary)]">{fmtDur(r.durationSec)}</td>
                <td className="whitespace-nowrap text-right">
                  <span className="inline-flex gap-1">
                    <button onClick={() => setPlaying(r)} className={BTN}><Play className="h-3 w-3" />{tr('回放')}</button>
                    <button data-rec-summary onClick={() => void summarize(r)} disabled={r.active || busy.has(r.id)} className={`${BTN} disabled:opacity-40`}
                      title={r.active ? tr('正在录制，先停止') : tr('把录像按命令切分，发给当前模型整理成「时间点 + 这段做了什么」的章节，存在录像旁；回放时侧边显示章节，点击跳转。输出按「发给 AI 前脱敏」处理，不发键入内容')}>
                      {busy.has(r.id) ? <Loader2 className="h-3 w-3 animate-spin-slow" /> : <Sparkles className="h-3 w-3" />}{tr('AI 摘要')}
                    </button>
                    <button onClick={() => client.recordings.openFolder(r.id).catch(() => {})} className={BTN} title={tr('打开所在文件夹')}><FolderOpen className="h-3 w-3" /></button>
                    <button onClick={() => setDeleting(r)} disabled={r.active} className={`${BTN} hover:!border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)] hover:text-[var(--color-danger)] disabled:opacity-30`} title={r.active ? tr('正在录制，先停止') : tr('删除')}><Trash2 className="h-3 w-3" /></button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {playing && <CastPlayer rec={playing} onClose={() => setPlaying(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title={tr('删除录像')}
        message={deleting ? tr('删除 {date} {time} 「{title}」的录像？删除后无法恢复。', { date: deleting.date, time: new Date(deleting.startedAt).toLocaleTimeString(), title: deleting.title }) : ''}
        confirmText={tr('删除')}
        onConfirm={() => {
          const r = deleting; setDeleting(null)
          if (r) client.recordings.delete(r.id).then(load).catch((e) => setErr(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
        }}
        onCancel={() => setDeleting(null)}
      />
    </Page>
  )
}

// 简易回放：把 o 事件按时间灌进只读 xterm，r 事件改尺寸；i 事件（键入）不显示（回显已在输出里）。
// 空闲超过 2 秒的压成 2 秒；拖进度 = 重置后瞬间重放到目标时间
function CastPlayer({ rec, onClose }: { rec: RecordingInfo; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)

  // 铺满播放区：行列数必须保持录制时的（vim/top 等按尺寸定位，改了会乱），所以改字号而不是 fit 行列。
  // xterm 单元格随字号近似线性缩放：按当前渲染尺寸等比换算，跑两遍收敛
  const fitFont = () => {
    const t = term.current, a = area.current
    if (!t?.element || !a) return
    for (let i = 0; i < 2; i++) {
      const w = t.element.offsetWidth, h = t.element.offsetHeight
      if (!w || !h) return
      const cur = t.options.fontSize ?? 12
      const ratio = Math.min((a.clientWidth - 16) / w, (a.clientHeight - 16) / h)
      const next = Math.max(6, Math.min(28, Math.floor(cur * ratio * 10) / 10))
      if (Math.abs(next - cur) < 0.1) return
      t.options.fontSize = next
    }
  }
  const refit = () => requestAnimationFrame(fitFont)
  const st = useRef<{ events: CastEvent[]; orig: CastEvent[]; size: [number, number]; idx: number; clock: number }>({ events: [], orig: [], size: [80, 24], idx: 0, clock: 0 })
  // AI 摘要章节（录像旁 .summary.json）；t 是录像原始时间，点击时换算成空闲压缩后的回放时间
  const [chapters, setChapters] = useState<RecordingChapter[] | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genErr, setGenErr] = useState<string | null>(null)
  useEffect(() => { client.aiLink.recordingSummary(rec.id).then((s) => setChapters(s?.chapters ?? null)).catch(() => setChapters(null)) }, [rec.id])
  const generate = () => {
    setGenBusy(true); setGenErr(null)
    client.aiLink.summarizeRecording(rec.id).then((s) => setChapters(s.chapters), (e) => setGenErr(tr(nlErrorText(String((e as Error)?.message ?? e))))).finally(() => setGenBusy(false))
  }
  const playAt = (t: number) => mapChapterTime(st.current.orig, st.current.events, t)
  useEffect(() => {   // Esc 关闭回放（捕获阶段，抢在设置弹窗之前）
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const [total, setTotal] = useState(0)
  const [pos, setPos] = useState(0)
  const [run, setRun] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [err, setErr] = useState<string | null>(null)

  // 播到 clock：把 idx 之后、时间 ≤ clock 的事件依次应用
  const flush = () => {
    const s = st.current, t = term.current
    if (!t) return
    while (s.idx < s.events.length && s.events[s.idx][0] <= s.clock) {
      const [, code, data] = s.events[s.idx++]
      if (code === 'o') t.write(data)
      else if (code === 'r') { const sz = parseSize(data); if (sz) { t.resize(sz[0], sz[1]); refit() } }
    }
  }
  const seek = (sec: number) => {
    const s = st.current, t = term.current
    if (!t) return
    t.reset(); t.resize(s.size[0], s.size[1]); refit()
    s.idx = 0; s.clock = sec; flush(); setPos(sec)
  }

  useEffect(() => {
    if (!box.current) return
    const p = getTermPrefs()
    const t = new Terminal({ disableStdin: true, cursorBlink: false, fontSize: 12, theme: themeOf(p.theme), fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace', scrollback: 5000 })
    t.open(box.current); term.current = t
    let alive = true
    client.recordings.read(rec.id).then((text) => {
      if (!alive) return
      const { header, events } = parseCast(text)
      const evs = limitIdle(events)
      st.current = { events: evs, orig: events, size: [header.width, header.height], idx: 0, clock: 0 }
      t.resize(header.width, header.height); refit()
      setTotal(evs.at(-1)?.[0] ?? 0); setRun(true)
    }).catch((e) => setErr(String(e?.message ?? e)))
    const ro = new ResizeObserver(refit)
    if (area.current) ro.observe(area.current)
    return () => { alive = false; ro.disconnect(); t.dispose(); term.current = null }
  }, [rec.id])

  useEffect(() => {
    if (!run) return
    const TICK = 50
    const h = setInterval(() => {
      const s = st.current
      s.clock += (TICK / 1000) * speed
      flush(); setPos(Math.min(s.clock, total))
      if (s.idx >= s.events.length) setRun(false)
    }, TICK)
    return () => clearInterval(h)
  }, [run, speed, total])

  const toggle = () => {
    if (!run && st.current.idx >= st.current.events.length) seek(0)   // 播完再点 = 从头来
    setRun((r) => !r)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="flex h-[85vh] w-[90vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 text-[12px]">
          <span className="truncate font-semibold text-[var(--color-text-primary)]">{tr('回放：{title}', { title: rec.title })}</span>
          <span className="text-[var(--color-text-muted)]">{rec.date} {new Date(rec.startedAt).toLocaleTimeString()}</span>
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        {err && <div className="px-3 py-2 text-[12px] text-[var(--color-danger)]">{tr('读取失败：{err}', { err })}</div>}
        <div className="flex min-h-0 flex-1">
          <div ref={area} className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-2" style={{ background: themeOf(getTermPrefs().theme).background }}><div ref={box} className="inline-block" /></div>
          {/* 章节侧栏：AI 摘要（没有时给「生成」按钮） */}
          <div data-rec-chapters className="flex w-60 shrink-0 flex-col border-l border-[var(--color-border-subtle)] text-[12px]">
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5 font-semibold text-[var(--color-text-primary)]">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('章节')}
              {chapters && <button onClick={generate} disabled={genBusy} title={tr('重新生成 AI 摘要')} className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">{genBusy ? <Loader2 className="h-3 w-3 animate-spin-slow" /> : <RefreshCw className="h-3 w-3" />}</button>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {chapters?.map((c, i) => {
                const at = playAt(c.t), next = chapters[i + 1], cur = pos >= at - 0.05 && (!next || pos < playAt(next.t) - 0.05)
                return (
                  <button key={i} data-chapter={i} onClick={() => seek(at)} title={tr('跳到这里')}
                    className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-[var(--color-bg-hover)] ${cur ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'}`}>
                    <span className="shrink-0 font-mono tabular-nums text-[var(--color-text-muted)]">{fmtDur(at)}</span>
                    <span className="min-w-0 break-words">{c.title}</span>
                  </button>
                )
              })}
              {!chapters && (
                <div className="px-2 py-2 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
                  {tr('还没有 AI 摘要。生成后按「时间点 + 这段做了什么」列出章节，点击跳转。')}
                  <button onClick={generate} disabled={genBusy} className={`${BTN} mt-2 disabled:opacity-40`}>{genBusy ? <Loader2 className="h-3 w-3 animate-spin-slow" /> : <Sparkles className="h-3 w-3" />}{genBusy ? tr('生成中…') : tr('生成 AI 摘要')}</button>
                </div>
              )}
              {genErr && <div className="px-2 py-1 text-[11px] text-[var(--color-danger)]">{genErr}</div>}
            </div>
          </div>
        </div>
        <div className="flex h-11 shrink-0 items-center gap-3 border-t border-[var(--color-border-subtle)] px-3 text-[12px]">
          <button onClick={toggle} title={run ? tr('暂停') : tr('播放')} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
            {run ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <input type="range" min={0} max={total || 0} step={0.1} value={pos} onChange={(e) => seek(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
          <span className="w-24 shrink-0 text-right tabular-nums text-[var(--color-text-secondary)]">{fmtDur(pos)} / {fmtDur(total)}</span>
          {[1, 2, 4].map((x) => (
            <button key={x} onClick={() => setSpeed(x)} className={`rounded px-1.5 py-0.5 ${speed === x ? 'bg-[var(--color-bg-raised)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>{x}x</button>
          ))}
        </div>
      </div>
    </div>
  )
}
