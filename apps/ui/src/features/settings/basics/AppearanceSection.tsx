import { useState } from 'react'
import { Check, Monitor } from 'lucide-react'
import { ICON_SIZES, SYSTEM_THEME_LABEL, UI_LANGUAGES, UI_THEMES, UI_ZOOMS, themeInfo, tr, type SystemSettings, type ThemeId, type ThemeKind, type UiLanguage, type UiTheme } from '@lingshell/shared'
import { saveLook, useLook } from '../../../lib/appearance.js'
import { getUiLanguage, rememberUiLanguage } from '../../../lib/locale.js'
import { saveSystemPatch } from '../../../lib/systemSave.js'
import { client } from '../../../client/index.js'
import { ConfirmDialog } from '../../common/index.js'
import { keyHint } from '../../../lib/keybindings.js'
import { cn } from '../../../lib/cn.js'
import { Select } from '../../../components/ui/Select.js'
import { Sel } from '../../../components/ui/form.js'
import { Row, Section } from '../ui.js'

/** 分段按钮：小选项组（图标大小），选中项高亮 */
function Segmented<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div role="radiogroup" data-testid={testId} className="inline-flex rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} data-value={o.id} onClick={() => onChange(o.id)}
          className={cn('flex items-center gap-1 rounded px-2.5 py-1 text-[12px] transition-colors',
            value === o.id ? 'bg-[var(--color-accent-bg)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]')}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  )
}

/** 主题色卡的缩略画面：左侧面板色条 + 主题底色 + 「Aa」+ accent 色条（颜色就是该主题自己的，所以用色卡数据而不是当前主题变量） */
function Preview({ id, className }: { id: ThemeId; className?: string }) {
  const s = themeInfo(id).swatch
  return (
    <div className={cn('flex h-full', className)} style={{ background: s.bg }}>
      <div className="w-1/4" style={{ background: s.panel }} />
      <div className="flex flex-1 flex-col justify-center gap-1 px-2">
        <span className="text-[15px] font-semibold leading-none" style={{ color: s.text }}>Aa</span>
        <span className="h-1 w-8 rounded-full" style={{ background: s.accent }} />
      </div>
    </div>
  )
}

