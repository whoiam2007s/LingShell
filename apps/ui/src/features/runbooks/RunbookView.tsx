// 「手册视图」（参考 Warp Notebooks）：整本运维手册按「Markdown 说明 + 命令块」显示，参数顶部一次填好；
// 每个命令块「执行到当前终端」（走撰写栏的确认逻辑：危险命令 / 隐藏字符 / 多行发生产要确认）与「复制」，
// 执行后块旁显示退出码与耗时（读终端的 OSC 133 命令标记）；「全部按顺序执行（遇错停）」；仍可「交给 AI 执行」。
// 自挂载：App 里常驻 <RunbookViewModal />，openRunbookView(id?) 打开。不能点遮罩关闭（按钮 / Esc）
import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, BookOpen, Play, Copy, Check, Square, Loader2, Bot, ListChecks, CircleAlert, Terminal as TermIcon } from 'lucide-react'
import {
  buildRunbookPrompt, fillRunbook, fmtMs, mergeStepRuns, pasteLine, planCompose, runbookMissing, runbookValues, secretRefs, tr,
  type ComposePlan, type Runbook, type StepRun, type TerminalInfo,
} from '@lingshell/shared'
import { client } from '../../client/index.js'
import { cn } from '../../lib/cn.js'
import { useActiveTerminal } from '../../lib/activeTerminal.js'
import { onTermCommand, promptStateOf, type TermCommandDone } from '../../lib/termCommands.js'
import { sendToChat } from '../../lib/sendToChat.js'
import { Select } from '../../components/ui/Select.js'
import { Input } from '../../components/ui/Input.js'
import { uiLayerOpen } from '../../components/ui/layer.js'
import { HelpTip } from '../../components/ui/form.js'
import { PasteConfirmDialog } from '../../components/PasteConfirm.js'
import { RUNBOOK_VIEW_EVENT } from './runbookViewBus.js'

export function RunbookViewModal() {
  const [open, setOpen] = useState<{ id?: string; n: number } | null>(null)
  useEffect(() => {
    const f = (e: Event) => setOpen((o) => ({ id: (e as CustomEvent<string | undefined>).detail, n: (o?.n ?? 0) + 1 }))
    window.addEventListener(RUNBOOK_VIEW_EVENT, f)
    return () => window.removeEventListener(RUNBOOK_VIEW_EVENT, f)
  }, [])
  useEffect(() => client.on((ev) => { if (ev.type === 'app:lock' && ev.locked) setOpen(null) }), [])
  if (!open) return null
  return <RunbookViewBody key={open.n} initialId={open.id} onClose={() => setOpen(null)} />
}

type StepState = { phase: 'running' } | { phase: 'done'; run: StepRun } | { phase: 'sent' } | { phase: 'skipped' } | { phase: 'error'; text: string }
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
// 拿不到退出码的终端：PowerShell / cmd 等非 bash 本地终端（没有 OSC 133 标记）
const noMarks = (t?: TerminalInfo) => !!t && (!!t.manualOnly || (!!t.shell && !t.shell.startsWith('wsl')))

