import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, ServerCog, AlertTriangle } from 'lucide-react'
import { tr, type TurnHostReport } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { ProfileDiffView } from '../hostcheck/index.js'

// 回合末「本轮主机变化」（变更保险）：AI 这一轮第一次改某台 Linux SSH 主机前、和这一轮结束时各拍一次轻量快照，
// 有变化才出这条（端口 / 失败服务 / 容器 / 关键配置文件），可展开看明细与配置文件差异。快照拍完才生成，比回合结束晚几秒出现

/** 本会话各轮的主机变更报告（turnId → 报告）。会话切换、收到 hostChanges:turn 时重取 */
export function useTurnHostChanges(sessionId: string) {
  const [map, setMap] = useState<Map<string, TurnHostReport>>(new Map())
  const refresh = useCallback(() => {
    if (!sessionId) { setMap(new Map()); return }
    client.hostChanges.list(sessionId).then((rs) => setMap(new Map(rs.map((r) => [r.turnId, r])))).catch(() => setMap(new Map()))
  }, [sessionId])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => client.on((ev) => { if (ev.type === 'hostChanges:turn' && ev.sessionId === sessionId) refresh() }), [sessionId, refresh])
  return map
}

export function TurnHostChangesBar({ data }: { data: TurnHostReport }) {
  const [open, setOpen] = useState(false)
  const changed = data.hosts.filter((h) => h.summary.length)
  const multi = data.hosts.length > 1
  const title = changed.map((h) => `${multi ? `${h.hostLabel ?? h.hostKey}${tr('：')}` : ''}${h.summary.join(tr('、'))}`).join(tr('；'))
  return (
    <div data-turn-host-changes className="mx-3 mb-1 mt-1.5 overflow-hidden rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
      <button onClick={() => setOpen((v) => !v)} title={title}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <ServerCog className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <span className="shrink-0">{tr('本轮主机变化：')}</span>
        <span data-turn-host-summary className="min-w-0 truncate">{title}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-[var(--color-border-subtle)] px-2 py-1.5">
          {data.hosts.map((h) => (
            <div key={h.hostKey}>
              {multi && <div className="mb-0.5 text-[11px] font-medium text-[var(--color-text-primary)]">{h.hostLabel ?? h.hostKey}</div>}
              {h.error && <div className="flex items-center gap-1 text-[10.5px] text-[var(--color-warn)]"><AlertTriangle className="h-3 w-3" />{h.error}</div>}
              {!h.error && <ProfileDiffView diff={h.diff} hostKey={h.hostKey} empty={tr('这台主机没有变化')} legend={tr('本轮改动前 → 改动后')} />}
            </div>
          ))}
          <div className="pt-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('改动前后各拍一次快照比较（端口 / 失败服务 / 容器 / 关键配置文件），快照也在该主机的「主机体检」档案里。')}</div>
        </div>
      )}
    </div>
  )
}
