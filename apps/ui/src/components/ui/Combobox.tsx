import { useRef, useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Check, ChevronDown } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { CONTROL_BOX, CONTROL_SIZE, PANEL, PANEL_ITEM, type ControlSize } from './control.js'
import { UI_LAYER, markUiLayerClosed } from './layer.js'

/** 候选过滤：输入为空或正好等于某候选时列出全部，否则按包含（不区分大小写）过滤 */
export function filterSuggestions(options: string[], text: string): string[] {
  const q = text.trim().toLowerCase()
  if (!q || options.some((o) => o.toLowerCase() === q)) return options
  return options.filter((o) => o.toLowerCase().includes(q))
}

/**
 * 可输入 + 候选（代替 <input list> + <datalist>）：可自由输入任意值；聚焦 / 点箭头 / ↓ 打开候选，
 * 输入时过滤，↑↓ 移动、回车选中、Esc 收起。候选面板与 Select 同样式。
 */
export function Combobox({ value, onChange, options, placeholder, disabled, size = 'md', className, title, id, maxLength }: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder?: string
  disabled?: boolean
  size?: ControlSize
  /** 外框类名（宽度等） */
  className?: string
  title?: string
  id?: string
  maxLength?: number
}) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = filterSuggestions(options, value)
  const show = open && list.length > 0
  const pick = (v: string) => { onChange(v); setOpen(false); setHi(-1) }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!show) { setOpen(true); setHi(Math.max(0, list.indexOf(value))); return }
      const d = e.key === 'ArrowDown' ? 1 : -1
      setHi((h) => (h + d + list.length) % list.length)
    } else if (e.key === 'Enter' && show && hi >= 0 && hi < list.length) {
      e.preventDefault(); pick(list[hi])
    } else if (e.key === 'Escape' && show) {
      e.preventDefault(); e.stopPropagation(); setOpen(false)
    }
  }

  return (
    <PopoverPrimitive.Root open={show} onOpenChange={(o) => { if (!o) { setOpen(false); markUiLayerClosed() } }}>
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchor} data-ui="combobox"
          className={cn(CONTROL_BOX, CONTROL_SIZE[size], 'flex w-full min-w-0 items-center px-0 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]', disabled && 'opacity-50', className)}>
          <input ref={input} id={id} value={value} placeholder={placeholder} disabled={disabled} title={title} maxLength={maxLength}
            role="combobox" aria-expanded={show} aria-autocomplete="list" autoComplete="off" spellCheck={false}
            onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(-1) }}
            onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
            className={cn('h-full min-w-0 flex-1 bg-transparent text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]', size === 'sm' ? 'pl-2' : 'pl-2.5')} />
          <button type="button" tabIndex={-1} disabled={disabled} aria-label={tr('候选')}
            onMouseDown={(e) => { e.preventDefault(); input.current?.focus(); setOpen((o) => !o) }}
            className="flex h-full shrink-0 items-center px-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...UI_LAYER} align="start" sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onInteractOutside={(e) => { if (anchor.current?.contains(e.target as Node)) e.preventDefault() }}
          className={cn(PANEL, 'max-h-[min(var(--radix-popover-content-available-height),280px)] w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1')}>
          <div role="listbox">
            {list.map((o, i) => (
              <div key={o} role="option" ref={i === hi ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined} aria-selected={o === value} data-highlighted={i === hi ? '' : undefined}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(o)}
                className={PANEL_ITEM}>
                {o === value && <Check className="absolute left-1.5 h-3.5 w-3.5 text-[var(--color-accent)]" />}
                <span className="truncate">{o}</span>
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
