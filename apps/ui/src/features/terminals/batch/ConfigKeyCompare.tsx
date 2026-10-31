import { useMemo, useState } from 'react'
import { Eye, EyeOff, Loader2, MessageSquareQuote } from 'lucide-react'
import {
  CONFIG_FORMATS, DIFF_STATUS_LABEL, MASK, configDiffQuote, detectConfigFormat, diffConfigs, diffCounts, redactSecrets, tr, tryFlatten,
  type CompareChoice, type ConfigDiffRow, type ConfigFormat, type DiffStatus,
} from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { quoteToChat } from '../../../lib/quoteToChat.js'
import { Select } from '../../../components/ui/Select.js'
import { Input } from '../../../components/ui/Input.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { HelpTip } from '../../../components/ui/form.js'
import { cn } from '../../../lib/cn.js'

// 配置按键对比（两端可以是任意本机 / 远程路径）：两份文件各自拍平成「键路径 → 值」再按键对齐，不受顺序、缩进、注释影响。
// 敏感值默认遮挡（●●●），点眼睛看明文；「让 AI 解释差异」只发遮挡后的差异表
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const STATUS_CLS: Record<DiffStatus, string> = {
  same: 'text-[var(--color-text-muted)]', diff: 'text-[var(--color-warn)]', onlyA: 'text-[var(--color-danger)]', onlyB: 'text-[var(--color-success)]',
}
const ROW_BG: Partial<Record<DiffStatus, string>> = {
  diff: 'bg-[color:color-mix(in_srgb,var(--color-warn)_8%,transparent)]',
  onlyA: 'bg-[color:color-mix(in_srgb,var(--color-danger)_7%,transparent)]',
  onlyB: 'bg-[color:color-mix(in_srgb,var(--color-success)_7%,transparent)]',
}

interface Side { key: string; path: string }
type Result = { rows: ConfigDiffRow[]; a: string; b: string; fa: ConfigFormat; fb: ConfigFormat }

