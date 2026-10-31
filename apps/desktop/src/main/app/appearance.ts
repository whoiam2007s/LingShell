// 界面外观（主进程侧）：原生主题（标题栏 / 原生菜单 / 滚动条 / prefers-color-scheme）+ 窗口底色 + 界面缩放。
// 启动时按已存设置先应用（窗口 show 之前，避免闪色）；渲染层改设置 / 快捷键调缩放时经 appearance:apply 即时应用（落盘走 settings:save）
// 原生主题只分深浅（按主题的 kind；跟随系统交给系统），窗口底色用具体主题的底色
import { ipcMain, nativeTheme, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kindOf, normalizeZoom, resolveTheme, themeInfo, themeSourceOf, type SystemSettings } from '@lingshell/shared'

type Look = Pick<Partial<SystemSettings>, 'uiTheme' | 'uiThemeDark' | 'uiThemeLight' | 'uiZoom'>
let cur: Look = {}

/** 启动最早期（建 splash / 主窗之前）：直接读 settings.json 定原生主题，启动页和窗口底色就是对的 */
export function initNativeTheme(configDir: string) {
  try {
    const s = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))?.system
    if (s && typeof s === 'object') cur = { uiTheme: s.uiTheme, uiThemeDark: s.uiThemeDark, uiThemeLight: s.uiThemeLight }
  } catch { /* 没有设置 = 暗黑 */ }
  nativeTheme.themeSource = themeSourceOf(cur.uiTheme, cur)
}
export const windowBg = () => themeInfo(resolveTheme(cur.uiTheme, nativeTheme.shouldUseDarkColors, cur)).swatch.bg
/** 当前界面主题（悬浮球窗口跟主窗口同一套颜色，见 background.ts） */
export const currentTheme = () => { const t = resolveTheme(cur.uiTheme, nativeTheme.shouldUseDarkColors, cur); return { theme: t, kind: kindOf(t) } }

export function registerAppearance(win: BrowserWindow, sys: () => Partial<SystemSettings>) {
  const s = sys()
  cur = { uiTheme: s.uiTheme, uiThemeDark: s.uiThemeDark, uiThemeLight: s.uiThemeLight, uiZoom: s.uiZoom }
  const apply = () => {
    nativeTheme.themeSource = themeSourceOf(cur.uiTheme, cur)
    win.setBackgroundColor(windowBg())
    win.webContents.setZoomFactor(normalizeZoom(cur.uiZoom ?? 1))
  }
  apply()
  // 缩放按页面生效：每次（重新）加载完补一次
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(normalizeZoom(cur.uiZoom ?? 1)))
  // 跟随系统时系统切换深浅色：窗口底色跟上（页面颜色由渲染层 matchMedia 处理）
  nativeTheme.on('updated', () => { if (!win.isDestroyed()) win.setBackgroundColor(windowBg()) })
  ipcMain.handle('appearance:apply', (_e, look: Look) => {
    cur = { ...cur, ...(look && typeof look === 'object' ? look : {}) }
    apply()
  })
}
