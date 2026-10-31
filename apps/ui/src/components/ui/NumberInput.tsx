import { ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import { CONTROL_BOX, CONTROL_SIZE, type ControlSize } from './control.js'

// 零依赖数字步进输入：直接键入或点上下箭头增减，自身钳制在 [min,max]。高度两档与 Input / Select 一致。
export function NumberInput({ value, onChange, min, max, step = 1, size = 'md', disabled, className, title }: {
  value: number; onChange: (n: number) => void; min: number; max: number; step?: number; size?: ControlSize; disabled?: boolean; className?: string; title?: string
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n))
  const set = (n: number) => onChange(clamp(Math.round(n)))
  return (
    <div data-ui="number" title={title} className={cn(CONTROL_BOX, CONTROL_SIZE[size], 'flex items-stretch overflow-hidden px-0 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]', disabled && 'opacity-50', className)}>
      <input type="number" value={value} min={min} max={max} disabled={disabled}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(n) }}
        className={cn('w-full min-w-0 bg-transparent text-[var(--color-text-primary)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none', size === 'sm' ? 'px-2' : 'px-2.5')} />
      <div className="flex shrink-0 flex-col border-l border-[var(--color-border-default)]">
        <button type="button" tabIndex={-1} disabled={disabled} onClick={() => set(value + step)} className="flex w-6 flex-1 items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><ChevronUp className="h-3 w-3" /></button>
        <button type="button" tabIndex={-1} disabled={disabled} onClick={() => set(value - step)} className="flex w-6 flex-1 items-center justify-center border-t border-[var(--color-border-default)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><ChevronDown className="h-3 w-3" /></button>
      </div>
    </div>
  )
}
