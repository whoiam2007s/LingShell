// 抽屉 / 小工具共用的样式常量、错误文本、标题栏（原先在 features/opsviews/common.tsx）。
// 放在 components 是为了让数据库、K8s、部署评审等项目不必 import 运维视图功能（会把整组抽屉拉进来，形成循环依赖）
import type { ReactNode } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { tr } from '@lingshell/shared'

export const errText = (e: unknown) => String((e as { message?: string })?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const IB = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)] disabled:opacity-40'
// 次要按钮 / 主按钮同一高度（h-6）、同一字号，并排时对齐
export const BTN = 'flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] px-2 text-[11px] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent'
export const PRIMARY = 'flex h-6 shrink-0 items-center gap-1 rounded border border-transparent bg-[var(--color-accent)] px-2.5 text-[11px] font-medium text-[var(--color-bg-base)] hover:opacity-90 disabled:opacity-40'
export const MUTED = 'text-[var(--color-text-muted)]'
export const DANGER_BOX = 'rounded border border-[var(--color-danger)] bg-[color:color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-2 py-1.5 text-[12px] font-medium text-[var(--color-danger)]'

export function DrawerHeader({ icon, title, extra, loading, onRefresh, onClose }: { icon: ReactNode; title: string; extra?: ReactNode; loading?: boolean; onRefresh?: () => void; onClose: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-subtle)] px-3">
      <span className="shrink-0 text-[var(--color-accent)]">{icon}</span>
      <span className="shrink-0 text-[12px] font-semibold text-[var(--color-text-primary)]">{title}</span>
      <span className="ml-auto" />
      {extra}
      {onRefresh && <button title={tr('刷新')} disabled={loading} onClick={onRefresh} className={IB}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>}
      <button title={tr('关闭')} onClick={onClose} className={IB}><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}

/** what = 视图名（调用方已 tr） */
export const Unsupported = ({ what }: { what: string }) => (
  <div className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]">{tr('{what}只支持 Linux 的 SSH 终端：先切到一个 SSH 终端再打开。', { what })}</div>
)
