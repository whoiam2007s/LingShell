import { forwardRef, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { CONTROL_BOX, CONTROL_SIZE } from './control.js'

/**
 * 每个真实字符显示 1~2 个圆点（随机），并保证总数 ≠ 真实长度，旁人看不出密码有几位。
 * 已有字符的点数保持不变，只对新增 / 删除的尾部做增减，输入时不会整体跳动。
 */
export function maskWeights(prev: number[], len: number, rnd: () => number = Math.random): number[] {
  const w = prev.slice(0, len)
  while (w.length < len) w.push(rnd() < 0.5 ? 1 : 2)
  if (len > 0 && w.reduce((a, b) => a + b, 0) === len) w[len - 1] = 2
  return w
}

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'value'> & { value: string }

/**
 * 密码输入框：右侧眼睛切换明文；隐藏时真实字符透明不可见（光标、选区也透明），上面叠一层数量随机的圆点。
 * className 作用在外框上（与原 <input> 的样式类通用：边框 / 背景 / 宽度 / 内边距），不传则用 md 档默认样式。
 */
export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput({ className, value, onFocus, onBlur, disabled, ...props }, ref) {
  const [show, setShow] = useState(false)
  const [focused, setFocused] = useState(false)
  const weights = useRef<number[]>([])
  weights.current = maskWeights(weights.current, value.length)
  const dots = weights.current.reduce((a, b) => a + b, 0)
  return (
    <div data-password-input className={cn('relative flex items-center gap-1 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]',
      className ?? cn(CONTROL_BOX, CONTROL_SIZE.md, 'w-full'), disabled && 'opacity-50')}>
      <span className="relative flex min-w-0 flex-1 items-center self-stretch">
        <input ref={ref} {...props} type={show ? 'text' : 'password'} value={value} disabled={disabled}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }} onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          className={cn('h-[18px] w-full min-w-0 border-0 bg-transparent p-0 leading-[18px] outline-none placeholder:text-[var(--color-text-muted)]',
            !show && value && 'text-transparent caret-transparent selection:bg-transparent')} />
        {!show && value && (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap tracking-[1px] text-[var(--color-text-primary)]">
            {'•'.repeat(dots)}
            {focused && <span className="ml-px inline-block h-[1.1em] w-px animate-pulse bg-[var(--color-text-primary)]" />}
          </span>
        )}
      </span>
      <button type="button" tabIndex={-1} disabled={disabled} title={show ? tr('隐藏密码') : tr('显示密码')}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setShow((s) => !s)}
        className="flex h-[18px] w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
})

/** 按 secret 决定是密码框还是普通输入框（如自动应答、键盘交互认证里「是否回显」由数据决定的场景） */
export function SecretOrText({ secret, value, ...props }: Props & { secret: boolean }) {
  return secret ? <PasswordInput value={value} {...props} /> : <input value={value} {...props} />
}
