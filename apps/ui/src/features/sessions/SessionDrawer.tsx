import type { ReactNode } from 'react'
import { SidePanel } from '../../components/SidePanel.js'

// 会话面板左滑抽屉：从会话区左缘向右覆盖（不占布局、不推终端）。
// 宽度可拖（上限窗口宽度的一半），双击恢复默认，按抽屉记宽度；定位交给 SidePanel（挂到 body 顶层，不被容器裁剪）。
export function SessionDrawer({ open, onClose, widthClass = 'w-[450px]', widthKey, children }: {
  open: boolean
  onClose: () => void
  widthClass?: string
  /** 宽度记忆的 key（不同抽屉各自记） */
  widthKey?: string
  children: ReactNode
}) {
  return (
    <SidePanel open={open} onClose={onClose} side="left" widthClass={widthClass} widthKey={widthKey}>
      {children}
    </SidePanel>
  )
}
