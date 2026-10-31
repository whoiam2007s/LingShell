// 跨功能共用的表单 / 布局小件（原先在 settings/ui.tsx 与各功能里各一份）。
// 放在 components 是为了让功能目录不必为了一个 HelpTip 去 import 设置功能（那会把整个设置弹窗拉进来，形成循环依赖）
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { Input } from './Input.js'
import { Select } from './Select.js'
import { PasswordInput } from './PasswordInput.js'
import { cn } from '../../lib/cn.js'

/** 问号图标，悬停 / 键盘聚焦显示完整说明。浮层挂 body 且 fixed 定位，不会被滚动容器裁掉 */
export function HelpTip({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const up = r.bottom + 160 > window.innerHeight   // 下方放不下就往上
    setPos({ x: Math.min(Math.max(r.left + r.width / 2, 170), window.innerWidth - 170), y: up ? r.top - 6 : r.bottom + 6, up })
  }
  return (
    <span ref={ref} tabIndex={0} aria-label={tr('tip|说明')} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}
      className={cn('inline-flex shrink-0 cursor-help items-center text-[var(--color-text-muted)] outline-none hover:text-[var(--color-accent)] focus-visible:text-[var(--color-accent)]', className)}>
      <CircleHelp className="h-3.5 w-3.5" />
      {pos && createPortal(
        <div role="tooltip" style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.up ? '-100%' : '0'})` }}
          className="pointer-events-none fixed z-[200] w-max max-w-[320px] whitespace-normal rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2.5 py-2 text-[11.5px] font-normal leading-[1.6] text-[var(--color-text-secondary)] shadow-lg">
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** 分组卡片：标题（可带说明 / 右侧操作）+ 若干行，行间细分隔线 */
export function Section({ title, tip, actions, children, className }: { title?: string; tip?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section data-setting-section={title} className={cn('rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]', className)}>
      {title && (
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3.5 py-2">
          <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
          {tip && <HelpTip>{tip}</HelpTip>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="divide-y divide-[var(--color-border-subtle)]">{children}</div>
    </section>
  )
}

/**
 * 设置行。label 简短（≤ 12 字左右），hint 一句话灰字（可选），tip 是完整说明（问号 hover）。
 * 控件默认靠右；wide=true 时控件另起一行占满（文本框、多行输入、规则列表等）。
 */
export function Row({ label, hint, tip, children, wide, danger }: { label: React.ReactNode; hint?: React.ReactNode; tip?: React.ReactNode; children?: React.ReactNode; wide?: boolean; danger?: boolean }) {
  const head = (
    <div className="min-w-0 flex-1">
      <div className={cn('flex items-center gap-1.5 text-[12.5px]', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>
        <span>{label}</span>{tip && <HelpTip>{tip}</HelpTip>}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  )
  // data-setting：命令面板搜到设置项后据此滚动定位（见 SettingsModal 的 focus）
  const anchor = typeof label === 'string' ? label : undefined
  if (wide) return <div data-setting={anchor} className="space-y-2 px-3.5 py-2.5">{head}{children}</div>
  return <div data-setting={anchor} className="flex min-h-[44px] items-center gap-4 px-3.5 py-2">{head}{children && <div className="flex shrink-0 items-center gap-2">{children}</div>}</div>
}

/** 输入框统一样式（宽度由调用方给）；单行高 32px，与 Select / NumberInput 的 md 档一致 */
export const INPUT = 'rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
/** 次要按钮 */
export const BTN2 = 'shrink-0 rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'
/** 多行输入 */
export const TEXTAREA = `${INPUT} w-full resize-y text-[12px]`

/** 单行输入（密码框自动换成 PasswordInput） */
export function Inp({ value, onChange, type = 'text', placeholder }: { value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  if (type === 'password') return <PasswordInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
  return <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
}
/** 下拉（原生 select 外观，统一组件） */
export function Sel({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return <Select value={value} onValueChange={onChange}>{children}</Select>
}
