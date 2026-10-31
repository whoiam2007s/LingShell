import type { ReactNode } from 'react'

// 仿 VS Code 的竖向活动栏：贴在工作区外侧，放打开侧边面板/工具的图标按钮，省出头部空间
export function ActivityBar({ side, children, bottom }: { side: 'left' | 'right'; children: ReactNode; bottom?: ReactNode }) {
  return (
    <div data-activity-bar={side}
      // 各功能自带的图标按钮（h-6 + 3.5 图标）在活动栏里统一放大到 ActBtn 的尺寸；只作用于直接按钮，不碰其弹出菜单里的按钮
      className={`flex w-[calc(2.25rem*var(--icon-zoom,1))] shrink-0 flex-col items-center gap-1 bg-[var(--color-bg-panel)] py-2 [&>*>button]:h-[var(--act-btn)] [&>*>button]:w-[var(--act-btn)] [&>*>button>svg]:h-4 [&>*>button>svg]:w-4 [&>button]:h-[var(--act-btn)] [&>button]:w-[var(--act-btn)] [&>button>svg]:h-4 [&>button>svg]:w-4 ${side === 'left' ? 'border-r' : 'border-l'} border-[var(--color-border-subtle)]`}>
      {children}
      {bottom && <div className="mt-auto flex flex-col items-center gap-1">{bottom}</div>}
    </div>
  )
}

/** 活动栏图标按钮；active = 对应面板开着时高亮 */
export function ActBtn({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className={`relative flex h-[var(--act-btn)] w-[var(--act-btn)] items-center justify-center rounded-md transition-colors hover:bg-[var(--color-bg-hover)] ${active ? 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}`}>
      {children}
    </button>
  )
}

export function ActSep() {
  return <div className="my-0.5 h-px w-5 bg-[var(--color-border-subtle)]" />
}
