import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Zap, Plus, X, AlertTriangle, ChevronRight, ChevronDown, ChevronUp, Search, Pencil, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import { newQuickId, quickCommandFrom, planQuickSend, quickTargets, quickVars, resolveQuickCommand, osLabel, QUICK_OS, quickScopeCtx, quickScopeMatch, quickScopeLabel, tk, tr, type QuickOs, type QuickCommand, type QuickCommandSet, type QuickCommandsData, type QuickSendPlan, type TerminalInfo, type HostSummary } from '@lingshell/shared'
import { QuickScopePicker } from './QuickScopePicker.js'
import { client } from '../../../client/index.js'
import { onPalette, paletteCtx } from '../../../lib/paletteBus.js'
import { Select } from '../../../components/ui/Select.js'
import { Checkbox } from '../../../components/ui/Checkbox.js'
import { uiLayerBusy, uiLayerOpen } from '../../../components/ui/layer.js'

// 快速命令栏：终端区下方一排按钮，点一下把命令直接写进终端（不经 AI）。
// 数据整份存 quick-commands.json（含显示开关），这里是进程内状态：工具栏开关按钮与命令栏共用。
let data: QuickCommandsData | null = null
let loading = false
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
function load() {
  if (data || loading) return
  loading = true
  client.quickCommands.get().then((d) => { data = d; emit() }).catch(() => {}).finally(() => { loading = false })
}
function useQuickCommands() {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => data)
}
// 先乐观更新，失败回滚并抛给调用方显示
async function persist(next: QuickCommandsData) {
  const prev = data
  data = next; emit()
  try { data = await client.quickCommands.save(next); emit() } catch (e) { data = prev; emit(); throw e }
}
const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
/** 别处改快速命令（对话里 AI 提议的「保存」）：读最新一份 → 改 → 存，命令栏随之刷新 */
export async function updateQuickCommands(f: (d: QuickCommandsData) => QuickCommandsData): Promise<QuickCommandsData> {
  const cur = await client.quickCommands.get()
  await persist(f(cur))
  return data!
}

const INPUT = 'w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'
const BTN = 'rounded border border-[var(--color-border-default)] px-2.5 py-0.5 text-[12px] hover:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] disabled:opacity-50'

type Panel =
  | { kind: 'edit'; cmd?: QuickCommand; fresh?: boolean }   // fresh：预填的新命令（标题仍是「添加」）
  | { kind: 'set'; rename: boolean }
  | { kind: 'delSet' }
  | { kind: 'run'; cmd: QuickCommand; values: Record<string, string> }

