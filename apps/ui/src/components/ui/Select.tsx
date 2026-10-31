import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '../../lib/cn.js'
import { CONTROL_BOX, CONTROL_SIZE, PANEL, PANEL_ITEM, type ControlSize } from './control.js'
import { UI_LAYER, markUiLayerClosed } from './layer.js'

/**
 * shadcn 风格下拉（Radix Select）：深色面板、选中项打勾、键盘上下 / 回车 / 首字母跳转、分组、分隔线、禁用项。
 * 选项两种写法任选：
 *  - options：[{ value, label, disabled }] / { group, options } / 'separator'
 *  - children：沿用原生写法 <option value>文字</option> / <optgroup label>…</optgroup> / <hr />，迁移时只改外壳
 * actions：面板底部的操作项（如「新建命令组…」），选中时调 onSelect，不改变当前值。
 * Radix 不允许空字符串做值，这里内部映射成哨兵，对外仍是 ''。
 */
export type SelectOption = { value: string; label: ReactNode; disabled?: boolean; title?: string }
export type SelectEntry = SelectOption | { group: string; options: SelectOption[] } | 'separator'
export type SelectAction = { label: ReactNode; onSelect: () => void; disabled?: boolean }

const EMPTY = '__empty__'
const ACTION = '__action__:'
const enc = (v: string) => (v === '' ? EMPTY : v)
const dec = (v: string) => (v === EMPTY ? '' : v)

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean; title?: string; label?: string }

/** 把 <option>/<optgroup>/<hr> 子元素（可夹 Fragment、数组、条件 false）展开成 entries */
export function parseChildren(children: ReactNode): SelectEntry[] {
  const out: SelectEntry[] = []
  const toOpt = (el: ReactElement<OptionProps>): SelectOption => {
    const p = el.props
    const label = p.children ?? p.label ?? ''
    return { value: String(p.value ?? (typeof label === 'string' ? label : '')), label, disabled: p.disabled, title: p.title }
  }
  const walk = (nodes: ReactNode, into: SelectEntry[] | SelectOption[]) => {
    Children.forEach(nodes, (n) => {
      if (!isValidElement(n)) return
      const el = n as ReactElement<OptionProps & { label?: string; children?: ReactNode }>
      if (el.type === 'option') (into as SelectEntry[]).push(toOpt(el))
      else if (el.type === 'optgroup') {
        const opts: SelectOption[] = []
        walk(el.props.children, opts)
        out.push({ group: String(el.props.label ?? ''), options: opts })
      } else if (el.type === 'hr') out.push('separator')
      else walk(el.props.children, into)   // Fragment 等容器
    })
  }
  walk(children, out)
  return out
}

export function Select({ value, onValueChange, options, children, actions, placeholder, disabled, size = 'md', className, contentClassName, title, id, 'aria-label': ariaLabel }: {
  value: string
  onValueChange: (v: string) => void
  options?: SelectEntry[]
  children?: ReactNode
  actions?: SelectAction[]
  placeholder?: ReactNode
  disabled?: boolean
  size?: ControlSize
  /** 触发器类名（宽度等） */
  className?: string
  contentClassName?: string
  title?: string
  id?: string
  'aria-label'?: string
}) {
  const entries = options ?? parseChildren(children)
  // 值为 '' 且没有 '' 这一项时交给 Radix 显示 placeholder
  const hasEmpty = entries.some((e) => e !== 'separator' && ('group' in e ? e.options.some((o) => o.value === '') : e.value === ''))
  const rootValue = value === '' && !hasEmpty ? '' : enc(value)
  const item = (o: SelectOption) => (
    <SelectPrimitive.Item key={o.value} value={enc(o.value)} disabled={o.disabled} title={o.title} className={PANEL_ITEM}>
      <span className="absolute left-1.5 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator><Check className="h-3.5 w-3.5 text-[var(--color-accent)]" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
  const sep = (k: string) => <SelectPrimitive.Separator key={k} className="-mx-1 my-1 h-px bg-[var(--color-border-default)]" />
  return (
    <SelectPrimitive.Root value={rootValue} disabled={disabled} onOpenChange={(o) => { if (!o) markUiLayerClosed() }}
      onValueChange={(v) => {
        if (v.startsWith(ACTION)) { actions?.[Number(v.slice(ACTION.length))]?.onSelect(); return }
        onValueChange(dec(v))
      }}>
      <SelectPrimitive.Trigger id={id} title={title} aria-label={ariaLabel} data-ui="select"
        className={cn(CONTROL_BOX, CONTROL_SIZE[size], 'flex w-full min-w-0 items-center justify-between gap-1.5 text-left data-[placeholder]:text-[var(--color-text-muted)] [&>span]:truncate', className)}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild><ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} {...UI_LAYER}
          // Esc 只关面板，别再冒泡到外层弹窗的 Esc 关闭
          onEscapeKeyDown={(e) => e.stopPropagation()}
          className={cn(PANEL, 'max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)]', contentClassName)}>
          <SelectPrimitive.ScrollUpButton className="flex h-5 items-center justify-center text-[var(--color-text-muted)]"><ChevronUp className="h-3.5 w-3.5" /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {entries.map((e, i) => e === 'separator' ? sep(`s${i}`)
              : 'group' in e ? (
                <SelectPrimitive.Group key={`g${i}`}>
                  <SelectPrimitive.Label className="px-2 pb-0.5 pt-1.5 text-[11px] text-[var(--color-text-muted)]">{e.group}</SelectPrimitive.Label>
                  {e.options.map(item)}
                </SelectPrimitive.Group>
              ) : item(e))}
            {actions && actions.length > 0 && <>
              {sep('actions')}
              {actions.map((a, i) => (
                <SelectPrimitive.Item key={`a${i}`} value={`${ACTION}${i}`} disabled={a.disabled} className={cn(PANEL_ITEM, 'text-[var(--color-text-secondary)]')}>
                  <SelectPrimitive.ItemText>{a.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </>}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-5 items-center justify-center text-[var(--color-text-muted)]"><ChevronDown className="h-3.5 w-3.5" /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
