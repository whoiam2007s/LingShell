import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FolderSync, Loader2, FolderOpen } from 'lucide-react'
import {
  SYNC_DEFAULT_EXCLUDES, SYNC_CAP, SYNC_MAX_DEPTH, SYNC_DIRECTION_LABEL, parseExcludes, rowAction, buildSyncPlan, defaultSelection, planSummary, planTouchesRemote, formatSize, tk, tr, dateLocale, getLocale,
  type TerminalInfo, type SyncRow, type SyncDirection, type SyncAction, type DirSyncCompareResult, type DirSyncProgress, type DirSyncRunResult,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { ProdBadge } from '../../components/sshParts.js'
import { cn } from '../../lib/cn.js'
import { Select } from '../../components/ui/Select.js'
import { Checkbox } from '../../components/ui/Checkbox.js'

// 本地 ↔ 远程目录比较与同步（WinSCP「Synchronize」风格）。打开：资源管理器远程目录右键「与本地目录比较/同步…」、命令面板「目录同步」。
// 流程：选终端 + 两边目录 → 比较 → 勾选差异、选方向 → 「生成同步计划」看数量 → 确认执行（逐个文件经 SFTP，可取消）→ 自动重新比较。
const EVT = 'lingshell:dirSync'
export function openDirSync(o: { terminalId?: string; remotePath?: string } = {}) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: o }))
}

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const LS_LOCAL = 'lingshell.dirSync.local', LS_EXCLUDES = 'lingshell.dirSync.excludes'
const ROW_LIMIT = 2000   // 一次最多渲染的行数（勾选不受影响）
// text 只做标记（tk），显示处 tr
const STATUS: Record<SyncRow['status'], { text: string; cls: string }> = {
  localOnly: { text: tk('仅本地'), cls: 'text-[var(--color-accent)]' },
  remoteOnly: { text: tk('仅远程'), cls: 'text-[var(--color-warn)]' },
  diff: { text: tk('不同'), cls: 'text-[var(--color-warn)]' },
  same: { text: tk('相同'), cls: 'text-[var(--color-text-muted)]' },
}
const ACTION: Record<SyncAction, { text: string; cls: string }> = {
  upload: { text: tk('→ 上传'), cls: 'text-[var(--color-accent)]' },
  download: { text: tk('← 下载'), cls: 'text-[var(--color-accent)]' },
  mkdirRemote: { text: tk('→ 建目录'), cls: 'text-[var(--color-accent)]' },
  mkdirLocal: { text: tk('← 建目录'), cls: 'text-[var(--color-accent)]' },
  deleteRemote: { text: tk('删除远程'), cls: 'text-[var(--color-danger)]' },
  deleteLocal: { text: tk('删除本地'), cls: 'text-[var(--color-danger)]' },
  none: { text: '', cls: '' },
}
const sideText = (s?: { isDir: boolean; size: number; mtime: number }) => (s ? `${s.isDir ? tr('目录') : formatSize(s.size)}${s.isDir ? '' : ` · ${new Date(s.mtime * 1000).toLocaleString(dateLocale())}`}` : '—')
const input = 'h-7 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'
const btn = 'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40'

export function DirSyncDialog() {
  const [open, setOpen] = useState<{ terminalId?: string; remotePath?: string; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ ...(e as CustomEvent).detail, n: (o?.n ?? 0) + 1 }))
    window.addEventListener(EVT, f)
    return () => window.removeEventListener(EVT, f)
  }, [])
  return open ? <SyncBody key={open.n} init={open} onClose={() => setOpen(null)} /> : null
}

