// 快捷键的进程内状态：注册表默认值 + 用户覆盖（SystemSettings.keybindings）。
// 所有按键处理（App / useTerminalShortcuts / TerminalPane）都经 actionOf() 判定，改了立即生效。
import { useSyncExternalStore } from 'react'
import { KEY_ACTION_BY_ID, cleanOverrides, formatKey, keyOfEvent, keymapsOf, pickAction, resolveKeybindings, tr, type KeybindingOverrides, type Keybindings } from '@lingshell/shared'
import { client } from '../client/index.js'
import { saveSystemPatch } from './systemSave.js'

// map：按键 → 全部动作（同键可分给终端里 / 终端外两个动作，按焦点挑，见 pickAction）
type State = { overrides: KeybindingOverrides; bindings: Keybindings; map: Map<string, string[]> }
const make = (o: KeybindingOverrides): State => { const bindings = resolveKeybindings(o); return { overrides: o, bindings, map: keymapsOf(bindings) } }
let state = make({})
const subs = new Set<() => void>()
let recording = false

export const getKeybindings = () => state
export const useKeybindings = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, getKeybindings)
export function setKeybindingOverrides(o: KeybindingOverrides | null | undefined) { state = make(cleanOverrides(o)); subs.forEach((f) => f()) }

/** 设置页录制新按键期间：所有快捷键处理暂停（不然录 Ctrl+Shift+T 会顺手开个终端） */
export const setRecordingKeys = (b: boolean) => { recording = b }

/** 键盘事件对应的动作 id（录制中 / 输入法组字中 / 未绑定返回 null） */
export function actionOf(e: KeyboardEvent): string | null {
  if (recording || e.isComposing) return null
  const k = keyOfEvent(e)
  return k ? pickAction(state.map.get(k), inTerminal(e.target)) : null
}
/** 终端里这个键要不要拦下（不发给 shell）：绑定了「全局 / 焦点在终端时」的动作就拦；「焦点不在终端时」的照常给 shell。
 *  锁定应用例外：App 在捕获阶段处理（已启用应用锁才拦），未启用时照常给 shell */
export function termShouldIntercept(e: KeyboardEvent): boolean {
  const id = actionOf(e)
  const scope = id ? KEY_ACTION_BY_ID[id]?.scope : undefined
  return !!id && id !== 'app.lock' && scope !== 'outside'
}
/** 焦点是否在终端里（「焦点不在终端时」类动作据此判断） */
export const inTerminal = (t: EventTarget | null) => t instanceof Element && !!t.closest('.xterm')
/** 该事件是否触发某动作（含作用范围判断：outside 类焦点在终端时不算） */
export function isAction(e: KeyboardEvent, id: string): boolean {
  if (actionOf(e) !== id) return false
  return KEY_ACTION_BY_ID[id]?.scope !== 'outside' || !inTerminal(e.target)
}
/** 某动作当前生效按键的展示文字（命令面板副标题、按钮 title 用）；未设置返回 '' */
export const keyLabel = (id: string) => { const k = state.bindings[id]; return k ? formatKey(k) : '' }
/** 按钮 title 后缀：'（Ctrl+Shift+B）'；多个用 / 连接，全未设置返回 '' */
export const keyHint = (...ids: string[]) => { const s = ids.map(keyLabel).filter(Boolean).join(' / '); return s ? tr('（{keys}）', { keys: s }) : '' }

/** 启动时从设置拉一次 */
export function loadKeybindings() {
  client.settings.get().then((s) => setKeybindingOverrides(s.system?.keybindings)).catch(() => {})
}
/** 改完立即生效并落盘（只改 keybindings，与设置页自动保存串行） */
export async function saveKeybindingOverrides(o: KeybindingOverrides) {
  setKeybindingOverrides(o)
  await saveSystemPatch({ keybindings: state.overrides })
}
