import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, FilePen, RotateCcw, Undo2, Check, X, FileDiff, Loader2 } from 'lucide-react'
import { tr, type HostSummary, type TurnChanges as TurnChangesData, type TurnFileChange, type TurnFileCheck, type TurnUndoResult } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { ConfirmDialog } from '../common/index.js'
import { DiffView } from '../../components/DiffView.js'

// 回合末改动汇总（参考 Cursor / Claude Code checkpoints）：AI 这一轮经 write_file 改过的文件，
// 可逐个「查看差异」「还原」，或「撤销本轮全部改动」。数据全来自执行记录，历史会话 / 重启后照样显示。

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** 本会话各轮的文件改动（turnId → 汇总）。会话切换、回合结束时重取 */
export function useTurnChanges(sessionId: string, busy: boolean) {
  const [map, setMap] = useState<Map<string, TurnChangesData>>(new Map())
  const refresh = useCallback(() => {
    if (!sessionId) { setMap(new Map()); return }
    client.turnChanges.list(sessionId).then((ts) => setMap(new Map(ts.map((t) => [t.turnId, t])))).catch(() => setMap(new Map()))
  }, [sessionId])
  useEffect(() => {
    setMap(new Map())   // 切会话先清：turn_1 这类 id 只在会话内唯一，旧 map 会显示到新会话的第一轮上
    let alive = true
    if (sessionId) client.turnChanges.list(sessionId).then((ts) => { if (alive) setMap(new Map(ts.map((t) => [t.turnId, t]))) }).catch(() => { if (alive) setMap(new Map()) })
    return () => { alive = false }
  }, [sessionId, busy])
  return { changes: map, refresh }
}

let hostCache: Promise<HostSummary[]> | undefined
function useHostLabel() {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  useEffect(() => { (hostCache ??= client.hosts.list().catch(() => [])).then(setHosts).catch(() => {}) }, [])
  return (k: string) => (k === 'local' ? tr('本地') : hosts.find((h) => h.id === k)?.label ?? k)
}

const BTN = 'flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-40'

