import { useEffect, type ReactNode } from 'react'
import { uiLayerBusy } from '../../../components/ui/layer.js'

// 终端侧右滑抽屉：贴终端区右缘向左覆盖，不占布局。行为同 SessionDrawer。
export function TerminalDrawer({ open, onClose, wide, xwide, widthClass, children }: { open: boolean; onClose: () => void; wide?: boolean; xwide?: boolean; widthClass?: string; children: ReactNode }) {
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
      <div className={`pointer-events-auto absolute right-0 top-0 h-full ${widthClass ?? (xwide ? 'w-[680px] max-w-full' : wide ? 'w-[440px] max-w-full' : 'w-[300px]')} border-l border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl transition-transform duration-200 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        {open ? children : null}
      </div>
    </div>
  )
}
