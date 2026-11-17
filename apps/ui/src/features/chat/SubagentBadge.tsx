// 会话标题栏的「子代理」下拉：这个会话派过哪些子代理、各自状态与耗时，点一行看总结。
// 只存内存（重启就没了）——列表是「这次在干什么」的窗口，不是存档；要看过程进子会话记录。
import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Loader2, Check, X, MessageCircleQuestion } from 'lucide-react'
import { fmtMs, tr, type SubagentView } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'

const statusText = (s: SubagentView['status']): string =>
  s === 'running' ? tr('运行中') : s === 'done' ? tr('完成') : s === 'blocked' ? tr('等你拍板') : tr('失败')

const statusTone = (s: SubagentView['status']): string =>
  s === 'running' ? 'text-[var(--color-warn)]' : s === 'done' ? 'text-[var(--color-success)]' : s === 'blocked' ? 'text-[var(--color-warn)]' : 'text-[var(--color-danger)]'

function StatusIcon({ status }: { status: SubagentView['status'] }) {
  if (status === 'running') return <Loader2 className="h-3 w-3 animate-spin-slow" />
  if (status === 'done') return <Check className="h-3 w-3" />
  if (status === 'blocked') return <MessageCircleQuestion className="h-3 w-3" />
  return <X className="h-3 w-3" />
}

export function SubagentBadge({ sessionId, live = false }: { sessionId: string; live?: boolean }) {
  const [list, setList] = useState<SubagentView[]>([])
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  // live（回合进行中）时轮询几次：子代理跑起来/结束时状态要跟着变
  useEffect(() => {
    let alive = true
    const load = () => client.subagent.list(sessionId).then((l: SubagentView[]) => { if (alive) setList(l) }).catch(() => {})
    void load()
    if (!live) return () => { alive = false }
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId, live])

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!list.length) return null
  const running = list.filter((x) => x.status === 'running').length

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button onClick={() => setOpen((o) => !o)} title={tr('这个会话派过的子代理（{n} 个）', { n: list.length })}
        className={cn('flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors hover:bg-[var(--color-bg-hover)]',
          running ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]')}>
        {running ? <Loader2 className="h-3 w-3 animate-spin-slow" /> : <Bot className="h-3 w-3" />}
        <span>{tr('子代理 {n}', { n: list.length })}</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 max-h-[min(420px,60vh)] w-[min(760px,92vw)] overflow-y-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-xl">
          {list.map((x) => (
            <div key={x.subagentId} className="rounded-md border-b border-[var(--color-border-subtle)] px-2 py-1.5 last:border-b-0">
              <button onClick={() => setDetail(detail === x.subagentId ? undefined : x.subagentId)}
                className="flex w-full items-center gap-2 text-left">
                <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', statusTone(x.status))}>
                  <StatusIcon status={x.status} />{statusText(x.status)}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[12px] text-[var(--color-text-secondary)]">{x.task}</span>
                {x.elapsedMs !== undefined && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{fmtMs(x.elapsedMs)}</span>}
              </button>
              {/* 最近一步：只知道「运行中」看不出卡在哪，这里显示它正在调什么 / 正在写什么 */}
              {x.status === 'running' && x.step && (
                <div className="mt-0.5 flex items-center gap-1 pl-[52px] text-[11px] text-[var(--color-text-muted)]">
                  <span className="shrink-0">{x.step.kind === 'tool' ? '⚙' : '✎'}</span>
                  <span className="truncate">{x.step.label}</span>
                </div>
              )}
              {detail === x.subagentId && (
                <div className="mt-1 space-y-1">
                  {x.blocked && (
                    <div className="rounded border border-[var(--color-border-default)] bg-[color:color-mix(in_srgb,var(--color-warn)_8%,transparent)] px-2 py-1 text-[11px]">
                      <div>{tr('问题：')}{x.blocked.question}</div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[var(--color-text-muted)]">{tr('上下文：')}{x.blocked.context}</div>
                    </div>
                  )}
                  {x.summary && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">{x.summary}</pre>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
