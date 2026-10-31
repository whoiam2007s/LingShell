import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn.js'

// shadcn 风格开关，适配项目 hex 变量：开启态 track=accent，关闭态=border；thumb 白点滑动。
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--color-accent)_50%,transparent)] disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-[var(--color-accent)] data-[state=unchecked]:bg-[var(--color-border-default)]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  )
}
