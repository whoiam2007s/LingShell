import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check } from 'lucide-react'
import { USAGE_PRICES_EVENT, PROVIDERS, tr, type UsagePrices, type UsageCurrency } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { Section, BTN2 } from '../../components/ui/form.js'
import { Select } from '../../components/ui/Select.js'

export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

type PriceRow = { provider: string; model: string; input: string; cacheRead: string; output: string }
const str = (n?: number) => (n === undefined ? '' : String(n))
const numOf = (s: string) => { const v = Number(s); return s.trim() === '' || !Number.isFinite(v) || v < 0 ? undefined : v }

// 单价表（每 1M tokens）。默认空：不内置官方价（会变、各家折扣不同），用过的模型自动列出来待填
export function PriceEditor({ seen, onSaved }: { seen: { provider: string; model: string }[]; onSaved: () => void }) {
  const [currency, setCurrency] = useState<UsageCurrency>('CNY')
  const [rows, setRows] = useState<PriceRow[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const apply = (p: UsagePrices) => { setCurrency(p.currency); setRows(p.models.map((m) => ({ provider: m.provider, model: m.model, input: str(m.input), cacheRead: str(m.cacheRead), output: str(m.output) }))) }
  useEffect(() => { client.usage.getPrices().then(apply).catch((e) => setErr(errText(e))) }, [])
  // 用过但还没填单价的模型补成空行
  const shown = useMemo(() => {
    if (!rows) return []
    const extra = seen.filter((m) => !rows.some((r) => r.provider === m.provider && r.model === m.model))
      .map((m) => ({ provider: m.provider, model: m.model, input: '', cacheRead: '', output: '' }))
    return [...rows, ...extra]
  }, [rows, seen])
  const set = (i: number, patch: Partial<PriceRow>) => setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const save = () => {
    const models = shown.filter((r) => r.provider && r.model.trim() && [r.input, r.cacheRead, r.output].some((v) => numOf(v) !== undefined))
      .map((r) => ({ provider: r.provider, model: r.model.trim(), input: numOf(r.input), cacheRead: numOf(r.cacheRead), output: numOf(r.output) }))
    // 广播一下：对话头部「本会话 tokens」的花费立刻按新单价重算，不用等下一次请求
    client.usage.savePrices({ currency, models }).then((p) => { apply(p); setSaved(true); setTimeout(() => setSaved(false), 2000); onSaved(); window.dispatchEvent(new Event(USAGE_PRICES_EVENT)) }).catch((e) => setErr(errText(e)))
  }
  const cell = 'h-7 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]'
  return (
    <Section title={tr('单价（每 1M tokens）')} tip={tr('按各家官网价格填写；某项不填按 0 算，三项都不填 = 不计花费。默认为空，不内置官方价（会变、各家折扣不同）；用过的模型会自动列出来待填。')}
      actions={<>
        <span className="text-[11px] text-[var(--color-text-muted)]">{tr('币种')}</span>
        <Select size="sm" value={currency} onValueChange={(v) => setCurrency(v as UsageCurrency)} className="w-auto">
          <option value="CNY">{tr('人民币 ¥')}</option><option value="USD">{tr('美元 $')}</option>
        </Select>
      </>}>
      <div className="space-y-2 px-3.5 py-2.5">
        {rows && shown.length === 0 && <div className="py-2 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有模型，用过后自动列出，也可手动添加')}</div>}
        {err && <div className="text-[12px] text-[var(--color-danger)]">{err}</div>}
        {rows && shown.length > 0 && (
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-[11px] text-[var(--color-text-muted)]">
              <th className="w-[150px] py-1 font-normal">{tr('提供商')}</th><th className="font-normal">{tr('模型')}</th><th className="w-[90px] font-normal">{tr('输入')}</th><th className="w-[90px] font-normal">{tr('命中缓存')}</th><th className="w-[90px] font-normal">{tr('输出')}</th><th className="w-7" />
            </tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td className="py-0.5 pr-1">
                    <Select size="sm" value={r.provider} onValueChange={(v) => set(i, { provider: v })}>
                      {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{tr(p.label)}</option>)}
                      {!PROVIDERS.some((p) => p.id === r.provider) && <option value={r.provider}>{r.provider}</option>}
                    </Select>
                  </td>
                  <td className="pr-1"><input value={r.model} onChange={(e) => set(i, { model: e.target.value })} className={cell} placeholder={tr('模型 id')} /></td>
                  {(['input', 'cacheRead', 'output'] as const).map((k) => (
                    <td key={k} className="pr-1"><input value={r[k]} onChange={(e) => set(i, { [k]: e.target.value })} inputMode="decimal" className={`${cell} tabular-nums`} placeholder="—" /></td>
                  ))}
                  <td><button onClick={() => setRows(shown.filter((_, j) => j !== i))} title={tr('删除')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"><Trash2 className="h-3.5 w-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center gap-2">
          <button onClick={() => setRows([...shown, { provider: PROVIDERS[0].id, model: '', input: '', cacheRead: '', output: '' }])} className={`flex items-center gap-1 ${BTN2}`}><Plus className="h-3.5 w-3.5" />{tr('添加模型')}</button>
          {saved && <span className="ml-auto flex items-center gap-1 text-[12px] text-[var(--color-success)]"><Check className="h-3.5 w-3.5" />{tr('已保存')}</span>}
          <button onClick={save} className={`${saved ? '' : 'ml-auto'} rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] hover:bg-[var(--color-accent-dim)]`}>{tr('保存单价')}</button>
        </div>
      </div>
    </Section>
  )
}