// 终端区底部常驻 footer（不提供隐藏；数据里的 barVisible 只为兼容旧文件保留，界面不再读它）。trailing：最右侧附加内容（主机状态标签）；lead：紧跟「快速命令」的入口（撰写栏开关）
export function QuickCommandBar({ terms, activeId, bcast, trailing, lead }: {
  terms: TerminalInfo[]; activeId: string; bcast: ReadonlySet<string> | null; trailing?: React.ReactNode; lead?: React.ReactNode
}) {
  const d = useQuickCommands()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // 命令列表 popover（命令多了一排放不下）：q = 搜索词，hi = 键盘高亮行
  const [listOpen, setListOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // 右键菜单：点外面关
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  // 列表：点外面 / Esc 关；每次打开清空搜索
  useEffect(() => {
    if (!listOpen) return
    setQ(''); setHi(0)
    // 组下拉的面板挂在 body 上：它开着时这次点击 / Esc 归它，不关列表
    const onDown = (e: MouseEvent) => { if (!uiLayerBusy() && !listRef.current?.contains(e.target as Node)) setListOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !uiLayerOpen()) { e.stopPropagation(); setListOpen(false) } }
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [listOpen])

  // 已保存主机（显示范围按分组匹配、编辑表单列主机 / 分组）：挂载时拉一次，打开列表 / 编辑时再刷新
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const loadHosts = () => { client.hosts.list().then(setHosts).catch(() => {}) }
  const panelOpen = !!panel
  useEffect(() => { loadHosts() }, [listOpen, panelOpen])
  // 命令面板：当前终端（列快速命令时按它的系统解析、按显示范围过滤）+ 发来的「运行快速命令」走下面同一个 run（参数 / 生产危险确认都复用）
  const activeTerm = terms.find((t) => t.id === activeId)
  // 终端所属主机 id 由 terminal:list 补上（新建终端的事件里没有）：切终端 / 终端增减时拉一次
  const [termHost, setTermHost] = useState<Record<string, string>>({})
  useEffect(() => {
    client.terminal.list().then((ts) => setTermHost(Object.fromEntries(ts.flatMap((t) => (t.hostId ? [[t.id, t.hostId]] : []))))).catch(() => {})
  }, [activeId, terms.length])
  const scopeCtx = quickScopeCtx(activeTerm && { type: activeTerm.type, hostId: activeTerm.hostId ?? termHost[activeTerm.id] }, hosts)
  paletteCtx.term = activeTerm && { title: activeTerm.title, os: activeTerm.os, env: activeTerm.env, scope: scopeCtx }
  const runRef = useRef<(setId: string, cmdId: string) => void>(() => {})
  useEffect(() => onPalette((c) => {
    if (c.type === 'quick') runRef.current(c.setId, c.cmdId)
    else if (c.type === 'quickAdd') setPanel({ kind: 'edit', cmd: quickCommandFrom(c.command), fresh: true })   // 存进当前组
  }), [])

  if (!d || !terms.length) return null
  runRef.current = (setId, cmdId) => {
    const cmd = d.sets.find((s) => s.id === setId)?.commands.find((c) => c.id === cmdId)
    if (cmd) run(cmd)
  }
  // 显示范围：当前终端不在范围里的命令组 / 命令不显示；当前组不适用时显示第一个适用的组（不改存的 activeSetId）
  const visSets = d.sets.filter((s) => quickScopeMatch(s.scope, scopeCtx))
  const set = visSets.find((s) => s.id === d.activeSetId) ?? visSets[0] ?? d.sets.find((s) => s.id === d.activeSetId) ?? d.sets[0]
  const setVisible = quickScopeMatch(set.scope, scopeCtx)
  const visCmds = setVisible ? set.commands.filter((c) => quickScopeMatch(c.scope, scopeCtx)) : []
  const save = (next: QuickCommandsData) => persist(next).then(() => { setErr(null); return true }, (e) => { setErr(errText(e)); return false })
  const mutate = (f: (s: QuickCommandSet) => QuickCommandSet) => save({ ...d, sets: d.sets.map((s) => s.id === set.id ? f(s) : s) })

  // 各终端发自己系统的版本；系统不支持的跳过并提示
  const send = (plan: QuickSendPlan) => {
    setErr(plan.unsupported.length ? tr('已跳过 {list}（该系统不支持此命令）', { list: plan.unsupported.map((t) => t.title).join(tr('list|、')) }) : null)
    for (const s of plan.sends) client.terminal.write(s.term.id, s.text).catch((e) => setErr(tr('发送到 {title} 失败：{msg}', { title: s.term.title, msg: errText(e) })))
  }
  // 有占位符或要发到生产且命令危险 → 弹面板；否则直接发
  const run = (cmd: QuickCommand) => {
    const targets = quickTargets(cmd, activeId, terms, bcast)
    if (!targets.length) { setErr(tr('没有可发送的终端（已断开或 AI 执行中）')); return }
    const plan = planQuickSend(cmd, {}, targets)
    if (!plan.sends.length) { setErr(tr('{list} 的系统不支持此命令', { list: targets.map((t) => t.title).join(tr('list|、')) })); return }
    setErr(null)
    if (plan.missing.length || plan.confirmProd.length) setPanel({ kind: 'run', cmd, values: {} })
    else send(plan)
  }
  const activeOs = terms.find((t) => t.id === activeId)?.os
  const move = (id: string, delta: number) => mutate((s) => {
    const i = s.commands.findIndex((c) => c.id === id), j = i + delta
    if (i < 0 || j < 0 || j >= s.commands.length) return s
    const cs = [...s.commands];[cs[i], cs[j]] = [cs[j], cs[i]]
    return { ...s, commands: cs }
  })

  return (
    <div className="relative flex h-8 shrink-0 items-center gap-1 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-1.5 text-[12px]">
      {/* 触发按钮：显示当前组和条数；点开向上弹出列表（组切换 / 搜索 / 运行 / 编辑排序删除 / 添加） */}
      <div ref={listRef} className="relative shrink-0">
        <button onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen} title={tr('快速命令：点开列表，点一条直接发到当前终端')}
          className={`flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[var(--color-bg-hover)] ${listOpen ? 'bg-[var(--color-bg-hover)]' : ''}`}>
          <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
          <span className="text-[var(--color-text-primary)]">{tr('快速命令')}</span>
          <span className="max-w-[120px] truncate text-[var(--color-text-muted)]">{tr('· {name}（{n}）', { name: tr(set.name), n: visCmds.length })}</span>
          <ChevronUp className={`h-3.5 w-3.5 text-[var(--color-text-muted)] transition-transform ${listOpen ? '' : 'rotate-180'}`} />
        </button>
        {listOpen && (() => {
          const kw = q.trim().toLowerCase()
          // 按当前终端的系统解析实际会发的命令；不支持 → 置灰（广播时其它终端可能支持，仍可点）
          const rows = visCmds.map((c) => {
            const r = resolveQuickCommand(c, activeOs)
            const unsupported = 'unsupported' in r
            return { c, text: unsupported ? '' : r.command, unsupported, off: unsupported && !(c.target === 'broadcast' && bcast) }
          }).filter(({ c, text }) => !kw || c.label.toLowerCase().includes(kw) || tr(c.label).toLowerCase().includes(kw) || text.toLowerCase().includes(kw))
          const cur = Math.min(hi, Math.max(rows.length - 1, 0))
          const go = (row: (typeof rows)[number]) => { if (row.off) return; setListOpen(false); run(row.c) }
          const ICON = 'flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-text-primary)]'
          return (
            <div role="dialog" aria-label={tr('快速命令')} className="absolute bottom-full left-0 z-30 mb-1.5 w-[380px] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1.5 shadow-2xl animate-fade-in">
              <div className="flex items-center gap-1.5 px-1 pb-1.5">
                <Select size="sm" value={set.id} title={tr('命令组')} aria-label={tr('命令组')} className="w-auto max-w-[130px] shrink-0"
                  onValueChange={(v) => { setHi(0); save({ ...d, activeSetId: v }) }}
                  options={(setVisible ? visSets : [set, ...visSets]).map((s) => ({ value: s.id, label: tr(s.name) }))}
                  actions={[
                    { label: tr('新建命令组…'), onSelect: () => { setListOpen(false); setPanel({ kind: 'set', rename: false }) } },
                    { label: tr('编辑当前组（名称 / 显示范围）…'), onSelect: () => { setListOpen(false); setPanel({ kind: 'set', rename: true }) } },
                    ...(d.sets.length > 1 ? [{ label: tr('删除当前组…'), onSelect: () => { setListOpen(false); setPanel({ kind: 'delSet' }) } }] : []),
                  ]} />
                {/* 与左边组下拉同高（h-7 = 28px） */}
                <div data-quick-search className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-1.5 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]">
                  <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
                  <input autoFocus value={q} placeholder={tr('搜索名称或命令，↑↓ 选择，Enter 发送')} aria-label={tr('搜索快速命令')}
                    onChange={(e) => { setQ(e.target.value); setHi(0) }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(cur + 1, rows.length - 1)) }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(cur - 1, 0)) }
                      else if (e.key === 'Enter' && rows[cur]) { e.preventDefault(); go(rows[cur]) }
                    }}
                    className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
                </div>
              </div>
              <div className="max-h-[320px] overflow-y-auto">
                {!rows.length && <div className="px-2.5 py-3 text-center text-[12px] text-[var(--color-text-muted)]">{!setVisible ? tr('当前终端没有可显示的命令组（都限定了别的主机 / 分组）') : visCmds.length ? tr('没有匹配的命令') : set.commands.length ? tr('这个组的命令都限定了别的主机 / 分组') : tr('这个组还没有命令')}</div>}
                {rows.map((row, i) => (
                  <div key={row.c.id} onMouseEnter={() => setHi(i)} onClick={() => go(row)} aria-disabled={row.off}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ id: row.c.id, x: e.clientX, y: e.clientY }) }}
                    title={`${row.c.description ? `${row.c.description}\n` : ''}${row.unsupported ? tr('当前终端（{os}）不支持', { os: osLabel(activeOs) || tr('未知系统') }) : row.text}${row.c.appendEnter ? '' : tr('（不回车）')}${row.c.target === 'broadcast' ? `\n${tr('广播开着时发给广播组')}` : ''}${row.c.scope ? `\n${tr('只在：{scope}', { scope: quickScopeLabel(row.c.scope, hosts) })}` : ''}`}
                    className={`group flex items-center gap-2 rounded-md px-2 py-1.5 ${row.off ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'} ${i === cur ? 'bg-[var(--color-bg-hover)]' : ''}`}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] text-[var(--color-text-primary)]">{tr(row.c.label)}{row.c.target === 'broadcast' && <span className="ml-1.5 text-[10.5px] text-[var(--color-text-muted)]">{tr('广播')}</span>}</div>
                      <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">{row.unsupported ? tr('当前系统不支持') : row.text.split('\n')[0]}</div>
                    </div>
                    {/* 悬停才显示，不挡视线；点图标不触发运行 */}
                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
                      <button title={tr('编辑')} className={ICON} onClick={() => { setListOpen(false); setPanel({ kind: 'edit', cmd: row.c }) }}><Pencil className="h-3 w-3" /></button>
                      <button title={tr('上移')} className={ICON} disabled={!!kw} onClick={() => move(row.c.id, -1)}><ArrowUp className="h-3 w-3" /></button>
                      <button title={tr('下移')} className={ICON} disabled={!!kw} onClick={() => move(row.c.id, 1)}><ArrowDown className="h-3 w-3" /></button>
                      <button title={tr('删除')} className={`${ICON} hover:!text-[var(--color-danger)]`} onClick={() => mutate((s) => ({ ...s, commands: s.commands.filter((c) => c.id !== row.c.id) }))}><Trash2 className="h-3 w-3" /></button>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => { setListOpen(false); setPanel({ kind: 'edit' }) }}
                className="mt-1 flex w-full items-center gap-1.5 border-t border-[var(--color-border-subtle)] px-2.5 pb-1 pt-2 text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]">
                <Plus className="h-3.5 w-3.5" />{tr('添加快速命令')}
              </button>
            </div>
          )
        })()}
      </div>
      {lead}
      <div className="min-w-0 flex-1" />
      {err && (
        <span className="flex max-w-[40%] shrink-0 items-center gap-1 truncate text-[11px] text-[var(--color-danger)]" title={err}>
          <AlertTriangle className="h-3 w-3 shrink-0" /><span className="truncate">{err}</span>
          <button onClick={() => setErr(null)} className="shrink-0 hover:opacity-70"><X className="h-3 w-3" /></button>
        </span>
      )}
      {trailing}

      {menu && (
        <div style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 w-32 -translate-y-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-1 shadow-lg">
          {([
            [tk('编辑'), () => setPanel({ kind: 'edit', cmd: set.commands.find((c) => c.id === menu.id) })],
            [tk('上移'), () => move(menu.id, -1)],
            [tk('下移'), () => move(menu.id, 1)],
            [tk('删除'), () => mutate((s) => ({ ...s, commands: s.commands.filter((c) => c.id !== menu.id) }))],
          ] as const).map(([label, f]) => (
            <button key={label} onClick={() => { setMenu(null); f() }}
              className={`block w-full rounded px-2.5 py-1 text-left hover:bg-[var(--color-bg-hover)] ${label === tk('删除') ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]'}`}>{tr(label)}</button>
          ))}
        </div>
      )}

      {panel && (
        <div className="absolute bottom-full left-1.5 z-30 mb-1 w-80 space-y-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-2.5 text-[12px] text-[var(--color-text-secondary)] shadow-lg">
          {panel.kind === 'edit' && <EditForm key={panel.cmd?.id} cmd={panel.cmd} fresh={panel.fresh} hosts={hosts} onCancel={() => setPanel(null)} onSave={async (c) => {
            const ok = await mutate((s) => ({ ...s, commands: s.commands.some((x) => x.id === c.id) ? s.commands.map((x) => x.id === c.id ? c : x) : [...s.commands, c] }))
            if (ok) setPanel(null)
          }} />}
          {panel.kind === 'set' && <SetForm initial={panel.rename ? set.name : ''} initialScope={panel.rename ? set.scope : undefined} hosts={hosts} onCancel={() => setPanel(null)} onSave={async (name, scope) => {
            const ok = panel.rename ? await mutate((s) => { const { scope: _s, ...rest } = s; return { ...rest, name, ...(scope ? { scope } : {}) } })
              : await (() => { const id = newQuickId('qs'); return save({ ...d, sets: [...d.sets, { id, name, commands: [], ...(scope ? { scope } : {}) }], activeSetId: id }) })()
            if (ok) setPanel(null)
          }} />}
          {panel.kind === 'delSet' && (
            <>
              <div>{tr('删除命令组「{name}」及其 {n} 条命令？', { name: tr(set.name), n: set.commands.length })}</div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setPanel(null)} className={BTN}>{tr('取消')}</button>
                <button onClick={async () => { if (await save({ ...d, sets: d.sets.filter((s) => s.id !== set.id) })) setPanel(null) }}
                  className={`${BTN} text-[var(--color-danger)]`}>{tr('删除')}</button>
              </div>
            </>
          )}
          {panel.kind === 'run' && (() => {
            const targets = quickTargets(panel.cmd, activeId, terms, bcast)
            const plan = planQuickSend(panel.cmd, panel.values, targets)
            const vars = quickVars(panel.cmd, targets)   // 只问实际要发的版本里的参数
            // 预览：同一条命令的终端合并显示
            const groups = new Map<string, string[]>()
            for (const s of plan.sends) groups.set(s.text, [...(groups.get(s.text) ?? []), s.term.title])
            return (
              <>
                <div className="font-medium text-[var(--color-text-primary)]">{tr(panel.cmd.label)}</div>
                {vars.map((k) => (
                  <label key={k} className="block space-y-0.5">
                    <span>{k}</span>
                    {/* Enter 直接发送（输入法组字中不算）；要发到生产的危险命令必须点按钮确认，Enter 不代劳 */}
                    <input className={INPUT} value={panel.values[k] ?? ''} autoFocus={k === vars[0]}
                      onChange={(e) => setPanel({ ...panel, values: { ...panel.values, [k]: e.target.value } })}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing || plan.confirmProd.length || !plan.sends.length || plan.missing.length) return
                        e.preventDefault(); send(plan); setPanel(null)
                      }} />
                  </label>
                ))}
                {[...groups].map(([text, titles]) => (
                  <div key={text} className="space-y-0.5">
                    {groups.size > 1 && <div className="text-[11px] text-[var(--color-text-muted)]">{titles.join(tr('list|、'))}</div>}
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg-base)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-primary)]">{text.replace(/\r$/, '')}</pre>
                  </div>
                ))}
                <div>{tr('发送到：{list}', { list: plan.sends.map((s) => s.term.title).join(tr('list|、')) || tr('（无可用终端）') })}</div>
                {plan.unsupported.length > 0 && <div className="text-[var(--color-text-muted)]">{tr('跳过（系统不支持）：{list}', { list: plan.unsupported.map((t) => t.title).join(tr('list|、')) })}</div>}
                {plan.confirmProd.length > 0 && (
                  <div className="flex items-start gap-1 text-[var(--color-danger)]"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{tr('危险命令，将发到生产终端：{list}', { list: plan.confirmProd.join(tr('list|、')) })}</div>
                )}
                <div className="flex justify-end gap-2">
                  <button onClick={() => setPanel(null)} className={BTN}>{tr('取消')}</button>
                  <button disabled={!plan.sends.length || plan.missing.length > 0} onClick={() => { send(plan); setPanel(null) }}
                    className={`${BTN} ${plan.confirmProd.length ? 'border-[color:color-mix(in_srgb,var(--color-danger)_60%,transparent)] text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]'}`}>
                    {plan.confirmProd.length ? tr('确认发送到生产') : tr('verb|发送')}
                  </button>
                </div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}

