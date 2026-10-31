import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/cn.js'

/**
 * shadcn 风格复选框（Radix Checkbox），用于列表多选（开关语义请用 Switch）。
 * checked 可为 'indeterminate'（部分选中）；onCheckedChange 回传 boolean。
 * 放在 <label> 里时点文字也能切换。tone=danger 时选中色为红（危险确认项）。
 */
export function Checkbox({ checked, onCheckedChange, disabled, className, title, tone = 'accent', onClick, id, 'aria-label': ariaLabel }: {
  checked: boolean | 'indeterminate'
  onCheckedChange?: (v: boolean) => void
  disabled?: boolean
  className?: string
  title?: string
  tone?: 'accent' | 'danger'
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  id?: string
  'aria-label'?: string
}) {
  return (
    <CheckboxPrimitive.Root checked={checked} disabled={disabled} title={title} id={id} aria-label={ariaLabel} onClick={onClick} data-ui="checkbox"
      onCheckedChange={(v) => onCheckedChange?.(v === true)}
      className={cn(
        'peer inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger'
          ? 'data-[state=checked]:border-[var(--color-danger)] data-[state=checked]:bg-[var(--color-danger)]'
          : 'data-[state=checked]:border-[var(--color-accent)] data-[state=checked]:bg-[var(--color-accent)] data-[state=indeterminate]:border-[var(--color-accent)] data-[state=indeterminate]:bg-[var(--color-accent)]',
        className,
      )}>
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[var(--color-bg-base)]">
        {checked === 'indeterminate' ? <Minus className="h-3 w-3" strokeWidth={3} /> : <Check className="h-3 w-3" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
