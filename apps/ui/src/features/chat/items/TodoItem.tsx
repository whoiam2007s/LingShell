import { ListChecks, Circle, CircleDot, CheckCircle2 } from 'lucide-react'
import type { ConvItem } from '../useConversation.js'
import { tr } from '@lingshell/shared'
import { cn } from '../../../lib/cn.js'

// 任务清单卡片：显示 todos + 进度条（实时更新）
export function TodoItem({ item }: { item: ConvItem }) {
  const todos = item.todos ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  const pct = item.completionPct ?? (todos.length ? Math.round((done / todos.length) * 100) : 0)

  return (
    <div className="animate-fade-in px-3 py-1">
      <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)]">
        {/* 头部 + 进度 */}
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">{tr('任务清单')}</span>
          <span className="ml-auto font-mono text-[11px] text-[var(--color-text-muted)]">{done}/{todos.length}</span>
        </div>
        {/* 进度条 */}
        <div className="h-0.5 w-full bg-[var(--color-bg-base)]">
          <div className="h-full bg-[var(--color-accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        {/* 清单 */}
        <ul className="px-2.5 py-1.5">
          {todos.map((t) => (
            <li key={t.id} className="flex items-start gap-2 py-0.5 text-[12px]">
              <TodoIcon status={t.status} />
              <span
                className={cn(
                  'leading-relaxed',
                  t.status === 'completed' && 'text-[var(--color-text-muted)] line-through',
                  t.status === 'in_progress' && 'text-[var(--color-text-primary)]',
                  t.status === 'pending' && 'text-[var(--color-text-secondary)]'
                )}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function TodoIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" />
  if (status === 'in_progress') return <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse-dim text-[var(--color-warn)]" />
  return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
}
