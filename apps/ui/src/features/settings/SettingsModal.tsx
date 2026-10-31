import { useCallback, useEffect, useRef, useState } from 'react'
import type { AutoSaveState } from './autoSave.js'
import { AutoSaveBadge, AutoSaveReport, type AutoSaveReporter } from './useAutoSave.js'
import { uiLayerOpen } from '../../components/ui/layer.js'
import { X, Cpu, Server, SlidersHorizontal, FileText, CalendarClock, Video, Info, BookOpen, Plug, KeyRound, Globe, TerminalSquare, ShieldCheck, ArchiveRestore, Keyboard } from 'lucide-react'
import { SshManager } from './basics/SshManager.js'
import { KeyManager } from './connection/KeyManager.js'
import { McpPanel } from './productivity/McpPanel.js'
import { TerminalSettings } from './basics/TerminalSettings.js'
import { AiSecuritySettings } from './basics/AiSecuritySettings.js'
import { GeneralSettings } from './basics/GeneralSettings.js'
import { TemplateManager } from './productivity/TemplateManager.js'
import { RunbookManager } from './productivity/RunbookManager.js'
import { ScheduleManager } from './productivity/ScheduleManager.js'
import { RecordingsPanel } from './records/RecordingsPanel.js'
import { AboutPanel } from './maintenance/AboutPanel.js'
import { NetworkSettings } from './connection/NetworkSettings.js'
import { MaintenancePanel } from './maintenance/MaintenancePanel.js'
import { ShortcutSettings } from './basics/ShortcutSettings.js'
import { SkillsPanel } from './productivity/SkillsPanel.js'
import { Sparkles, Vault } from 'lucide-react'
import { SecretVaultManager } from './connection/SecretVaultManager.js'
import { Smartphone } from 'lucide-react'
import { MobileAccessSettings } from './connection/MobileAccessSettings.js'
import { ComplianceSettings } from './productivity/ComplianceSettings.js'
import { ListChecks } from 'lucide-react'
import { tk, tr } from '@lingshell/shared'

import { ModelSettings } from './basics/ModelSettings.js'
export type SettingsTab = 'model' | 'ssh' | 'terminal' | 'ai' | 'general' | 'templates' | 'runbooks' | 'schedules' | 'mcp' | 'keys' | 'network' | 'recordings' | 'about' | 'maintenance' | 'shortcuts' | 'skills' | 'secrets' | 'mobile' | 'compliance'
// 页面标题：值是中文原文（= 翻译键，帮助 / 命令面板也用它），显示时 tr()
export const TITLES: Record<SettingsTab, string> = {
  model: tk('模型设置'), ssh: tk('主机与连接'), terminal: tk('终端'), ai: tk('AI 与安全'), general: tk('通用'),
  templates: tk('常用任务模板'), runbooks: tk('运维手册'), schedules: tk('定时巡检'), mcp: tk('MCP 服务'),
  keys: tk('SSH 密钥'), network: tk('网络代理'), recordings: tk('终端录像'), about: tk('关于'),
  maintenance: tk('备份与诊断'),
  shortcuts: tk('快捷键'),
  skills: 'Skills',
  secrets: tk('密钥保险箱'),
  mobile: tk('手机访问'),
  compliance: tk('合规基线'),
}
// 左侧菜单：分组（组标题小号灰字）→ 各页
const ICONS: Record<SettingsTab, React.ComponentType<{ className?: string }>> = {
  model: Cpu, ssh: Server, terminal: TerminalSquare, ai: ShieldCheck, general: SlidersHorizontal,
  templates: FileText, runbooks: BookOpen, schedules: CalendarClock, mcp: Plug,
  keys: KeyRound, network: Globe, recordings: Video, about: Info,
  maintenance: ArchiveRestore,
  shortcuts: Keyboard,
  skills: Sparkles,
  secrets: Vault,
  mobile: Smartphone,
  compliance: ListChecks,
}
const MENU: { group?: string; tabs: SettingsTab[] }[] = [
  { group: tk('基础'), tabs: ['model', 'ssh', 'ai', 'shortcuts', 'terminal', 'general'] },
  { group: tk('效率'), tabs: ['templates', 'runbooks', 'schedules', 'compliance', 'mcp', 'skills'] },
  { group: tk('连接'), tabs: ['keys', 'secrets', 'network', 'mobile'] },
  { group: tk('记录'), tabs: ['recordings'] },
  { group: tk('维护'), tabs: ['maintenance'] },
  { tabs: ['about'] },
]

