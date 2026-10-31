import { useEffect, type ReactNode } from 'react'
import { uiLayerBusy } from '../../components/ui/layer.js'

// 右滑抽屉：绝对定位浮层，从会话面板右缘向左覆盖在会话面板上（不占布局、不推终端）。
// open 时 translateX(0) 显示；关闭时 translateX(100%) 滑出 + 容器 overflow-hidden 裁掉，
// 避免阴影/本体溢出到右侧终端区。open 时叠半透明遮罩，点遮罩或按 Esc 关闭。
export function SessionDrawer({ open, onClose, widthClass = 'w-[270px]', children }: { open: boolean; onClose: () => void; widthClass?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
      {/* 抽屉里下拉面板开着时点遮罩只关面板，不关抽屉 */}
      {open && <div onClick={() => { if (!uiLayerBusy()) onClose() }} className="pointer-events-auto absolute inset-0 bg-black/20 transition-opacity" />}
      <div
        className={`pointer-events-auto absolute left-0 top-0 h-full ${widthClass} max-w-full border-r border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl transition-transform duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {open ? children : null}
      </div>
    </div>
  )
}