function RunbookViewBody({ initialId, onClose }: { initialId?: string; onClose: () => void }) {
  const [list, setList] = useState<Runbook[] | null>(null)
  const [id, setId] = useState(initialId ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [states, setStates] = useState<Record<number, StepState>>({})
  const [ask, setAsk] = useState<{ plan: ComposePlan; title: string; go: () => void } | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  const [err, setErr] = useState('')
  const stopRef = useRef<() => void>(() => {})
  const active = useActiveTerminal()

  useEffect(() => {
    client.runbooks.list().then((l) => { setList(l); setId((cur) => (l.some((r) => r.id === cur) ? cur : l[0]?.id ?? '')) }).catch(() => setList([]))
  }, [])
  // 终端清单（标题 / 环境 / 状态）：确认逻辑与目标显示要用；隔一会儿刷新（断线 / AI 占用会变）
  useEffect(() => {
    const pull = () => client.terminal.list().then(setTerms).catch(() => {})
    pull()
    const t = setInterval(pull, 2000)
    return () => clearInterval(t)
  }, [])
  const rb = list?.find((r) => r.id === id)
  useEffect(() => { setValues({}); setStates({}); setErr('') }, [id])

  // Esc 关（上面还盖着确认框 / 下拉时不关）
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || uiLayerOpen()) return
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => !rootRef.current?.contains(o))) return
      // 焦点在终端里（vim 等要用 Esc）时不关，只有焦点在手册视图里才关
      const a = document.activeElement
      if (a && a !== document.body && !rootRef.current?.contains(a)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => () => stopRef.current(), [])

  const steps = useMemo(() => (rb ? fillRunbook(rb, values) : []), [rb, values])
  const missing = useMemo(() => (rb ? runbookMissing(rb, values) : []), [rb, values])
  const term = terms.find((t) => t.id === active?.id)
  const setSt = (i: number, s: StepState) => setStates((m) => ({ ...m, [i]: s }))

  /** 发出一个命令块并等它跑完：先挂监听再写，按行数收集 OSC 133 结果。拿不到标记的终端只发不等 */
  const sendAndWait = async (i: number, plan: ComposePlan): Promise<StepRun | undefined> => {
    const t = plan.sends[0]
    setSt(i, { phase: 'running' })
    // 还没见过提示符（渲染页刚重载等）：第一条命令收不到结束标记，先补一个回车让 shell 重画提示符
    if (!noMarks(t) && promptStateOf(t.id) === 'unknown') { await client.terminal.write(t.id, '\r').catch(() => {}); await new Promise((r) => setTimeout(r, 400)) }
    const results: TermCommandDone[] = []
    const wait = noMarks(t) ? Promise.resolve(undefined) : new Promise<StepRun | undefined>((resolve, reject) => {
      const off = onTermCommand((c) => {
        if (c.terminalId !== t.id) return
        results.push(c)
        if (results.length >= plan.lines.length) { off(); resolve(mergeStepRuns(results)) }
      })
      stopRef.current = () => { off(); reject(new Error('stopped')) }
    })
    const write = secretRefs(plan.data).length ? client.secrets.send : client.terminal.write
    return write(t.id, plan.data).then(() => wait).then((run) => {
      setSt(i, run ? { phase: 'done', run } : { phase: 'sent' })
      return run
    }, (e) => {
      const stopped = errText(e) === 'stopped'
      setSt(i, stopped ? { phase: 'error', text: tr('已停止等待（命令可能仍在终端里运行）') } : { phase: 'error', text: tr('发送失败：{msg}', { msg: errText(e) }) })
      throw e
    })
  }
  const planFor = (command: string): ComposePlan | string => {
    if (!active) return tr('没有当前终端：先在右侧打开或选中一个终端')
    const plan = planCompose(command, 'active', active.id, terms, null)
    if (!plan.sends.length) return tr('当前终端已断开或 AI 正在使用')
    if (promptStateOf(active.id) === 'busy') return tr('当前终端还有命令在运行，等它结束再执行')
    return plan
  }

  const runOne = (i: number) => {
    const s = steps[i]
    if (!s?.command || !rb) return
    const mine = runbookMissing({ params: rb.params, steps: [rb.steps[i]] }, values)   // 只看这一块用到的参数
    if (mine.length) { setErr(tr('先填参数：{list}', { list: mine.join(tr('、')) })); return }
    const p = planFor(s.command)
    if (typeof p === 'string') { setErr(p); return }
    setErr('')
    const go = () => { void sendAndWait(i, p).catch(() => {}); active?.focus() }
    if (p.confirm) setAsk({ plan: p, title: p.hidden ? tr('命令含隐藏字符') : p.prod.length ? tr('发送到生产终端') : tr('dialog|危险命令确认'), go })
    else go()
  }

  // 全部按顺序执行：一次确认全部命令，逐块发出并等退出码，非 0 即停
  const runAll = () => {
    if (missing.length) { setErr(tr('先填参数：{list}', { list: missing.join(tr('、')) })); return }
    const idx = steps.map((s, i) => (s.command ? i : -1)).filter((i) => i >= 0)
    const all = planFor(idx.map((i) => steps[i].command).join('\n'))
    if (typeof all === 'string') { setErr(all); return }
    if (noMarks(all.sends[0])) { setErr(tr('当前终端拿不到命令的退出码（非 bash），不能自动按顺序执行；请逐条执行')); return }
    setErr('')
    setAsk({
      plan: all, title: tr('全部按顺序执行'), go: async () => {
        setBusyAll(true); setStates({})
        try {
          for (const [k, i] of idx.entries()) {
            const p = planFor(steps[i].command!)
            if (typeof p === 'string') { setSt(i, { phase: 'error', text: p }); break }
            const run = await sendAndWait(i, p)
            if (run?.exitCode !== undefined && run.exitCode !== 0) { for (const j of idx.slice(k + 1)) setSt(j, { phase: 'skipped' }); break }
          }
        } catch { /* 停止 / 发送失败：已在块上标出 */ } finally { setBusyAll(false) }
      },
    })
  }
  const stop = () => stopRef.current()
  const copy = (i: number) => {
    const c = steps[i]?.command
    if (!c) return
    navigator.clipboard?.writeText(c).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1200) }, () => setErr(tr('复制失败')))
  }
  const toAi = () => {
    if (!rb) return
    // 和手动执行一致：参数没填完不交给 AI，免得它拿着 {{占位符}} 或猜值去跑
    if (missing.length) { setErr(tr('先填参数：{list}', { list: missing.join(tr('、')) })); return }
    const ts = term ? [term] : terms.filter((t) => t.status === 'running').slice(0, 1)
    if (!ts.length) { setErr(tr('没有可用的终端：先在右侧打开一个')); return }
    sendToChat(buildRunbookPrompt(rb, values, ts))
    onClose()
  }
  const v = rb ? runbookValues(rb, values) : {}
  const anyRunning = busyAll || Object.values(states).some((s) => s.phase === 'running')

  return (
    // 停靠在左侧（盖住对话区），右侧终端保持可见可操作：边执行边看输出。不点外面关（要在终端里操作），按钮 / Esc 关
    <div ref={rootRef} data-runbook-view className="fixed bottom-3 left-3 top-11 z-40 animate-fade-in">
      <div className="flex h-full w-[min(820px,56vw)] flex-col overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4 py-2">
          <BookOpen className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('运维手册')}</span>
          <Select size="sm" className="w-64" aria-label={tr('选择手册')} value={id} onValueChange={setId} placeholder={tr('选择手册')}
            options={(list ?? []).map((r) => ({ value: r.id, label: tr('{name}（{n} 步）', { name: r.name, n: r.steps.length }) }))} />
          <HelpTip>
            {tr('手动逐条执行：每个命令块「执行到当前终端」把命令发到右侧当前终端（危险命令、含隐藏字符、多行发到生产终端时先确认，同撰写栏）， 跑完在块旁显示退出码和耗时（需要 bash 终端）。「全部按顺序执行」遇到非 0 退出码即停。也可以「交给 AI 执行」，由 AI 按步骤做并对照预期结果。')}
          </HelpTip>
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--color-text-muted)]" data-runbook-target title={tr('命令发往右侧当前（焦点）终端')}>
            <TermIcon className="h-3.5 w-3.5 shrink-0" />{term ? <span className="truncate text-[var(--color-text-secondary)]">{term.title}{term.env === 'prod' ? tr('（生产）') : ''}</span> : tr('没有当前终端')}
          </span>
          <button onClick={onClose} title={tr('关闭（Esc）')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
        </div>

        {!list ? null : !rb ? (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有运维手册：可在「设置 → 运维手册」新建，或在执行记录里「保存为手册」、让 AI 生成')}</div>
        ) : (
          <>
            {/* 参数 + 操作 */}
            <div className="shrink-0 space-y-2 border-b border-[var(--color-border-subtle)] px-4 py-2.5">
              {rb.params.length > 0 && (
                <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5" data-runbook-params>
                  {rb.params.map((p) => (
                    <label key={p.name} className="flex flex-col gap-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
                      <span>{p.label}<span className="ml-1 font-mono text-[10.5px] text-[var(--color-text-muted)]">{`{{${p.name}}}`}</span></span>
                      <Input size="sm" className="w-48" value={values[p.name] ?? ''} placeholder={p.default ?? tr('必填')} aria-label={p.label}
                        onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
                    </label>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {busyAll
                  ? <button onClick={stop} className="flex items-center gap-1 rounded-md border border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)] px-2.5 py-1 text-[12px] text-[var(--color-danger)] hover:bg-[var(--color-bg-hover)]"><Square className="h-3.5 w-3.5" />{tr('停止')}</button>
                  : <button data-runbook-runall onClick={runAll} disabled={!steps.some((s) => s.command) || anyRunning}
                      className="flex items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40"><ListChecks className="h-3.5 w-3.5" />{tr('全部按顺序执行（遇错停）')}</button>}
                <button data-runbook-ai onClick={toAi} disabled={anyRunning || missing.length > 0} title={missing.length ? tr('先填参数：{list}', { list: missing.join(tr('、')) }) : tr('把手册（填好参数）发给 AI，由 AI 在当前终端按步骤执行、对照预期结果')}
                  className="flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2.5 py-1 text-[12px] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"><Bot className="h-3.5 w-3.5 text-[var(--color-accent)]" />{tr('交给 AI 执行')}</button>
                {missing.length > 0 && <span className="text-[11.5px] text-[var(--color-warn)]">{tr('待填参数：{list}', { list: missing.join(tr('、')) })}</span>}
                {err && <span className="flex items-center gap-1 text-[11.5px] text-[var(--color-danger)]"><CircleAlert className="h-3.5 w-3.5" />{err}</span>}
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">{rb.name}</h2>
              {rb.description && <div className="markdown-body break-words text-[12.5px]"><Markdown remarkPlugins={[remarkGfm]}>{rb.description}</Markdown></div>}
              {steps.map((s, i) => {
                const st = states[i]
                const unfilled = rb.steps[i].command?.match(/\{\{\s*([^{}]+?)\s*\}\}/g)?.filter((m) => !m.includes('secret:') && !v[m.slice(2, -2).trim()])
                return (
                  <section key={i} data-runbook-step={i} className="space-y-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-muted)]">{i + 1}.</span>
                      <span className="text-[13px] font-medium text-[var(--color-text-primary)]">{s.title}</span>
                      <span className={cn('shrink-0 rounded px-1.5 text-[10.5px]', s.kind === 'change' ? 'bg-[color:color-mix(in_srgb,var(--color-warn)_15%,transparent)] text-[var(--color-warn)]' : 'bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]')}>{s.kind === 'change' ? tr('runbook|改动') : tr('runbook|检查')}</span>
                    </div>
                    {s.expect && <div className="pl-5 text-[12px] text-[var(--color-text-secondary)]">{tr('预期：{text}', { text: s.expect })}</div>}
                    {s.command && (
                      <div className="ml-5 overflow-hidden rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]">
                        <div className="flex items-start gap-2 px-3 py-2">
                          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-[var(--color-text-primary)]">{s.command}</pre>
                          <div className="flex shrink-0 items-center gap-1">
                            <button data-step-run onClick={() => runOne(i)} disabled={anyRunning} title={tr('执行到当前终端（危险命令 / 生产终端会先确认）')}
                              className="flex h-6 items-center gap-1 rounded border border-[var(--color-border-default)] px-1.5 text-[11.5px] text-[var(--color-text-primary)] hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] hover:text-[var(--color-accent)] disabled:opacity-40">
                              <Play className="h-3 w-3" />{tr('执行到当前终端')}
                            </button>
                            <button onClick={() => copy(i)} title={tr('复制命令')} className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]">
                              {copied === i ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </div>
                        {(st || !!unfilled?.length) && (
                          <div data-step-status={st?.phase ?? 'unfilled'} className="flex items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-3 py-1 text-[11.5px]">
                            {!st ? <span className="text-[var(--color-warn)]">{tr('未填参数：{list}', { list: unfilled!.join(' ') })}</span>
                              : st.phase === 'running' ? <><Loader2 className="h-3 w-3 animate-spin text-[var(--color-warn)]" /><span className="text-[var(--color-text-secondary)]">{tr('执行中…')}</span>
                                <button onClick={stop} className="ml-1 text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text-primary)] hover:underline">{tr('停止等待')}</button></>
                              : st.phase === 'done' ? <span data-exit={st.run.exitCode ?? ''} className={st.run.exitCode === 0 ? 'text-[var(--color-success)]' : st.run.exitCode === undefined ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}>
                                  {st.run.exitCode === undefined ? tr('已执行（没取到退出码）') : tr('退出码 {code}', { code: st.run.exitCode })} · {tr('耗时 {time}', { time: fmtMs(st.run.durationMs) })}{st.run.lines > 1 ? tr('（{n} 行）', { n: st.run.lines }) : ''}</span>
                              : st.phase === 'sent' ? <span className="text-[var(--color-text-muted)]">{tr('已发送（此终端拿不到退出码）')}</span>
                              : st.phase === 'skipped' ? <span className="text-[var(--color-text-muted)]">{tr('前面的步骤失败，未执行')}</span>
                              : <span className="text-[var(--color-danger)]">{st.text}</span>}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </div>
      <PasteConfirmDialog open={!!ask} title={ask?.title ?? ''} confirmText={tr('确认发送并执行')}
        message={ask ? tr('将发送到 {targets}{prod}，下面 {n} 行会逐行立即执行{danger}：', {
          targets: ask.plan.sends.map((t) => t.title).join(tr('、')),
          prod: ask.plan.prod.length ? tr('（生产终端）') : '',
          n: ask.plan.lines.length,
          danger: ask.plan.dangerous.length ? tr('，其中 {n} 行是危险命令（红色）', { n: ask.plan.dangerous.length }) : '',
        }) : ''}
        lines={ask?.plan.lines.map(pasteLine) ?? []}
        onCancel={() => setAsk(null)} onConfirm={() => { const a = ask; setAsk(null); a?.go() }} />
    </div>
  )
}