// focus：命令面板里搜到的设置项（行的标签 / 分组标题），打开后滚到它并闪一下；n 变了就再定位一次（设置已开着时再搜）
// 行只在某些状态下才显示（开关没开、正在编辑某个模型、弹窗里）时找不到：退而定位到它所在的分组，再不行就停在这一页
export type SettingsFocus = { label: string; kind: 'row' | 'section'; section?: string; n: number }
export function SettingsModal({ onClose, onSaved, initialTab = 'model', onOpenSession, onOpenHelp, focus, sshNewHost }: { onClose: () => void; onSaved?: () => void; initialTab?: SettingsTab; onOpenSession?: (sessionId: string) => void; onOpenHelp?: () => void; focus?: SettingsFocus; sshNewHost?: number }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  useEffect(() => { setTab(initialTab) }, [initialTab, focus?.n])
  // 页面可能还在加载（设置异步读回来才渲染）：最多等 3 秒找目标
  const handledFocus = useRef(0)   // 定位过一次就不再重复：以前切走再切回来会把旧目标再滚一遍 / 闪一下
  useEffect(() => {
    if (!focus || handledFocus.current === focus.n) return
    // 索引里存中文原文（翻译键），页面上 Row / Section 的 data-setting 是显示出来的译文
    const row = focus.kind === 'row' ? `[data-setting="${CSS.escape(tr(focus.label))}"]` : undefined
    const sec = focus.kind === 'section' ? focus.label : focus.section
    const find = (sel?: string) => (sel ? rootRef.current?.querySelector<HTMLElement>(`[data-settings-scroll] ${sel}`) ?? undefined : undefined)
    let tries = 0
    const t = setInterval(() => {
      tries++
      const el = find(row) ?? (tries >= 15 || !row ? find(sec ? `[data-setting-section="${CSS.escape(tr(sec))}"]` : undefined) : undefined)
      if (!el && tries < 30) return
      clearInterval(t)
      if (!el) return
      handledFocus.current = focus.n
      el.scrollIntoView({ block: 'center' })
      el.removeAttribute('data-setting-flash'); void el.offsetWidth; el.setAttribute('data-setting-flash', '')
      setTimeout(() => el.removeAttribute('data-setting-flash'), 1700)
    }, 100)
    return () => clearInterval(t)
  }, [focus?.n, tab])
  // 各页自动保存的状态（标题旁显示）；切页先清空，旧页卸载时 flush 的结果到了仍会显示
  const [save, setSave] = useState<{ state: AutoSaveState; retry?: () => void }>({ state: { status: 'idle' } })
  const report = useCallback<AutoSaveReporter>((state, retry) => setSave({ state, retry }), [])
  const switchTab = (t: SettingsTab) => {
    if (t === tab) return
    setSave({ state: { status: 'idle' } }); setTab(t)
    document.querySelector<HTMLElement>('[data-settings-scroll]')?.scrollTo({ top: 0 })   // 换页从顶部开始，不沿用上一页的滚动位置
  }
  // Esc 关闭设置。不关的情况：上面还盖着别的弹层（确认框、录像回放、手册编辑等，它们各自处理 Esc）；
  // 焦点在输入框里（第一下 Esc 只让输入框失焦并保存，免得想退出输入却把设置关了）
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 打开设置把焦点收进弹窗，并把 Tab 限制在弹窗内：以前焦点还留在后面的终端 / 输入框，能边「看设置」边往里打字
  useEffect(() => { panelRef.current?.focus() }, [])
  const onTabKey = (e: import('react').KeyboardEvent) => {
    if (e.key !== 'Tab' || !rootRef.current) return
    const els = [...rootRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null)
    if (!els.length) return
    const first = els[0], last = els[els.length - 1]
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    else if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last.focus() }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || uiLayerOpen()) return
      // 全屏弹层都是按需挂载的 fixed inset-0：除设置自身外还有一个，说明它盖在上面
      if ([...document.querySelectorAll('.fixed.inset-0')].some((o) => o !== rootRef.current)) return
      const a = document.activeElement
      if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a instanceof HTMLElement && a.dataset.ui === 'select')) { (a as HTMLElement).blur(); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div ref={rootRef} onKeyDown={onTabKey} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
      <div ref={panelRef} tabIndex={-1} className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] shadow-2xl outline-none" onClick={(e) => e.stopPropagation()}>
        <nav className="flex w-[190px] shrink-0 flex-col overflow-y-auto border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] p-2.5">
          <div className="px-2.5 pb-2 pt-1.5 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr('设置')}</div>
          {MENU.map((m, i) => (
            <div key={i} className="mt-2 flex flex-col gap-0.5">
              {m.group ? <div className="px-2.5 pb-0.5 text-[11px] text-[var(--color-text-muted)]">{tr(m.group)}</div> : <div className="mx-2.5 mb-1 border-t border-[var(--color-border-subtle)]" />}
              {m.tabs.map((t) => { const Icon = ICONS[t]; return <NavItem key={t} icon={<Icon className="h-4 w-4" />} label={tr(TITLES[t])} active={tab === t} onClick={() => switchTab(t)} /> })}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center border-b border-[var(--color-border-subtle)] px-4">
            <span className="shrink-0 text-[13px] font-semibold text-[var(--color-text-primary)]">{tr(TITLES[tab])}</span>
            <AutoSaveBadge state={save.state} retry={save.retry} />
            <button onClick={onClose} className="ml-auto flex shrink-0 h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><X className="h-4 w-4" /></button>
          </div>
          {/* 滚动容器不留底部内边距（sticky 会以内边距内侧为界，SaveBar 就贴不到底），底部留白由 Page 的 pb-4 给；以 SaveBar 结尾的页去掉 pb-4，SaveBar 才能贴底 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4" data-settings-scroll>
            <AutoSaveReport.Provider value={report}>
            {tab === 'model' ? <ModelSettings onSaved={onSaved} /> : tab === 'ssh' ? <SshManager newHostSeq={sshNewHost} /> : tab === 'terminal' ? <TerminalSettings />
              : tab === 'ai' ? <AiSecuritySettings /> : tab === 'general' ? <GeneralSettings /> : tab === 'keys' ? <KeyManager /> : tab === 'mcp' ? <McpPanel />
              : tab === 'templates' ? <TemplateManager /> : tab === 'runbooks' ? <RunbookManager /> : tab === 'schedules' ? <ScheduleManager onOpenSession={onOpenSession} />
              : tab === 'shortcuts' ? <ShortcutSettings /> : tab === 'recordings' ? <RecordingsPanel /> : tab === 'network' ? <NetworkSettings />
              : tab === 'maintenance' ? <MaintenancePanel /> : tab === 'skills' ? <SkillsPanel /> : tab === 'secrets' ? <SecretVaultManager /> : tab === 'mobile' ? <MobileAccessSettings /> : tab === 'compliance' ? <ComplianceSettings /> : <AboutPanel onOpenHelp={onOpenHelp} />}
            </AutoSaveReport.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${active ? 'bg-[var(--color-bg-raised)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>
      <span className="text-[var(--color-accent)]">{icon}</span>{label}
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div><label className="mb-1.5 flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">{label}{hint && <span className="text-[11px] text-[var(--color-success)]">{hint}</span>}</label>{children}</div>
}
