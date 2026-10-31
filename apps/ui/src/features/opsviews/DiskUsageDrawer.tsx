import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, File as FileIcon, Folder, FolderOpen, HardDrive, MessageSquareQuote } from 'lucide-react'
import {
  bashPath, diskLinuxOnly, diskQuote, diskSupported, formatSize, redactSecrets, tk, tr,
  type DiskBigFiles, type DiskCommon, type DiskDeleted, type DiskLevel, type FsScope, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { quoteToChat } from '../../lib/quoteToChat.js'
import { Input } from '../../components/ui/Input.js'
import { HelpTip } from '../../components/ui/form.js'
import { getTermCwd } from '../../lib/termCwd.js'
import { BTN, DrawerHeader, IB, MUTED, errText } from './common.js'
import { trx } from '../../lib/trx.js'

type Tab = 'dirs' | 'big' | 'common' | 'deleted'
const TABS: { id: Tab; label: string; linux?: boolean }[] = [
  { id: 'dirs', label: tk('目录占用') }, { id: 'big', label: tk('最大的 50 个文件') }, { id: 'common', label: tk('常见占用'), linux: true }, { id: 'deleted', label: tk('已删除仍被占用'), linux: true },
]
const kb = (n: number) => formatSize(n * 1024)
const pctColor = (p: number) => (p >= 90 ? 'var(--color-danger)' : p >= 80 ? 'var(--color-warn)' : 'var(--color-success)')

/** 面包屑：/var/log → [/, /var, /var/log]；C:/Users/x → [C:/, C:/Users, C:/Users/x] */
export function crumbs(p: string): { label: string; path: string }[] {
  const m = /^([A-Za-z]:)?\/?/.exec(p)!
  const root = m[1] ? `${m[1]}/` : '/'
  const out = [{ label: root, path: root }]
  let cur = root
  for (const s of p.slice(m[0].length).split('/').filter(Boolean)) { cur = cur.endsWith('/') ? cur + s : `${cur}/${s}`; out.push({ label: s, path: cur }) }
  return out
}
const parentOf = (p: string) => { const c = crumbs(p); return c.length > 1 ? c[c.length - 2].path : undefined }

// 磁盘空间分析（只读）：按大小排序的目录条形列表，点目录往下钻，面包屑返回；另有大文件 / 常见占用 / 已删除仍被占用三页。
// 本地终端用 Git Bash 跑同样的 du / find；「问 AI」把已统计的内容（脱敏后）放进对话输入框
export function DiskUsageDrawer({ term, initialPath, onReveal, onClose }: { term?: TerminalInfo; initialPath?: string; onReveal?: (path: string) => void; onClose: () => void }) {
  const ok = !!term && diskSupported(term.type, term.os)
  const linux = !!term && diskLinuxOnly(term.type, term.os)
  const scopeKey = term?.type === 'ssh' ? term.id : 'local'
  const [path, setPath] = useState(() => (initialPath ? bashPath(initialPath) : term?.type === 'ssh' ? '/' : bashPath(getTermCwd(term?.id ?? '') ?? '')))
  const [draft, setDraft] = useState(path)
  const [tab, setTab] = useState<Tab>('dirs')
  const [level, setLevel] = useState<DiskLevel>()
  const [big, setBig] = useState<DiskBigFiles>()
  const [common, setCommon] = useState<DiskCommon>()
  const [deleted, setDeleted] = useState<DiskDeleted>()
  const [loading, setLoading] = useState<Tab | null>(null)
  const [err, setErr] = useState('')
  const seq = useRef(0)

  // 本地终端没上报目录时取 pwd
  useEffect(() => {
    if (path || !term) return
    client.terminal.pwd(term.id).then((p) => { const v = bashPath(p || 'C:/'); setPath(v); setDraft(v) }).catch(() => { setPath('C:/'); setDraft('C:/') })
  }, [path, term])

  const load = useCallback((t: Tab, p: string) => {
    if (!ok || !p) return
    const scope: FsScope = scopeKey === 'local' ? 'local' : { terminalId: scopeKey }
    const n = ++seq.current
    setLoading(t); setErr('')
    // 只认最后一次请求的结果：连着点目录 / 切页签时，先发的慢请求不能盖掉后发的结果
    const req = t === 'dirs' ? client.diskUsage.level(scope, p).then((r) => { if (n === seq.current) setLevel(r) })
      : t === 'big' ? client.diskUsage.bigFiles(scope, p).then((r) => { if (n === seq.current) setBig(r) })
        : t === 'common' ? client.diskUsage.common(scope).then((r) => { if (n === seq.current) setCommon(r) })
          : client.diskUsage.deleted(scope).then((r) => { if (n === seq.current) setDeleted(r) })
    req.catch((e) => { if (n === seq.current) setErr(errText(e)) }).finally(() => { if (n === seq.current) setLoading(null) })
  }, [ok, scopeKey])
  // 换目录：目录页立刻重算，大文件页跟着当前目录（切过去时再算）
  useEffect(() => { setBig(undefined); if (tab === 'dirs' || tab === 'big') load(tab, path) }, [path])
  const pick = (t: Tab) => {
    setTab(t)
    if ((t === 'big' && !big) || (t === 'common' && !common) || (t === 'deleted' && !deleted)) load(t, path)
  }
  const go = (p: string) => { setPath(p); setDraft(p); setTab('dirs') }

  const ask = async () => {
    const s = await client.settings.get().catch(() => undefined)
    const text = diskQuote({ host: term?.title ?? '', level, big, common, deleted, fmt: formatSize })
    quoteToChat(s?.system?.aiRedact === false ? text : redactSecrets(text))
    onClose()
  }

  const header = <DrawerHeader icon={<HardDrive className="h-3.5 w-3.5" />} title={tr('磁盘占用')} loading={!!loading} onRefresh={ok ? () => load(tab, path) : undefined} onClose={onClose}
    extra={ok ? <>
      <button data-disk-ask disabled={!level && !big && !common && !deleted} onClick={() => void ask()} title={tr('把已统计的结果放进对话输入框，问 AI 哪些能安全清理（按设置脱敏，不自动发送）')}
        className={`${BTN} text-[var(--color-accent)]`}><MessageSquareQuote className="h-3 w-3" />{tr('问 AI 怎么清理')}</button>
      <HelpTip>{tr('只读：只用 du / find / df / lsof 统计，不删除任何东西（要清理请在终端或资源管理器里操作，或问 AI）。只统计同一分区（du -x），每次最多算 25 秒，超时显示已统计的部分。没有 root 时读不了别人的目录，结果会偏小。本地终端用 Git Bash 统计。')}</HelpTip>
    </> : undefined} />
  if (!ok) return <div className="flex h-full flex-col">{header}<div className={`px-3 py-3 text-[12px] ${MUTED}`}>{tr('磁盘空间分析支持本地终端和 Linux / macOS 的 SSH 终端。')}</div></div>

  const fs = level?.fs
  const max = Math.max(1, ...(level?.entries.map((e) => e.kb) ?? [1]))
  const up = parentOf(path)
  return (
    <div className="flex h-full flex-col" data-disk-drawer>
      {header}
      <div className="shrink-0 space-y-1 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button title={tr('上一级')} disabled={!up} onClick={() => up && go(up)} className={IB}><ArrowUp className="h-3.5 w-3.5" /></button>
          <Input data-disk-path size="sm" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) go(bashPath(draft.trim())) }} spellCheck={false} className="font-mono" />
        </div>
        <div data-disk-crumbs className="flex flex-wrap items-center gap-x-0.5 font-mono text-[11px]">
          {crumbs(path).map((c, i, a) => (
            <span key={c.path} className="flex items-center">
              {i > 0 && i > 1 && <span className={MUTED}>/</span>}
              <button onClick={() => go(c.path)} className={`rounded px-0.5 hover:bg-[var(--color-bg-hover)] ${i === a.length - 1 ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-accent)]'}`}>{c.label}</button>
            </span>
          ))}
        </div>
        {fs && (
          <div data-disk-fs className="text-[10.5px] text-[var(--color-text-secondary)]">
            <div className="mb-0.5 flex items-center gap-1.5">
              <span className={MUTED}>{tr('分区 {mount}', { mount: fs.mount })}</span>
              <span style={{ color: pctColor(fs.usedPct) }} className="font-medium">{tr('已用 {pct}%', { pct: fs.usedPct })}</span>
              <span className={MUTED}>{tr('{used} / {size} · 剩余 {avail}', { used: kb(fs.usedKb), size: kb(fs.sizeKb), avail: kb(fs.availKb) })}</span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-[var(--color-bg-hover)]"><div className="h-full rounded" style={{ width: `${fs.usedPct}%`, background: pctColor(fs.usedPct) }} /></div>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--color-border-subtle)] px-3 py-1">
        {TABS.filter((t) => !t.linux || linux).map((t) => (
          <button key={t.id} data-disk-tab={t.id} onClick={() => pick(t.id)}
            className={`rounded px-2 py-0.5 text-[11px] ${t.id === tab ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>{tr(t.label)}</button>
        ))}
      </div>
      {err && <div className="shrink-0 whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{err}</div>}
      <div className="min-h-0 flex-1 overflow-auto text-[11.5px]">
        {loading === tab && <div className={`px-3 py-2 ${MUTED}`}>{tr('统计中…（大目录可能要十几秒）')}</div>}
        {tab === 'dirs' && level && loading !== 'dirs' && <>
          <div className={`flex items-center gap-2 px-3 py-1 text-[10.5px] ${MUTED}`}>
            <span>{trx('{dir} 合计 {total}，{n} 项', { total: <span className="font-medium text-[var(--color-text-primary)]">{kb(level.totalKb)}</span> }, { dir: level.dir, n: level.entries.length })}</span>
            {level.truncated && <span data-disk-truncated className="text-[var(--color-warn)]">{tr('超时，只统计了一部分')}</span>}
            {level.denied > 0 && <span className="text-[var(--color-warn)]">{tr('{n} 处没权限读取，结果偏小', { n: level.denied })}</span>}
          </div>
          {level.entries.length === 0 && <div className={`px-3 py-2 ${MUTED}`}>{tr('空目录')}</div>}
          {level.entries.map((e) => (
            <div key={e.path} data-disk-entry={e.name} onClick={e.dir ? () => go(e.path) : undefined} title={e.path}
              className={`group relative flex items-center gap-1.5 px-3 py-[3px] hover:bg-[var(--color-bg-hover)] ${e.dir ? 'cursor-pointer' : ''}`}>
              <div className="pointer-events-none absolute inset-y-[3px] left-3 rounded-sm bg-[color:color-mix(in_srgb,var(--color-accent)_16%,transparent)]" style={{ width: `calc(${(e.kb / max) * 100}% - 24px)` }} />
              {e.dir ? <Folder className="relative h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <FileIcon className="relative h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
              <span className="relative min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{e.name}</span>
              {e.dir && onReveal && <button title={tr('在资源管理器打开')} onClick={(ev) => { ev.stopPropagation(); onReveal(e.path) }} className={`${IB} relative hidden group-hover:flex`}><FolderOpen className="h-3 w-3" /></button>}
              <span className="relative w-10 shrink-0 text-right text-[10px] text-[var(--color-text-muted)]">{level.totalKb ? `${Math.round((e.kb / level.totalKb) * 100)}%` : ''}</span>
              <span className="relative w-16 shrink-0 text-right font-mono text-[var(--color-text-secondary)]">{kb(e.kb)}</span>
            </div>
          ))}
        </>}
        {tab === 'big' && big && loading !== 'big' && <>
          <div className={`px-3 py-1 text-[10.5px] ${MUTED}`}>{tr('{dir} 下大于 {mb}MB 的文件（同一分区）', { dir: big.dir, mb: big.minMb })}{big.truncated && <span className="ml-1 text-[var(--color-warn)]">{tr('超时，只找了一部分')}</span>}</div>
          {big.files.length === 0 && <div className={`px-3 py-2 ${MUTED}`}>{tr('没有大于 {mb}MB 的文件', { mb: big.minMb })}</div>}
          {big.files.map((f) => (
            <div key={f.path} data-disk-big className="group flex items-center gap-1.5 px-3 py-[3px] hover:bg-[var(--color-bg-hover)]" title={f.path}>
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-primary)]">{f.path}</span>
              {onReveal && <button title={tr('在资源管理器打开所在目录')} onClick={() => onReveal(parentOf(f.path) ?? '/')} className={`${IB} hidden group-hover:flex`}><FolderOpen className="h-3 w-3" /></button>}
              <span className="w-16 shrink-0 text-right font-mono text-[var(--color-text-secondary)]">{formatSize(f.bytes)}</span>
            </div>
          ))}
        </>}
        {tab === 'common' && common && loading !== 'common' && <>
          {!common.root && <div className="px-3 py-1 text-[10.5px] text-[var(--color-warn)]">{tr('不是 root：/var/lib/docker 等目录可能读不到或偏小')}</div>}
          {common.truncated && <div data-disk-common-cut className="px-3 py-1 text-[10.5px] text-[var(--color-warn)]">{tr('统计时间到，后面几项没来得及统计（可稍后刷新）')}</div>}
          {common.journal && <div className={`px-3 py-1 text-[10.5px] ${MUTED}`}>{tr('journal：{s}', { s: common.journal })}</div>}
          {common.items.map((c) => (
            <div key={c.path} data-disk-common={c.path} className="border-b border-[var(--color-border-subtle)] px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[var(--color-text-primary)]">{tr(c.label)}</span>
                <button onClick={() => go(c.path)} title={tr('在「目录占用」里展开')} className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-accent)] hover:underline">{c.path}</button>
                <span className="ml-auto shrink-0 font-mono text-[var(--color-text-secondary)]">{c.kb === undefined ? tr('读不到') : kb(c.kb)}</span>
              </div>
              <div className={`mt-0.5 text-[10.5px] leading-snug ${MUTED}`}>{tr(c.tip).split('`').map((s, i) => (i % 2 ? <code key={i} className="rounded bg-[var(--color-bg-hover)] px-1 font-mono text-[var(--color-text-secondary)]">{s}</code> : s))}</div>
            </div>
          ))}
        </>}
        {tab === 'deleted' && deleted && loading !== 'deleted' && <>
          <div className={`px-3 py-1 text-[10.5px] ${MUTED}`}>
            {trx('文件已删除但进程还开着，空间要等进程关闭文件（重启该进程）才释放。共 {total}', { total: <span className="font-medium text-[var(--color-text-primary)]">{formatSize(deleted.totalBytes)}</span> })}
            {tr('（来源：{src}）', { src: deleted.source === 'lsof' ? 'lsof +L1' : '/proc/*/fd' })}{!deleted.root && <span className="text-[var(--color-warn)]">{tr('；不是 root，只能看到自己的进程')}</span>}
          </div>
          {deleted.items.length === 0 && <div className={`px-3 py-2 ${MUTED}`}>{tr('没有发现已删除但仍被占用的文件')}</div>}
          {deleted.items.map((d) => (
            <div key={`${d.pid}:${d.path}`} data-disk-deleted className="flex items-center gap-1.5 px-3 py-[3px] hover:bg-[var(--color-bg-hover)]" title={`${d.fd ? tr('{cmd}（pid {pid}，fd {fd}）', { cmd: d.command, pid: d.pid, fd: d.fd }) : tr('{cmd}（pid {pid}）', { cmd: d.command, pid: d.pid })}\n${d.path}`}>
              <span className="w-24 shrink-0 truncate text-[var(--color-text-primary)]">{d.command}<span className={`ml-1 text-[10px] ${MUTED}`}>{d.pid}</span></span>
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-secondary)]">{d.path}</span>
              <span className="w-16 shrink-0 text-right font-mono text-[var(--color-text-secondary)]">{formatSize(d.bytes)}</span>
            </div>
          ))}
        </>}
      </div>
    </div>
  )
}