function SyncBody({ init, onClose }: { init: { terminalId?: string; remotePath?: string }; onClose: () => void }) {
  const [terms, setTerms] = useState<TerminalInfo[] | null>(null)
  const [tid, setTid] = useState(init.terminalId ?? '')
  const [remoteRoot, setRemoteRoot] = useState(init.remotePath ?? '')
  const [localRoot, setLocalRoot] = useState(() => localStorage.getItem(LS_LOCAL) ?? '')
  const [excludes, setExcludes] = useState(() => localStorage.getItem(LS_EXCLUDES) ?? SYNC_DEFAULT_EXCLUDES)
  const [byContent, setByContent] = useState(false)
  const [res, setRes] = useState<DirSyncCompareResult | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [onlyDiff, setOnlyDiff] = useState(true)
  const [dir, setDir] = useState<SyncDirection>('upload')
  const [mirror, setMirror] = useState(false)
  const [stage, setStage] = useState<'edit' | 'plan'>('edit')
  const [prodOk, setProdOk] = useState(false)
  const [busy, setBusy] = useState<'compare' | 'run' | null>(null)
  const [prog, setProg] = useState<DirSyncProgress | null>(null)
  const [done, setDone] = useState<DirSyncRunResult | null>(null)
  const [error, setError] = useState('')
  const idRef = useRef(crypto.randomUUID())

  useEffect(() => {
    client.terminal.list().then((ts) => {
      const ssh = ts.filter((t) => t.type === 'ssh' && t.status === 'running')
      setTerms(ssh)
      setTid((cur) => (ssh.some((t) => t.id === cur) ? cur : ssh[0]?.id ?? ''))
    }).catch((e) => setError(errText(e)))
  }, [])
  // 进行中轮询进度；关闭对话框即取消
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => { client.dirSync.progress(idRef.current).then(setProg).catch(() => {}) }, 300)
    return () => clearInterval(t)
  }, [busy])
  useEffect(() => () => { client.dirSync.cancel(idRef.current).catch(() => {}) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const term = terms?.find((t) => t.id === tid)
  const prod = term?.env === 'prod'
  const canCompare = !!tid && !!localRoot.trim() && remoteRoot.trim().startsWith('/') && !busy

  const compare = async (keepDone = false) => {
    if (!tid) return
    setBusy('compare'); setProg(null); setError(''); setStage('edit'); if (!keepDone) setDone(null)
    localStorage.setItem(LS_LOCAL, localRoot.trim()); localStorage.setItem(LS_EXCLUDES, excludes)
    try {
      const r = await client.dirSync.compare(idRef.current, { terminalId: tid, localRoot: localRoot.trim(), remoteRoot: remoteRoot.trim(), excludes: parseExcludes(excludes), byContent })
      setRes(r); setSel(new Set(defaultSelection(r.rows)))
    } catch (e) { setRes(null); setError(errText(e)) } finally { setBusy(null) }
  }

  const rows = res?.rows ?? []
  const plan = useMemo(() => buildSyncPlan(rows, sel, dir, mirror), [rows, sel, dir, mirror])
  const sum = planSummary(plan)
  const deletes = sum.deleteRemote + sum.deleteLocal
  const touchesRemote = planTouchesRemote(plan)
  const shown = rows.filter((r) => !onlyDiff || r.status !== 'same')
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})

  // 勾目录 = 连同其下的项一起勾 / 取消
  const toggle = (r: SyncRow) => setSel((s) => {
    const n = new Set(s), on = !s.has(r.rel)
    for (const x of rows) if ((x.rel === r.rel || x.rel.startsWith(r.rel + '/')) && x.status !== 'same' && !x.skip) { if (on) n.add(x.rel); else n.delete(x.rel) }
    return n
  })
  const selectable = rows.filter((r) => r.status !== 'same' && !r.skip)
  const allOn = selectable.length > 0 && selectable.every((r) => sel.has(r.rel))

  const execute = async () => {
    setBusy('run'); setProg(null); setError('')
    try {
      const r = await client.dirSync.run(idRef.current, [...sel], dir, mirror)
      setDone(r); setProdOk(false)
      await compare(true)   // 执行后自动重新比较，看两边是否一致
    } catch (e) { setError(errText(e)); setBusy(null) }
  }

  const pct = prog && prog.phase !== 'scan' ? (prog.totalBytes ? prog.doneBytes / prog.totalBytes : prog.totalItems ? prog.doneItems / prog.totalItems : 0) : 0
  const pickLocal = () => client.system.pickDirectory().then((p) => { if (p) setLocalRoot(p) }).catch(() => {})

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[90vh] w-[900px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <FolderSync className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('目录比较与同步')}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('本地 ⇄ 远程 · 逐个文件经 SFTP 传输（不打包、不加密）')}</span>
          <button onClick={onClose} disabled={!!busy} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-2 border-b border-[var(--color-border-subtle)] p-3 text-[12px]">
          <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-1.5">
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('远程终端')}</span>
            <div className="flex items-center gap-2">
              <Select size="sm" value={tid} onValueChange={(v) => { setTid(v); setRes(null) }} disabled={!!busy} className="flex-1"
                placeholder={terms?.length === 0 ? tr('（没有已连接的 SSH 终端，请先连接主机）') : undefined}
                options={(terms ?? []).map((t) => ({ value: t.id, label: `${t.title}${t.detail ? ` · ${t.detail}` : ''}` }))} />
              {prod && <ProdBadge />}
            </div>
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('远程目录')}</span>
            <input value={remoteRoot} onChange={(e) => setRemoteRoot(e.target.value)} disabled={!!busy} placeholder="/var/www/html" spellCheck={false} className={cn(input, 'font-mono')} />
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('本地目录')}</span>
            <div className="flex items-center gap-2">
              <input value={localRoot} onChange={(e) => setLocalRoot(e.target.value)} disabled={!!busy} placeholder="D:\project\dist" spellCheck={false} className={cn(input, 'min-w-0 flex-1 font-mono')} />
              <button onClick={pickLocal} disabled={!!busy} className="flex h-7 items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"><FolderOpen className="h-3.5 w-3.5" />{tr('选择…')}</button>
            </div>
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('排除规则')}</span>
            <input value={excludes} onChange={(e) => setExcludes(e.target.value)} disabled={!!busy} spellCheck={false} title={tr('逗号分隔。不含 / 的匹配任意一级名字（如 .git、*.log）；含 / 的从同步根起匹配（如 dist/assets）；结尾 / 只匹配目录')}
              className={cn(input, 'font-mono')} />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]" title={tr('大小相同的文件再比 sha256：本地直接算，远程用 sha256sum（服务器上没有就退回按修改时间）')}>
              <Checkbox checked={byContent} onCheckedChange={setByContent} disabled={!!busy} />
              {tr('按内容比较（sha256，较慢）')}
            </label>
            <span className="text-[11px] text-[var(--color-text-muted)]">{tr('大小不同或修改时间相差超过 2 秒算「不同」 · 上限 {cap} 项、{depth} 层 · 符号链接不同步', { cap: SYNC_CAP, depth: SYNC_MAX_DEPTH })}</span>
            <button disabled={!canCompare} onClick={() => compare()}
              className={cn(btn, 'ml-auto flex items-center gap-1.5 bg-[var(--color-accent)] text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]')}>
              {busy === 'compare' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy === 'compare' ? tr('比较中…') : res ? tr('重新比较') : tr('比较')}
            </button>
          </div>
        </div>

        <div className="min-h-[200px] flex-1 overflow-y-auto text-[12px]">
          {busy && (
            <div className="space-y-1.5 p-4">
              <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-accent)]" />
                {!prog || prog.phase === 'scan' ? tr('正在列目录… 已扫描 {n} 项', { n: prog?.scanned ?? 0 })
                  : prog.phase === 'hash' ? tr('正在计算 sha256… {done}/{total}', { done: prog.doneItems, total: prog.totalItems })
                    : tr('正在同步… {done}/{total} 项 · {doneBytes}/{totalBytes}', { done: prog.doneItems, total: prog.totalItems, doneBytes: formatSize(prog.doneBytes), totalBytes: formatSize(prog.totalBytes) })}
                <button onClick={() => client.dirSync.cancel(idRef.current).catch(() => {})} className="ml-auto rounded-md border border-[var(--color-border-default)] px-2.5 py-0.5 text-[11px] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
              </div>
              {prog && prog.phase !== 'scan' && <div className="h-1.5 overflow-hidden rounded bg-[var(--color-bg-hover)]"><div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${Math.round(pct * 100)}%` }} /></div>}
              {prog?.current && <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{prog.current}</div>}
            </div>
          )}
          {error && <div className="whitespace-pre-wrap break-all px-4 py-2 text-[var(--color-danger)]">{error}</div>}
          {done && !busy && (
            <div className={cn('mx-3 mt-2 rounded-md border px-3 py-2', done.failed.length ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-subtle)]')}>
              <div className="text-[var(--color-text-primary)]">
                {done.cancelled
                  ? tr('同步已取消：上传 {up}、下载 {down}、新建目录 {mk}、删除远程 {delR}、本地移到回收站 {delL}', { up: done.uploaded, down: done.downloaded, mk: done.mkdirs, delR: done.deletedRemote, delL: done.deletedLocal })
                  : tr('同步完成：上传 {up}、下载 {down}、新建目录 {mk}、删除远程 {delR}、本地移到回收站 {delL}', { up: done.uploaded, down: done.downloaded, mk: done.mkdirs, delR: done.deletedRemote, delL: done.deletedLocal })}
                {done.failed.length > 0 && <span className="text-[var(--color-danger)]">{tr('，失败 {n}', { n: done.failed.length })}</span>}
                {res && <span className="text-[var(--color-text-muted)]">{tr(' · 已重新比较')}{rows.every((r) => r.status === 'same') ? tr('，两边一致') : ''}</span>}
              </div>
              {done.failed.slice(0, 20).map((f) => <div key={f.rel} className="truncate font-mono text-[11px] text-[var(--color-danger)]" title={f.error}>{tr('{path}：{err}', { path: f.rel, err: f.error })}</div>)}
            </div>
          )}
          {!busy && res && stage === 'edit' && (
            <>
              <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-3 py-1 text-[11px] text-[var(--color-text-muted)]">
                <Checkbox checked={allOn} disabled={!selectable.length} onCheckedChange={() => setSel(allOn ? new Set() : new Set(selectable.map((r) => r.rel)))} title={tr('全选 / 全不选')} />
                <span>{tr('仅本地 {local} · 仅远程 {remote} · 不同 {diff} · 相同 {same}', { local: counts.localOnly ?? 0, remote: counts.remoteOnly ?? 0, diff: counts.diff ?? 0, same: counts.same ?? 0 })}{res.excluded ? tr(' · 已排除 {n}', { n: res.excluded }) : ''}</span>
                <label className="ml-auto flex cursor-pointer items-center gap-1"><Checkbox checked={onlyDiff} onCheckedChange={setOnlyDiff} />{tr('只看差异')}</label>
              </div>
              {res.hashNote && <div className="px-3 py-1 text-[11px] text-[var(--color-warn)]">{tr(res.hashNote)}</div>}
              {shown.length === 0 && <div className="px-4 py-6 text-center text-[var(--color-text-muted)]">{rows.length ? tr('两边一致，没有差异') : tr('两边都是空目录')}</div>}
              {shown.slice(0, ROW_LIMIT).map((r) => {
                const a = rowAction(r, dir, mirror), on = sel.has(r.rel), st = STATUS[r.status]
                const can = r.status !== 'same' && !r.skip
                const depth = r.rel.split('/').length - 1
                return (
                  <div key={r.rel} className={cn('flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-0.5 hover:bg-[var(--color-bg-hover)]', !on && can && 'opacity-60')}>
                    <Checkbox checked={on} disabled={!can} onCheckedChange={() => toggle(r)} />
                    <span className={cn('w-11 shrink-0 text-[11px]', getLocale() === 'en' && 'w-[68px]', st.cls)}>{tr(st.text)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]" style={{ paddingLeft: depth * 12 }} title={r.rel}>
                      {r.rel.slice(r.rel.lastIndexOf('/') + 1)}{r.isDir ? '/' : ''}
                    </span>
                    <span className="w-44 shrink-0 truncate text-right text-[10.5px] text-[var(--color-text-muted)]" title={tr('本地：{info}', { info: sideText(r.local) })}>{sideText(r.local)}</span>
                    <span className="w-44 shrink-0 truncate text-right text-[10.5px] text-[var(--color-text-muted)]" title={tr('远程：{info}', { info: sideText(r.remote) })}>{sideText(r.remote)}</span>
                    <span className={cn('w-20 shrink-0 truncate text-right text-[11px]', getLocale() === 'en' && 'w-24', a.skip ? 'text-[var(--color-text-muted)]' : ACTION[a.action].cls)} title={a.skip}>
                      {!on && can ? '' : a.skip ? tr('跳过') : tr(ACTION[a.action].text)}
                    </span>
                  </div>
                )
              })}
              {shown.length > ROW_LIMIT && <div className="px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]">{tr('只显示前 {n} 行（共 {total} 行），勾选与同步对全部有效', { n: ROW_LIMIT, total: shown.length })}</div>}
            </>
          )}
          {!busy && res && stage === 'plan' && (
            <div className="space-y-2 p-4">
              <div className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('同步计划：{dir}', { dir: tr(SYNC_DIRECTION_LABEL[dir]) })}</div>
              <div className="font-mono text-[11px] text-[var(--color-text-muted)]">{tr('本地 {local} ⇄ 远程 {remote}', { local: res.localRoot, remote: res.remoteRoot })}</div>
              <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-text-secondary)]">
                {sum.upload > 0 && <li>{tr('上传 {n} 个文件（{size}）', { n: sum.upload, size: formatSize(sum.uploadBytes) })}</li>}
                {sum.mkdirRemote > 0 && <li>{tr('远程新建 {n} 个目录', { n: sum.mkdirRemote })}</li>}
                {sum.download > 0 && <li>{tr('下载 {n} 个文件（{size}）', { n: sum.download, size: formatSize(sum.downloadBytes) })}</li>}
                {sum.mkdirLocal > 0 && <li>{tr('本地新建 {n} 个目录', { n: sum.mkdirLocal })}</li>}
                {sum.deleteRemote > 0 && <li className="text-[var(--color-danger)]">{tr('删除远程 {n} 项（不可恢复）', { n: sum.deleteRemote })}</li>}
                {sum.deleteLocal > 0 && <li className="text-[var(--color-danger)]">{tr('本地 {n} 项移到回收站', { n: sum.deleteLocal })}</li>}
                {sum.skipped > 0 && <li className="text-[var(--color-text-muted)]">{tr('跳过 {n} 项：{list}', { n: sum.skipped, list: plan.skipped.slice(0, 3).map((s) => tr('{path}（{reason}）', { path: s.rel, reason: s.reason })).join(tr('；')) })}{sum.skipped > 3 ? ' …' : ''}</li>}
                {sum.total === 0 && <li>{tr('没有要做的操作')}</li>}
              </ul>
              <PlanList title={tr('删除远程')} items={plan.deleteRemote.map((x) => x.rel)} danger />
              <PlanList title={tr('本地移到回收站')} items={plan.deleteLocal.map((x) => x.rel)} danger />
              <PlanList title={tr('上传')} items={plan.upload.map((x) => x.rel)} />
              <PlanList title={tr('下载')} items={plan.download.map((x) => x.rel)} />
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {tr('逐个文件经 SFTP 传输，不打包、不加密（要加密请用「上传到服务器」）；每个文件先写临时文件再替换，取消或失败不会留下半截。覆盖的远程文件保留原权限，传完把修改时间设成源文件的。')}
                {touchesRemote && tr(' 会改远程，记入「执行记录」（目录同步）。')}
              </div>
              {deletes > 0 && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 font-medium text-[var(--color-danger)]">
                  {sum.deleteRemote
                    ? tr('镜像删除已开启：将删除目标端多余的 {n} 项，远程删除不可恢复。目录只在为空时删除（含被排除的项就保留）。', { n: deletes })
                    : tr('镜像删除已开启：将删除目标端多余的 {n} 项。目录只在为空时删除（含被排除的项就保留）。', { n: deletes })}
                </div>
              )}
              {prod && touchesRemote && (
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-danger)] px-3 py-2 font-medium text-[var(--color-danger)]">
                  <Checkbox tone="danger" checked={prodOk} onCheckedChange={setProdOk} />
                  {tr('这是生产主机（{host}），我已核对远程目录和上面的计划', { host: term?.title ?? '' })}
                </label>
              )}
            </div>
          )}
        </div>

        {res && !busy && (
          <div className="flex shrink-0 items-center gap-3 border-t border-[var(--color-border-subtle)] px-4 py-2.5 text-[12px]">
            {stage === 'edit' ? (
              <>
                <Select size="sm" className="w-auto" value={dir} onValueChange={(v) => { const d = v as SyncDirection; setDir(d); if (d === 'both') setMirror(false) }}
                  options={(Object.keys(SYNC_DIRECTION_LABEL) as SyncDirection[]).map((d) => ({ value: d, label: tr(SYNC_DIRECTION_LABEL[d]) }))} />
                <label className={cn('flex cursor-pointer items-center gap-1.5', mirror ? 'font-medium text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]', dir === 'both' && 'opacity-40')}
                  title={dir === 'both' ? tr('双向同步不删除') : tr('删除目标端有、源端没有的项')}>
                  <Checkbox tone="danger" checked={mirror} disabled={dir === 'both'} onCheckedChange={setMirror} />
                  {dir === 'download' ? tr('镜像删除（删除本地多余项）') : tr('镜像删除（删除远程多余项）')}
                </label>
                <span className="text-[11px] text-[var(--color-text-muted)]">{tr('已勾 {n} 项 → {ops} 个操作', { n: sel.size, ops: sum.total })}</span>
                <button disabled={!sum.total} onClick={() => { setStage('plan'); setProdOk(false) }}
                  className={cn(btn, 'ml-auto bg-[var(--color-accent)] text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]')}>{tr('生成同步计划')}</button>
              </>
            ) : (
              <>
                <button onClick={() => setStage('edit')} className={cn(btn, 'border border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>{tr('返回修改')}</button>
                <button disabled={!sum.total || (prod && touchesRemote && !prodOk)} onClick={execute}
                  className={cn(btn, 'ml-auto', deletes || (prod && touchesRemote) ? 'bg-[var(--color-danger)] text-[var(--color-on-danger)] hover:opacity-90' : 'bg-[var(--color-accent)] text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]')}>
                  {deletes ? tr('开始同步（含删除 {n} 项）', { n: deletes }) : tr('开始同步')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanList({ title, items, danger }: { title: string; items: string[]; danger?: boolean }) {
  if (!items.length) return null
  return (
    <details className="rounded-md border border-[var(--color-border-subtle)]">
      <summary className={cn('cursor-pointer px-2.5 py-1 text-[11px]', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]')}>{tr('{title}（{n}）', { title, n: items.length })}</summary>
      <div className="max-h-40 overflow-y-auto px-2.5 pb-1.5 font-mono text-[11px] text-[var(--color-text-muted)]">
        {items.slice(0, 500).map((r) => <div key={r} className="truncate">{r}</div>)}
        {items.length > 500 && <div>{tr('… 共 {n} 项', { n: items.length })}</div>}
      </div>
    </details>
  )
}
