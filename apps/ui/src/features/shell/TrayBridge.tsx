// 托盘 / 悬浮球菜单的动作（主进程已把主窗口显示出来，见 desktop/main/app/background.ts）→ 交给界面对应入口。
// 打开会话复用 inspection:openSession（App 里已处理），这里只管 tray:action
import { useEffect, useRef } from 'react'
import { client } from '../../client/index.js'
import { paletteSend } from '../../lib/paletteBus.js'
import { openDashboard } from '../dashboard/index.js'

export function TrayBridge(p: { onNewSession(): void; onOpenSettings(): void; onCloseOverlays(): void }) {
  const ref = useRef(p); ref.current = p
  useEffect(() => client.on((ev) => {
    if (ev.type !== 'tray:action') return
    const a = ev.action, h = ref.current
    if (a.type !== 'settings') h.onCloseOverlays()
    switch (a.type) {
      case 'newSession': h.onNewSession(); break
      case 'newLocal': paletteSend({ type: 'newLocal' }); break
      case 'connectHost': paletteSend({ type: 'connectHost', hostId: a.hostId }); break
      case 'dashboard': openDashboard(); break
      case 'settings': h.onOpenSettings(); break
      // 快速提问：窗口刚显示出来，等一帧再聚焦对话输入框（同快捷键 focus.chat）
      case 'focusChat': setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.focus(), 50); break
    }
  }), [])
  return null
}
