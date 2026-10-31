import { useEffect, useState } from 'react'
import { Layers, Server, X } from 'lucide-react'
import { batchGroups, toggleGroup, pickedTargets, ereUnsupported, MULTI_LOG_MAX_HOSTS, LOG_SEARCH_PER_HOST, LOG_SEARCH_PER_HOST_MAX, LOG_COMMON_PATHS, tk, tr, type BatchChoice, type BatchGroup, type LogSource } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { onPalette } from '../../lib/paletteBus.js'
import { cn } from '../../lib/cn.js'
import { Checkbox } from '../../components/ui/Checkbox.js'
import { Select } from '../../components/ui/Select.js'
import { Input } from '../../components/ui/Input.js'
import { Combobox } from '../../components/ui/Combobox.js'
import { NumberInput } from '../../components/ui/NumberInput.js'
import { HelpTip } from '../../components/ui/form.js'
import { ProdBadge } from '../../components/sshParts.js'
import { openMultiLog } from './LogViewer.js'
import { trx } from '../../lib/trx.js'

// 多主机日志：选主机 + 日志来源 →「实时合流」（按时间归并成一个流）或「历史检索」（时间段 + 关键字，含轮转 .gz）。
// 结果都在日志面板里开一个多主机标签。入口：日志按钮弹层「多主机日志 / 历史检索…」、命令面板
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const RANGES = [
  { value: '15m', label: tk('最近 15 分钟'), ms: 15 * 60_000 }, { value: '1h', label: tk('最近 1 小时'), ms: 3600_000 }, { value: '6h', label: tk('最近 6 小时'), ms: 6 * 3600_000 },
  { value: '24h', label: tk('最近 24 小时'), ms: 86_400_000 }, { value: '7d', label: tk('最近 7 天'), ms: 7 * 86_400_000 }, { value: 'all', label: tk('不限时间'), ms: 0 }, { value: 'custom', label: tk('自定义…'), ms: 0 },
]
// datetime-local 的值（本机时区）
const localInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16) }

export function MultiLogDialog() {
  const [open, setOpen] = useState<'follow' | 'search' | null>(null)
  useEffect(() => onPalette((c) => { if (c.type === 'multiLog') setOpen(c.mode ?? 'follow') }), [])
  return open ? <Body initial={open} onClose={() => setOpen(null)} /> : null
}

