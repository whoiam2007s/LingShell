import { Fragment, createContext, useContext, useEffect, useRef, useState } from 'react'
import { X, Search, Lightbulb, ExternalLink } from 'lucide-react'
import { helpSections, filterHelp, type HelpBlock, type HelpSection } from './helpContent.js'
import { HELP_SETTINGS_TITLES_EN } from './helpContent.en.js'
import { buildHelpIndex, helpSectionHits, helpTokens, splitHighlight, type HelpTarget } from './helpSearch.js'
import { linkify, type HelpAction } from './helpLinks.js'
import { TITLES, type SettingsTab } from '../settings/index.js'
import { KEY_ACTIONS, KEY_GROUPS, formatKey, getLocale, resolveKeybindings, tk, tr, type Keybindings } from '@lingshell/shared'
import { isAction, useKeybindings } from '../../lib/keybindings.js'

/** 打开帮助（默认 F1）：焦点在终端里时不拦（mc / htop 等终端程序要用 F1） */
export const isHelpKey = (e: KeyboardEvent) => isAction(e, 'help')

// 快捷键章节的表格从快捷键注册表生成（按分组），和实际按键处理同源；按键为当前生效值（含用户自定义）
const SCOPE_NOTE = { global: '', terminal: tk('（焦点在终端时）'), outside: tk('（焦点不在终端时）'), system: tk('（系统全局，需在设置里开启）') } as const
const keyText = (k: string | null | undefined) => (k ? formatKey(k) : tr('未设置'))
const withShortcuts = (secs: HelpSection[], b: Keybindings): HelpSection[] => secs.map((s) => s.id !== 'shortcuts' ? s : {
  ...s, blocks: [...s.blocks, ...KEY_GROUPS.map((g): HelpBlock => ({
    h: tr(g.label),
    keys: KEY_ACTIONS.filter((a) => a.group === g.id).map((a) => [a.editable ? keyText(b[a.id]) : tr(a.keys),
      tr('{name}{scope}：{desc}', { name: tr(a.name), scope: SCOPE_NOTE[a.scope] ? tr(SCOPE_NOTE[a.scope]) : '', desc: tr(a.desc) })]),
  }))],
})
/** 搜索索引 / 命令面板用（按默认按键建索引；块序号与实时渲染一致）。语言在模块求值前已定（lib/locale.ts） */
export const HELP_SECTIONS_FULL: HelpSection[] = withShortcuts(helpSections(), resolveKeybindings())
const SECTIONS = HELP_SECTIONS_FULL
/** 帮助搜索索引（命令面板与本弹窗共用）：模块加载时从帮助内容生成 */
export const HELP_INDEX = buildHelpIndex(SECTIONS)

// 章节列表：先按章节整体过滤（多词可分散在不同块），再按最好的块命中分排序
function listFor(q: string) {
  const hits = helpSectionHits(HELP_INDEX, q)
  const list = filterHelp(SECTIONS, q)
  return { list: helpTokens(q).length ? [...list].sort((a, b) => (hits.get(b.id)?.score ?? 0) - (hits.get(a.id)?.score ?? 0)) : list, hits }
}
// 该章里要滚到的块：最好的命中块，否则第一个含任一词的块，都没有 = 章节顶部
function jumpBlock(q: string, sec: string, hits: Map<string, { block: number }>) {
  const h = hits.get(sec)
  if (h) return h.block
  const tokens = helpTokens(q)
  return HELP_INDEX.find((d) => d.section === sec && d.block >= 0 && tokens.some((t) => `${d.h ?? ''} ${d.body}`.toLowerCase().includes(t)))?.block ?? -1
}

