import { cn } from '../../lib/cn.js'

/**
 * 单选圆点（自建，零依赖）：role=radio，点击 / 空格选中。同组互斥由调用方的 checked 决定。
 * 放在 <label> 里时点文字也能选中。
 */
export function Radio({ checked, onSelect, disabled, title, className }: {
  checked: boolean
  onSelect: () => void
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={disabled} title={title} data-ui="radio"
      data-state={checked ? 'checked' : 'unchecked'} onClick={() => { if (!checked) onSelect() }}
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-40',
        'data-[state=checked]:border-[var(--color-accent)]',
        className,
      )}>
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
    </button>
  )
}
