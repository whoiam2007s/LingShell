import { forwardRef } from 'react'
import { cn } from '../../lib/cn.js'
import { CONTROL_BOX, CONTROL_SIZE, type ControlSize } from './control.js'

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'list'> & { size?: ControlSize }

/** 单行输入框：深色底、聚焦 accent 边框，高度两档与 Select / NumberInput 一致。不支持 list（候选用 Combobox） */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ size = 'md', className, ...props }, ref) {
  return <input ref={ref} {...props} className={cn(CONTROL_BOX, CONTROL_SIZE[size], 'w-full min-w-0', className)} />
})

/** 多行输入框：样式同 Input，高度由 rows / className 决定 */
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} {...props} className={cn(CONTROL_BOX, 'w-full min-w-0 px-2.5 py-1.5 text-[12.5px] leading-[1.5]', className)} />
})
