import { useEffect, useRef, useState } from 'react'
import { BellRing, Sparkles, X } from 'lucide-react'
import { tr } from '@lingshell/shared'

// 终端关键字告警的提示（左下角：右侧抽屉（告警 / 进程等）从右边滑出，放右边会被挡住）：带「用 AI 排查」，10 秒后自动收起；鼠标停在上面时不收
export function AlertAiToast({ text, onAsk, onClose }: { text: string; onAsk: () => void; onClose: () => void }) {
  const [hover, setHover] = useState(false)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    if (hover) return
    const t = setTimeout(() => close.current(), 10_000)
    return () => clearTimeout(t)
  }, [text, hover])
  return (
    <div data-alert-toast onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className="absolute bottom-2 left-3 z-20 flex max-w-[70%] items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--color-warn)_50%,transparent)] bg-[var(--color-bg-panel)] px-2 py-1 text-[11px] text-[var(--color-warn)] shadow-lg animate-fade-in">
      <BellRing className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate" title={text}>{tr('告警：{text}', { text })}</span>
      <button data-alert-ai onClick={onAsk} title={tr('新开一个会话，把告警和终端最近的输出发给 AI 排查原因')}
        className="flex shrink-0 items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-1.5 py-0.5 font-medium text-[var(--color-bg-base)] hover:opacity-90">
        <Sparkles className="h-3 w-3" />{tr('用 AI 排查')}
      </button>
      <button onClick={onClose} title={tr('关闭')} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
    </div>
  )
}
