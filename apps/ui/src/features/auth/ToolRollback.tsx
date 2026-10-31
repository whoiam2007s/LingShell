import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { rollbackStatus, tr, type AuditEntry } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { RollbackDialog, AUDIT_CHANGED } from './RollbackDialog.js'

// 对话里工具卡片所属的会话（ChatPanel 提供）：卡片按 callId 在该会话的执行记录里找到这次执行
export const ToolSessionContext = createContext<string | null>(null)

// exec_in_terminal 卡片底部的回滚条：回滚命令 + 「回滚」按钮 / 「已回滚」。与执行记录的「一键回滚」同一逻辑
export function ToolRollback({ callId, rollback }: { callId: string; rollback: string }) {
  const sessionId = useContext(ToolSessionContext)
  const [rec, setRec] = useState<AuditEntry>()
  const [status, setStatus] = useState<'none' | 'done' | 'failed'>('none')
  const [target, setTarget] = useState<{ sessionId: string; at: string }>()
  const load = useCallback(() => {
    if (!sessionId) return
    client.audit.listForSession(sessionId).then((rows) => {
      const r = rows.find((x) => x.callId === callId && x.decision.startsWith('exec_allowed'))
      setRec(r)
      if (r) setStatus(rollbackStatus(rows, r))
    }).catch(() => {})
  }, [sessionId, callId])
  useEffect(() => { load() }, [load])
  useEffect(() => { window.addEventListener(AUDIT_CHANGED, load); return () => window.removeEventListener(AUDIT_CHANGED, load) }, [load])
  if (!rec?.rollback) return null   // 没执行成功落记录（被拒 / 出错）就没有可回滚的
  return (
    <div data-tool-rollback className="flex items-center gap-1.5 px-2.5 pb-1.5 pl-[42px] text-[11px] text-[var(--color-text-muted)]">
      <code className="min-w-0 flex-1 truncate font-mono" title={rollback}>{tr('回滚：{cmd}', { cmd: rollback })}</code>
      {status === 'done' ? (
        <span className="shrink-0 rounded bg-[color:color-mix(in_srgb,var(--color-success)_12%,transparent)] px-1.5 py-px text-[10.5px] text-[var(--color-success)]">{tr('已回滚')}</span>
      ) : (
        <button onClick={() => setTarget({ sessionId: rec.sessionId, at: rec.at })} title={status === 'failed' ? tr('上次回滚失败，可再试') : tr('执行 AI 给出的回滚命令（会先确认）')}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-px text-[10.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-warn)]">
          <Undo2 className="h-3 w-3" />{status === 'failed' ? tr('重试回滚') : tr('回滚')}
        </button>
      )}
      <RollbackDialog target={target} onClose={() => setTarget(undefined)} />
    </div>
  )
}
