import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpToLine, Loader2, MessageSquareQuote, RefreshCw, ScrollText, ServerCog, X } from 'lucide-react'
import {
  SVC_ACTIONS, SVC_ACTION_LABEL, filterSvcs, redactSecrets, sortSvcs, svcAutostart, svcFailed, svcQuote, systemdSupported, tr,
  type SvcAction, type SvcList, type SvcRow, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { Input } from '../../../components/ui/Input.js'
import { openLogViewer } from '../../logs/index.js'
import { trx } from '../../../lib/trx.js'

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
const BTN = 'flex items-center gap-1 rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent'
const ON = 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]'

// 运行状态 → 圆点颜色
function dotCls(r: SvcRow): string {
  if (svcFailed(r)) return 'bg-[var(--color-danger)]'
  if (r.active === 'active') return 'bg-[var(--color-success)]'
  if (/ing$/.test(r.active)) return 'bg-[var(--color-warn)]'
  return 'bg-[var(--color-text-muted)] opacity-50'
}
// 操作按钮在当前状态下是否没意义（灰掉，免得误点）
function actionDisabled(r: SvcRow, a: SvcAction): string | undefined {
  const auto = svcAutostart(r)
  if (a === 'enable' && auto === true) return tr('已经是开机自启')
  if (a === 'disable' && auto === false) return tr('已经不是开机自启')
  if ((a === 'enable' || a === 'disable') && r.enabled && auto === undefined) return tr('开机自启状态是 {state}，不能用 enable / disable 改', { state: r.enabled })
  if (a === 'start' && r.active === 'active') return tr('已在运行')
  if ((a === 'stop' || a === 'reload') && r.active !== 'active' && !/ing$/.test(r.active)) return tr('没在运行')
  return undefined
}

