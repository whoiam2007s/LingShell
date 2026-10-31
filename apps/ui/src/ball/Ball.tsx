// 悬浮球（独立小窗，见 desktop/main/app/background.ts）：球身显示状态；悬停展开状态卡（窗口临时变大，球位置不动）；
// 拖动用 JS（-webkit-app-region: drag 会吞掉点击 / 右键）：按下后移动超过 4px 才算拖，否则是点击；右键弹原生菜单。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { tr, type BallView } from '@lingshell/shared'
import { Logo } from '../components/Logo'
import { cn } from '../lib/cn.js'

interface BallApi { onState(h: (v: BallView) => void): () => void; send(channel: string, ...args: unknown[]): void }
const api = (): BallApi | undefined => (window as unknown as { ballAPI?: BallApi }).ballAPI

const BALL = 52
const HOVER_DELAY_MS = 250

export function Ball() {
  const [v, setV] = useState<BallView | null>(null)
  const [hover, setHover] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  useEffect(() => {
    const a = api()
    if (!a) return
    const off = a.onState((s) => {
      const el = document.documentElement
      el.dataset.theme = s.theme; el.dataset.kind = s.kind
      setV(s)
    })
    a.send('ball:ready')
    return off
  }, [])

  // 悬停：先在窗口外量出卡片高度，交给主进程放大窗口（主进程回推 expanded / 展开方向）。内容变了再量一次
  const content = v ? JSON.stringify({ ...v, expanded: 0, side: 0, valign: 0 }) : ''
  useLayoutEffect(() => {
    if (hover && cardRef.current) api()?.send('ball:expand', cardRef.current.offsetHeight)
  }, [hover, content])

  const enter = () => {
    api()?.send('ball:enter')
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => { if (!drag.current) setHover(true) }, HOVER_DELAY_MS)
  }
  const leave = () => {
    clearTimeout(hoverTimer.current)
    if (drag.current) return
    setHover(false)
    api()?.send('ball:leave')
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { x: e.screenX, y: e.screenY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.screenX - d.x, dy = e.screenY - d.y
    if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; clearTimeout(hoverTimer.current); setHover(false); api()?.send('ball:dragStart', dx, dy) }
  }
  // 捕获意外丢失（切窗口等）也要结束拖动，否则主进程会一直让球跟着光标
  const onLost = () => {
    const d = drag.current
    if (d?.moved) { drag.current = null; api()?.send('ball:dragEnd', 0, 0) }
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.moved) api()?.send('ball:dragEnd', e.screenX - d.x, e.screenY - d.y)
    else api()?.send('ball:click')
  }

  if (!v) return null
  const expanded = v.expanded && hover
  const orb = (
    <div data-ball-orb data-look={v.look} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onLostPointerCapture={onLost}
      onContextMenu={(e) => { e.preventDefault(); api()?.send('ball:menu') }}
      className="relative flex shrink-0 cursor-pointer select-none items-center justify-center rounded-full" style={{ width: BALL, height: BALL }}>
      <Orb v={v} />
    </div>
  )
  const card = <Card v={v} />
  return (
    <div data-ball-root className="relative h-screen w-screen overflow-hidden" onMouseEnter={enter} onMouseLeave={leave}>
      {expanded ? (
        <div data-ball-card className={cn('flex h-full w-full overflow-hidden rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]',
          v.valign === 'top' ? 'flex-col' : 'flex-col-reverse')}>
          <div className={cn('flex shrink-0 items-center', v.side === 'right' ? 'flex-row' : 'flex-row-reverse')}>
            {orb}
            <Head v={v} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1">{card}</div>
        </div>
      ) : orb}
      {/* 量高度用（同卡片结构）：不可见、不占位 */}
      {hover && (
        <div ref={cardRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 w-[280px] border">
          <div style={{ height: BALL }} /><div className="px-3 pb-3 pt-1">{card}</div>
        </div>
      )}
    </div>
  )
}

/** 球身：圆形 Logo（随主题强调色）+ 外环表示状态：强调色（空闲）/ 蓝色转环（运行中）/ 橙色闪烁 + 数字（待授权）/ 红色（看门狗报警、最近出错）/ 锁（已锁定） */
function Orb({ v }: { v: BallView }) {
  const ring = v.look === 'running' ? 'border-[var(--color-user)] border-t-transparent animate-spin-slow'
    : v.look === 'waiting' ? 'border-[var(--color-warn)] animate-pulse-dim'
    : v.look === 'alert' ? 'border-[var(--color-danger)]'
    : 'border-[color:color-mix(in_srgb,var(--color-accent)_75%,transparent)]'   // 空闲也用强调色：深浅背景上都看得清
  return (
    <>
      <span className={cn('absolute inset-[3px] rounded-full border-[3px]', ring)} />
      {/* 外圈浅描边 + 投影：叠在任何颜色的桌面 / 窗口上都有轮廓 */}
      <span className="absolute inset-[1px] rounded-full shadow-lg ring-1 ring-[color:color-mix(in_srgb,var(--color-text-primary)_30%,transparent)]" />
      <span className={cn('flex h-[38px] w-[38px] items-center justify-center overflow-hidden rounded-full bg-[var(--color-bg-raised)] shadow-md',
        v.look === 'alert' && 'ring-2 ring-[color:color-mix(in_srgb,var(--color-danger)_45%,transparent)]')}>
        {v.look === 'locked'
          ? <Lock className="h-5 w-5 text-[var(--color-text-secondary)]" />
          : <Logo shape="circle" className="h-full w-full" />}
      </span>
      {v.badge > 0 && (
        <span data-ball-badge className="absolute right-[2px] top-[2px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-warn)] px-1 text-[11px] font-semibold leading-none text-[var(--color-bg-base)] animate-pulse-dim">
          {v.badge > 99 ? '99+' : v.badge}
        </span>
      )}
    </>
  )
}

