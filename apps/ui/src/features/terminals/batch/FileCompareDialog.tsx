import { useEffect, useState } from 'react'
import { X, GitCompare, Server, MonitorDot, Loader2 } from 'lucide-react'
import { compareChoices, COMPARE_MIN, COMPARE_MAX, COMPARE_MAX_BYTES, COMPARE_QUICK_PATHS, tk, tr, type CompareChoice, type CompareResult } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { onPalette, paletteSend } from '../../../lib/paletteBus.js'
import { DiffView } from '../../../components/DiffView.js'
import { ProdBadge } from '../../../components/sshParts.js'
import { cn } from '../../../lib/cn.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { Radio } from '../../../components/ui/Radio.js'
import { ConfigKeyCompare } from './ConfigKeyCompare.js'

// 多台主机比对配置文件（只读）：选 2–6 台 + 路径 + 基准 → 汇总表（相同 / 不同 / 读取失败），点行看与基准的 diff。
// 打开：终端工具栏按钮 / 命令面板「比对多台主机的文件」（都走 paletteBus 的 compareFiles）
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

function statusOf(r: CompareResult): { text: string; cls: string } {
  if (r.status === 'baseline') return { text: tr('基准'), cls: 'text-[var(--color-accent)]' }
  if (r.status === 'same') return { text: tr('相同'), cls: 'text-[var(--color-success)]' }
  if (r.status === 'diff') return { text: r.added + r.removed ? tr('不同 +{a} −{r} 行', { a: r.added, r: r.removed }) : tr('仅末尾换行不同'), cls: 'text-[var(--color-warn)]' }
  if (r.status === 'skipped') return { text: tr('基准读取失败，未比对'), cls: 'text-[var(--color-text-muted)]' }
  return { text: tr('读取失败：{msg}', { msg: String(r.error) }), cls: 'text-[var(--color-danger)]' }
}

export function FileCompareButton() {
  return (
    <button title={tr('比对多台主机的文件（只读）')} onClick={() => paletteSend({ type: 'compareFiles' })}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]"><GitCompare className="h-3.5 w-3.5" /></button>
  )
}

export function FileCompareDialog() {
  const [open, setOpen] = useState<null | 'lines' | 'keys'>(null)
  useEffect(() => onPalette((c) => { if (c.type === 'compareFiles') setOpen(c.mode ?? 'lines') }), [])
  return open ? <CompareBody mode={open} setMode={setOpen} onClose={() => setOpen(null)} /> : null
}

