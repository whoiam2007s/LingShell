import { useMemo, useState } from 'react'
import { ChevronRight, Brain } from 'lucide-react'
import { charCount, fmtChars, tr } from '@lingshell/shared'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { ReasoningElapsed } from './TurnTime.js'

// AI 思考过程：可折叠，默认收起。标题行：「思考过程 · 12.3秒 · 1,234 字」（时长没有记录就只显示字数）
// live = 所在回合仍在进行（决定未结束的思考块是否实时计时）
export function ReasoningItem({ item, streaming, live = false }: { item: ConvItem; streaming: boolean; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const preview = item.text.slice(0, 60).replace(/\n/g, ' ')
  const chars = useMemo(() => charCount(item.text), [item.text])
  // 模型有时返回空的思考块（如 DeepSeek 先说话再调工具的那一步）：结束后没内容就不显示，免得出现点开为空的折叠行
  if (item.status !== 'in_progress' && !item.text.trim()) return null
  return (
    <div className="animate-fade-in px-3 py-1">
      {/* 不带头像：AI 头像由所在回合统一出一个 */}
      <div className="min-w-0">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-[var(--color-reasoning)] transition-colors hover:bg-[var(--color-bg-hover)]"
        >
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <Brain className={cn('h-3 w-3 shrink-0', streaming && 'animate-pulse-dim')} />
          <span className="flex min-w-0 items-center gap-1 text-[var(--color-text-muted)]">
            <span className="shrink-0">{streaming ? tr('正在思考…') : tr('思考过程')}</span>
            <ReasoningElapsed item={item} live={live} />
            {chars > 0 && (
              <span data-reasoning-chars className="shrink-0 tabular-nums" title={tr('思考内容的字符数：汉字、字母、数字、标点、空白各算 1 个')}>· {fmtChars(chars)}</span>
            )}
            {!open && preview && <span className="ml-1 truncate opacity-70">{preview}…</span>}
          </span>
        </button>
        {open && (
          <div className="ml-6 mt-1 border-l border-[var(--color-border-subtle)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
            <span className={cn('whitespace-pre-wrap', streaming && 'stream-cursor')}>{item.text}</span>
          </div>
        )}
      </div>
    </div>
  )
}