// 使用帮助：左栏按模块列章节 + 顶部搜索，右栏滚动显示内容。布局同设置弹窗
// onAction：正文链接（设置页、抽屉、终端区动作）；onOpenSettings：右上角「去设置」
// target：打开时定位到某章某块并短暂高亮（命令面板的帮助结果），q 填进搜索框、命中词高亮
export function HelpModal({ target, onClose, onOpenSettings, onAction }: { target?: HelpTarget; onClose: () => void; onOpenSettings: (tab: SettingsTab) => void; onAction: (a: HelpAction) => void }) {
  const [q, setQ] = useState(target?.q ?? '')
  const [cur, setCur] = useState(target?.section ?? SECTIONS[0].id)
  const [jump, setJump] = useState<{ block: number } | null>(target ? { block: target.block ?? -1 } : null)
  const [flash, setFlash] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 弹窗开着时再从命令面板选帮助结果：换目标
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (!target) return
    setQ(target.q ?? ''); setCur(target.section); setJump({ block: target.block ?? -1 })
  }, [target])
  // Esc 关闭。帮助可能盖在设置上面，所以只看自己是不是最上层（DOM 里最后一个全屏遮罩），不是就交给上层弹窗自己处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const all = document.querySelectorAll('.fixed.inset-0')
      if (all[all.length - 1] !== rootRef.current) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { list, hits } = listFor(q)
  const { bindings } = useKeybindings()
  const sec0 = list.find((s) => s.id === cur) ?? list[0]
  const sec = sec0?.id === 'shortcuts' ? withShortcuts(helpSections().filter((s) => s.id === 'shortcuts'), bindings)[0] : sec0   // 快捷键表显示当前生效按键
  const tokens = helpTokens(q)
  useEffect(() => { bodyRef.current?.scrollTo(0, 0) }, [sec?.id])
  // 定位：滚到块并短暂高亮（须在上面「换章节回顶部」之后执行）
  useEffect(() => {
    if (!jump) return
    const el = jump.block >= 0 ? bodyRef.current?.querySelector(`[data-help-block="${jump.block}"]`) : null
    if (!el) { bodyRef.current?.scrollTo(0, 0); return }
    el.scrollIntoView({ block: 'start' })
    setFlash(jump.block)
    const t = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(t)
  }, [jump])
  // 输入即过滤：选中得分最高的章节并滚到最佳命中块；点章节时有搜索词也滚到该章的命中块
  const search = (v: string) => {
    setQ(v)
    const r = listFor(v)
    const top = r.list[0]
    if (!top || !helpTokens(v).length) return
    setCur(top.id); setJump({ block: jumpBlock(v, top.id, r.hits) })
  }
  const pick = (id: string) => { setCur(id); setJump(tokens.length ? { block: jumpBlock(q, id, hits) } : null) }

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div role="dialog" aria-modal="true" aria-label={tr('使用帮助')} className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex w-[190px] shrink-0 flex-col gap-1 border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5">
          <div className="px-2.5 pb-2 pt-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('使用帮助')}</div>
          <div className="mb-1 flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2 focus-within:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]">
            <Search className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
            <input autoFocus value={q} onChange={(e) => search(e.target.value)} aria-label={tr('搜索帮助')} placeholder={tr('搜索帮助…')}
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); search('') } }}   // 有字先清空，再按才关
              className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {list.map((s) => (
              <button key={s.id} onClick={() => pick(s.id)} aria-current={s.id === sec?.id}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors ${s.id === sec?.id ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
                <s.icon className="h-4 w-4 shrink-0 text-[var(--color-accent)]" /><span className="truncate"><Highlight text={s.title} tokens={tokens} /></span>
              </button>
            ))}
            {!list.length && <div className="px-2.5 py-4 text-center text-[12px] text-[var(--color-text-muted)]">{tr('没有匹配的主题')}</div>}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border-subtle)] px-4">
            <span className="text-[13px] font-semibold text-[var(--color-text-primary)]">{sec?.title ?? tr('使用帮助')}</span>
            {sec?.settings && (
              <button onClick={() => onOpenSettings(sec.settings!)} className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                <ExternalLink className="h-3.5 w-3.5" />{tr('去设置：{page}', { page: settingsTitle(sec.settings) })}
              </button>
            )}
            <button onClick={onClose} title={tr('关闭（Esc）')} className={`${sec?.settings ? '' : 'ml-auto '}flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]`}><X className="h-4 w-4" /></button>
          </div>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {sec ? <ActionCtx.Provider value={onAction}><HlCtx.Provider value={tokens}><div className="max-w-[760px] space-y-2">{sec.blocks.map((b, i) => <Block key={i} i={i} b={b} flash={flash === i} />)}</div></HlCtx.Provider></ActionCtx.Provider>
              : <div className="text-[12.5px] text-[var(--color-text-muted)]">{tr('换个关键词试试，或清空搜索框看全部章节。')}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 命中词高亮（帮助正文、命令面板的帮助结果共用） */
export function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length) return <>{text}</>
  return <>{splitHighlight(text, tokens).map((p, i) => p.hit
    ? <mark key={i} className="rounded-sm bg-[color:color-mix(in_srgb,var(--color-warn)_35%,transparent)] text-inherit">{p.text}</mark>
    : <Fragment key={i}>{p.text}</Fragment>)}</>
}

