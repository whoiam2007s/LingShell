import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2, Loader2 } from 'lucide-react'
import { tr, type RollbackCheck, type RollbackResult } from '@lingshell/shared'
import { trx } from '../../lib/trx.js'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

// 回滚执行后广播：执行记录面板与对话里的工具卡片据此刷新「已回滚」状态
export const AUDIT_CHANGED = 'lingshell:audit-changed'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// 「一键回滚」确认框（执行记录 / 对话工具卡片共用）：先 check 展示回滚命令、在哪个终端执行、规则 / 授权判定，
// 确认后经该终端执行并显示结果。只能按钮 / Esc 关闭（不点遮罩关）
export function RollbackDialog({ target, onClose, onDone }: {
  target: { sessionId: string; at: string } | undefined
  onClose: () => void
  onDone?: () => void
}) {
  const [check, setCheck] = useState<RollbackCheck>()
  const [err, setErr] = useState('')
  const [ack, setAck] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RollbackResult>()
  useEffect(() => {
    setCheck(undefined); setErr(''); setAck(false); setResult(undefined); setRunning(false)
    if (target) client.rollback.check(target.sessionId, target.at).then(setCheck).catch((e) => setErr(errMsg(e)))
  }, [target])
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, running, onClose])
  if (!target) return null

  const run = () => {
    setRunning(true); setErr('')
    client.rollback.run(target.sessionId, target.at, ack)
      .then((r) => { setResult(r); onDone?.(); window.dispatchEvent(new Event(AUDIT_CHANGED)) })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setRunning(false))
  }
  const blocked = !check || check.verdict === 'deny' || (check.dangerous && !ack)

  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm animate-fade-in">
      <div data-rollback-dialog className="w-[520px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-5 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-[var(--color-text-primary)]">
          <Undo2 className="h-4 w-4 text-[var(--color-warn)]" />{tr('一键回滚')}
        </div>
        {!check && !err && <div className="flex items-center gap-1.5 py-3 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin-slow" />{tr('检查中…')}</div>}
        {check && (
          <>
            <p className="mb-2 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)]">
              {trx('将在终端 {term} 执行下面的回滚命令', { term: <code className="rounded bg-[var(--color-bg-raised)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)]">{check.terminalTitle}</code> })}
              {check.prod && <span className="ml-1 rounded bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] px-1 py-px text-[10.5px] text-[var(--color-danger)]">{tr('生产')}</span>}
            </p>
            <pre data-rollback-command className={cn('max-h-40 overflow-auto whitespace-pre-wrap break-all rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed',
              check.dangerous ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]' : 'bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]')}>$ {check.command}</pre>
            {check.note && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('说明：{note}', { note: check.note })}</div>}
            {check.rule && <div className="mt-1 text-[11px] text-[var(--color-accent)]">{tr('按规则：{rule}', { rule: check.rule })}</div>}
            {check.verdict === 'deny' && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{tr('无法回滚：{reason}', { reason: check.reason ?? '' })}</div>}
            {check.verdict === 'confirm' && check.reason && <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">{check.reason}</div>}
            {check.dangerous && check.verdict !== 'deny' && !result && (
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--color-danger)]">
                <Checkbox checked={ack} onCheckedChange={setAck} />{tr('这是危险命令，我已核对无误')}
              </label>
            )}
          </>
        )}
        {result && (
          <div data-rollback-result className="mt-3">
            <div className={cn('text-[12px] font-medium', result.exitCode === 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')}>
              {result.exitCode === 0 ? tr('回滚完成') : tr('回滚命令返回 {code}，请检查输出', { code: result.exitCode })}
            </div>
            {result.output.trim() && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]">{result.output.trim().slice(-4000)}</pre>}
          </div>
        )}
        {err && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={running} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40">{result ? tr('关闭') : tr('取消')}</button>
          {!result && (
            <button onClick={run} disabled={blocked || running} className="flex items-center gap-1 rounded-md bg-[var(--color-warn)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--color-bg-base)] transition-opacity hover:opacity-90 disabled:opacity-40">
              {running && <Loader2 className="h-3.5 w-3.5 animate-spin-slow" />}{tr('执行回滚')}
            </button>
          )}
        </div>
      </div>
    </div>
  ), document.body)
}
