import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { CONFIG_KIND_LABEL, tr, type ConfigKind, type ExplainItem, type ExplainResult } from '@lingshell/shared'
import { client } from '../../client/index.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const LEVEL_CLS: Record<ExplainItem['level'], string> = {
  ok: 'border-[var(--color-border-subtle)]',
  warn: 'border-[color:color-mix(in_srgb,var(--color-warn)_55%,transparent)]',
  danger: 'border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)]',
}

// 文件编辑器右侧的「解释」侧栏：一次性调用模型逐段解释当前内容（按内容缓存，没改动不重复请求）；点一条高亮对应行，
// 外面点行号时 activeLine 变化 → 滚到并选中覆盖该行的那条
export function ConfigExplainPanel({ path, kind, text, activeLine, onPick, onClose }: {
  path: string; kind: ConfigKind; text: string
  activeLine?: number
  onPick: (item: ExplainItem) => void
  onClose: () => void
}) {
  const [res, setRes] = useState<ExplainResult>()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<number>()
  const [stale, setStale] = useState(false)   // 解释后内容又改了
  const lastText = useRef('')
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)   // 点「重新解释」时旧请求可能后返回：只认最后一次

  const run = (force = false) => {
    const n = ++seq.current
    setBusy(true); setErr('')
    lastText.current = text
    client.configExplain.run(path, text, force)
      .then((r) => { if (n === seq.current) { setRes(r); setSel(undefined); setStale(false) } })
      .catch((e) => { if (n === seq.current) setErr(errMsg(e)) })
      .finally(() => { if (n === seq.current) setBusy(false) })
  }
  useEffect(() => { run() }, [])   // 打开即解释（有缓存直接出）
  useEffect(() => { if (res && text !== lastText.current) setStale(true) }, [text, res])
  useEffect(() => {
    if (!res || activeLine === undefined) return
    const i = res.items.findIndex((x) => activeLine >= x.start && activeLine <= x.end)
    if (i < 0) return
    setSel(i)
    listRef.current?.querySelector(`[data-explain-item="${i}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeLine, res])

  const risky = res?.items.filter((x) => x.level !== 'ok').length ?? 0
  return (
    <div data-explain-panel className="flex w-[360px] shrink-0 flex-col border-l font-sans leading-normal border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)]">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-2.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)]" title={tr(CONFIG_KIND_LABEL[kind])}>{tr('解释 · {kind}', { kind: tr(CONFIG_KIND_LABEL[kind]) })}</span>
        <span className="ml-auto" />
        {res && <button title={tr('忽略缓存，重新解释')} disabled={busy} onClick={() => run(true)} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" /></button>}
        <button title={tr('收起解释')} onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-3.5 w-3.5" /></button>
      </div>
      {res && (
        <div className="shrink-0 border-b border-[var(--color-border-subtle)] px-2.5 py-1 text-[10.5px] text-[var(--color-text-muted)]">
          {tr('{n} 段', { n: res.items.length })}{risky ? <span className="text-[var(--color-warn)]">{tr(' · {n} 处值得注意', { n: risky })}</span> : tr(' · 没发现风险')}{res.cached ? tr(' · 来自缓存') : ''}{res.truncated ? tr(' · 文件太长，只解释了前面部分') : ''}
          {stale && <> · <button onClick={() => run()} className="text-[var(--color-accent)] hover:underline">{tr('内容已改，重新解释')}</button></>}
        </div>
      )}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {busy && <div className="flex items-center gap-1.5 px-1 py-2 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />{tr('AI 正在逐段解释…')}</div>}
        {err && !busy && <div className="space-y-1.5 px-1 py-2 text-[12px] text-[var(--color-danger)]"><div className="whitespace-pre-wrap">{err}</div><button onClick={() => run()} className="text-[var(--color-accent)] hover:underline">{tr('重试')}</button></div>}
        {!busy && res?.items.map((x, i) => (
          <button key={i} data-explain-item={i} onClick={() => { setSel(i); onPick(x) }}
            className={`mb-1.5 block w-full rounded border-l-[3px] border bg-[var(--color-bg-base)] px-2 py-1.5 text-left hover:bg-[var(--color-bg-hover)] ${LEVEL_CLS[x.level]} ${sel === i ? 'ring-1 ring-[var(--color-accent)]' : ''}`}>
            <div className="flex items-center gap-1.5 text-[11.5px]">
              <span className="min-w-0 truncate font-mono font-semibold text-[var(--color-text-primary)]">{x.title || tr('（未命名）')}</span>
              <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{x.start === x.end ? tr('第 {n} 行', { n: x.start }) : tr('第 {a}–{b} 行', { a: x.start, b: x.end })}</span>
            </div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-secondary)]">{x.explain}</div>
            {x.risk && (
              <div className={`mt-1 flex items-start gap-1 text-[11px] leading-relaxed ${x.level === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]'}`}>
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /><span>{x.risk}</span>
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="shrink-0 border-t border-[var(--color-border-subtle)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">{tr('由 AI 生成，仅供参考；发送前按「发给 AI 前脱敏」处理。点一条高亮对应行，点行号定位到解释。')}</div>
    </div>
  )
}
