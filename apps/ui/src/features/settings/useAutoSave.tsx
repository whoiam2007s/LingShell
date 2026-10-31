// 设置页自动保存的 React 外壳：页面改值时 schedule()，卸载（关弹窗 / 切页）与关窗口时立即 flush；
// 状态经 AutoSaveReport 上报给设置弹窗标题旁的 AutoSaveBadge（「已自动保存」几秒后淡出，失败标红可重试）。
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Check, Loader2, RotateCw } from 'lucide-react'
import { tr } from '@lingshell/shared'
import { createAutoSaver, type AutoSaveState, type AutoSaver } from './autoSave.js'

export type AutoSaveReporter = (s: AutoSaveState, retry: () => void) => void
export const AutoSaveReport = createContext<AutoSaveReporter>(() => {})

/** 焦点在密码 / API Key 框里：先不存（离开输入框时再存），免得半截 Key / 密码落盘被拿去用 */
export const typingSecret = () => !!(document.activeElement as HTMLElement | null)?.closest?.('[data-password-input]')

export function useAutoSave(o: { save: () => Promise<void>; validate?: () => string | null | undefined; defer?: () => boolean }) {
  const report = useContext(AutoSaveReport)
  const ref = useRef({ ...o, report })
  ref.current = { ...o, report }
  const saver = useRef<AutoSaver | null>(null)
  if (!saver.current) {
    const s: AutoSaver = createAutoSaver({
      save: () => ref.current.save(),
      validate: () => ref.current.validate?.(),
      defer: () => (ref.current.defer ?? typingSecret)(),
      onState: (st) => ref.current.report(st, () => void s.retry()),
    })
    saver.current = s
  }
  useEffect(() => {
    const s = saver.current!
    // 关窗口 / 关设置 / 切页时也遵守 defer：焦点还在密码框里说明 Key / 密码只输了一半，
    // 这时落盘会把半截值覆盖掉原本可用的凭据（离开输入框后的 flush 不受影响）
    const flushSafe = () => { if ((ref.current.defer ?? typingSecret)()) return; void s.flush() }
    window.addEventListener('beforeunload', flushSafe)
    window.addEventListener('pagehide', flushSafe)
    return () => { window.removeEventListener('beforeunload', flushSafe); window.removeEventListener('pagehide', flushSafe); flushSafe() }
  }, [])
  const s = saver.current
  return {
    schedule: s.schedule,
    flush: s.flush,
    /** 放在页面根的 onBlur：离开输入框就把待存的改动落盘（密码框等 defer 的输入也在离开时才存） */
    onBlur: () => { setTimeout(() => { if (!(ref.current.defer ?? typingSecret)()) void s.flush() }, 0) },
  }
}

/** 设置弹窗标题旁的保存状态：保存中 / 已自动保存（淡出）/ 失败（红色 + 重试）/ 值不合法（红色，未保存） */
export function AutoSaveBadge({ state, retry }: { state: AutoSaveState; retry?: () => void }) {
  const [fade, setFade] = useState(false)
  useEffect(() => {
    setFade(false)
    if (state.status !== 'saved') return
    const t = setTimeout(() => setFade(true), 2500)
    return () => clearTimeout(t)
  }, [state])
  const base = 'ml-3 flex min-w-0 items-center gap-1 truncate text-[11.5px] transition-opacity duration-700'
  if (state.status === 'pending' || state.status === 'saving')
    return <span data-autosave="saving" className={`${base} text-[var(--color-text-muted)]`}><Loader2 className="h-3 w-3 shrink-0 animate-spin" />{tr('保存中…')}</span>
  if (state.status === 'saved')
    return <span data-autosave="saved" className={`${base} text-[var(--color-success)] ${fade ? 'opacity-0' : ''}`}><Check className="h-3.5 w-3.5 shrink-0" />{tr('已自动保存')}</span>
  if (state.status === 'invalid')
    return <span data-autosave="invalid" title={state.error} className={`${base} text-[var(--color-danger)]`}>{tr('未保存：{error}', { error: state.error ?? '' })}</span>
  if (state.status === 'error')
    return (
      <span data-autosave="error" title={state.error} className={`${base} text-[var(--color-danger)]`}>
        <span className="truncate">{tr('保存失败：{error}', { error: state.error ?? '' })}</span>
        {retry && <button onClick={retry} className="flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-[var(--color-bg-hover)]"><RotateCw className="h-3 w-3" />{tr('重试')}</button>}
      </span>
    )
  return null
}