const OS_INPUT_LABEL: Record<QuickOs, string> = { linux: 'Linux', macos: 'macOS', windows: tk('Windows（Git Bash）') }

function EditForm({ cmd, fresh, hosts, onSave, onCancel }: { cmd?: QuickCommand; fresh?: boolean; hosts: HostSummary[]; onSave: (c: QuickCommand) => void; onCancel: () => void }) {
  const [c, setC] = useState<QuickCommand>(cmd ?? { id: newQuickId('qc'), label: '', command: '', appendEnter: true, target: 'active' })
  const [osOpen, setOsOpen] = useState(() => Object.keys(cmd?.variants ?? {}).length > 0)
  const hasV = QUICK_OS.some((os) => c.variants?.[os]?.trim())
  const ok = c.label.trim() && (c.command.trim() || hasV)
  const setV = (os: QuickOs, v: string) => setC({ ...c, variants: { ...c.variants, [os]: v } })
  return (
    <>
      <div className="font-medium text-[var(--color-text-primary)]">{cmd && !fresh ? tr('编辑快速命令') : tr('添加快速命令')}</div>
      <input className={INPUT} placeholder={tr('按钮名称')} value={c.label} autoFocus onChange={(e) => setC({ ...c, label: e.target.value })} />
      <textarea className={`${INPUT} font-mono`} rows={3} placeholder={tr('默认命令，可多行；{{参数}} 发送前填写')} value={c.command} onChange={(e) => setC({ ...c, command: e.target.value })} />
      <button onClick={() => setOsOpen(!osOpen)} className="flex items-center gap-0.5 hover:text-[var(--color-text-primary)]">
        {osOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{hasV && !osOpen ? tr('按系统设置（已设置）') : tr('按系统设置')}
      </button>
      {osOpen && (
        <div className="space-y-1.5 pl-3">
          {QUICK_OS.map((os) => (
            <label key={os} className="block space-y-0.5">
              <span className="text-[11px]">{tr(OS_INPUT_LABEL[os])}</span>
              <input className={`${INPUT} font-mono`} placeholder={tr('留空 = 用默认命令')} value={c.variants?.[os] ?? ''} onChange={(e) => setV(os, e.target.value)} />
            </label>
          ))}
          <label className="flex items-center gap-1"><Checkbox checked={!!c.strict} onCheckedChange={(v) => setC({ ...c, strict: v })} />{tr('仅在设置了的系统上可用')}</label>
        </div>
      )}
      <QuickScopePicker value={c.scope} hosts={hosts} onChange={(scope) => { const { scope: _s, ...rest } = c; setC(scope ? { ...rest, scope } : rest) }} />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1"><Checkbox checked={c.appendEnter} onCheckedChange={(v) => setC({ ...c, appendEnter: v })} />{tr('末尾回车')}</label>
        <Select size="sm" value={c.target} onValueChange={(v) => setC({ ...c, target: v as QuickCommand['target'] })} className="w-auto">
          <option value="active">{tr('发到当前终端')}</option>
          <option value="broadcast">{tr('广播中发到广播组')}</option>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button disabled={!ok} onClick={() => onSave(c)} className={`${BTN} text-[var(--color-text-primary)]`}>{tr('保存')}</button>
      </div>
    </>
  )
}

function SetForm({ initial, initialScope, hosts, onSave, onCancel }: { initial: string; initialScope?: string[]; hosts: HostSummary[]; onSave: (name: string, scope?: string[]) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial)
  const [scope, setScope] = useState(initialScope)
  return (
    <>
      <div className="font-medium text-[var(--color-text-primary)]">{initial ? tr('编辑命令组') : tr('新建命令组')}</div>
      <input className={INPUT} placeholder={tr('命令组名称')} value={name} autoFocus onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), scope) }} />
      <QuickScopePicker value={scope} onChange={setScope} hosts={hosts} />
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className={BTN}>{tr('取消')}</button>
        <button disabled={!name.trim()} onClick={() => onSave(name.trim(), scope)} className={`${BTN} text-[var(--color-text-primary)]`}>{tr('保存')}</button>
      </div>
    </>
  )
}
