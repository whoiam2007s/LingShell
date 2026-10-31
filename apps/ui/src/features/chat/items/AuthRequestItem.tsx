import { useEffect, useState } from 'react'
import { ShieldAlert, ShieldCheck, Shield, ShieldX, Clock, Check, X, Pencil } from 'lucide-react'
import type { ConvItem } from '../useConversation.js'
import { cn } from '../../../lib/cn.js'
import { client } from '../../../client/index.js'
import { DiffView } from '../../../components/DiffView.js'
import { ReviewBadge, SudoLeasePick } from '../../auth/index.js'
import { SUDO_LEASE_DEFAULT, tr } from '@lingshell/shared'
import { trx } from '../../../lib/trx.js'

// 授权请求卡片：会话向某终端请求读/写权限，用户在对话时间线里点 [允许]/[拒绝]。
// 允许前可改命令（仅 exec_in_terminal）；拒绝时可写原因，原因会作为工具结果交给 AI。
export function AuthRequestItem({ item }: { item: ConvItem }) {
  const a = item.auth
  if (!a) return null
  return <AuthRequestCard auth={a} />
}

function AuthRequestCard({ auth: a }: { auth: NonNullable<ConvItem['auth']> }) {
  const resolved = a.result // undefined | 'allow' | 'deny' | 'timeout'
  const [remain, setRemain] = useState(Math.ceil(a.deadlineMs / 1000))
  // 授权粒度是 hostKey（a.terminalId 现填 hostKey）：'local'→「本地」；hostId→主机 label（user@host）；查不到回退裸值
  const [termLabel, setTermLabel] = useState(a.terminalId === 'local' ? tr('本地') : a.terminalId)
  useEffect(() => {
    if (a.terminalId === 'local') { setTermLabel(tr('本地')); return }
    if (a.terminalId.startsWith('mcp:')) return
    client.hosts.list().then((hs) => {
      const h = hs.find((x) => x.id === a.terminalId)
      if (h) setTermLabel(tr('{name}（{target}）', { name: h.label, target: `${h.username}@${h.host}` }))
    }).catch(() => {})
  }, [a.terminalId])

  useEffect(() => {
    if (resolved) return
    const t = setInterval(() => setRemain((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [resolved])

  const danger = a.risk === 'dangerous'
  const reasonText =
    a.mcp ? tr('外部工具可能产生副作用，每次调用都需确认（可在 设置 → MCP 服务 里把该工具标为免确认）')
    : a.tool === 'write_file' ? tr('确认以下改动？覆盖前会自动备份原文件，可在执行记录里还原')
    : a.tool === 'download_file' ? tr('确认把该文件下载到本机？')
    : a.reason === 'dangerous_command' ? tr('此命令命中危险模式，确认执行？')
    : a.rule && a.reason === 'elevation' ? tr('命令命中「总是询问」规则，确认执行？')
    : a.reason === 'elevation' ? tr('请求将权限提升到写入')
    : a.tool === 'run_on_hosts' ? tr('跨主机提问：首次访问这些主机（只读命令，各台独立通道执行，不占用终端）')
    : tr('首次访问该终端')
  const permText = a.needed === 'write' ? tr('写入') : tr('读取')
  const editable = a.tool === 'exec_in_terminal' && !!a.command
  const withRollback = a.tool === 'exec_in_terminal' && !!(a.rollback || a.rollbackNote || a.rollbackMissing)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(a.command ?? '')
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState('')
  const [sent, setSent] = useState<{ command?: string; note?: string; sudo?: number }>()   // 本卡提交了什么，决定后回显
  const [sudo, setSudo] = useState({ on: false, minutes: SUDO_LEASE_DEFAULT })   // 「本主机 N 分钟内允许提权」
  const allow = () => {
    const command = editing && draft.trim() && draft.trim() !== a.command?.trim() ? draft.trim() : undefined
    const sudoMinutes = a.sudo && sudo.on ? sudo.minutes : undefined
    setSent({ command, sudo: sudoMinutes })
    void client.auth.decide(a.approvalId, { decision: 'allow', command, ...(sudoMinutes ? { sudoMinutes } : {}) })
  }
  const deny = () => {
    const n = note.trim() || undefined
    setSent({ note: n })
    void client.auth.decide(a.approvalId, { decision: 'deny', note: n })
  }

  const HeadIcon = resolved === 'allow' ? ShieldCheck : danger ? ShieldAlert : Shield

  return (
    <div className="animate-fade-in px-3 py-1">
      <div className="overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-raised)]">
        {/* 头部：危险时用淡红底色区分，不用刺眼红框 */}
        <div className={cn('flex items-center gap-2 px-2.5 py-1.5', danger && 'bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)]')}>
          <HeadIcon className={cn('h-3.5 w-3.5 shrink-0', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]')} />
          <span className={cn('text-[12px] font-semibold', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]')}>
            {a.mcp ? tr('会话请求调用外部工具') : tr('会话请求权限')}
          </span>
          <span className="ml-auto rounded bg-[var(--color-bg-base)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">
            {a.mcp ? 'MCP' : permText}
          </span>
        </div>

        {/* 详情 */}
        <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-2">
          {a.mcp ? (
            <div className="text-[12px] text-[var(--color-text-secondary)]">
              {trx('MCP 服务{server}的工具{tool}', {
                server: <code className="mx-1 rounded bg-[var(--color-bg-raised)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)]">{a.mcp.server}</code>,
                tool: <code className="mx-1 rounded bg-[var(--color-bg-raised)] px-1 py-0.5 text-[11px] text-[var(--color-accent)]">{a.mcp.tool}</code>,
              })}
            </div>
          ) : a.targets?.length ? (
            // 多主机批量执行：一张卡列出全部目标，允许即对这些主机同时生效
            <div className="text-[12px] text-[var(--color-text-secondary)]">
              {/* run_on_hosts 不经终端，直接访问主机（只读命令，读取权限） */}
              {(() => {
                const perm = <span className={cn('mx-1 font-medium', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]')}>{tr('【{perm}】', { perm: permText })}</span>
                const n = a.targets.length
                return a.tool === 'run_on_hosts'
                  ? trx('在以下 {n} 台主机上同时执行（需各主机的{perm}权限）', { perm }, { n })
                  : trx('在以下 {n} 个终端上同时执行（需各主机的{perm}权限）', { perm }, { n })
              })()}
              <div className="mt-1 flex flex-wrap gap-1">
                {a.targets.map((t) => (
                  <code key={t.terminalId} title={t.hostKey} className="rounded bg-[var(--color-bg-raised)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)]">
                    {t.label}{t.hostKey === 'local' ? tr('（本地）') : ''}
                  </code>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-[var(--color-text-secondary)]">
              {trx('对终端{term}的{perm}权限', {
                term: <code className="mx-1 rounded bg-[var(--color-bg-raised)] px-1 py-0.5 text-[11px] text-[var(--color-text-primary)]">{termLabel}</code>,
                perm: <span className={cn('mx-1 font-medium', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]')}>{tr('【{perm}】', { perm: permText })}</span>,
              })}
            </div>
          )}
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{reasonText}</div>
          {a.rule && <div data-auth-rule className="mt-0.5 text-[11px] text-[var(--color-accent)]">{tr('按规则：{rule}', { rule: a.rule })}</div>}
          {a.review && <ReviewBadge review={a.review} className="mt-1.5" />}
          {/* AI 的命令说明：危险命令标「请自行核实」，免得用户只看说明就点允许 */}
          {a.explain && (
            <div className={cn('mt-2 rounded px-2 py-1.5 text-[12px] leading-relaxed', danger ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-text-primary)]' : 'bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-text-primary)]')}>
              <span className={cn('font-medium', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]')}>
                {danger ? tr('AI 的说明（请自行核实）：') : tr('说明：')}
              </span>
              {a.explain}
            </div>
          )}

          {editing && !resolved ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); allow() } }}
              autoFocus
              rows={Math.min(6, draft.split('\n').length + 1)}
              className="mt-2 w-full resize-y rounded border border-[var(--color-accent)] bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-primary)] outline-none"
            />
          ) : a.mcp ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-raised)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{a.mcp.args}</pre>
          ) : a.diff !== undefined ? (
            <>
              {a.command && <div className="mt-2 font-mono text-[11px] text-[var(--color-text-secondary)]">{a.command}</div>}
              <DiffView diff={a.diff} />
            </>
          ) : a.command && (() => {
            const pre = (
              <pre
                className={cn(
                  'max-h-32 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed',
                  withRollback ? 'h-full' : 'mt-2',
                  danger
                    ? 'bg-[color:color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)]'
                    : 'bg-[var(--color-bg-raised)] text-[var(--color-text-secondary)]'
                )}
              >
                {a.tool === 'exec_in_terminal' || a.tool === 'start_background' || a.tool === 'exec_on_terminals' || a.tool === 'run_on_hosts' ? '$ ' : ''}{sent?.command ?? a.command}
              </pre>
            )
            if (!withRollback) return pre
            // 「执行」与「回滚」并排：先看清改坏了怎么退回再决定允许
            return (
              <div data-auth-rollback className="mt-2 grid grid-cols-2 gap-2">
                <div className="flex min-w-0 flex-col">
                  <div className="mb-0.5 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('auth|执行')}</div>
                  {pre}
                </div>
                <div className="flex min-w-0 flex-col">
                  <div className="mb-0.5 text-[10.5px] font-medium text-[var(--color-text-muted)]">{tr('回滚')}</div>
                  {a.rollback ? (
                    <pre className="h-full max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[color:color-mix(in_srgb,var(--color-success)_8%,transparent)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">$ {a.rollback}</pre>
                  ) : a.rollbackMissing ? (
                    <div data-rollback-missing className="h-full rounded bg-[color:color-mix(in_srgb,var(--color-warn)_14%,transparent)] px-2 py-1.5 text-[11px] font-medium text-[var(--color-warn)]">{tr('AI 未提供回滚方案')}</div>
                  ) : (
                    <div className="h-full rounded bg-[var(--color-bg-raised)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('无回滚命令')}</div>
                  )}
                  {a.rollbackNote && <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--color-text-muted)]">{a.rollbackNote}</div>}
                </div>
              </div>
            )
          })()}
          {sent?.command && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('已改为上面的命令执行（原命令：{command}）', { command: a.command ?? '' })}</div>}

          {!resolved ? (
            <>
              <div className="mt-2 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                <Clock className="h-3 w-3" />
                <span>{tr('{time} 后自动拒绝', { time: `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}` })}</span>
              </div>
              {denying && (
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); deny() } if (e.key === 'Escape') setDenying(false) }}
                  autoFocus
                  placeholder={tr('告诉 AI 为什么拒绝、该怎么做（可选，回车确认）')}
                  className="mt-2 w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-raised)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                />
              )}
              {a.sudo && !denying && <SudoLeasePick on={sudo.on} minutes={sudo.minutes} onChange={(on, minutes) => setSudo({ on, minutes })} />}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={allow}
                  className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)]"
                >
                  <Check className="h-3.5 w-3.5" />
                  {editing ? tr('按修改后执行') : tr('允许')}
                </button>
                <button
                  onClick={() => (denying ? deny() : setDenying(true))}
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
                >
                  <X className="h-3.5 w-3.5" />
                  {denying ? tr('确认拒绝') : tr('拒绝')}
                </button>
                {editable && !editing && !denying && (
                  <button
                    onClick={() => setEditing(true)}
                    className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
                  >
                    <Pencil className="h-3 w-3" />
                    {tr('改命令')}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="mt-2">
              <ResultBadge result={resolved} />
              {resolved === 'allow' && sent?.sudo && <div className="mt-1 text-[11px] text-[var(--color-warn)]">{tr('本主机 {n} 分钟内允许提权（可在会话授权里立即收回）', { n: sent.sudo })}</div>}
              {resolved === 'deny' && sent?.note && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{tr('原因：{reason}', { reason: sent.note })}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ResultBadge({ result }: { result: 'allow' | 'deny' | 'timeout' | 'cancelled' }) {
  if (result === 'allow')
    return (
      <span className="flex items-center gap-1 text-[12px] text-[var(--color-success)]">
        <ShieldCheck className="h-3.5 w-3.5" />{tr('已允许')}
      </span>
    )
  if (result === 'timeout')
    return (
      <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]">
        <Clock className="h-3.5 w-3.5" />{tr('已超时（自动拒绝）')}
      </span>
    )
  if (result === 'cancelled')
    return (
      <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-muted)]">
        <Clock className="h-3.5 w-3.5" />{tr('本轮已结束，未处理')}
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-[12px] text-[var(--color-danger)]">
      <ShieldX className="h-3.5 w-3.5" />{tr('已拒绝')}
    </span>
  )
}
