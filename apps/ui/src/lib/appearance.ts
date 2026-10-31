// 界面外观的进程内状态：主题（10 套 + 跟随系统）、界面缩放、图标大小。
// - 主题：<html data-theme="<主题 id>" data-kind="dark|light">，颜色变量见 index.css；跟随系统时 matchMedia 实时切换（深 / 浅各用哪套见 uiThemeDark / uiThemeLight）
// - 图标大小：<html> 上的 --icon-zoom（svg.lucide 按它 zoom，只放大图标不改文字）
// - 界面缩放 / 原生主题（标题栏、滚动条、prefers-color-scheme）：主进程 appearance:apply（见 desktop/main/app/appearance.ts）
// 设置缓存在 localStorage，index.html 的内联脚本据此在首帧前先设好 data-theme / data-kind / --icon-zoom，避免闪色
import { useSyncExternalStore } from 'react'
import { DEFAULT_SYSTEM_SETTINGS, iconZoomOf, isUiTheme, kindOf, normalizeZoom, resolveTheme, stepZoom, systemDarkTheme, systemLightTheme, themeInfo, type IconSize, type ResolvedTheme, type SystemSettings, type ThemeId, type UiTheme } from '@lingshell/shared'
import { client } from '../client/index.js'
import { isAction } from './keybindings.js'
import { saveSystemPatch } from './systemSave.js'
import { setTermPrefs } from './termPrefs.js'
import { syncUiLanguage } from './locale.js'

export type Look = { uiTheme: UiTheme; uiThemeDark: ThemeId; uiThemeLight: ThemeId; uiZoom: number; iconSize: IconSize }
export const LOOK_CACHE_KEY = 'lingshell.appearance'
const D = DEFAULT_SYSTEM_SETTINGS
// 老配置（只有 dark / light / system）原样认；未知值回落 暗黑
const lookOf = (s: Partial<SystemSettings> | null | undefined, t = s?.uiTheme): Look => ({
  uiTheme: isUiTheme(t) ? t : 'dark',
  uiThemeDark: systemDarkTheme(s ?? undefined),
  uiThemeLight: systemLightTheme(s ?? undefined),
  uiZoom: normalizeZoom(s?.uiZoom ?? D.uiZoom),
  iconSize: s?.iconSize === 'medium' || s?.iconSize === 'large' ? s.iconSize : 'small',
})
function readCache(): Look {
  try { return lookOf(JSON.parse(localStorage.getItem(LOOK_CACHE_KEY) ?? 'null')) } catch { return lookOf(null) }
}

const mq = window.matchMedia('(prefers-color-scheme: dark)')
let state: { look: Look; theme: ResolvedTheme } = { look: readCache(), theme: 'dark' }
const subs = new Set<() => void>()

function render() {
  const theme = resolveTheme(state.look.uiTheme, mq.matches, state.look)
  const el = document.documentElement
  el.dataset.theme = theme
  el.dataset.kind = kindOf(theme)
  el.style.background = themeInfo(theme).swatch.bg   // 与首帧脚本一致（CSS 还没加载时的底色）
  el.style.setProperty('--icon-zoom', String(iconZoomOf(state.look.iconSize)))
  try { localStorage.setItem(LOOK_CACHE_KEY, JSON.stringify(state.look)) } catch { /* 存不了就只是首帧不准 */ }
  if (theme !== state.theme) state = { ...state, theme }
  setTermPrefs({ uiTheme: theme })   // 终端配色「跟随界面主题」
  subs.forEach((f) => f())
}

/** 应用外观（不落盘）。主题变了等主进程切完原生主题再按 matchMedia 重新解析（跟随系统依赖它） */
export function applyLook(p: Partial<Look>) {
  state = { ...state, look: { ...state.look, ...p } }
  render()
  const { uiTheme, uiThemeDark, uiThemeLight, uiZoom } = state.look
  client.appearance.apply({ uiTheme, uiThemeDark, uiThemeLight, uiZoom }).then(render, () => {})
}

/** 应用并落盘（只改外观字段，不动其它；与设置页自动保存串行，避免旧快照覆盖） */
export async function saveLook(p: Partial<Look>) {
  applyLook(p)
  await saveSystemPatch(state.look)
}

export const getLook = () => state
export const useLook = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, getLook)

// 快捷键调缩放：防抖落盘
let zoomTimer: ReturnType<typeof setTimeout> | undefined
function zoomBy(dir: 1 | -1 | 0) {
  const z = stepZoom(state.look.uiZoom, dir)
  if (z === state.look.uiZoom) return
  applyLook({ uiZoom: z })
  clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => { saveLook({}).catch(() => {}) }, 500)
}

/** 按已存设置重新应用（启动、解锁、导入配置后）；界面语言也在这里校正 */
export const reloadLook = () => client.settings.get().then((s) => { applyLook(lookOf(s.system)); syncUiLanguage(s.system?.language) }).catch(() => {})

/** 启动：先按缓存应用（index.html 已设过首帧），再按已存设置校正；监听系统深浅色与缩放快捷键 */
export function initAppearance() {
  render()
  void reloadLook()
  client.on((ev) => { if (ev.type === 'app:lock' && !ev.locked) void reloadLook() })   // 启动即锁定时设置读不到，解锁后补
  mq.addEventListener('change', render)
  window.addEventListener('keydown', (e) => {
    const dir = isAction(e, 'app.zoomIn') ? 1 : isAction(e, 'app.zoomOut') ? -1 : isAction(e, 'app.zoomReset') ? 0 : null
    if (dir === null) return
    e.preventDefault(); e.stopPropagation()
    zoomBy(dir)
  }, true)
}
