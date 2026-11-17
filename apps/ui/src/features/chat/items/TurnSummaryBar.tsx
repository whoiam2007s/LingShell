import { useState } from 'react'
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { tr } from '@lingshell/shared'

/**
 * 回合末的「本轮结论」条。
 *
 * 背景：模型常在调用 propose_host_knowledge 之前把总结写完，而知识卡提议会被 groupTurns
 * 提到 final 前面、那段文字则留在 steps 里（折进【执行过程】容器），于是用户看到时间线
 * 最后一条只有知识卡。这里把被顶掉的那段文字补到回合末，避免「本轮的总结看不到」。
 *
 * 纯 UI 复现，不重新请求模型。
 */
export function TurnSummaryBar({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 160 || text.includes('\n\n')
  return (
    <div className="mt-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1.5" data-turn-summary>
      <button
        type="button"
        onClick={() => long && setOpen((v) => !v)}
        className={`flex w-full items-start gap-1.5 text-left ${long ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0 flex-1">
          <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">{tr('本轮结论')}</span>
          <div
            className={`mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--color-text-primary)] ${
              long && !open ? 'line-clamp-2' : ''
            }`}
          >
            {text}
          </div>
          {long && (
            <span className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-[var(--color-text-muted)]">
              {open ? <><ChevronUp className="h-3 w-3" />{tr('收起')}</> : <><ChevronDown className="h-3 w-3" />{tr('展开全部')}</>}
            </span>
          )}
        </div>
      </button>
    </div>
  )
}
