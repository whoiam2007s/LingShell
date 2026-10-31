// 设置页通用布局：分组卡片 Section + 设置行 Row（左：标签 + 问号说明，右：控件）+ 吸底保存栏 SaveBar。
// 设置项一律改了自动保存（useSystemSettings / useAutoSave）；SaveBar 只用于新建 / 编辑一条记录（模板、手册、MCP 等）。
// 长说明一律进 HelpTip（hover / 聚焦显示），页面上只留一句短提示。
import { ArrowLeft, Check } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { cn } from '../../lib/cn.js'
import { HelpTip } from '../../components/ui/form.js'

// 表单 / 布局小件已下沉到 components/ui/form.tsx（跨功能共用）；这里转出，设置页内部照旧从 ./ui.js 引用
export { BTN2, HelpTip, INPUT, Row, Section } from '../../components/ui/form.js'

/** 吸底保存栏：已保存提示 + 主按钮。放在页面根 div 末尾（页面根需为 flex 列或普通块，滚动容器内 sticky 生效） */
export function SaveBar({ onSave, saved, msg, disabled, label = tr('保存') }: { onSave: () => void; saved?: boolean; msg?: { ok: boolean; text: string } | null; disabled?: boolean; label?: string }) {
  return (
    <div data-savebar className="sticky bottom-0 -mx-4 mt-4 flex items-center gap-3 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-4 py-2.5">
      {saved && <span className="flex items-center gap-1 text-[12px] text-[var(--color-success)]"><Check className="h-3.5 w-3.5" />{tr('已保存')}</span>}
      {msg && <span className={cn('flex min-w-0 items-center gap-1 truncate text-[12px]', msg.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]')} title={msg.text}>{msg.ok && <Check className="h-3.5 w-3.5 shrink-0" />}{msg.text}</span>}
      <button onClick={onSave} disabled={disabled}
        className="ml-auto rounded-md border border-transparent bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40">{label}</button>
    </div>
  )
}

/** 页面根：统一宽度与分组间距 */
export function Page({ children, className, onBlur }: { children: React.ReactNode; className?: string; onBlur?: () => void }) {
  return <div onBlur={onBlur} className={cn('mx-auto w-full max-w-[760px] space-y-4 pb-4 [&:has(>[data-savebar]:last-child)]:pb-0', className)}>{children}</div>
}

// ── 列表页共用（模板 / 手册 / 巡检 / MCP 等）：工具栏、列表容器、空状态、返回链接、行内图标按钮 ──
export const BTN1 = 'flex shrink-0 items-center gap-1 rounded-md border border-transparent bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-dim)] disabled:opacity-40'
export const ICON_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
export const ICON_DEL = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[color:color-mix(in_srgb,var(--color-danger)_15%,transparent)] hover:text-[var(--color-danger)] disabled:opacity-30'
/** 列表容器：一张 rounded-lg 卡片，条目间细线 */
export const LIST = 'divide-y divide-[var(--color-border-subtle)] overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-base)]'
/** 列表条目行 */
export const ITEM = 'flex items-center gap-2 px-3.5 py-2 text-[12.5px]'
export const taCls = 'w-full resize-none rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]'

/** 列表页顶部工具栏：左一句短提示（+ 问号说明），右侧操作按钮 */
export function Toolbar({ hint, tip, children }: { hint?: React.ReactNode; tip?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]"><span className="truncate">{hint}</span>{tip && <HelpTip>{tip}</HelpTip>}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}
/** 空状态：居中灰字 + 可选主按钮 */
export function EmptyState({ text, action }: { text: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[var(--color-border-subtle)] px-4 py-8 text-[12.5px] text-[var(--color-text-muted)]">
      <span>{text}</span>{action}
    </div>
  )
}
export function BackLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)]"><ArrowLeft className="h-3.5 w-3.5" />{children}</button>
}
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
