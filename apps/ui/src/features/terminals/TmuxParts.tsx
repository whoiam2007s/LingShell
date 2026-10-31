import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Layers } from 'lucide-react'
import { dateLocale, tr, type TerminalInfo, type TmuxSessionInfo } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'
import { client } from '../../client/index.js'

// 保持会话（tmux）相关的小部件：关标签时后台有任务的三选一确认、右键菜单里的会话状态与「接回保留的会话」

const BTN = 'rounded-md border border-[var(--color-border-default)] px-3 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]'

export function TmuxCloseDialog({ jobs, unknown, onKill, onKeep, onCancel }: { jobs: string[]; unknown?: boolean; onKill: () => void; onKeep: () => void; onCancel: () => void }) {
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="w-[380px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <AlertTriangle className="h-4 w-4 text-[var(--color-danger)]" />{tr('关闭终端')}
        </div>
        <p className="mb-4 break-words text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
          {unknown ? tr('暂时查不到后台任务（连接忙或超时），关闭可能中断正在运行的任务。')
            : trx('后台还有任务在运行：{jobs}。', { jobs: <code className="text-[var(--color-text-primary)]">{jobs.join(tr('list|、'))}</code> })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
          <button onClick={onKeep} className={BTN}>{tr('关闭但保留在服务器上')}</button>
          <button onClick={onKill} className="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-on-danger)] hover:opacity-90">{tr('关闭并结束')}</button>
        </div>
      </div>
    </div>
  ), document.body)
}

// 右键菜单里的一段：本终端是否在保持会话里 + 同主机上保留着的会话（点击接回，开新标签）
export function TmuxMenuSection({ term, onAttach, itemClass }: { term: TerminalInfo; onAttach?: (name: string) => void; itemClass: string }) {
  const [kept, setKept] = useState<TmuxSessionInfo[]>([])
  useEffect(() => {
    if (!term.tmux || term.status !== 'running') return
    client.terminal.tmuxSessions(term.id).then(setKept).catch(() => {})
  }, [term.id])
  return (
    <>
      <div title={term.tmux ? tr('远端 tmux 会话 {name}：断线 / 重启应用后自动接回', { name: term.tmux }) : tr('在「设置 → 主机与连接」里给主机开启「断线后保持会话（tmux）」')}
        className="flex items-center gap-2 px-2.5 py-1.5 text-[var(--color-text-muted)]">
        <Layers className="h-3.5 w-3.5" />{tr('保持会话：')}{term.tmux ? <span className="text-[var(--color-success)]">{tr('已开启')}</span> : tr('未开启')}
      </div>
      {kept.length > 0 && onAttach && (
        <>
          <div className="px-2.5 pt-0.5 text-[10px] text-[var(--color-text-muted)]">{tr('服务器上有 {n} 个保留的会话', { n: kept.length })}</div>
          {kept.map((s) => (
            <button key={s.name} onClick={() => onAttach(s.name)} title={s.attached ? tr('接回 {name}（另有客户端连着）', { name: s.name }) : tr('接回 {name}', { name: s.name })} className={itemClass}>
              <span className="min-w-0 flex-1 truncate">{s.command || s.name}</span>
              <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{s.createdAt ? new Date(s.createdAt).toLocaleString(dateLocale()) : ''}</span>
            </button>
          ))}
        </>
      )}
    </>
  )
}
