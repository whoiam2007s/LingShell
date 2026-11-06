// 下载完成后的弹窗：现在就重启安装，还是等关闭灵壳时自动安装。
// 不放「取消」：用户点了下载就是想升级；真要装完不再提示，关掉这个窗直接继续用，退出时也会装上。
import { createPortal } from 'react-dom'
import { ArrowUpFromLine } from 'lucide-react'
import { tr } from '@lingshell/shared'

export function UpdateReadyDialog({ version, onRestart, onLater }: {
  version?: string
  onRestart: () => void
  onLater: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-update-ready className="w-[420px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <ArrowUpFromLine className="h-4 w-4 text-[var(--color-danger)]" />
          {version ? tr('灵壳 {version} 已下载', { version }) : tr('新版本已下载')}
        </div>
        <p className="mb-4 text-[12.5px] leading-[1.7] text-[var(--color-text-secondary)]">
          {tr('现在重启会立刻安装新版本（终端和会话会自动重连）；选「关闭后安装」则继续用当前版本，退出灵壳时再装。')}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onLater}
            className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
          >
            {tr('关闭后安装')}
          </button>
          <button
            onClick={onRestart}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)]"
          >
            {tr('立即重启安装')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
