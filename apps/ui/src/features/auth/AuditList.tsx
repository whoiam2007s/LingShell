import { useCallback, useEffect, useState } from 'react'
import { k8sAuditLabel, dockerAuditLabel, batchAuditLabel, rolloutAuditLabel, gitAuditLabel, gitOpAuditLabel, explorerAuditLabel, systemdAuditLabel, cronAuditLabel, canRollback, rollbackStatus, ROLLBACK_DECISION, type AuditEntry, type HostSummary, tr, tk, dateLocale } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { RotateCcw, BookPlus, Undo2 } from 'lucide-react'
import { RollbackDialog, AUDIT_CHANGED } from './RollbackDialog.js'
import { ConfirmDialog } from '../common/index.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { SaveRunbookDialog } from '../runbooks/index.js'
import { REVIEW_DECISION, SUDO_LEASE_RULE } from '@lingshell/shared'
import { ReviewBadge } from './SafetyBits.js'

const ALLOW_REASON: Record<string, string> = { first_access: tk('首次授权'), elevation: tk('提升为写入'), dangerous_command: tk('危险命令确认'), user: tk('批准'), plan: tk('计划内') }

// decision → 给人看的标签 + 色调。decision 词表见 shared/protocol/types.ts AuditEntry
function describe(d: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (d === 'exec_allowed') return { label: tr('audit|执行'), tone: 'muted' }
  if (d === 'exec_allowed:edited') return { label: tr('改后执行'), tone: 'warn' }
  if (d === 'read_allowed') return { label: tr('audit|读取'), tone: 'muted' }
  if (d === 'upload_allowed') return { label: tr('上传'), tone: 'warn' }
  if (d === 'download_allowed') return { label: tr('下载'), tone: 'warn' }
  if (d === 'write_allowed') return { label: tr('改文件'), tone: 'warn' }
  if (d === 'restored') return { label: tr('已还原'), tone: 'ok' }
  if (d === 'turn_undo') return { label: tr('撤销本轮改动'), tone: 'ok' }
  if (d === ROLLBACK_DECISION) return { label: tr('回滚'), tone: 'warn' }
  if (d === 'user_edit') return { label: tr('手动编辑'), tone: 'warn' }
  if (d === 'file_delete') return { label: tr('删除文件'), tone: 'bad' }
  if (d === 'file_rename') return { label: tr('重命名'), tone: 'warn' }
  if (d === 'mcp_call') return { label: tr('MCP 调用'), tone: 'warn' }
  if (d === 'key_deploy') return { label: tr('部署公钥'), tone: 'warn' }
  if (d === 'process_kill') return { label: tr('进程信号'), tone: 'bad' }   // 进程管理器里发 TERM / KILL / HUP
  if (d === 'db_kill') return { label: tr('数据库·终止会话'), tone: 'bad' }   // 数据库快查里手动终止会话
  if (d === 'db_script') return { label: tr('数据库·执行脚本'), tone: 'bad' }   // 数据库「脚本」页签手动执行
  if (d === 'db_key_del') return { label: tr('数据库·删除 key'), tone: 'bad' }   // 数据库「Key」页签删除 Redis key
  if (d === 'fleet_exec') return { label: tr('跨主机提问'), tone: 'ok' }    // AI 的 run_on_hosts（只读命令）
  const dk = dockerAuditLabel(d) ?? gitAuditLabel(d) ?? gitOpAuditLabel(d) ?? batchAuditLabel(d) ?? rolloutAuditLabel(d) ?? explorerAuditLabel(d) ?? systemdAuditLabel(d) ?? cronAuditLabel(d) ?? k8sAuditLabel(d)   // 用户在容器视图里启停 / 重启、批量执行、资源管理器改权限/压缩/解压、服务视图启停、定时任务视图改 crontab
  if (dk) return { label: dk, tone: 'warn' }   // 这些函数自己已经 tr() 过
  if (d.startsWith('allow:')) return { label: tr(ALLOW_REASON[d.slice(6)] ?? ALLOW_REASON.user), tone: 'ok' }
  if (d === 'deny:preview_mode') return { label: tr('预演拦截（未执行）'), tone: 'warn' }
  if (d.startsWith(`${REVIEW_DECISION}:`)) return { label: tr('AI 复核拦截：{reason}', { reason: d.slice(REVIEW_DECISION.length + 1) }), tone: 'bad' }
  if (d === 'deny:user') return { label: tr('你拒绝'), tone: 'bad' }
  if (d.startsWith('deny:user:')) return { label: tr('你拒绝：{reason}', { reason: d.slice(10) }), tone: 'bad' }
  if (d.startsWith('deny:')) return { label: tr('拦截：{reason}', { reason: d.slice(5) }), tone: 'bad' }
  return { label: d, tone: 'muted' }
}

