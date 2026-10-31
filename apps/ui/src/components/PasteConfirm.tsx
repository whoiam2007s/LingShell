import { revealHidden, tr, type PasteLine } from '@lingshell/shared'
import { ConfirmDialog } from './ui/ConfirmDialog.js'

// 粘贴 / 撰写栏发送前的确认框（两处共用）：逐行显示，危险行标红，隐藏字符显示成 ⟨ESC⟩、⟨U+200B⟩ 这类占位（橙底）。
// onStrip 有值时多一个「去除隐藏字符后…」按钮
export function PasteConfirmDialog({ open, title, message, confirmText, lines, onConfirm, onCancel, onStrip, stripText }: {
  open: boolean; title: string; message: string; confirmText: string; lines: PasteLine[]
  onConfirm: () => void; onCancel: () => void; onStrip?: () => void; stripText?: string
}) {
  return (
    <ConfirmDialog open={open} title={title} message={message} confirmText={confirmText} onConfirm={onConfirm} onCancel={onCancel}>
      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 font-mono text-[11.5px] text-[var(--color-text-primary)]">
        {lines.map((l, i) => (
          <div key={i} className={l.dangerous ? 'text-[var(--color-danger)]' : ''}>
            {l.hidden ? revealHidden(l.text).split(/(⟨[^⟩]+⟩)/).map((s, j) => j % 2
              ? <span key={j} className="rounded-sm bg-[color:color-mix(in_srgb,var(--color-warn)_25%,transparent)] text-[var(--color-warn)]">{s}</span>
              : s) : l.text}
          </div>
        ))}
      </pre>
      {onStrip && (
        <button onClick={onStrip}
          className="mt-2 rounded-md border border-[color:color-mix(in_srgb,var(--color-warn)_50%,transparent)] px-3 py-1 text-[12px] text-[var(--color-warn)] hover:bg-[color:color-mix(in_srgb,var(--color-warn)_12%,transparent)]">
          {stripText ?? tr('去除隐藏字符后粘贴')}
        </button>
      )}
    </ConfirmDialog>
  )
}
