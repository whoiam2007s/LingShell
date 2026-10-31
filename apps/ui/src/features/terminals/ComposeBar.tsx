import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SquarePen, SendHorizontal, X, AlertTriangle } from 'lucide-react'
import { planCompose, pushComposeHistory, pasteLine, stripHidden, secretRefs, secretScopeLabel, tr, type ComposePlan, type ComposeTarget, type TerminalInfo, type SecretSummary } from '@lingshell/shared'
import { ConfirmDialog } from '../common/index.js'
import { client } from '../../client/index.js'
import { keyHint, keyLabel } from '../../lib/keybindings.js'
import { PasteConfirmDialog } from '../../components/PasteConfirm.js'
import { Select } from '../../components/ui/Select.js'

// 撰写栏（Xshell 撰写栏 / SecureCRT Command Window）：终端底部的多行输入框，写好再发。
// 开关、发送目标、历史都存 localStorage（纯界面偏好，不进配置文件）。
const LS_OPEN = 'lingshell.compose.open', LS_TARGET = 'lingshell.compose.target', LS_HIST = 'lingshell.compose.history'
const readJson = <T,>(k: string, d: T): T => { try { const v = JSON.parse(localStorage.getItem(k) ?? 'null'); return v ?? d } catch { return d } }

let open = localStorage.getItem(LS_OPEN) === '1'
const subs = new Set<() => void>()
export function toggleCompose() { open = !open; localStorage.setItem(LS_OPEN, open ? '1' : '0'); subs.forEach((f) => f()) }
const useComposeOpen = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => open)
// 对话里多行代码块「插入终端」：打开撰写栏并填入（不发送），检查后由用户自己发（走撰写栏的确认逻辑）
let inbox: string | null = null
export function composeInsert(text: string) { inbox = text; if (!open) toggleCompose(); else subs.forEach((f) => f()) }
const useComposeInbox = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => inbox)

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')

// footer 里的开关按钮（与「快速命令」并排）
export function ComposeToggle() {
  const on = useComposeOpen()
  return (
    <button onClick={toggleCompose} aria-pressed={on} title={on ? tr('关闭撰写栏{key}', { key: keyHint('term.compose') }) : tr('撰写栏：多行命令写好再发，可发到当前 / 广播组 / 全部终端{key}', { key: keyHint('term.compose') })}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--color-bg-hover)] ${on ? 'bg-[var(--color-bg-hover)] text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}`}>
      <SquarePen className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />{tr('撰写栏')}
    </button>
  )
}