// 设置页标题：中文界面就是 TITLES；英文界面用设置页译名，词典里还没有时退回帮助正文里的英文写法
function settingsTitle(tab: SettingsTab): string {
  const t = tr(TITLES[tab])
  return getLocale() === 'en' && t === TITLES[tab] ? HELP_SETTINGS_TITLES_EN[tab] : t
}
// 正文链接认的设置页标题：中文 = TITLES 原样；英文 = 界面译名 + 帮助正文写法（两者可能暂时不一致，都认）
function linkTitles(): Record<SettingsTab, string | string[]> {
  if (getLocale() !== 'en') return TITLES
  return Object.fromEntries((Object.keys(TITLES) as SettingsTab[]).map((k) => [k, [...new Set([settingsTitle(k), HELP_SETTINGS_TITLES_EN[k]])]])) as Record<SettingsTab, string[]>
}

// `反引号` 里的渲染成 code；其余文字里的入口（「设置 → 页名」「功能名」）渲染成可点链接，点了关帮助、直达该功能；搜索词高亮
const ActionCtx = createContext<(a: HelpAction) => void>(() => {})
const HlCtx = createContext<string[]>([])
function Rich({ text }: { text: string }) {
  const run = useContext(ActionCtx)
  const tokens = useContext(HlCtx)
  return <>{text.split('`').map((t, i) => i % 2
    ? <code key={i} className="rounded bg-[var(--color-bg-raised)] px-1 font-mono text-[11.5px] text-[var(--color-text-primary)]"><Highlight text={t} tokens={tokens} /></code>
    : linkify(t, linkTitles()).map((p, j) => typeof p === 'string' ? <Highlight key={`${i}-${j}`} text={p} tokens={tokens} />
      : <button key={`${i}-${j}`} type="button" onClick={() => run(p.action)} title={tr('点击打开')}
          className="text-[var(--color-accent)] underline decoration-dotted underline-offset-2 hover:decoration-solid"><Highlight text={p.text} tokens={tokens} /></button>))}</>
}

const Hl = ({ text }: { text: string }) => <Highlight text={text} tokens={useContext(HlCtx)} />

// flash：从搜索定位过来时短暂高亮整块
function Block({ b, i, flash }: { b: HelpBlock; i: number; flash: boolean }) {
  return (
    <section data-help-block={i} className={`-mx-2 scroll-mt-2 space-y-2 rounded-md px-2 py-1 text-[12.5px] leading-relaxed text-[var(--color-text-secondary)] transition-colors duration-700 ${flash ? 'bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)]' : ''}`}>
      {b.h && <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]"><Hl text={b.h} /></h3>}
      {b.p && <p><Rich text={b.p} /></p>}
      {b.steps && <ol className="list-decimal space-y-1 pl-5 marker:text-[var(--color-text-muted)]">{b.steps.map((s, k) => <li key={k}><Rich text={s} /></li>)}</ol>}
      {b.keys && (
        <div className="space-y-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 text-[12px]">
          {b.keys.map(([k, d], j) => <div key={j} className="flex gap-3"><code className="w-48 shrink-0 text-[var(--color-text-primary)]"><Hl text={k} /></code><span className="text-[var(--color-text-muted)]"><Hl text={d} /></span></div>)}
        </div>
      )}
      {b.tips && (
        <div className="flex gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5 text-[12px] text-[var(--color-text-muted)]">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
          <ul className="space-y-1">{b.tips.map((t, k) => <li key={k}><Rich text={t} /></li>)}</ul>
        </div>
      )}
    </section>
  )
}