function Body({ initial, onClose }: { initial: 'follow' | 'search'; onClose: () => void }) {
  const [mode, setMode] = useState(initial)
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [kind, setKind] = useState<'file' | 'journal'>('file')
  const [path, setPath] = useState('')
  const [unit, setUnit] = useState('')
  const [range, setRange] = useState('1h')
  const [from, setFrom] = useState(() => localInput(Date.now() - 3600_000))
  const [to, setTo] = useState(() => localInput(Date.now()))
  const [pattern, setPattern] = useState('')
  const [regex, setRegex] = useState(false)
  const [cs, setCs] = useState(false)
  const [per, setPer] = useState(LOG_SEARCH_PER_HOST)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([client.hosts.list(), client.terminal.list()]).then(([hs, ts]) => {
      // 只要 SSH 主机：去掉「本机」组；已知是 Windows 的（在线终端探测出来的）也去掉——日志命令要 sh / tail / journalctl
      const winHost = new Set(ts.filter((t) => t.type === 'ssh' && t.os === 'windows').flatMap((t) => [t.id, ...(t.hostId ? [t.hostId] : [])]))
      const isWin = (c: BatchChoice) => (c.target.kind === 'host' && winHost.has(c.target.hostId)) || (c.target.kind === 'terminal' && winHost.has(c.target.terminalId))
      const gs = batchGroups(hs, ts).map((g) => ({ ...g, items: g.items.filter((c) => c.key !== 'local' && !isWin(c)) })).filter((g) => g.items.length)
      setGroups(gs)
      setPicked(gs.flatMap((g) => g.items).filter((c) => c.live).slice(0, MULTI_LOG_MAX_HOSTS).map((c) => c.key))
    }).catch((e) => setError(errText(e)))
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const targets = pickedTargets(groups, picked)
  const tooMany = targets.length > MULTI_LOG_MAX_HOSTS
  const src: LogSource | undefined = kind === 'file' ? (path.trim() ? { kind: 'file', path: path.trim() } : undefined) : unit.trim() ? { kind: 'journal', unit: unit.trim() } : { kind: 'journal' }
  let badRe = ''
  if (mode === 'search' && regex && pattern) {
    try { new RegExp(pattern) } catch { badRe = tr('正则有误') }
    // 远端是 grep -E：\d \w 之类 JS 写法会静默失配，提前拦
    const bad = !badRe && ereUnsupported(pattern)
    if (bad) badRe = tr('不支持 {x}（远端用 grep -E；\\d 请写成 [0-9]）', { x: bad })
  }
  const span = () => {
    if (range === 'custom') return { from: new Date(from).getTime() || undefined, to: new Date(to).getTime() || undefined }
    const r = RANGES.find((x) => x.value === range)
    return r?.ms ? { from: Date.now() - r.ms } : {}
  }
  const badSpan = mode === 'search' && range === 'custom' && (() => { const s = span(); return !!(s.from && s.to && s.from >= s.to) })()
  const canGo = !!src && targets.length > 0 && !tooMany && !badRe && !badSpan
  const go = () => {
    if (!canGo || !src) return
    const hosts = targets.map((c) => ({ label: c.label, target: c.target }))
    if (mode === 'follow') openMultiLog(src, { mode, hosts })
    else openMultiLog(src, { mode, hosts, query: { ...span(), ...(pattern ? { pattern } : {}), regex, caseSensitive: cs, perHost: per } })
    onClose()
  }
  const seg = (on: boolean) => cn('rounded px-3 py-1 text-[12px]', on ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')
  const lbl = 'flex items-center gap-1.5 text-[var(--color-text-secondary)]'

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div data-multilog-dialog className="relative flex max-h-[88vh] w-[760px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <Layers className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('多主机日志')}</span>
          <div className="ml-3 flex items-center gap-0.5 rounded-md border border-[var(--color-border-subtle)] p-0.5">
            <button onClick={() => setMode('follow')} className={seg(mode === 'follow')}>{tr('实时合流')}</button>
            <button onClick={() => setMode('search')} className={seg(mode === 'search')}>{tr('历史检索')}</button>
          </div>
          <HelpTip>{mode === 'follow' ? tr('每台各开一条 tail -F / journalctl -f，按日志里的时间合成一个流，每行前面标出主机。只读，不进终端和执行记录。') : tr('在每台上检索当前文件和同名轮转文件（含 .gz，用 zcat）或 journalctl，按时间段和关键字筛选，结果按时间合并。只读。')}</HelpTip>
          <button onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          <div className="grid grid-cols-[1fr_280px] gap-4">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="text-[11px] text-[var(--color-text-muted)]">{tr('日志来源（各台用同一路径 / 单元）')}</div>
                <div className="flex items-center gap-2">
                  <Select size="sm" className="w-32" value={kind} onValueChange={(v) => setKind(v as 'file' | 'journal')} options={[{ value: 'file', label: tr('日志文件') }, { value: 'journal', label: 'journalctl' }]} />
                  {kind === 'file'
                    ? <Combobox size="sm" className="min-w-0 flex-1" value={path} onChange={setPath} options={LOG_COMMON_PATHS} placeholder="/var/log/app/app.log" />
                    : <Input size="sm" className="min-w-0 flex-1 font-mono" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={tr('单元名（可空），如 nginx')} />}
                </div>
              </div>
              {mode === 'search' && (
                <div className="space-y-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={lbl}>{tr('时间段')}<Select size="sm" className="w-36" value={range} onValueChange={setRange} options={RANGES.map(({ value, label }) => ({ value, label: tr(label) }))} /></span>
                    {range === 'custom' && (
                      <span className={lbl}>
                        <Input size="sm" type="datetime-local" className="w-48" value={from} onChange={(e) => setFrom(e.target.value)} />{tr('至')}
                        <Input size="sm" type="datetime-local" className="w-48" value={to} onChange={(e) => setTo(e.target.value)} />
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(lbl, 'min-w-0 flex-1')}>{tr('关键字')}
                      <Input size="sm" className={cn('min-w-0 flex-1 font-mono', badRe && 'border-[var(--color-danger)]')} value={pattern} onChange={(e) => setPattern(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') go() }} placeholder={tr('可空；如 ERROR 或 timeout|refused')} />
                    </span>
                    <label className={cn(lbl, 'cursor-pointer')}><Checkbox checked={regex} onCheckedChange={(v) => setRegex(!!v)} />{tr('正则')}</label>
                    <label className={cn(lbl, 'cursor-pointer')}><Checkbox checked={cs} onCheckedChange={(v) => setCs(!!v)} />{tr('区分大小写')}</label>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={lbl}>{trx('每台最多{input}行（取时间段内最新的）', { input: <NumberInput size="sm" className="w-24" value={per} min={1} max={LOG_SEARCH_PER_HOST_MAX} step={100} onChange={setPer} /> })}</span>
                  </div>
                  {(badRe || badSpan) && <div className="text-[11.5px] text-[var(--color-danger)]">{badRe || tr('开始时间要早于结束时间')}</div>}
                </div>
              )}
              {error && <div className="text-[var(--color-danger)]">{error}</div>}
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('选择主机（已选 {n} 台，最多 {max} 台）', { n: targets.length, max: MULTI_LOG_MAX_HOSTS })}</div>
              <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border-subtle)]">
                {groups.length === 0 && <div className="px-3 py-2 text-[var(--color-text-muted)]">{error ? tr('加载失败') : tr('没有 SSH 主机，先在主机面板添加')}</div>}
                {groups.map((g) => {
                  const keys = g.items.map((c) => c.key), n = keys.filter((k) => picked.includes(k)).length
                  return (
                    <div key={g.name}>
                      <label className="flex cursor-pointer items-center gap-2 bg-[var(--color-bg-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                        <Checkbox checked={n === keys.length ? true : n > 0 ? 'indeterminate' : false} onCheckedChange={() => setPicked((p) => toggleGroup(p, keys))} />
                        <span className="min-w-0 flex-1 truncate font-medium">{tr(g.name)}</span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">{n}/{keys.length}</span>
                      </label>
                      {g.items.map((c) => (
                        <label key={c.key} title={c.detail} className="flex cursor-pointer items-center gap-2 py-1 pl-6 pr-2.5 hover:bg-[var(--color-bg-hover)]">
                          <Checkbox checked={picked.includes(c.key)} onCheckedChange={() => setPicked((p) => toggleGroup(p, [c.key]))} />
                          <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{c.label}</span>
                          {c.env === 'prod' && <ProdBadge />}
                          <span className={cn('shrink-0 text-[10px]', c.live ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]')}>{c.live ? tr('已连接') : tr('临时连接')}</span>
                        </label>
                      ))}
                    </div>
                  )
                })}
              </div>
              {tooMany && <div className="mt-1 text-[11.5px] text-[var(--color-warn)]">{tr('最多选 {n} 台', { n: MULTI_LOG_MAX_HOSTS })}</div>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">{tr('结果在终端区底部的日志面板里打开，每行前标出主机')}</span>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border-default)] px-4 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{tr('取消')}</button>
          <button data-multilog-go disabled={!canGo} onClick={go} className="rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
            {mode === 'follow' ? tr('开始合流') : tr('开始检索')}
          </button>
        </div>
      </div>
    </div>
  )
}
