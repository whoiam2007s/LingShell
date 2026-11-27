import type { ReactNode } from 'react'
import { Send, Square, Terminal } from 'lucide-react'
import { tr } from '@lingshell/shared'

/**
 * 输入框底部工具栏：左槽「+ 菜单 / 模型」，右槽「性能指标 / 执行模式 / 停止与发送」。
 * 只负责排版与两个动作按钮，内容由 Composer 组装后传进来。
 */
export function ComposerFooter({ left, usage, mode, busy, showSend, bang, disabled, onSend, onStop }: {
  left: ReactNode
  usage?: ReactNode
  mode?: ReactNode
  busy: boolean
  showSend: boolean
  bang: string | null
  disabled?: boolean
  onSend: () => void
  onStop: () => void
}) {
  return (
    <div data-composer-footer className="flex min-h-[30px] shrink-0 items-center gap-2 pt-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{left}</div>
      <div className="flex shrink-0 items-center gap-2">
        {usage}
        {mode}
        {busy && (
          <button onClick={onStop} title={tr('停止')} data-composer-stop
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-danger)] text-[var(--color-bg-base)] transition-all hover:opacity-80">
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
        {showSend && (
          <button onClick={onSend} data-composer-send disabled={disabled}
            title={bang !== null ? tr('在当前终端执行（不发给 AI）') : busy ? tr('追问：当前步骤结束后、AI 下一次请求前插入（Alt+Enter：本轮结束后再发）') : tr('发送')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-[var(--color-bg-base)] transition-all hover:bg-[var(--color-accent-dim)] disabled:cursor-not-allowed disabled:opacity-30">
            {bang !== null ? <Terminal className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  )
}