export function TurnChangesBar({ sessionId, data, onChanged }: { sessionId: string; data: TurnChangesData; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [diffs, setDiffs] = useState<Record<string, { diff?: string; error?: string; state?: string }>>({})
  const [results, setResults] = useState<Record<string, TurnUndoResult>>({})
  const [confirm, setConfirm] = useState<{ files: TurnFileChange[]; checks: TurnFileCheck[]; all: boolean }>()
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const host = useHostLabel()
  const files = data.files
  const pending = files.filter((f) => !f.undoneAt)

  const toggleDiff = (f: TurnFileChange) => {
    if (diffs[f.key]) { setDiffs(({ [f.key]: _drop, ...rest }) => rest); return }
    setDiffs((d) => ({ ...d, [f.key]: {} }))
    client.turnChanges.diff(sessionId, data.turnId, f.key)
      .then((r) => setDiffs((d) => ({ ...d, [f.key]: r })))
      .catch((e: unknown) => setDiffs((d) => ({ ...d, [f.key]: { error: errText(e) } })))
  }
  // 先查一遍（是否已被后续改动覆盖），再弹确认
  const ask = (target: TurnFileChange[], all = false) => {
    setErr('')
    client.turnChanges.check(sessionId, data.turnId, target.map((f) => f.key))
      .then((checks) => setConfirm({ files: target, checks, all }))
      .catch((e: unknown) => setErr(errText(e)))
  }
  const run = () => {
    const c = confirm
    setConfirm(undefined)
    if (!c) return
    setRunning(true)
    setOpen(true)
    client.turnChanges.undo(sessionId, data.turnId, c.files.map((f) => f.key))
      .then((rs) => setResults((m) => ({ ...m, ...Object.fromEntries(rs.map((r) => [r.key, r])) })))
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => { setRunning(false); onChanged() })
  }

  const stateOf = (key: string) => confirm?.checks.find((c) => c.key === key)
  const created = confirm?.files.filter((f) => f.created) ?? []
  const changed = confirm?.files.filter((f) => stateOf(f.key)?.state === 'changed') ?? []
  const unknown = confirm?.files.filter((f) => stateOf(f.key)?.state === 'unknown') ?? []

  return (
    <div data-turn-changes className="mx-3 mb-1 mt-1.5 overflow-hidden rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11.5px]">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <FilePen className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <span data-turn-changes-title>{tr('本轮改了 {n} 个文件', { n: files.length })}</span>
          {pending.length < files.length && <span className="text-[10.5px] text-[var(--color-text-muted)]">{tr('（已撤销 {n} 个）', { n: files.length - pending.length })}</span>}
        </button>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-text-muted)]" /> : pending.length > 0 && (
          <button data-undo-turn onClick={() => ask(pending, true)} title={tr('按逆序还原本轮改过的全部文件（新建的删除）；撤销前的内容会先备份')} className={BTN}>
            <Undo2 className="h-3 w-3" />{tr('撤销本轮全部改动')}
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-[var(--color-border-subtle)] px-2 py-1">
          {files.map((f) => {
            const r = results[f.key]
            const d = diffs[f.key]
            return (
              <div key={f.key} data-turn-file={f.path} className="py-0.5">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={cn('shrink-0 rounded px-1 text-[10px]', f.created ? 'text-[var(--color-success)] bg-[color:color-mix(in_srgb,var(--color-success)_10%,transparent)]' : 'text-[var(--color-warn)] bg-[color:color-mix(in_srgb,var(--color-warn)_10%,transparent)]')}>
                    {f.created ? tr('file|新建') : tr('file|修改')}
                  </span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">{host(f.hostKey)}</span>
                  {/* 文件名在前、目录灰字在后（长路径截断时文件名仍看得见），悬停看完整路径 */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono" title={f.path}>
                    <span className="shrink-0 text-[var(--color-text-primary)]">{f.path.split(/[\\/]/).pop()}</span>
                    <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-muted)]">{f.path.replace(/[\\/][^\\/]*$/, '')}</span>
                  </span>
                  {r ? (
                    <span data-undo-result={r.ok ? 'ok' : 'fail'} className={cn('flex shrink-0 items-center gap-0.5 text-[10.5px]', r.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')} title={r.error}>
                      {r.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {r.ok ? (r.action === 'deleted' ? tr('已删除') : r.action === 'restored' ? tr('已还原') : r.error ?? tr('已跳过')) : tr('失败：{error}', { error: r.error ?? '' })}
                    </span>
                  ) : f.undoneAt ? (
                    <span className="shrink-0 text-[10.5px] text-[var(--color-text-muted)]">{tr('undo|已撤销')}</span>
                  ) : (
                    <>
                      <button onClick={() => toggleDiff(f)} className={BTN} title={tr('本轮之前 → 当前内容')}><FileDiff className="h-3 w-3" />{d ? tr('收起差异') : tr('查看差异')}</button>
                      <button onClick={() => ask([f])} disabled={running} className={BTN} title={f.created ? tr('删除这个本轮新建的文件（先备份）') : tr('用本轮改动前的备份还原')}><RotateCcw className="h-3 w-3" />{tr('还原')}</button>
                    </>
                  )}
                </div>
                {d && !r && (d.error ? <div className="mt-0.5 text-[10.5px] text-[var(--color-danger)]">{d.error}</div>
                  : d.diff === undefined ? <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('读取中…')}</div>
                  : <>
                    {d.state === 'changed' && <div className="mt-0.5 text-[10.5px] text-[var(--color-warn)]">{tr('这个文件在本轮之后又被改过，下面的差异包含后来的改动')}</div>}
                    <DiffView diff={d.diff} legend={tr('本轮之前 → 当前')} />
                  </>)}
              </div>
            )
          })}
          <div className="pt-1 text-[10.5px] text-[var(--color-text-muted)]">{tr('只含 AI 用写文件工具做的改动；经终端命令（sed -i、echo > 等）改的文件没有备份，无法撤销。')}</div>
        </div>
      )}
      {err && <div className="border-t border-[var(--color-border-subtle)] px-2 py-1 text-[10.5px] text-[var(--color-danger)]">{err}</div>}
      <ConfirmDialog open={!!confirm} title={confirm?.all ? tr('撤销本轮改动') : tr('还原文件')} confirmText={tr('undo|撤销')}
        message={confirm ? (created.length
          ? tr('将按逆序还原 {n} 个修改过的文件、删除 {m} 个本轮新建的文件。撤销前的当前内容会先备份，之后仍可在执行记录里还原回来。', { n: confirm.files.length - created.length, m: created.length })
          : tr('将按逆序还原 {n} 个修改过的文件。撤销前的当前内容会先备份，之后仍可在执行记录里还原回来。', { n: confirm.files.length })) : ''}
        onConfirm={run} onCancel={() => setConfirm(undefined)}>
        {confirm && (created.length > 0 || changed.length > 0 || unknown.length > 0) ? (
          <div className="max-h-56 space-y-2 overflow-auto text-[11.5px]">
            {created.length > 0 && <FileList tone="danger" title={tr('将删除（本轮新建）：')} files={created} />}
            {changed.length > 0 && <FileList tone="warn" title={tr('以下文件在本轮之后又被改过，撤销会覆盖那些改动：')} files={changed} />}
            {unknown.length > 0 && <FileList tone="muted" title={tr('无法确认当前内容（主机未连接或记录较旧），仍会尝试撤销：')} files={unknown} note={(f) => stateOf(f.key)?.error} />}
          </div>
        ) : undefined}
      </ConfirmDialog>
    </div>
  )
}

function FileList({ title, files, tone, note }: { title: string; files: TurnFileChange[]; tone: 'danger' | 'warn' | 'muted'; note?: (f: TurnFileChange) => string | undefined }) {
  const color = tone === 'danger' ? 'text-[var(--color-danger)]' : tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-text-muted)]'
  return (
    <div>
      <div className={color}>{title}</div>
      {files.map((f) => <div key={f.key} className="truncate pl-2 font-mono text-[11px] text-[var(--color-text-secondary)]" title={f.path}>{f.path}{note?.(f) ? tr('（{s}）', { s: note(f)! }) : ''}</div>)}
    </div>
  )
}
