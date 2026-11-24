import { useCallback, useEffect, useRef, useState } from 'react'

// 水平分割拖拽：返回左侧面板宽度 + 分隔线的 onMouseDown。
// 拖动时左宽 = 鼠标 X - 容器左缘，钳在 [min, 容器宽-min]（保证两侧都 ≥ min）。
// 松手时回调 onCommit(持久化)。容器 ref 用于换算相对坐标 + 拿总宽。
export function useResizable(opts: {
  initial: number
  min: number
  containerRef: React.RefObject<HTMLElement | null>
  onCommit?: (width: number) => void
}) {
  const { initial, min, containerRef, onCommit } = opts
  const [width, setWidth] = useState(initial)
  const dragging = useRef(false)
  // 用户「想要的」宽度：不受当前窗口大小影响。持久化存它，显示才夹取 ——
  // 以前把夹取后的值存盘，于是大屏→小屏→大屏回来，宽度永远停在小屏那个值（0.1.19 遗留问题）
  const desired = useRef(initial)

  const clamp = useCallback((w: number) => {
    const total = containerRef.current?.clientWidth ?? 0
    const max = Math.max(min, total - min)   // 右侧也要 ≥ min；窗口过窄时退化到 min
    return Math.min(Math.max(w, min), max)
  }, [min, containerRef])

  // initial 变化（如从持久化恢复）时同步一次：显示用夹过的值，持久化里存的仍是「想要的宽度」
  useEffect(() => { desired.current = initial; setWidth(clamp(initial)) }, [initial, clamp])

  // 窗口大小变了：显示宽度跟着重新夹取（不覆盖持久化的值）—— 否则缩小窗口后面板会溢出
  useEffect(() => {
    const onResize = () => setWidth(clamp(desired.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const rect = containerRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const onMove = (ev: MouseEvent) => { if (dragging.current) setWidth(clamp(ev.clientX - left)) }
    const onUp = (ev: MouseEvent) => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      const raw = Math.max(min, Math.round(ev.clientX - left))
      desired.current = raw
      onCommit?.(raw)   // 存「想要的宽度」，不存被窗口夹小后的值（否则大屏回来永远恢复不了）
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'   // 拖动时禁选中文本
    document.body.style.cursor = 'col-resize'
  }, [clamp, containerRef, onCommit])

  return { width, onMouseDown }
}