export function ComposeBar({ terms, activeId, bcast }: { terms: TerminalInfo[]; activeId: string; bcast: ReadonlySet<string> | null }) {
  const on = useComposeOpen()
  const [text, setText] = useState('')
  const [target, setTargetS] = useState<ComposeTarget>(() => readJson<ComposeTarget>(LS_TARGET, 'active'))
  const [hist, setHist] = useState<string[]>(() => readJson<string[]>(LS_HIST, []))
  const [hIdx, setHIdx] = useState(-1)       // -1 = 正在编辑的草稿；否则为历史下标（0 最新）
  const draft = useRef('')
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null)
  const [ask, setAsk] = useState<ComposePlan | null>(null)
  const [secretAsk, setSecretAsk] = useState<{ plan: ComposePlan; items: { name: string; s?: SecretSummary; scope?: string }[] } | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const incoming = useComposeInbox()
  useEffect(() => {
    if (incoming === null) return
    inbox = null
    setText(incoming); setHIdx(-1)
    requestAnimationFrame(() => ta.current?.focus())
  }, [incoming])
  if (!on || !terms.length) return null

  const setTarget = (t: ComposeTarget) => { setTargetS(t); localStorage.setItem(LS_TARGET, t) }
  const doSend = (plan: ComposePlan) => {
    // 含 {{secret:名称}}：交给主进程展开后写进终端（明文不经界面；范围不符整段不发）
    const write = secretRefs(plan.data).length ? client.secrets.send : client.terminal.write
    for (const t of plan.sends) write(t.id, plan.data).catch((e) => setNote({ err: true, text: tr('发送到 {title} 失败：{msg}', { title: t.title, msg: errText(e) }) }))
    const h = pushComposeHistory(hist, text)
    setHist(h); localStorage.setItem(LS_HIST, JSON.stringify(h))
    setText(''); setHIdx(-1); draft.current = ''
    setNote(plan.skipped.length ? { err: false, text: tr('已跳过 {n} 个（断开 / AI 执行中）', { n: plan.skipped.length }) } : null)
    ta.current?.focus()
  }
  const proceed = (plan: ComposePlan) => (plan.confirm ? setAsk(plan) : doSend(plan))
  const send = async () => {
    const plan = planCompose(text, target, activeId, terms, bcast)
    if (!plan.sends.length) { setNote({ err: true, text: tr('没有可发送的终端（已断开或 AI 执行中）') }); return }
    const names = secretRefs(plan.data)
    if (!names.length) { proceed(plan); return }
    // 含密钥占位符：先确认用哪些密钥（再走原有的危险命令 / 生产确认）
    const [all, hosts] = await Promise.all([client.secrets.list().catch(() => [] as SecretSummary[]), client.hosts.list().catch(() => [])])
    const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? id
    setSecretAsk({ plan, items: names.map((n) => { const s = all.find((x) => x.name === n); return { name: n, ...(s ? { s, scope: secretScopeLabel(s, label) } : {}) } }) })
  }
  // ↑ 光标在第一行时翻更早的，↓ 光标在最后一行时翻更新的；翻回 -1 恢复草稿
  const browse = (d: 1 | -1, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    if (el.selectionStart !== el.selectionEnd) return
    const atEdge = d === 1 ? !el.value.slice(0, el.selectionStart).includes('\n') : !el.value.slice(el.selectionEnd).includes('\n')
    const next = hIdx + d
    if (!atEdge || next < -1 || next >= hist.length) return
    e.preventDefault()
    if (hIdx === -1) draft.current = text
    setHIdx(next); setText(next === -1 ? draft.current : hist[next])
  }

  const lines = Math.min(Math.max(text.split('\n').length, 2), 8)
  return (
    <div className="flex shrink-0 items-start gap-1.5 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5 py-1.5 text-[12px]">
      <textarea ref={ta} autoFocus value={text} rows={lines} spellCheck={false} aria-label={tr('撰写栏')}
        placeholder={tr('写好命令再发送：Enter 发送，Shift+Enter 换行，↑↓ 翻历史；多行逐行执行')}
        onChange={(e) => { setText(e.target.value); setHIdx(-1) }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); void send() }
          else if (e.key === 'ArrowUp' && !e.shiftKey) browse(1, e)
          else if (e.key === 'ArrowDown' && !e.shiftKey) browse(-1, e)
          else if (e.key === 'Escape') { e.preventDefault(); toggleCompose() }
        }}
        className="min-h-[52px] min-w-0 flex-1 resize-none rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 font-mono text-[12px] leading-[18px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]" />
      <div className="flex shrink-0 flex-col items-stretch gap-1">
        {/* 右列与输入框上下对齐：下拉 24 + 间距 4 + 发送 24 = 输入框最小高 52 */}
        <Select size="sm" value={target} onValueChange={(v) => setTarget(v as ComposeTarget)} title={tr('发送目标')} className="h-6 w-auto">
          <option value="active">{tr('发到当前终端')}</option>
          <option value="broadcast">{bcast ? tr('发到广播组（{n}）', { n: bcast.size }) : tr('发到广播组（未开广播 = 当前）')}</option>
          <option value="all">{tr('发到全部终端（{n}）', { n: terms.length })}</option>
        </Select>
        <button onClick={() => void send()} title={tr('发送（Enter）')}
          className="flex h-6 items-center justify-center gap-1 rounded border border-[var(--color-border-default)] px-2 text-[var(--color-text-primary)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:text-[var(--color-accent)]">
          <SendHorizontal className="h-3.5 w-3.5" />{tr('verb|发送')}
        </button>
        {note && (
          <span title={note.text} className={`flex max-w-[220px] items-center gap-1 text-[11px] ${note.err ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
            {note.err && <AlertTriangle className="h-3 w-3 shrink-0" />}<span className="truncate">{note.text}</span>
          </span>
        )}
      </div>
      <button onClick={toggleCompose} title={tr('关闭撰写栏（{keys}）', { keys: [keyLabel('term.compose'), 'Esc'].filter(Boolean).join(' / ') })} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"><X className="h-3.5 w-3.5" /></button>
      {/* 与终端粘贴同一个确认框：危险行标红、隐藏字符显示占位，可去除隐藏字符后发送 */}
      <PasteConfirmDialog open={!!ask} title={ask?.hidden ? tr('发送内容含隐藏字符') : ask?.prod.length ? tr('发送到生产终端') : tr('dialog|危险命令确认')} confirmText={tr('确认发送并执行')}
        message={tr('将发送到 {targets}{prod}，下面 {n} 行会逐行立即执行{danger}{hidden}：', {
          targets: ask?.sends.map((t) => t.title).join(tr('list|、')) ?? '',
          prod: ask?.prod.length ? tr('（含生产终端：{list}）', { list: ask.prod.join(tr('list|、')) }) : '',
          n: ask?.lines.length ?? 0,
          danger: ask?.dangerous.length ? tr('，其中 {n} 行是危险命令（红色）', { n: ask.dangerous.length }) : '',
          hidden: ask?.hidden ? tr('，含隐藏 / 控制字符（以 ⟨…⟩ 标出）') : '',
        })}
        lines={ask?.lines.map(pasteLine) ?? []}
        onCancel={() => { setAsk(null); ta.current?.focus() }}
        onConfirm={() => { const p = ask; setAsk(null); if (p) doSend(p) }}
        stripText={tr('去除隐藏字符后发送')}
        onStrip={ask?.hidden ? () => { setAsk(null); doSend(planCompose(stripHidden(text), target, activeId, terms, bcast)) } : undefined} />
      <ConfirmDialog open={!!secretAsk} title={tr('使用密钥保险箱')} confirmText={tr('替换并继续')}
        message={tr('将发送到 {targets}。发送前会把下列占位符换成真实值（只在本机主进程里替换，界面与命令历史里仍是占位符；不在可用范围内的终端会拒绝发送）：', { targets: secretAsk?.plan.sends.map((t) => t.title).join(tr('list|、')) ?? '' })}
        onCancel={() => { setSecretAsk(null); ta.current?.focus() }}
        onConfirm={() => { const p = secretAsk?.plan; setSecretAsk(null); if (p) proceed(p) }}>
        <ul className="space-y-1 text-[12px]">
          {secretAsk?.items.map(({ name, s, scope }) => (
            <li key={name} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[var(--color-accent)]">{`{{secret:${name}}}`}</span>
              <span className={s ? 'min-w-0 truncate text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]'}>
                {s ? `${tr('{desc} · 可用范围：{scope}', { desc: s.description || tr('（无说明）'), scope: scope ?? '' })}${s.hasValue ? '' : tr(' · 未设置值')}` : tr('保险箱里没有这个密钥，发送会失败')}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  )
}