/** 一张色卡：缩略画面 + 主题名；选中时 accent 外框 + 勾 */
function ThemeCard({ value, selected, onPick, title, children, label }: { value: UiTheme; selected: boolean; onPick: () => void; title: string; children: React.ReactNode; label: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={selected} data-value={value} title={title} onClick={onPick}
      className={cn('group relative flex flex-col overflow-hidden rounded-md border text-left transition-colors',
        selected ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-border-default)] hover:border-[var(--color-border-strong)]')}>
      <div className="h-12 w-full border-b border-[var(--color-border-subtle)]">{children}</div>
      <div className={cn('flex items-center gap-1 bg-[var(--color-bg-panel)] px-2 py-1 text-[11.5px]', selected ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]')}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
      </div>
    </button>
  )
}

const optionsOf = (kind: ThemeKind) => UI_THEMES.filter((t) => t.kind === kind).map((t) => ({
  value: t.id, label: <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border border-[var(--color-border-default)]" style={{ background: t.swatch.accent }} />{tr(t.label)}</span>,
}))

/** 设置 → 通用 → 外观：改了立即生效并保存（页面其它字段的自动保存以当前生效的外观为准，不会覆盖） */
export function AppearanceSection({ onChange }: { onChange?: (p: Partial<SystemSettings>) => void }) {
  const { look } = useLook()
  const change = (p: Partial<typeof look>) => { onChange?.(p); void saveLook(p).catch(() => {}) }
  // 界面语言：存盘后要重启才完全生效（菜单 / 托盘 / 主进程文案在启动时定）；实际语言没变（如 跟随系统 ↔ 当前语言）不问
  const [lang, setLang] = useState<UiLanguage>(getUiLanguage)
  const [askRestart, setAskRestart] = useState(false)
  const changeLang = (v: UiLanguage) => {
    setLang(v); onChange?.({ language: v })
    void saveSystemPatch({ language: v }).then(() => { if (rememberUiLanguage(v)) setAskRestart(true) }).catch(() => {})
  }
  return (
    <Section title={tr('外观')} tip={tr('改了立即生效并保存。终端配色默认「跟随界面主题」（每套主题配好了对应的终端配色），可在 设置 → 终端 单独指定。')}>
      <Row label={tr('界面语言')} hint={tr('跟随系统 = 系统是中文用中文，否则用英文；切换后重启应用生效')}>
        <div className="w-40" data-testid="ui-language"><Select value={lang} onValueChange={(v) => changeLang(v as UiLanguage)} options={UI_LANGUAGES.map((l) => ({ value: l.id, label: tr(l.label) }))} /></div>
      </Row>
      <ConfirmDialog open={askRestart} title={tr('重启以切换语言')} message={tr('界面语言已保存，重启应用后生效。打开的终端和 SSH 连接会断开，对话记录会保留。')}
        confirmText={tr('立即重启')} onConfirm={() => { setAskRestart(false); void client.system.relaunch().catch(() => {}) }} onCancel={() => setAskRestart(false)} />
      <Row label={tr('主题')} hint={tr('点一下立即切换；跟随系统 = 随 Windows / macOS 的深浅色自动切换')} wide>
        <div role="radiogroup" data-testid="ui-theme" className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2">
          {UI_THEMES.map((t) => (
            <ThemeCard key={t.id} value={t.id} selected={look.uiTheme === t.id} onPick={() => change({ uiTheme: t.id })} title={tr('{name}：{desc}', { name: tr(t.label), desc: tr(t.desc) })} label={tr(t.label)}>
              <Preview id={t.id} />
            </ThemeCard>
          ))}
          <ThemeCard value="system" selected={look.uiTheme === 'system'} onPick={() => change({ uiTheme: 'system' })} title={tr('跟随系统：系统深色 / 浅色时分别用下面选的主题')}
            label={<span className="flex items-center gap-1"><Monitor className="h-3 w-3 shrink-0" />{tr(SYSTEM_THEME_LABEL)}</span>}>
            <div className="flex h-full">
              <Preview id={look.uiThemeDark} className="w-1/2 overflow-hidden" />
              <Preview id={look.uiThemeLight} className="w-1/2 overflow-hidden" />
            </div>
          </ThemeCard>
        </div>
      </Row>
      {look.uiTheme === 'system' && <>
        <Row label={tr('系统为深色时')} hint={tr('只列深色类主题')}>
          <div className="w-40" data-testid="ui-theme-dark"><Select value={look.uiThemeDark} onValueChange={(v) => change({ uiThemeDark: v as ThemeId })} options={optionsOf('dark')} /></div>
        </Row>
        <Row label={tr('系统为浅色时')} hint={tr('只列浅色类主题')}>
          <div className="w-40" data-testid="ui-theme-light"><Select value={look.uiThemeLight} onValueChange={(v) => change({ uiThemeLight: v as ThemeId })} options={optionsOf('light')} /></div>
        </Row>
      </>}
      <Row label={tr('界面缩放')} hint={`${tr('文字、图标、间距一起缩放')}${keyHint('app.zoomIn', 'app.zoomOut', 'app.zoomReset')}`}
        tip={tr('整个窗口按比例缩放，适合高分屏或想看大一点的时候。终端字号另外在 设置 → 终端 调（或在终端里按 Ctrl+= / Ctrl+-）。')}>
        <div className="w-36"><Sel value={String(look.uiZoom)} onChange={(v) => change({ uiZoom: Number(v) })}>
          {UI_ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%{z === 1 ? tr('（默认）') : ''}</option>)}
        </Sel></div>
      </Row>
      <Row label={tr('图标大小')} hint={tr('只放大按钮和活动栏的图标，文字不变')}>
        <Segmented testId="icon-size" value={look.iconSize} onChange={(v) => change({ iconSize: v })} options={ICON_SIZES.map(({ id, label }) => ({ id, label: tr(label) }))} />
      </Row>
    </Section>
  )
}