// systemd 服务视图：当前 SSH 终端（Linux）所在主机的服务列表（独立 exec channel 跑 systemctl，不进交互 shell）。
// 搜索 / 只看失败 / 失败置顶；选中一个看 systemctl status，可启停 / 重启 / 重载 / 开机自启（先确认，记执行记录）、查看日志、问 AI。切终端时由外层 key 重挂载
export function ServiceDrawer({ term, onClose }: { term?: TerminalInfo; onClose: () => void }) {
  const ok = !!term && systemdSupported(term.type, term.os)
  const tid = term?.id ?? ''
  const prod = term?.env === 'prod'
  const [list, setList] = useState<SvcList>()
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [failedFirst, setFailedFirst] = useState(true)
  const [sel, setSel] = useState<string>()
  const [status, setStatus] = useState<{ name: string; text?: string; error?: string }>()
  const [confirm, setConfirm] = useState<{ row: SvcRow; action: SvcAction }>()
  const [running, setRunning] = useState<string>()       // 正在执行的操作（按钮转圈）
  const [actErr, setActErr] = useState('')              // 操作失败：stderr 原文
  const [flash, setFlash] = useState('')

  const inflight = useRef(false)
  const refresh = useCallback(() => {
    if (!ok || inflight.current) return
    inflight.current = true; setLoading(true)
    client.systemd.list(tid).then((r) => { setList(r); setErr('') }).catch((e) => setErr(errText(e)))
      .finally(() => { inflight.current = false; setLoading(false) })
  }, [ok, tid])
  useEffect(() => { refresh() }, [refresh])

  const loadStatus = useCallback((name: string) => {
    setStatus({ name })
    client.systemd.status(tid, name).then((text) => setStatus((s) => (s?.name === name ? { name, text } : s)))
      .catch((e) => setStatus((s) => (s?.name === name ? { name, error: errText(e) } : s)))
  }, [tid])
  useEffect(() => { setActErr(''); if (sel) loadStatus(sel); else setStatus(undefined) }, [sel, loadStatus])

  const rows = useMemo(() => sortSvcs(filterSvcs(list?.rows ?? [], q, onlyFailed), failedFirst), [list, q, onlyFailed, failedFirst])
  const failedCount = useMemo(() => (list?.rows ?? []).filter(svcFailed).length, [list])
  const selRow = sel ? list?.rows.find((r) => r.name === sel) : undefined

  const note = (text: string) => { setFlash(text); setTimeout(() => setFlash((f) => (f === text ? '' : f)), 2500) }
  const doAction = () => {
    const x = confirm
    if (!x) return
    setConfirm(undefined); setActErr(''); setRunning(x.action)
    client.systemd.action(tid, x.row.name, x.action)
      .then(() => note(tr('已{action}：{name}', { action: tr(SVC_ACTION_LABEL[x.action]), name: x.row.name })))
      .catch((e) => setActErr(tr('{action} {name} 失败：\n{msg}', { action: tr(SVC_ACTION_LABEL[x.action]), name: x.row.name, msg: errText(e) })))
      .finally(() => { setRunning(undefined); refresh(); loadStatus(x.row.name) })
  }
  const askAi = async (r: SvcRow) => {
    const text = status?.name === r.name && status.text ? status.text : await client.systemd.status(tid, r.name).catch((e) => tr('（读取 status 失败：{msg}）', { msg: errText(e) }))
    const s = await client.settings.get().catch(() => undefined)
    const quote = svcQuote(term?.title ?? '', r, text)
    quoteToChat(s?.system?.aiRedact === false ? quote : redactSecrets(quote))
    onClose()
  }
  const viewLog = (r: SvcRow) => { openLogViewer(tid, { kind: 'journal', unit: r.name }); onClose() }

  const header = (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <ServerCog className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">{tr('服务（systemd）')}</span>
      {list && !list.noSystemd && <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{list.rows.length}</span>}
      <span className="ml-auto" />
      {ok && list && !list.noSystemd && <>
        <button title={tr('只看失败的服务')} onClick={() => setOnlyFailed((v) => !v)}
          className={`flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] hover:bg-[var(--color-bg-hover)] ${onlyFailed ? ON : failedCount ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
          <AlertTriangle className="h-3 w-3" />{failedCount ? tr('只看失败（{n}）', { n: failedCount }) : tr('只看失败')}
        </button>
        <button title={failedFirst ? tr('失败的置顶（点击改为按名字排序）') : tr('按名字排序（点击改为失败的置顶）')} onClick={() => setFailedFirst((v) => !v)}
          className={`${IB} ${failedFirst ? ON : ''}`}><ArrowUpToLine className="h-3.5 w-3.5" /></button>
      </>}
      {ok && <button title={tr('刷新')} disabled={loading} onClick={refresh} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )

  if (!ok) return (
    <div className="flex h-full flex-col">{header}
      <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('服务视图只支持 Linux 的 SSH 终端：先切到一个 SSH 终端再打开。')}</div>
    </div>
  )
  if (list?.noSystemd) return (
    <div className="flex h-full flex-col">{header}
      <div className="space-y-1.5 px-3 py-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
        <div>{tr(list.noSystemd)}</div>
        <div className="text-[var(--color-text-muted)]">{trx('这类主机可以在终端里用 {a}、{b} 等查看服务。', { a: <code className="font-mono">service --status-all</code>, b: <code className="font-mono">rc-status</code> })}</div>
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('按服务名 / 描述过滤')} />
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto text-[11.5px]">
        {!list && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{loading ? tr('读取中…') : ''}</div>}
        {list && rows.length === 0 && <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{onlyFailed && !q ? tr('没有失败的服务') : tr('（没有匹配的服务）')}</div>}
        {rows.map((r) => {
          const failed = svcFailed(r), auto = svcAutostart(r)
          return (
            <div key={r.name} data-svc={r.name} onClick={() => setSel(r.name === sel ? undefined : r.name)} title={`${r.name}\n${r.description}\n${tr('加载 {load} · 运行 {active}/{sub} · 开机自启 {enabled}', { load: r.load || tr('（未加载）'), active: r.active, sub: r.sub, enabled: r.enabled ?? tr('未知') })}`}
              className={`flex cursor-default items-center gap-2 px-3 py-[3px] hover:bg-[var(--color-bg-hover)] ${r.name === sel ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_15%,transparent)]' : ''}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls(r)}`} />
              <span className={`w-[42%] shrink-0 truncate font-mono ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]'}`}>{r.name.replace(/\.service$/, '')}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{r.description || (r.load === 'not-found' ? tr('（单元文件不存在）') : '')}</span>
              <span className={`w-[64px] shrink-0 truncate text-right ${failed ? 'font-medium text-[var(--color-danger)]' : r.active === 'active' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}`}>{failed ? 'failed' : r.sub || r.active}</span>
              <span title={tr('开机自启：{state}', { state: r.enabled ?? tr('未知') })} className={`w-[48px] shrink-0 text-center text-[10px] ${auto ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`}>{auto === true ? tr('自启') : auto === false ? '—' : r.enabled ? r.enabled.slice(0, 6) : ''}</span>
            </div>
          )
        })}
      </div>
      {selRow && (
        <div className="flex max-h-[55%] shrink-0 flex-col gap-1.5 border-t border-[var(--color-border-default)] px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls(selRow)}`} />
            <span className="truncate font-mono font-medium text-[var(--color-text-primary)]">{selRow.name}</span>
            <span className="shrink-0 text-[var(--color-text-muted)]">{selRow.active}{selRow.sub ? ` (${selRow.sub})` : ''} · {tr('开机自启 {state}', { state: selRow.enabled ?? tr('未知') })}</span>
            <button title={tr('重新读取 status')} onClick={() => loadStatus(selRow.name)} className={`${IB} ml-auto`}><RefreshCw className="h-3 w-3" /></button>
          </div>
          <pre data-svc-status className="min-h-[60px] flex-1 overflow-auto whitespace-pre rounded bg-[var(--color-bg-raised)] p-1.5 font-mono text-[10.5px] leading-[1.45] text-[var(--color-text-secondary)]">
            {status?.name !== selRow.name || (!status.text && !status.error) ? tr('读取 systemctl status…') : status.error ? <span className="text-[var(--color-danger)]">{status.error}</span> : status.text}
          </pre>
          {actErr && <pre data-svc-error className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-all rounded border border-[color:color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-danger)_8%,transparent)] p-1.5 font-mono text-[10.5px] text-[var(--color-danger)]">{actErr}</pre>}
          <div className="flex flex-wrap items-center gap-1.5">
            {SVC_ACTIONS.map((a) => {
              const why = actionDisabled(selRow, a)
              return (
                <button key={a} disabled={!!running || !!why} title={why ?? tr('systemctl {a} {name}（需要 root 时用 sudo -n）', { a, name: selRow.name })} onClick={() => setConfirm({ row: selRow, action: a })}
                  className={`${BTN} ${a === 'stop' || a === 'disable' ? 'text-[var(--color-danger)]' : a === 'restart' || a === 'reload' ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-secondary)]'}`}>
                  {running === a && <Loader2 className="h-3 w-3 animate-spin" />}{tr(SVC_ACTION_LABEL[a])}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button title={tr('在日志面板里打开 journalctl -u {name} -f', { name: selRow.name })} onClick={() => viewLog(selRow)} className={`${BTN} text-[var(--color-text-secondary)]`}><ScrollText className="h-3 w-3" />{tr('查看日志')}</button>
            <button title={tr('把服务状态和最近日志放进对话输入框（按设置脱敏，不自动发送）')} onClick={() => void askAi(selRow)} className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('问 AI')}</button>
            {flash && <span className="text-[11px] text-[var(--color-success)]">{flash}</span>}
          </div>
        </div>
      )}
      {!selRow && flash && <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[11px] text-[var(--color-success)]">{flash}</div>}
      <ConfirmDialog open={!!confirm}
        title={confirm ? (prod ? tr('生产主机：{title}', { title: tr('{action}服务 {name}', { action: tr(SVC_ACTION_LABEL[confirm.action]), name: confirm.row.name }) })
          : tr('{action}服务 {name}', { action: tr(SVC_ACTION_LABEL[confirm.action]), name: confirm.row.name })) : ''}
        message={confirm ? tr('确定在「{title}」上执行下面的命令？非 root 用户会加 sudo -n（只用免密 sudo，要密码会直接失败）。操作会记入执行记录。', { title: term?.title ?? '' }) : ''}
        confirmText={confirm ? (prod ? tr('生产主机 · {label}', { label: tr(SVC_ACTION_LABEL[confirm.action]) }) : tr(SVC_ACTION_LABEL[confirm.action])) : ''}
        onConfirm={doAction} onCancel={() => setConfirm(undefined)}>
        {confirm && (
          <div className="space-y-2">
            {prod && (
              <div className="flex items-center gap-1.5 rounded border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-2 py-1.5 text-[12px] font-medium text-[var(--color-danger)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{tr('这是生产主机！')}{confirm.action === 'stop' || confirm.action === 'restart' ? tr('停止 / 重启会中断这个服务正在处理的请求。') : tr('请确认不会影响线上业务。')}
              </div>
            )}
            <div className="rounded bg-[var(--color-bg-raised)] p-2 font-mono text-[11.5px] text-[var(--color-text-primary)]">systemctl {confirm.action} {confirm.row.name}</div>
            {confirm.row.description && <div className="text-[11.5px] text-[var(--color-text-muted)]">{confirm.row.description}</div>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
