// 会话标题栏的「子代理」下拉：这个会话派过哪些子代理、各自状态与耗时，点一行看总结。
// 只存内存（重启就没了）——列表是「这次在干什么」的窗口，不是存档；要看过程进子会话记录。
//
// 一行只显示「标题」（模型给的一句话，或 task 首句截 40 字）：完整 prompt 收进详情，
// 下拉与悬停提示都出在按钮正下方居中（与对话区 hover 模型的 tooltip 一致），不再用原生 title。
import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Loader2, Check, X, MessageCircleQuestion, Terminal } from 'lucide-react'
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

/** 浮层统一位置：按钮正下方居中（窗口再窄也不出屏） */
const BELOW_CENTER = 'absolute left-1/2 top-full z-40 mt-1 -translate-x-1/2'

export function SubagentBadge({ sessionId, live = false }: { sessionId: string; live?: boolean }) {
  const [list, setList] = useState<SubagentView[]>([])
  // 后台任务（start_background 起的）：只显示还在跑的，跑完自动消失（不持久化）
  const [bg, setBg] = useState<{ jobId: string; command: string; startedAt: number }[]>([])
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [detail, setDetail] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  // live（回合进行中）时轮询几次：子代理跑起来/结束时状态要跟着变。
  // 空闲时只有「还有东西在显示」才继续轮询 —— 否则每个面板每 5 秒都在问一次内存表，
  // 而且每次都拿到新数组、白触发一次重渲染（自评审发现）
  const active = live || list.length > 0 || bg.length > 0
  useEffect(() => {
    let alive = true
    // 内容没变就保持原引用，别让轮询把界面每 3 秒重渲一次
    type Row = { jobId?: string; id?: string; status?: string; steps?: unknown[] }
    const keyOf = (x: Row) => `${x.jobId ?? x.id ?? ''}|${x.status ?? ''}|${x.steps?.length ?? 0}`
    const same = (a: Row[], b: Row[]) => a.length === b.length && a.every((x, i) => keyOf(x) === keyOf(b[i]))
    const load = () => {
      void client.subagent.list(sessionId).then((l: SubagentView[]) => { if (alive) setList((cur) => (same(cur, l) ? cur : l)) }).catch(() => {})
      void client.bg.list(sessionId).then((l) => { if (alive) setBg((cur) => (same(cur, l) ? cur : l)) }).catch(() => {})
    }
    load()   // 先查一次：从「空闲且空」的状态也要能发现刚起来的任务
    if (!active) return () => { alive = false }
    const t = setInterval(load, live ? 3000 : 5000)
    return () => { alive = false; clearInterval(t) }
  }, [sessionId, live, active])

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!list.length && !bg.length) return null
  const running = list.filter((x) => x.status === 'running').length
  const tip = tr('这个会话派过的子代理（{n} 个）', { n: list.length })

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button onClick={() => setOpen((o) => !o)} aria-label={tip} aria-expanded={open}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)} onBlur={() => setHover(false)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors hover:bg-[var(--color-bg-hover)]">
        {/* 图标跟名字同一个主题色；正在跑的在名字后面挂一个转圈（一眼看出还在动） */}
        {!!list.length && (
          <span data-badge-subagent className={cn('flex items-center gap-1', running ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]')}>
            <Bot className="h-3 w-3" />
            {tr('子代理 {n}', { n: list.length })}
            {running > 0 && <Loader2 className="h-3 w-3 animate-spin-slow" />}
          </span>
        )}
        {!!bg.length && (
          <span data-badge-bg className="flex items-center gap-1 text-[var(--color-accent)]">
            <Terminal className="h-3 w-3" />
            {tr('后台 {n}', { n: bg.length })}
            <Loader2 className="h-3 w-3 animate-spin-slow" />
          </span>
        )}
        <ChevronDown className={cn('h-3 w-3 text-[var(--color-text-muted)] transition-transform', open && 'rotate-180')} />
      </button>
      {hover && !open && (
        <div data-subagent-tip className={`${BELOW_CENTER} pointer-events-none whitespace-nowrap rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] shadow-lg`}>
          {tip}
        </div>
      )}
      {open && (
        <div className={`${BELOW_CENTER} max-h-[min(420px,60vh)] w-[min(500px,calc(100vw-24px))] overflow-y-auto rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-xl`}>
          {/* 后台任务：只列还在跑的，跑完自动从列表消失（内存态，不落盘） */}
          {bg.map((t) => (
            <div key={t.jobId} data-bg-task className="flex items-center gap-2 rounded-md border-b border-[var(--color-border-subtle)] px-2 py-1.5 last:border-b-0">
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-warn)]"><Loader2 className="h-3 w-3 animate-spin-slow" />{tr('后台')}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]" title={t.command}>{t.command}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-text-muted)]">{fmtMs(Date.now() - t.startedAt)}</span>
              <button onClick={() => void client.bg.cancel(sessionId).catch(() => {})} title={tr('停止这个会话的后台任务（进程真的会被杀掉）')}
                className="shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)]"><X className="h-3 w-3" /></button>
            </div>
          ))}
          {list.map((x) => (
            <div key={x.subagentId} className="rounded-md border-b border-[var(--color-border-subtle)] px-2 py-1.5 last:border-b-0">
              <button onClick={() => setDetail(detail === x.subagentId ? undefined : x.subagentId)}
                className="flex w-full items-center gap-2 text-left">
                <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', statusTone(x.status))}>
                  <StatusIcon status={x.status} />{statusText(x.status)}
                </span>
                {/* 只看标题：一行放得下，能一眼分清谁是谁 */}
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-secondary)]">{x.title || x.task}</span>
                {x.elapsedMs !== undefined && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{fmtMs(x.elapsedMs)}</span>}
                <ChevronDown className={cn('h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform', detail === x.subagentId && 'rotate-180')} />
              </button>
              {/* 最近一步：只知道「运行中」看不出卡在哪，这里显示它正在调什么 / 正在写什么 */}
              {x.status === 'running' && x.step && detail !== x.subagentId && (
                <div className="mt-0.5 flex items-center gap-1 pl-[52px] text-[11px] text-[var(--color-text-muted)]">
                  <span className="shrink-0">{x.step.kind === 'tool' ? '⚙' : '✎'}</span>
                  <span className="truncate">{x.step.label}</span>
                </div>
              )}
              {detail === x.subagentId && (
                <div className="mt-1 space-y-1">
                  {x.task && (
                    <div className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px]">
                      <div className="text-[var(--color-text-muted)]">{tr('任务：')}</div>
                      <div className="mt-0.5 whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">{x.task}</div>
                    </div>
                  )}
                  {!!x.steps?.length && (
                    <div className="rounded border border-[var(--color-border-subtle)] px-2 py-1 text-[11px]">
                      <div className="text-[var(--color-text-muted)]">{tr('执行轨迹（{n} 步）：', { n: x.steps.length })}</div>
                      <div className="mt-0.5 max-h-40 space-y-0.5 overflow-auto">
                        {x.steps.map((s, i) => (
                          <div key={i} className="flex items-start gap-1">
                            <span className="shrink-0 text-[var(--color-text-muted)]">{s.kind === 'tool' ? '⚙' : '✎'}</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]" title={s.label}>{s.label}</span>
                            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{s.at.slice(11, 19)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
