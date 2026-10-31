// 外观 / 快捷键 / 字号这些「哪里有交互就从哪里落盘」的写法，统一串行并只改自己的字段：
// 以前各自 get→save 整份 system，和设置页的自动保存并发时，后写的旧快照会把刚存的字段覆盖回去。
import { DEFAULT_SYSTEM_SETTINGS, type SystemSettings } from '@lingshell/shared'
import { client } from '../client/index.js'

let chain: Promise<unknown> = Promise.resolve()

export function saveSystemPatch(patch: Partial<SystemSettings>): Promise<void> {
  const p = chain.then(async () => {
    const s = await client.settings.get()
    await client.settings.save({ ...s, system: { ...DEFAULT_SYSTEM_SETTINGS, ...s.system, ...patch } })
  })
  chain = p.catch(() => {})   // 一次失败不阻断后面的保存
  return p
}
