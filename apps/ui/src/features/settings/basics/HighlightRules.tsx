import { Plus, Trash2, Regex, CaseSensitive, Bold, Bell, BellRing } from 'lucide-react'
import type { HighlightColor, HighlightRule, TerminalThemeId } from '@lingshell/shared'
import { DEFAULT_HIGHLIGHT_RULES, HIGHLIGHT_COLORS, tk, tr } from '@lingshell/shared'
import { themeOf } from '../../../lib/termPrefs.js'
import { Switch } from '../../../components/ui/Switch.js'
import { Select } from '../../../components/ui/Select.js'
import { BTN2 } from '../ui.js'

const COLOR_LABEL: Record<HighlightColor, string> = {
  red: tk('红'), green: tk('绿'), yellow: tk('黄'), blue: tk('蓝'), magenta: tk('品红'), cyan: tk('青'), white: tk('白'),
  brightRed: tk('亮红'), brightGreen: tk('亮绿'), brightYellow: tk('亮黄'), brightBlue: tk('亮蓝'), brightMagenta: tk('亮品红'), brightCyan: tk('亮青'), brightWhite: tk('亮白'),
}
const COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]

export const badRegex = (r: Pick<HighlightRule, 'isRegex' | 'pattern'>) => {
  if (!r.isRegex || !r.pattern) return false
  try { new RegExp(r.pattern); return false } catch { return true }
}
const TOGGLE = (on: boolean) => `flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--color-bg-hover)] ${on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`

// 关键字高亮规则编辑（设置 → 终端 → 提醒，wide 行）：启用/关键字/正则/大小写/粗体/告警/颜色/删除；颜色取当前终端配色的调色板
export function HighlightRules({ rules, theme, onChange }: { rules: HighlightRule[]; theme: TerminalThemeId; onChange: (r: HighlightRule[]) => void }) {
  const pal = themeOf(theme)
  const set = (i: number, p: Partial<HighlightRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)))
  return (
    <div className="space-y-1.5">
      {rules.map((r, i) => (
        <div key={r.id} className="flex items-center gap-1.5">
          <Switch checked={r.enabled} onCheckedChange={(v) => set(i, { enabled: v })} />
          <input value={r.pattern} onChange={(e) => set(i, { pattern: e.target.value })} placeholder={r.isRegex ? tr('正则表达式') : tr('关键字')}
            title={badRegex(r) ? tr('正则不合法，改对后才会自动保存') : undefined}
            style={{ color: pal[r.color] as string, background: pal.background as string, fontWeight: r.bold ? 600 : undefined }}
            className={`h-7 min-w-0 flex-1 rounded-md border px-2 font-mono text-[12px] outline-none focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)] ${badRegex(r) ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-default)]'}`} />
          <button title={tr('正则')} onClick={() => set(i, { isRegex: !r.isRegex })} className={TOGGLE(r.isRegex)}><Regex className="h-3.5 w-3.5" /></button>
          <button title={tr('区分大小写')} onClick={() => set(i, { caseSensitive: !r.caseSensitive })} className={TOGGLE(r.caseSensitive)}><CaseSensitive className="h-3.5 w-3.5" /></button>
          <button title={tr('粗体')} onClick={() => set(i, { bold: !r.bold })} className={TOGGLE(!!r.bold)}><Bold className="h-3.5 w-3.5" /></button>
          <button title={r.notify ? tr('告警：已开（命中时标签角标 / 系统通知，每 30 秒最多一次）') : tr('告警：命中时标签角标 / 系统通知')} onClick={() => set(i, { notify: !r.notify })} className={TOGGLE(!!r.notify)}>
            {r.notify ? <BellRing className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
          </button>
          <span className="h-3.5 w-3.5 shrink-0 rounded-sm" style={{ background: pal[r.color] as string }} />
          <Select size="sm" className="w-[84px]" value={r.color} onValueChange={(v) => set(i, { color: v as HighlightColor })}
            options={COLORS.map((c) => ({ value: c, label: tr(COLOR_LABEL[c]) }))} />
          <button title={tr('删除')} onClick={() => onChange(rules.filter((_, j) => j !== i))} className={`${TOGGLE(false)} hover:text-[var(--color-danger)]`}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      {rules.length === 0 && <div className="py-2 text-center text-[12px] text-[var(--color-text-muted)]">{tr('还没有规则')}</div>}
      <div className="flex gap-2 pt-1">
        <button onClick={() => onChange([...rules, { id: `r${Date.now().toString(36)}`, pattern: '', isRegex: false, caseSensitive: false, color: 'magenta', enabled: true }])}
          className={`${BTN2} flex items-center gap-1`}><Plus className="h-3.5 w-3.5" />{tr('添加规则')}</button>
        <button onClick={() => onChange(DEFAULT_HIGHLIGHT_RULES)} className={BTN2}>{tr('恢复默认')}</button>
      </div>
    </div>
  )
}