function Head({ v }: { v: BallView }) {
  const line = v.locked ? tr('已锁定')
    : v.badge ? tr('{n} 个待授权', { n: v.badge })
    : v.sessionCount ? tr('{n} 个会话进行中', { n: v.sessionCount })
    : tr('空闲')
  return (
    <div className={cn('min-w-0 flex-1 px-1', v.side === 'left' && 'text-right')}>
      <div className="text-[12.5px] font-semibold">{tr('灵壳')}</div>
      <div className={cn('truncate text-[11px]', v.approvals.length ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]')}>{line}</div>
    </div>
  )
}

const Title = ({ children }: { children: React.ReactNode }) => <div className="mb-1 mt-2 text-[10.5px] font-medium text-[var(--color-text-muted)] first:mt-0">{children}</div>

function Card({ v }: { v: BallView }) {
  if (v.locked) return <div className="py-1 text-[12px] text-[var(--color-text-secondary)]">{tr('应用已锁定，解锁后显示状态')}</div>
  const quiet = !v.approvals.length && !v.sessions.length && !v.transfers.active && !v.watchdog.firing && !v.error
  return (
    <div className="text-[12px]">
      {v.approvals.length > 0 && <>
        <Title>{tr('待授权')}</Title>
        {v.approvals.map((a) => (
          <div key={a.approvalId} className="mb-1 flex items-center gap-2 rounded-md bg-[var(--color-bg-panel)] px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[11.5px]" title={a.command}>{a.command}</div>
              {a.host && <div className="truncate text-[10.5px] text-[var(--color-text-muted)]">{a.host}</div>}
            </div>
            <button data-ball-go onClick={() => api()?.send('ball:openSession', a.sessionId)}
              className="shrink-0 rounded bg-[var(--color-warn)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:opacity-90">{tr('去处理')}</button>
          </div>
        ))}
        {v.badge > v.approvals.length && <div className="text-[10.5px] text-[var(--color-text-muted)]">{tr('还有 {n} 条，请在主窗口处理', { n: v.badge - v.approvals.length })}</div>}
      </>}
      {v.sessions.length > 0 && <>
        <Title>{tr('进行中的会话')}</Title>
        {v.sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-2 py-0.5">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.status === 'waiting' ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-user)]')} />
            <span className="min-w-0 flex-1 truncate">{tr(s.title)}</span>
            <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{s.status === 'waiting' ? tr('待授权') : tr('运行中')}</span>
          </div>
        ))}
        {v.sessionCount > v.sessions.length && <div className="text-[10.5px] text-[var(--color-text-muted)]">{tr('还有 {n} 个会话，请在主窗口查看', { n: v.sessionCount - v.sessions.length })}</div>}
      </>}
      {v.error && <div className="mt-2 truncate text-[11.5px] text-[var(--color-danger)]">{tr('「{title}」出错了', { title: tr(v.error) })}</div>}
      <Title>{tr('状态')}</Title>
      <Line k={tr('看门狗')} val={v.watchdog.paused ? tr('已暂停') : v.watchdog.firing ? tr('{n} 个告警', { n: v.watchdog.firing }) : tr('正常')} warn={!v.watchdog.paused && v.watchdog.firing > 0} />
      {v.transfers.active > 0 && <Line k={tr('传输')} val={tr('{n} 个进行中', { n: v.transfers.active }) + (v.transfers.percent !== undefined ? ` · ${v.transfers.percent}%` : '')} />}
      {v.stats && <Line k={tr(v.stats.title)} val={[v.stats.cpuPct !== undefined && `CPU ${Math.round(v.stats.cpuPct)}%`, v.stats.memPct !== undefined && tr('内存 {pct}%', { pct: Math.round(v.stats.memPct) })].filter(Boolean).join(' · ') || '—'} />}
      {quiet && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('没有进行中的任务')}</div>}
    </div>
  )
}

const Line = ({ k, val, warn }: { k: string; val: string; warn?: boolean }) => (
  <div className="flex items-center gap-2 py-0.5">
    <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">{k}</span>
    <span className={cn('shrink-0', warn ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>{val}</span>
  </div>
)
