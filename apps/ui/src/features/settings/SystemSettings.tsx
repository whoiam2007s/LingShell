import { useEffect, useRef, useState } from 'react'
import type { SystemSettings as Sys } from '@lingshell/shared'
import { DEFAULT_SYSTEM_SETTINGS, tr } from '@lingshell/shared'
import { client } from '../../client/index.js'
import { getLook } from '../../lib/appearance.js'
import { delayOf, mergeSystem } from './autoSave.js'
import { useAutoSave } from './useAutoSave.js'

// 终端 / AI 与安全 / 通用 三页共用：各项都存 AppSettings.system，改了防抖自动保存（关弹窗 / 切页时立即保存）。
// validate：返回错误文案时不保存（就地提示），改合法后再存；defer：防抖到点时返回 true 就等失焦再存（默认：焦点在密码框里）。
export function useSystemSettings({ onSaved, validate, defer }: {
  onSaved?: (sys: Sys) => void; validate?: (sys: Sys) => string | null | undefined; defer?: () => boolean
} = {}) {
  const [loaded, setLoaded] = useState(false)
  const [sys, setSys] = useState<Sys>(DEFAULT_SYSTEM_SETTINGS)
  const cur = useRef(sys)            // 最新值（同步更新，flush 时不依赖渲染）
  const dirty = useRef(new Set<keyof Sys>())
  useEffect(() => { client.settings.get().then((s) => { cur.current = { ...DEFAULT_SYSTEM_SETTINGS, ...s.system }; setSys(cur.current); setLoaded(true) }) }, [])
  const auto = useAutoSave({
    defer,
    validate: () => validate?.(cur.current),
    save: async () => {
      const keys = [...dirty.current]
      dirty.current.clear()
      try {
        const s = await client.settings.get()
        // 外观（主题 / 缩放 / 图标）改了即存、快捷键也会改缩放：以当前生效的为准
        const system = { ...mergeSystem({ ...DEFAULT_SYSTEM_SETTINGS, ...s.system }, cur.current, keys), ...getLook().look }
        await client.settings.save({ provider: s.provider, model: s.model, baseUrl: s.baseUrl, system })
        onSaved?.(system)
      } catch (e) { for (const k of keys) dirty.current.add(k); throw e }
    },
  })
  const set = (p: Partial<Sys>) => {
    cur.current = { ...cur.current, ...p }
    for (const k of Object.keys(p) as (keyof Sys)[]) dirty.current.add(k)
    setSys(cur.current)
    auto.schedule(delayOf(p))
  }
  return { loaded, sys, set, onBlur: auto.onBlur }
}

export const Loading = () => <div className="text-[13px] text-[var(--color-text-muted)]">{tr('加载中…')}</div>

/** 依赖开关的子项：缩进，行间同样细线分隔 */
export function Sub({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-[var(--color-border-subtle)] pl-4">{children}</div>
}

export { TEXTAREA } from '../../components/ui/form.js'
