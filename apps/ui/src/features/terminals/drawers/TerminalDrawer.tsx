import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { tr } from '@lingshell/shared'
import { uiLayerBusy } from '../../../components/ui/layer.js'

// 终端侧右滑抽屉：贴终端区右缘向左覆盖，不占布局。行为同 SessionDrawer。
// 宽度可拖：左边缘拖动调宽，双击复位，按抽屉类型记住上次的宽度。
const MIN_W = 280
const storeKey = (k: string) => `drawer.width.${k}`
const clamp = (v: number) => Math.max(MIN_W, Math.min(Math.max(MIN_W, window.innerWidth - 80), v))

export function TerminalDrawer({ open, onClose, wide, xwide, widthClass, widthKey, children }: {
  open: boolean
  onClose: () => void
  wide?: boolean
  xwide?: boolean
  widthClass?: string
  /** 宽度记忆的 key；不传则按默认宽度 / widthClass 归类记忆 */
  widthKey?: string
  children: ReactNode
}) {
  const base = xwide ? 680 : wide ? 440 : 340
  const memKey = widthKey ?? `auto-${base}-${widthClass ?? ''}`
  const [w, setW] = useState<number | undefined>(() => {
    const raw = localStorage.getItem(storeKey(memKey))
    const v = raw ? Number(raw) : NaN
    return Number.isFinite(v) && v >= MIN_W ? clamp(v) : undefined
  })
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 拖动调宽：以左边缘为把手，向左拖变宽
  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const cur = boxRef.current?.getBoundingClientRect().width ?? base
    const startX = e.clientX
    const move = (ev: MouseEvent) => setW(clamp(cur + (startX - ev.clientX)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const el = boxRef.current
      if (el) {
        const width = Math.round(el.getBoundingClientRect().width)
        if (width >= MIN_W) localStorage.setItem(storeKey(memKey), String(width))
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [base, memKey])

  // 双击复位成默认宽度
  const reset = useCallback(() => {
    setW(undefined)
    localStorage.removeItem(storeKey(memKey))
  }, [memKey])

  const fallback = widthClass ?? (xwide ? 'w-[680px] max-w-full' : wide ? 'w-[440px] max-w-full' : 'w-[340px] max-w-full')
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {/* 抽屉里下拉面板开着时点遮罩只关面板，不关抽屉 */}
      {open && <div onClick={() => { if (!uiLayerBusy()) onClose() }} className="pointer-events-auto absolute inset-0 bg-black/20 transition-opacity" />}
      <div
        ref={boxRef}
        data-drawer
        style={w ? { width: w } : undefined}
        className={`pointer-events-auto absolute right-0 top-0 h-full ${w ? '' : fallback} border-l border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl transition-transform duration-200 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* 左边缘拖宽把手：视觉上是一条细线，悬停时高亮 */}
        <div
          data-drawer-resize
          onMouseDown={onDown}
          onDoubleClick={reset}
          title={tr('拖动调整宽度，双击恢复默认')}
          className="absolute left-0 top-0 z-20 h-full w-[5px] -translate-x-[2px] cursor-col-resize hover:bg-[var(--color-accent)]/35 active:bg-[var(--color-accent)]/55"
        />
        {open ? children : null}
      </div>
    </div>
  )
}
