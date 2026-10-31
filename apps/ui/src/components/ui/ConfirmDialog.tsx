import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { createPortal } from 'react-dom'
import { tr } from '@lingshell/shared'

// 通用二次确认弹窗（居中）。会话删除、主机删除等危险操作复用。
// 用 Portal 挂到 body：否则若渲染在抽屉内，抽屉面板的 transform(translate-x) 会让 fixed 退化为相对抽屉定位，把弹窗困在半个面板里。
// children：消息下方的附加内容（如要执行的命令预览），有时弹窗加宽
export function ConfirmDialog({ open, title, message, confirmText = tr('删除'), onConfirm, onCancel, children, confirmDisabled }: {
  open: boolean
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode
  confirmDisabled?: boolean   // 确认按钮先灰着（如生产环境要先勾选「我确认」）
}) {
  // Esc / 点遮罩 = 取消；捕获阶段拦下，别让抽屉跟着 Esc 一起关
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [open, onCancel])
  if (!open) return null
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className={`${children ? 'w-[520px]' : 'w-[340px]'} rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <AlertTriangle className="h-4.5 w-4.5 text-[var(--color-danger)]" />
          {title}
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">{message}</p>
        {children && <div className="mb-4">{children}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button onClick={onConfirm} disabled={confirmDisabled} className="rounded-md bg-[var(--color-danger)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-on-danger)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">{confirmText}</button>
        </div>
      </div>
    </div>
  ), document.body)
}
