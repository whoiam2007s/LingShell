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

  // initial 变化（如从持久化恢复）时同步一次
  useEffect(() => { setWidth(initial) }, [initial])

  const clamp = useCallback((w: number) => {
    const total = containerRef.current?.clientWidth ?? 0
    const max = Math.max(min, total - min)   // 右侧也要 ≥ min；窗口过窄时退化到 min
    return Math.min(Math.max(w, min), max)
  }, [min, containerRef])

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
      onCommit?.(clamp(ev.clientX - left))
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'   // 拖动时禁选中文本
    document.body.style.cursor = 'col-resize'
  }, [clamp, containerRef, onCommit])

  return { width, onMouseDown }
}
