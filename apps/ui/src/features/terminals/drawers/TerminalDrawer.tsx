import type { ReactNode } from 'react'
import { SidePanel } from '../../../components/SidePanel.js'

// 终端侧抽屉：贴终端区右缘向左覆盖，不占布局。行为同 SessionDrawer。
// 宽度可拖（上限窗口宽度的一半），双击恢复默认，按抽屉记宽度；定位交给 SidePanel（挂到 body 顶层，不被容器裁剪）。
export function TerminalDrawer({ open, onClose, wide: _wide, xwide, widthClass, widthKey, children }: {
  open: boolean
  onClose: () => void
  wide?: boolean
  xwide?: boolean
  widthClass?: string
  /** 宽度记忆的 key；不传则按方向 + 默认宽度归类记忆 */
  widthKey?: string
  children: ReactNode
}) {
  const fallback = widthClass ?? (xwide ? 'w-[680px]' : 'w-[450px]')
  return (
    <SidePanel open={open} onClose={onClose} side="right" widthClass={fallback} widthKey={widthKey}>
      {children}
    </SidePanel>
  )
}