function CompareBody({ mode, setMode, onClose }: { mode: 'lines' | 'keys'; setMode: (m: 'lines' | 'keys') => void; onClose: () => void }) {
  const [choices, setChoices] = useState<CompareChoice[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [baseKey, setBaseKey] = useState('')
  const [path, setPath] = useState(COMPARE_QUICK_PATHS[0])
  const [ignoreNoise, setIgnoreNoise] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 结果连同当时的目标 / 选项一起存：之后改勾选不会让表格错位
  const [res, setRes] = useState<{ items: CompareChoice[]; results: CompareResult[]; base: string; path: string; ignoreNoise: boolean } | null>(null)
  const [view, setView] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([client.hosts.list(), client.terminal.list()]).then(([hs, ts]) => {
      const cs = compareChoices(hs, ts)
      setChoices(cs)
      // 默认勾上有在线连接的远程主机（最多 COMPARE_MAX 台），本机不默认勾
      const pre = cs.filter((c) => c.live && c.key !== 'local').slice(0, COMPARE_MAX).map((c) => c.key)
      setPicked(pre); setBaseKey(pre[0] ?? '')
    }).catch((e) => setError(errText(e)))
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 保持列表顺序（不按点击先后），基准不在勾选里就退到第一台
  const items = choices.filter((c) => picked.includes(c.key))
  const base = items.some((c) => c.key === baseKey) ? baseKey : items[0]?.key ?? ''
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= COMPARE_MAX ? p : [...p, key]))
  const canRun = items.length >= COMPARE_MIN && !!path.trim() && !busy

  const run = async () => {
    if (!canRun) return
    setBusy(true); setError(''); setView(null)
    try {
      const results = await client.fs.compare(items.map((c) => c.target), path.trim(), { baseline: items.findIndex((c) => c.key === base), ignoreNoise })
      setRes({ items, results, base, path: path.trim(), ignoreNoise })
      // 有不同的默认展开第一处
      const first = results.findIndex((r) => r.status === 'diff')
      setView(first >= 0 ? first : null)
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }

  const shown = view !== null && res ? res.results[view] : undefined
  const baseLabel = res?.items.find((c) => c.key === res.base)?.label ?? ''

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div className={`flex max-h-[86vh] ${mode === 'keys' ? 'h-[86vh] w-[min(980px,94vw)]' : 'w-[760px]'} flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
          <GitCompare className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('比对文件')}</span>
          <div className="flex shrink-0 rounded-md border border-[var(--color-border-default)] p-0.5 text-[11.5px]" data-compare-mode>
            {([['lines', tk('多台按行比对')], ['keys', tk('两端按键对比')]] as const).map(([m, label]) => (
              <button key={m} data-mode={m} onClick={() => setMode(m)}
                className={cn('whitespace-nowrap rounded px-2 py-0.5', mode === m ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>{tr(label)}</button>
            ))}
          </div>
          {/* 一行放不下（英文更长）时截断，悬停看全文 */}
          <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]" title={tr('只读，不改任何文件 · 单个文件上限 {n}MB', { n: COMPARE_MAX_BYTES / 1024 / 1024 })}>{tr('只读，不改任何文件 · 单个文件上限 {n}MB', { n: COMPARE_MAX_BYTES / 1024 / 1024 })}</span>
          <button onClick={onClose} title={tr('关闭（Esc）')} className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>
        {mode === 'keys' ? <ConfigKeyCompare choices={choices} onClose={onClose} /> : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
          <div>
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">{tr('文件路径（绝对路径，~/ 表示家目录）')}</div>
            <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run() }} spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {COMPARE_QUICK_PATHS.map((p) => (
                <button key={p} onClick={() => setPath(p)}
                  className={cn('rounded border px-1.5 py-0.5 font-mono text-[11px] hover:border-[var(--color-accent)]', p === path ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]')}>{p}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center text-[11px] text-[var(--color-text-muted)]">
              <span>{tr('选择主机（{n}/{max}，至少 {min} 台）· 圆点选基准', { n: items.length, max: COMPARE_MAX, min: COMPARE_MIN })}</span>
              <span className="ml-auto">{tr('「临时连接」：比对时新建连接，读完即断')}</span>
            </div>
            <div className="max-h-52 overflow-y-auto rounded-md border border-[var(--color-border-subtle)]">
              {choices.length === 0 && <div className="px-3 py-2 text-[var(--color-text-muted)]">{tr('加载中…')}</div>}
              {choices.map((c) => {
                const on = picked.includes(c.key)
                return (
                  <label key={c.key} className={cn('flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-[var(--color-bg-hover)]', !on && picked.length >= COMPARE_MAX && 'opacity-50')}>
                    <Checkbox checked={on} disabled={!on && picked.length >= COMPARE_MAX} onCheckedChange={() => toggle(c.key)} />
                    {c.key === 'local' ? <MonitorDot className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" /> : <Server className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
                    <span className="max-w-[40%] truncate text-[var(--color-text-primary)]">{c.label}</span>
                    {c.env === 'prod' && <ProdBadge />}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">{c.detail}</span>
                    {c.key !== 'local' && <span className={cn('shrink-0 text-[10px]', c.live ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]')}>{c.live ? tr('已连接') : tr('临时连接')}</span>}
                    <Radio title={tr('以这台为基准')} checked={on && base === c.key} disabled={!on} onSelect={() => setBaseKey(c.key)} />
                  </label>
                )
              })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]">
              <Checkbox checked={ignoreNoise} onCheckedChange={setIgnoreNoise} />
              {tr('忽略空白和注释行（# / ; 开头）')}
            </label>
            {error && <span className="min-w-0 flex-1 truncate text-[var(--color-danger)]" title={error}>{error}</span>}
            <button disabled={!canRun} onClick={run}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? tr('读取中…') : res ? tr('重新比对') : tr('开始比对')}
            </button>
          </div>
          {res && (
            <div className="overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
              <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)]">
                <span className="font-mono">{res.path}</span>{tr(' · 基准：{name}', { name: baseLabel })}{res.ignoreNoise && tr(' · 已忽略空白和注释行')}
              </div>
              {res.items.map((c, i) => {
                const r = res.results[i], s = statusOf(r), clickable = r.status === 'diff'
                return (
                  <div key={c.key} onClick={clickable ? () => setView(view === i ? null : i) : undefined}
                    className={cn('flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2.5 py-1.5 last:border-b-0',
                      clickable && 'cursor-pointer hover:bg-[var(--color-bg-hover)]', view === i && 'bg-[var(--color-accent-bg)]')}>
                    <span className="max-w-[40%] truncate text-[var(--color-text-primary)]">{c.label}</span>
                    {c.env === 'prod' && <ProdBadge />}
                    <span className={cn('min-w-0 flex-1 truncate text-right', s.cls)} title={s.text}>{s.text}</span>
                    {clickable && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{view === i ? tr('收起') : tr('查看差异')}</span>}
                  </div>
                )
              })}
            </div>
          )}
          {shown?.status === 'diff' && res && view !== null && (
            <div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {tr('{base}（基准）→ {name}', { base: baseLabel, name: res.items[view].label })}{res.ignoreNoise && tr('（行号是忽略空白和注释行后的行号）')}
              </div>
              <DiffView diff={shown.diff} maxHeight="max-h-[40vh]" legend={tr('红色＝只在基准里，绿色＝只在 {name} 里', { name: res.items[view].label })} />
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
