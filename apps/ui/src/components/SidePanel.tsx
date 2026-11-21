import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tr } from '@lingshell/shared'
import { uiLayerBusy } from './ui/layer.js'

/**
 * 侧边抽屉的通用壳（左右共用）。
 *
 * 关键点：用 createPortal 挂到 document.body + fixed 定位 ——
 * 抽屉原本挂在「会话区」「终端区」各自的容器里，absolute inset-0 只覆盖父容器，
 * 拖宽超出就被父容器裁掉；挪到顶层后整块视口都能用。
 *
 * 但顶层不能盖住应用标题栏：实测量 [data-app-titlebar] 的高度，抽屉从它下面开始。
 *
 * 宽度可拖：贴内侧边缘拖，最小 280px，最大内容区宽度的一半；
 * 双击把手恢复默认；宽度按 key 记在 localStorage（不同抽屉各自记）。
 */
const MIN_W = 280
const MAX_RATIO = 0.5
const storeKey = (k: string) => `sidePanel.width.${k}`
const maxW = () => Math.max(MIN_W, Math.floor(window.innerWidth * MAX_RATIO))
const clamp = (v: number) => Math.max(MIN_W, Math.min(maxW(), v))

export function SidePanel({ open, onClose, side, widthClass, widthKey, children }: {
  open: boolean
  onClose: () => void
  side: 'left' | 'right'
  /** 默认宽度（Tailwind 类）；没拖过时用它 */
  widthClass?: string
  /** 宽度记忆的 key；不传则按方向 + 默认宽度归类 */
  widthKey?: string
  children: ReactNode
}) {
  const base = 450
  const memKey = widthKey ?? `auto-${side}-${widthClass ?? base}`
  const [w, setW] = useState<number | undefined>(() => {
    const raw = localStorage.getItem(storeKey(memKey))
    const v = raw ? Number(raw) : NaN
    return Number.isFinite(v) && v >= MIN_W ? clamp(v) : undefined
  })
  const boxRef = useRef<HTMLDivElement | null>(null)
  // 顶部避让：应用标题栏（h-9 + 边框）不能被抽屉盖住
  const [top, setTop] = useState(36)
  // 左右避让：活动栏（最左/最右的图标列）要给抽屉让出位置，否则抽屉会盖住它们
  const [inset, setInset] = useState({ left: 0, right: 0 })

  useEffect(() => {
    const bar = document.querySelector('[data-app-titlebar]')
    if (!(bar instanceof HTMLElement)) return
    const measure = () => setTop(bar.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const l = document.querySelector('[data-activity-bar="left"]')
    const r = document.querySelector('[data-activity-bar="right"]')
    const measure = () => setInset({
      left: l instanceof HTMLElement ? Math.round(l.getBoundingClientRect().width) : 0,
      right: r instanceof HTMLElement ? Math.round(r.getBoundingClientRect().width) : 0,
    })
    measure()
    const ro = new ResizeObserver(measure)   // 图标缩放会改活动栏宽度，跟着重算
    if (l instanceof HTMLElement) ro.observe(l)
    if (r instanceof HTMLElement) ro.observe(r)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 窗口变小后，记住的宽度可能超过一半，重新夹一次
  useEffect(() => {
    const onResize = () => setW((v) => (v ? clamp(v) : v))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖动调宽：左侧面板拖右边缘（向右变宽），右侧面板拖左边缘（向左变宽）
  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const cur = boxRef.current?.getBoundingClientRect().width ?? base
    const startX = e.clientX
    const dir = side === 'left' ? 1 : -1
    const move = (ev: MouseEvent) => setW(clamp(cur + dir * (ev.clientX - startX)))
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
  }, [base, memKey, side])

  const reset = useCallback(() => {
    setW(undefined)
    localStorage.removeItem(storeKey(memKey))
  }, [memKey])

  const fallback = widthClass ?? 'w-[450px]'
  const isLeft = side === 'left'
  const el = (
    <div className="pointer-events-none fixed bottom-0 z-40 overflow-hidden" style={{ top, left: inset.left, right: inset.right }}>
      {/* 抽屉里下拉面板开着时点遮罩只关面板，不关抽屉 */}
      {open && <div onClick={() => { if (!uiLayerBusy()) onClose() }} className="pointer-events-auto absolute inset-0 bg-black/20 transition-opacity" />}
      <div
        ref={boxRef}
        data-side-panel={side}
        style={w ? { width: w } : undefined}
        className={`pointer-events-auto absolute top-0 h-full ${w ? '' : fallback} ${isLeft ? 'left-0 border-r' : 'right-0 border-l'} border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl transition-transform duration-200 ease-out ${open ? 'translate-x-0' : isLeft ? '-translate-x-full' : 'translate-x-full'}`}>
        {/* 内侧边缘把手：一条细线，悬停高亮 */}
        <div
          data-side-panel-resize
          onMouseDown={onDown}
          onDoubleClick={reset}
          title={tr('拖动调整宽度，双击恢复默认')}
          className={`absolute top-0 z-20 h-full w-[5px] cursor-col-resize hover:bg-[var(--color-accent)]/35 active:bg-[var(--color-accent)]/55 ${isLeft ? 'right-0 translate-x-[2px]' : 'left-0 -translate-x-[2px]'}`}
        />
        {open ? children : null}
      </div>
    </div>
  )
  return createPortal(el, document.body)
}
