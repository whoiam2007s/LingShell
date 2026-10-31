// 模型配置列表的共享读取：设置页保存后广播事件，对话区的「模型」菜单 / 标签跟着刷新
import { useEffect, useState } from 'react'
import type { ModelProfile } from '@lingshell/shared'
import { client } from '../client/index.js'

export const MODEL_PROFILES_EVENT = 'lingshell:model-profiles-changed'
export const notifyModelProfilesChanged = () => window.dispatchEvent(new Event(MODEL_PROFILES_EVENT))

export interface ModelProfilesState { profiles: ModelProfile[]; defaultId?: string }

export function useModelProfiles(): ModelProfilesState {
  const [s, setS] = useState<ModelProfilesState>({ profiles: [] })
  useEffect(() => {
    const load = () => client.settings.get().then((x) => setS({ profiles: x.modelProfiles ?? [], defaultId: x.defaultProfileId })).catch(() => {})
    load()
    window.addEventListener(MODEL_PROFILES_EVENT, load)
    return () => window.removeEventListener(MODEL_PROFILES_EVENT, load)
  }, [])
  return s
}

// 会话所选配置 id → 实际用的那套（缺省 / 已删 = 默认配置）
export const profileOf = (s: ModelProfilesState, id?: string): ModelProfile | undefined =>
  s.profiles.find((p) => p.id === id) ?? s.profiles.find((p) => p.id === s.defaultId) ?? s.profiles[0]
