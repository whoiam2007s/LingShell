import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ListTree, Loader2 } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { cn } from '../../../lib/cn.js'

// 【执行过程】折叠容器：把一轮里的中间步骤（工具/思考/todo/中间 text）收起来。
// active=正在执行的轮 → 默认展开，实时看步骤；turn 完成（active 转 false）→ 自动收起。
// 用户手动点过后（touched）不再被自动收起，尊重用户意图。
// duration = 「· N 步」后的整轮耗时；extra = 标题行右侧（如「开始回答 HH:mm:ss」）
// openTick：外部要求展开（终端标记定位到本轮的工具卡），每次递增触发一次
export function TurnSteps({ active, children, count, duration, extra, openTick = 0 }: { active: boolean; children: React.ReactNode; count: number; duration?: React.ReactNode; extra?: React.ReactNode; openTick?: number }) {
  const [open, setOpen] = useState(active || openTick > 0)
  const touched = useRef(false)
  const prevActive = useRef(active)
  useEffect(() => { if (openTick) { touched.current = true; setOpen(true) } }, [openTick])

  // active true→false（本轮执行完毕）且用户没手动干预 → 自动收起
  useEffect(() => {
    if (prevActive.current && !active && !touched.current) setOpen(false)
    prevActive.current = active
  }, [active])

  return (
    <div className="px-3 py-1">
      <button
        onClick={() => { touched.current = true; setOpen((o) => !o) }}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)]"
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        {active ? <Loader2 className="h-3 w-3 shrink-0 animate-spin-slow text-[var(--color-accent)]" /> : <ListTree className="h-3 w-3 shrink-0" />}
        <span>{tr('执行过程')}</span>
        <span className="opacity-70">· {tr('{n} 步', { n: count })}</span>
        {duration}
        {extra && <span className="ml-auto">{extra}</span>}
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  )
}
