// 图片预览弹窗：滚轮以光标为中心缩放、按钮 + / − / 适应窗口 / 1:1、双击在适应和 1:1 间切换、缩放后拖拽平移、显示百分比；
// 多张时 ← → 键或两侧按钮切换。Esc 或 × 关闭（不点遮罩关闭）。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react'
import { tr, type MsgAttachment } from '@lingshell/shared'
import { imageSrc, naturalSize } from '../lib/imageSrc.js'

const MIN = 0.02, MAX = 16, STEP = 1.25, PAD = 24
type View = { s: number; x: number; y: number }

export function ImageViewer({ items, index, onClose }: { items: MsgAttachment[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index)
  const a = items[Math.min(i, items.length - 1)]!
  const [src, setSrc] = useState<string | null | undefined>(a.src)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const many = items.length > 1
  const go = (d: number) => setI((k) => (k + d + items.length) % items.length)

  // 按图片身份重载（父组件重渲染会给新对象，不能依赖对象本身）
  const id = a.imageId ?? a.path ?? a.src ?? a.name
  useEffect(() => {
    let alive = true
    setNat(null); setView(null); setSrc(a.src)
    if (!a.src) void imageSrc(a).then((s) => { if (alive) setSrc(s) })
    return () => { alive = false }
  }, [id])

  const rect = () => box.current?.getBoundingClientRect() ?? { width: 800, height: 600 }
  // 适应：整图放进窗口（位图小图不放大，svg 矢量可放大）；1:1：原始尺寸居中
  const fit = (n = nat): View | null => {
    if (!n) return null
    const r = rect()
    const s = Math.min(src?.startsWith('data:image/svg+xml') ? MAX : 1, (r.width - PAD * 2) / n.w, (r.height - PAD * 2) / n.h)
    return { s, x: (r.width - n.w * s) / 2, y: (r.height - n.h * s) / 2 }
  }
  const actual = (): View | null => { if (!nat) return null; const r = rect(); return { s: 1, x: (r.width - nat.w) / 2, y: (r.height - nat.h) / 2 } }
  // 以 (px, py)（相对图片区域）为中心缩放到 ns：该点下的图片像素保持不动
  const zoomAt = (px: number, py: number, f: (s: number) => number) => setView((v) => {
    if (!v) return v
    const ns = Math.min(MAX, Math.max(MIN, f(v.s)))
    return { s: ns, x: px - ((px - v.x) * ns) / v.s, y: py - ((py - v.y) * ns) / v.s }
  })
  const zoomCenter = (k: number) => { const r = rect(); zoomAt(r.width / 2, r.height / 2, (s) => s * k) }

  // 键盘：Esc 关闭、← → 切换（捕获阶段，不让底下的输入框 / 终端收到）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose() }
      else if (many && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.stopPropagation(); e.preventDefault(); go(e.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, many])

  // 滚轮缩放要 preventDefault，React 的 onWheel 是被动监听，只能自己挂
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, (s) => s * Math.pow(1.0015, -e.deltaY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const n = naturalSize(e.currentTarget, src ?? '')
    setNat(n); setView(fit(n))
  }
  // data: URL 的图片常常在挂载时就已经 complete，onLoad 可能来不及触发（预览一直停在隐藏状态）。
  // src 变化后补一次 complete 检查，确保首帧也能拿到自然尺寸并定位。
  useEffect(() => {
    const el = imgRef.current
    if (!el) return
    const apply = () => {
      if (!el.complete) return
      const n = naturalSize(el, src ?? '')
      if (!n.w || !n.h) return
      setNat(n); setView(fit(n))
    }
    apply()
    const t = setTimeout(apply, 60)
    return () => clearTimeout(t)
  }, [src])
  const isFit = !!view && !!nat && Math.abs(view.s - (fit()?.s ?? 0)) < 1e-3
  const BTN = 'flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[12px] text-white/85 hover:bg-white/15 disabled:opacity-40'

  return createPortal((
    <div data-image-preview className="fixed inset-0 z-[80] flex flex-col bg-black/80 animate-fade-in">
      {/* 顶栏：名称 / 序号 · 缩放按钮 · 关闭 */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-white/85">
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={a.path ?? a.name}>{a.name}{many && <span className="ml-2 text-white/50">{i + 1} / {items.length}</span>}</span>
        <button data-zoom-out onClick={() => zoomCenter(1 / STEP)} title={tr('缩小')} className={BTN}><Minus className="h-4 w-4" /></button>
        <span data-zoom-pct className="w-12 text-center text-[12px] tabular-nums">{view ? `${Math.round(view.s * 100)}%` : '—'}</span>
        <button data-zoom-in onClick={() => zoomCenter(STEP)} title={tr('放大')} className={BTN}><Plus className="h-4 w-4" /></button>
        <button data-zoom-fit onClick={() => setView(fit())} title={tr('适应窗口')} className={BTN}>{tr('适应窗口')}</button>
        <button data-zoom-1 onClick={() => setView(actual())} title={tr('原始大小')} className={BTN}>1:1</button>
        <button data-close onClick={onClose} title={tr('关闭（Esc）')} className={`${BTN} ml-2`}><X className="h-4 w-4" /></button>
      </div>
      {/* 图片区：拖拽平移、双击切换适应 / 1:1 */}
      <div ref={box} data-viewer-stage className="relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
        onPointerDown={(e) => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          drag.current = { x: e.clientX, y: e.clientY }
          setView((v) => v && { ...v, x: v.x + e.clientX - d.x, y: v.y + e.clientY - d.y })
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        onDoubleClick={(e) => {
          if (!nat) return
          if (!isFit) { setView(fit()); return }
          const r = e.currentTarget.getBoundingClientRect()
          zoomAt(e.clientX - r.left, e.clientY - r.top, () => 1)
        }}>
        {src ? (
          // 用实际宽高而不是 transform scale：svg 放大后仍清晰
          <img key={src} ref={imgRef} src={src} alt={a.name} draggable={false} onLoad={onLoad}
            style={view && nat ? { left: view.x, top: view.y, width: nat.w * view.s, height: nat.h * view.s } : { visibility: 'hidden' }}
            className="absolute max-w-none" />
        ) : (
          <div className="flex h-full items-center justify-center text-[12.5px] text-white/60">{src === null ? tr('图片读取失败（可能已删除）') : tr('加载中…')}</div>
        )}
        {many && (
          <>
            <button data-prev onClick={() => go(-1)} onPointerDown={(e) => e.stopPropagation()} title={tr('上一张（←）')}
              className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/85 hover:bg-black/70"><ChevronLeft className="h-5 w-5" /></button>
            <button data-next onClick={() => go(1)} onPointerDown={(e) => e.stopPropagation()} title={tr('下一张（→）')}
              className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/85 hover:bg-black/70"><ChevronRight className="h-5 w-5" /></button>
          </>
        )}
      </div>
    </div>
  ), document.body)
}