export function ConfigKeyCompare({ choices, onClose }: { choices: CompareChoice[]; onClose: () => void }) {
  const pre = choices.filter((c) => c.live && c.key !== 'local')
  const [a, setA] = useState<Side>({ key: 'local', path: '' })
  const [b, setB] = useState<Side>({ key: pre[0]?.key ?? 'local', path: '' })
  const [fmt, setFmt] = useState<'auto' | ConfigFormat>('auto')
  const [onlyDiff, setOnlyDiff] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [res, setRes] = useState<Result | null>(null)
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')

  const opts = choices.map((c) => ({ value: c.key, label: c.key !== 'local' && !c.live ? tr('{label}（临时连接）', { label: c.label }) : c.label }))
  const label = (s: Side) => `${choices.find((c) => c.key === s.key)?.label ?? s.key}:${s.path}`
  const canRun = !!a.path.trim() && !!b.path.trim() && !busy && choices.length > 0

  const run = async () => {
    if (!canRun) return
    setBusy(true); setError(''); setShown(new Set())
    try {
      const target = (s: Side) => choices.find((c) => c.key === s.key)!.target
      const [ta, tb] = await Promise.all([
        client.configDiff.read(target(a), a.path.trim()).catch((e) => { throw new Error(tr('{side} 端：{msg}', { side: 'A', msg: errText(e) })) }),
        client.configDiff.read(target(b), b.path.trim()).catch((e) => { throw new Error(tr('{side} 端：{msg}', { side: 'B', msg: errText(e) })) }),
      ])
      const fa = fmt === 'auto' ? detectConfigFormat(a.path, ta.text) : fmt, fb = fmt === 'auto' ? detectConfigFormat(b.path, tb.text) : fmt
      const ma = tryFlatten(ta.text, fa), mb = tryFlatten(tb.text, fb)
      if ('error' in ma) throw new Error(tr('{side} 端：{msg}', { side: 'A', msg: ma.error }))
      if ('error' in mb) throw new Error(tr('{side} 端：{msg}', { side: 'B', msg: mb.error }))
      setRes({ rows: diffConfigs(ma.map, mb.map), a: label(a), b: label(b), fa, fb })
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }

  const counts = res && diffCounts(res.rows)
  const rows = useMemo(() => (res?.rows ?? []).filter((r) => (!onlyDiff || r.status !== 'same') && (!q || r.key.toLowerCase().includes(q.toLowerCase()))), [res, onlyDiff, q])
  const ask = async () => {
    if (!res) return
    const s = await client.settings.get().catch(() => undefined)
    const t = configDiffQuote(res.rows, res.a, res.b)
    quoteToChat(s?.system?.aiRedact === false ? t : redactSecrets(t))
    onClose()
  }
  const val = (r: ConfigDiffRow, v: string | undefined) => {
    if (v === undefined) return <span className="italic text-[var(--color-text-muted)]">{tr('（无）')}</span>
    if (r.sensitive && !shown.has(r.key)) return <span className="tracking-wider text-[var(--color-text-muted)]">{MASK}</span>
    return v === '' ? <span className="italic text-[var(--color-text-muted)]">{tr('（空）')}</span> : v
  }

  const side = (name: 'A' | 'B', s: Side, set: (s: Side) => void) => (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <span className="rounded bg-[var(--color-bg-raised)] px-1.5 font-semibold text-[var(--color-text-primary)]">{name}</span>
        <span>{tr('选本机或一台主机，再填文件路径')}</span>
      </div>
      <Select size="sm" value={s.key} onValueChange={(k) => set({ ...s, key: k })} options={opts} aria-label={tr('{side} 端', { side: name })} />
      <Input data-keycmp-path={name} size="sm" value={s.path} onChange={(e) => set({ ...s, path: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void run() }}
        placeholder={tr('如 {path}', { path: s.key === 'local' ? 'D:\\app\\.env' : '/opt/app/application.yml' })} spellCheck={false} className="font-mono" />
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 text-[12px]" data-keycmp>
      <div className="flex shrink-0 gap-3">{side('A', a, setA)}{side('B', b, setB)}</div>
      <div className="mt-2.5 flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)]">{tr('格式')}</span>
          <Select size="sm" className="w-36" value={fmt} onValueChange={(v) => setFmt(v as 'auto' | ConfigFormat)} options={[{ value: 'auto', label: tr('按文件名自动') }, ...CONFIG_FORMATS.map((f) => ({ value: f.id, label: f.label }))]} />
          <HelpTip>{tr('支持 .env、properties、ini / conf、YAML、JSON（含 jsonc）、TOML。两边格式可以不同（如测试用 .env、生产用 properties）。嵌套键拍平成 a.b.c，数组下标写成 a[0]；顺序、缩进、注释、引号不影响结果。键名像密码 / 令牌（password、secret、token、key…）或值像密钥的默认遮挡，点眼睛看。')}</HelpTip>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[var(--color-text-secondary)]"><Checkbox checked={onlyDiff} onCheckedChange={setOnlyDiff} />{tr('只看不同')}</label>
        {error && <span data-keycmp-error className="min-w-0 flex-1 truncate text-[var(--color-danger)]" title={error}>{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          {res && <button data-keycmp-ask onClick={() => void ask()} title={tr('把差异表（敏感值已遮挡）放进对话输入框，让 AI 解释可能的影响（不自动发送）')}
            className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2.5 py-1.5 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"><MessageSquareQuote className="h-3.5 w-3.5" />{tr('让 AI 解释差异')}</button>}
          <button data-keycmp-run disabled={!canRun} onClick={() => void run()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)] disabled:opacity-40">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{busy ? tr('读取中…') : res ? tr('重新对比') : tr('开始对比')}
          </button>
        </div>
      </div>
      {res && counts && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
          <div data-keycmp-summary className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-[11px]">
            <span className="text-[var(--color-text-muted)]">{tr('共 {n} 个键', { n: res.rows.length })}</span>
            <span className={STATUS_CLS.diff}>{tr('值不同 {n}', { n: counts.diff })}</span>
            <span className={STATUS_CLS.onlyA}>{tr('只在 A {n}', { n: counts.onlyA })}</span>
            <span className={STATUS_CLS.onlyB}>{tr('只在 B {n}', { n: counts.onlyB })}</span>
            <span className="text-[var(--color-text-muted)]">{tr('相同 {n}', { n: counts.same })}</span>
            <span className="text-[var(--color-text-muted)]">{tr('· A 按 {fa}、B 按 {fb} 解析', { fa: CONFIG_FORMATS.find((f) => f.id === res.fa)?.label ?? '', fb: CONFIG_FORMATS.find((f) => f.id === res.fb)?.label ?? '' })}</span>
            <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('过滤键名')} className="ml-auto w-40" />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed border-collapse text-[11.5px]">
              <thead className="sticky top-0 z-[1] bg-[var(--color-bg-panel)] text-left text-[10.5px] text-[var(--color-text-muted)]">
                <tr>
                  <th className="w-[30%] border-b border-[var(--color-border-subtle)] px-2.5 py-1 font-medium">{tr('键')}</th>
                  <th className="truncate border-b border-[var(--color-border-subtle)] px-2 py-1 font-medium" title={res.a}>A · {res.a}</th>
                  <th className="truncate border-b border-[var(--color-border-subtle)] px-2 py-1 font-medium" title={res.b}>B · {res.b}</th>
                  <th className="w-20 border-b border-[var(--color-border-subtle)] px-2 py-1 font-medium">{tr('差异')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={4} className="px-2.5 py-4 text-center text-[var(--color-text-muted)]">{onlyDiff ? tr('两份配置的键和值完全一致') : tr('没有键')}</td></tr>}
                {rows.map((r) => (
                  <tr key={r.key} data-keycmp-row={r.key} data-status={r.status} className={cn('align-top', ROW_BG[r.status])}>
                    <td className="break-all border-b border-[var(--color-border-subtle)] px-2.5 py-1 font-mono text-[var(--color-text-primary)]">
                      <span className="flex items-start gap-1">
                        <span className="min-w-0 flex-1">{r.key}</span>
                        {r.sensitive && (
                          <button data-keycmp-eye title={shown.has(r.key) ? tr('遮挡') : tr('显示敏感值')} onClick={() => setShown((s) => { const n = new Set(s); if (!n.delete(r.key)) n.add(r.key); return n })}
                            className="mt-[1px] shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">{shown.has(r.key) ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</button>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-2 py-1 font-mono text-[var(--color-text-secondary)]">{val(r, r.a)}</td>
                    <td className="whitespace-pre-wrap break-all border-b border-[var(--color-border-subtle)] px-2 py-1 font-mono text-[var(--color-text-secondary)]">{val(r, r.b)}</td>
                    <td className={cn('border-b border-[var(--color-border-subtle)] px-2 py-1 text-[10.5px]', STATUS_CLS[r.status])}>
                      {tr(DIFF_STATUS_LABEL[r.status])}{r.sensitive && r.status !== 'onlyA' && r.status !== 'onlyB' && !shown.has(r.key) && <span className="block text-[var(--color-text-muted)]">{r.status === 'same' ? tr('两边相同') : tr('两边不同')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!res && !busy && <div className="mt-6 text-center text-[11.5px] text-[var(--color-text-muted)]">{tr('两端各选一个位置并填路径，按键对齐比较（如测试和生产的 .env / application.yml）')}</div>}
    </div>
  )
}
