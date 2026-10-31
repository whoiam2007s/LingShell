import { useEffect, useRef, useState } from 'react'
import { X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import { startTransferSync, useTransfers, openTransferPanel } from './transferStore.js'
import { summarize, isActive } from './transferView.js'
import { tr } from '@lingshell/shared'

// 右下角汇总浮层：「3 个传输进行中 · 45%」，点开传输面板。
// 这一批全部结束后显示结果：全部成功 4 秒后自动收起；有失败的一直留着，等点开或关掉。
export function TransferToast() {
  const { tasks, open } = useTransfers()
  useEffect(() => startTransferSync(), [])
  const batch = useRef(new Set<string>())   // 本批（浮层出现以来）进过队列的任务
  const [hidden, setHidden] = useState(true)

  const s = summarize(tasks)
  for (const t of tasks) if (isActive(t)) batch.current.add(t.taskId)
  const mine = tasks.filter((t) => batch.current.has(t.taskId))
  const failed = mine.filter((t) => t.state === 'error').length
  const ok = mine.filter((t) => t.state === 'done').length

  // 只有「新一批传输开始」或「本批全部结束」时重新出现；用户在批次中途收起后，进度变化不再把它弹回来
  const prevActive = useRef(0)
  useEffect(() => {
    if (s.active === 0 || prevActive.current === 0) setHidden(false)
    prevActive.current = s.active
  }, [s.active])
  useEffect(() => {
    if (s.active > 0 || hidden || failed) return
    const h = setTimeout(() => { setHidden(true); batch.current.clear() }, 4000)
    return () => clearTimeout(h)
  }, [s.active, hidden, failed])

  const dismiss = () => { setHidden(true); batch.current.clear() }
  const show = !hidden && !open && mine.length > 0   // 面板开着时不重复显示
  return (
    <>
      {show && (
        <div className="fixed bottom-4 right-4 z-[80] w-64 cursor-pointer rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-3 shadow-2xl"
          title={tr('打开传输面板')} onClick={() => { openTransferPanel(); if (!s.active) dismiss() }}>
          <div className="flex items-center gap-2 text-[12px]">
            {s.active ? <Loader2 className="h-3.5 w-3.5 animate-spin-slow text-[var(--color-accent)]" />
              : failed ? <AlertCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />
              : <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" />}
            <span className="font-medium text-[var(--color-text-primary)]">
              {s.active ? tr('{n} 个传输进行中 · {p}%', { n: s.active, p: s.percent })
                : failed ? (ok ? tr('{failed} 个传输失败，{ok} 个完成', { failed, ok }) : tr('{n} 个传输失败', { n: failed }))
                : tr('{n} 个传输已完成', { n: ok })}
            </span>
            <button onClick={(e) => { e.stopPropagation(); dismiss() }} title={tr('收起（传输继续在后台进行）')}
              className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X className="h-3 w-3" /></button>
          </div>
          {s.active > 0 && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
              <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${s.percent}%` }} />
            </div>
          )}
        </div>
      )}
    </>
  )
}