const TONE = {
  ok: 'text-[var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]',
  warn: 'text-[var(--color-warn)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)]',
  bad: 'text-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]',
  muted: 'text-[var(--color-text-muted)] bg-[var(--color-bg-raised)]',
}

function when(iso: string): string {
  const t = new Date(iso)
  const hm = t.toLocaleTimeString(dateLocale(), { hour12: false })
  return t.toDateString() === new Date().toDateString() ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`
}

// 执行记录：AI 在本会话里读/执行/上传了什么、在哪台主机、谁批准的、退出码。新在前。
export function AuditList({ sessionId, hosts }: { sessionId: string; hosts: HostSummary[] }) {
  const [rows, setRows] = useState<AuditEntry[]>([])
  // 全部会话：想找某次改动不用先记得是在哪个会话里做的
  const [all, setAll] = useState(false)
  const [titles, setTitles] = useState<Map<string, string>>(new Map())
  const refresh = useCallback(() => {
    ;(all ? client.audit.listRecent() : client.audit.listForSession(sessionId)).then(setRows).catch(() => {})
  }, [sessionId, all])
  useEffect(() => {
    if (all) client.agent.listPersisted().then((ms) => setTitles(new Map(ms.map((m) => [m.id, m.title])))).catch(() => {})
  }, [all])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { window.addEventListener(AUDIT_CHANGED, refresh); return () => window.removeEventListener(AUDIT_CHANGED, refresh) }, [refresh])
  // 有新的授权决定或工具跑完就刷新
  useEffect(() => client.on((ev) => {
    if (ev.type === 'auth:resolved' || (ev.type === 'agent:itemUpdated' && ev.kind === 'tool_call' && ev.status !== 'in_progress')) refresh()
  }), [refresh])

  const host = (k: string) => (k === 'local' ? tr('本地') : k.startsWith('mcp:') ? `MCP · ${k.slice(4)}` : hosts.find((h) => h.id === k)?.label ?? k)
  // 「还原」：确认后用该记录的备份覆盖回原文件（覆盖前当前内容同样会备份，并新增一条「已还原」记录）
  const [restoring, setRestoring] = useState<AuditEntry>()
  const [restoreErr, setRestoreErr] = useState<{ at: string; msg: string }>()
  const doRestore = () => {
    const r = restoring
    setRestoring(undefined)
    if (!r) return
    client.audit.restore(r.sessionId, r.at)
      .then(() => { setRestoreErr(undefined); refresh() })
      .catch((e: unknown) => setRestoreErr({ at: r.at, msg: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }))
  }

  // 「一键回滚」：确认框里展示回滚命令，经同主机终端执行（见 RollbackDialog）
  const [rollingBack, setRollingBack] = useState<{ sessionId: string; at: string }>()

  // 「保存为手册」：本会话执行成功的命令沉淀成运维手册
  const [saving, setSaving] = useState(false)
  const canSave = !all && rows.some((r) => r.decision.startsWith('exec_allowed') && r.exitCode === 0)
  const scope = (
    <div className="mb-2 flex items-center">
      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <Checkbox checked={all} onCheckedChange={setAll} />
        {tr('显示全部会话')}
      </label>
      {canSave && (
        <button onClick={() => setSaving(true)} title={tr('把本会话执行成功的命令保存为可重复执行的运维手册')}
          className="ml-auto flex items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
          <BookPlus className="h-3 w-3" />{tr('保存为手册')}
        </button>
      )}
      {saving && <SaveRunbookDialog entries={rows} onClose={() => setSaving(false)} />}
    </div>
  )
  if (rows.length === 0) {
    return <>{scope}<div className="rounded-md border border-dashed border-[var(--color-border-subtle)] px-2.5 py-2 text-[11px] text-[var(--color-text-muted)]">{all ? tr('AI 还没有操作过终端') : tr('本会话 AI 还没有操作过终端')}</div></>
  }
  return (
    <div className="space-y-1.5">
      {scope}
      {rows.map((r, i) => {
        // 写入没有备份 = 新建的文件（没有原文可还原），别标成「改文件」让人以为丢了还原
        const d = r.decision === 'write_allowed' && !r.backupPath ? { label: tr('新建文件'), tone: 'muted' as const }
          : r.rule && r.decision.startsWith('deny:') ? { label: tr('按规则拦截'), tone: 'bad' as const } : describe(r.decision)
        return (
          <div key={`${r.at}-${i}`} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
              <span className="tabular-nums">{when(r.at)}</span>
              <span className="min-w-0 flex-1 truncate" title={r.terminalTitle ?? r.terminalId}>{host(r.hostKey)}{r.terminalTitle ? ` · ${r.terminalTitle}` : ''}</span>
              <span className={cn('max-w-[55%] shrink-0 truncate rounded px-1.5 py-0.5 text-[10px]', TONE[d.tone])} title={d.label}>{d.label}</span>
              {r.via === 'mobile' && <span data-audit-mobile className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', TONE.warn)} title={tr('在已配对的手机上批准 / 拒绝')}>{tr('手机授权')}</span>}
              {r.exitCode !== undefined && (
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums', r.exitCode === 0 ? TONE.muted : TONE.bad)} title={tr('退出码')}>
                  {r.exitCode}{r.truncated ? ` ${tr('超时')}` : ''}
                </span>
              )}
            </div>
            {all && <div className="mt-0.5 truncate text-[10px] text-[color:color-mix(in_srgb,var(--color-accent)_80%,transparent)]" title={r.sessionId}>{tr('会话：{title}', { title: titles.has(r.sessionId) ? tr(titles.get(r.sessionId)!) : tr('（已删除的会话）') })}</div>}
            {r.rule === SUDO_LEASE_RULE
              ? <div data-audit-sudo className="mt-0.5"><span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', TONE.warn)} title={tr('授权卡上选了「本主机 N 分钟内允许提权」，期内这条需要提权的命令未逐条确认')}>{tr(SUDO_LEASE_RULE)}</span></div>
              : r.rule && <div data-audit-rule className="mt-0.5 truncate text-[10.5px] text-[var(--color-accent)]" title={r.rule}>{tr('按规则：{rule}', { rule: r.rule })}</div>}
            {r.review && <ReviewBadge review={r.review} className="mt-1" />}
            {r.command && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{r.command}</pre>
            )}
            {r.filePath && r.backupPath && (
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                <span className="min-w-0 flex-1 truncate" title={r.backupPath}>{tr('备份：{path}', { path: r.backupPath })}</span>
                <button
                  onClick={() => setRestoring(r)}
                  className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
                >
                  <RotateCcw className="h-3 w-3" />{tr('还原')}
                </button>
              </div>
            )}
            {restoreErr?.at === r.at && <div className="mt-1 text-[10px] text-[var(--color-danger)]">{tr('还原失败：{msg}', { msg: restoreErr.msg })}</div>}
            {canRollback(r) && (() => {
              const st = rollbackStatus(rows, r)
              return (
                <div data-audit-rollback className="mt-1 flex items-start gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                  <pre className="min-w-0 flex-1 truncate font-mono" title={`${r.rollback}${r.rollbackNote ? `\n${tr('说明：{note}', { note: r.rollbackNote })}` : ''}`}>{tr('回滚：{cmd}', { cmd: r.rollback ?? '' })}</pre>
                  {st === 'done' ? (
                    <span data-rolled-back className={cn('shrink-0 rounded px-1.5 py-0.5', TONE.ok)}>{tr('已回滚')}</span>
                  ) : (
                    <>
                      {st === 'failed' && <span className={cn('shrink-0 rounded px-1.5 py-0.5', TONE.bad)}>{tr('回滚失败')}</span>}
                      <button onClick={() => setRollingBack({ sessionId: r.sessionId, at: r.at })}
                        className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-warn)]">
                        <Undo2 className="h-3 w-3" />{tr('一键回滚')}
                      </button>
                    </>
                  )}
                </div>
              )
            })()}
            {r.decision.startsWith('exec_allowed') && !r.rollback && r.rollbackNote && (
              <div className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]" title={r.rollbackNote}>{tr('回滚说明：{note}', { note: r.rollbackNote })}</div>
            )}
          </div>
        )
      })}
      <ConfirmDialog
        open={!!restoring}
        title={tr('还原文件')}
        message={restoring ? tr('用 {time} 这次改动前的备份覆盖 {path}？当前内容会先另存一份备份，还原后仍可再还原回来。', { time: when(restoring.at), path: restoring.filePath ?? '' }) : ''}
        confirmText={tr('还原')}
        onConfirm={doRestore}
        onCancel={() => setRestoring(undefined)}
      />
      <RollbackDialog target={rollingBack} onClose={() => setRollingBack(undefined)} onDone={refresh} />
    </div>
  )
}
