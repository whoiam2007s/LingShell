import { useEffect, useState } from 'react'
import { Copy, Check, TextCursorInput, Play } from 'lucide-react'
import { planCompose, pasteLine, stripHidden, tr, type ComposePlan } from '@lingshell/shared'
import { client } from '../../../client/index.js'
import { useActiveTerminal, getActiveTerminal } from '../../../lib/activeTerminal.js'
import { PasteConfirmDialog } from '../../../components/PasteConfirm.js'
import { composeInsert } from '../../terminals/index.js'
import { commandOf, insertText, isMultiline, isShellLang } from '../codeBlock.js'

const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
const BTN = 'flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-muted)]'

// AI 回复里的代码块：右上角悬停出现「复制」；shell 类（bash/sh/无语言…）再加「插入终端」「执行」（参考 Warp）。
// 插入 = 写到当前终端提示符、不回车（多行打开撰写栏填入，不执行）；执行 = 同撰写栏「发到当前终端」：危险命令 / 隐藏字符 / 生产终端先确认
export function CodeBlock({ lang, text, children, live }: { lang: string; text: string; children: React.ReactNode; live: boolean }) {
  const term = useActiveTerminal()
  const shell = isShellLang(lang)
  const cmd = commandOf(text)
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [ask, setAsk] = useState<ComposePlan | null>(null)
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 2500); return () => clearTimeout(t) }, [note])
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t) }, [copied])

  const copy = () => navigator.clipboard.writeText(text.replace(/\n$/, '')).then(() => setCopied(true), () => setNote({ err: true, text: tr('复制失败') }))
  // 现取终端状态（断开 / AI 执行中的不发）
  const target = async () => {
    const t = getActiveTerminal()
    if (!t) { setNote({ err: true, text: tr('没有打开的终端') }); return null }
    const terms = await client.terminal.list().catch(() => [])
    const info = terms.find((x) => x.id === t.id)
    if (!info) { setNote({ err: true, text: tr('当前终端已关闭') }); return null }
    return { t, info, terms }
  }
  const insert = async () => {
    const r = await target()
    if (!r) return
    if (isMultiline(cmd)) { composeInsert(cmd); setNote({ err: false, text: tr('多行命令已填入撰写栏，检查后发送') }); return }
    if (r.info.status === 'disconnected' || r.info.locked) { setNote({ err: true, text: r.info.locked ? tr('AI 正在这个终端执行命令') : tr('终端已断开') }); return }
    client.terminal.write(r.t.id, insertText(cmd)).then(() => r.t.focus(), (e) => setNote({ err: true, text: tr('插入失败：{error}', { error: errText(e) }) }))
  }
  const doRun = (plan: ComposePlan) => {
    const t = getActiveTerminal()
    for (const s of plan.sends) client.terminal.write(s.id, plan.data).then(() => t?.focus(), (e) => setNote({ err: true, text: tr('发送到 {name} 失败：{error}', { name: s.title, error: errText(e) }) }))
  }
  const run = async () => {
    const r = await target()
    if (!r) return
    const plan = planCompose(cmd, 'active', r.t.id, r.terms, null)
    if (!plan.sends.length) { setNote({ err: true, text: r.info.locked ? tr('AI 正在这个终端执行命令') : tr('终端已断开') }); return }
    // 比撰写栏多一条：发到生产终端单行也确认（代码块是 AI 写的，用户未必逐字看过）
    if (plan.confirm || plan.prod.length) setAsk(plan)
    else doRun(plan)
  }

  const noTerm = !term
  return (
    // 头部一行：左边语言名，右边按钮（悬停才显示）；放在代码上方而不是盖在代码上，短代码也不被挡住
    <div data-code-block className="group/code my-[0.5em] overflow-hidden rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
      <div className="flex h-6 items-center gap-1 border-b border-[var(--color-border-subtle)] pl-2.5 pr-0.5 text-[10.5px] text-[var(--color-text-muted)]">
        <span className="mr-auto font-mono">{lang || tr('代码')}</span>
        {note && <span className={`max-w-[220px] truncate text-[11px] ${note.err ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`} title={note.text}>{note.text}</span>}
        {!live && (
          <div className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/code:opacity-100">
            <button data-code-copy onClick={copy} title={tr('复制代码')} className={BTN}>{copied ? <Check className="h-3 w-3 text-[var(--color-success)]" /> : <Copy className="h-3 w-3" />}</button>
            {shell && (
              <>
                <button data-code-insert onClick={insert} disabled={noTerm} className={BTN}
                  title={noTerm ? tr('没有打开的终端') : isMultiline(cmd) ? tr('插入终端：多行命令填入撰写栏（不执行，检查后再发）') : tr('插入终端：写到当前终端的提示符，不回车')}>
                  <TextCursorInput className="h-3 w-3" />
                </button>
                <button data-code-run onClick={run} disabled={noTerm} className={BTN}
                  title={noTerm ? tr('没有打开的终端') : tr('在当前终端执行（多行逐行执行；危险命令 / 隐藏字符 / 生产终端先确认）')}>
                  <Play className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <pre className="!m-0 !rounded-none !border-0">{children}</pre>
      {/* 与撰写栏 / 终端粘贴同一个确认框 */}
      <PasteConfirmDialog open={!!ask} title={ask?.hidden ? tr('命令含隐藏字符') : ask?.dangerous.length ? tr('dialog|危险命令确认') : tr('发送到生产终端')} confirmText={tr('确认执行')}
        message={tr('将在 {targets} 执行下面 {n} 行', { targets: (ask?.sends.map((t) => t.title).join(tr('、')) ?? '') + (ask?.prod.length ? tr('（生产终端）') : ''), n: ask?.lines.length ?? 0 })
          + (ask?.dangerous.length ? tr('，其中 {n} 行是危险命令（红色）', { n: ask.dangerous.length }) : '')
          + (ask?.hidden ? tr('，含隐藏 / 控制字符（以 ⟨…⟩ 标出）') : '') + tr('：')}
        lines={ask?.lines.map(pasteLine) ?? []}
        onCancel={() => setAsk(null)}
        onConfirm={() => { const p = ask; setAsk(null); if (p) doRun(p) }}
        stripText={tr('去除隐藏字符后执行')}
        onStrip={ask?.hidden ? () => { const p = ask; setAsk(null); if (p) doRun(planCompose(stripHidden(cmd), 'active', p.sends[0]?.id ?? '', p.sends, null)) } : undefined} />
    </div>
  )
}
