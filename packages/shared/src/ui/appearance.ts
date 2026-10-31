// 界面外观：主题（10 套配色 + 跟随系统）、界面缩放、图标大小。渲染层 lib/appearance.ts 应用，主进程 appearance.ts 同步原生主题与缩放
import { tk } from '../i18n/i18n.js'
import type { SystemSettings, TerminalThemeId } from '../protocol/index.js'

/** 具体的界面主题（颜色变量见 apps/ui/src/index.css 的 html[data-theme="<id>"]） */
export type ThemeId = 'dark' | 'light' | 'midnight' | 'dracula' | 'nord' | 'solarized' | 'sepia' | 'contrast' | 'rose' | 'lavender'
export type UiTheme = ThemeId | 'system'
/** 主题的深浅类型：原生主题（标题栏 / 滚动条 / color-scheme）、启动页按它选 */
export type ThemeKind = 'dark' | 'light'
export type ResolvedTheme = ThemeId
export type IconSize = 'small' | 'medium' | 'large'

/**
 * 主题清单（深色在前、浅色在后，色卡 / 下拉 / 命令面板都按这个顺序）：中文名 / 深浅 / 跟随界面时的终端配色 / 适用场景 / 色卡用的几个颜色（与 index.css 同值，单测校验）。
 * 新增主题：这里加一项 + index.css 加一个 data-theme 块 + index.html 首帧脚本的底色表
 */
export const UI_THEMES: {
  id: ThemeId; label: string; kind: ThemeKind; terminal: Exclude<TerminalThemeId, 'auto'>; desc: string
  swatch: { bg: string; panel: string; accent: string; text: string }
}[] = [
  { id: 'dark', label: tk('暗黑'), kind: 'dark', terminal: 'dark', desc: tk('默认深色，长时间对着终端不刺眼'), swatch: { bg: '#0d1117', panel: '#161b22', accent: '#2dd4bf', text: '#e6edf3' } },
  { id: 'midnight', label: tk('午夜蓝'), kind: 'dark', terminal: 'tokyo-night', desc: tk('Tokyo Night 风，深蓝底、蓝色强调，夜间柔和'), swatch: { bg: '#1a1b26', panel: '#1f2335', accent: '#7aa2f7', text: '#c0caf5' } },
  { id: 'dracula', label: tk('德古拉'), kind: 'dark', terminal: 'dracula', desc: tk('经典 Dracula，紫色强调、色彩鲜明'), swatch: { bg: '#282a36', panel: '#2f3241', accent: '#bd93f9', text: '#f8f8f2' } },
  { id: 'nord', label: tk('北极'), kind: 'dark', terminal: 'nord', desc: tk('Nord 冷灰蓝，低饱和、对比温和'), swatch: { bg: '#2e3440', panel: '#3b4252', accent: '#88c0d0', text: '#eceff4' } },
  { id: 'solarized', label: tk('深海'), kind: 'dark', terminal: 'solarized-dark', desc: tk('Solarized Dark，墨绿深底、橙色强调'), swatch: { bg: '#002b36', panel: '#073642', accent: '#f0884f', text: '#eee8d5' } },
  { id: 'rose', label: tk('玫瑰'), kind: 'dark', terminal: 'rose-pine', desc: tk('Rosé Pine，深紫黑底、玫粉强调，柔和不刺眼'), swatch: { bg: '#191724', panel: '#1f1d2e', accent: '#eb6f92', text: '#e0def4' } },
  { id: 'contrast', label: tk('高对比'), kind: 'dark', terminal: 'high-contrast', desc: tk('纯黑底、纯白字、亮黄强调、边框更明显，适合视力不好或强光下'), swatch: { bg: '#000000', panel: '#0a0a0a', accent: '#ffd60a', text: '#ffffff' } },
  { id: 'light', label: tk('明亮'), kind: 'light', terminal: 'light', desc: tk('白底黑字、蓝色强调，白天、强光环境、投屏演示'), swatch: { bg: '#ffffff', panel: '#f6f8fa', accent: '#0969da', text: '#1f2328' } },
  { id: 'lavender', label: tk('薰衣草'), kind: 'light', terminal: 'light', desc: tk('白底、淡紫面板、紫色强调，清爽的浅色'), swatch: { bg: '#ffffff', panel: '#f7f5fe', accent: '#7c3aed', text: '#26213a' } },
  { id: 'sepia', label: tk('护眼米黄'), kind: 'light', terminal: 'solarized-light', desc: tk('米黄纸色（Solarized Light），比纯白柔和，适合长时间阅读'), swatch: { bg: '#fdf6e3', panel: '#f5edd6', accent: '#8f5400', text: '#3b3a33' } },
]
export const SYSTEM_THEME_LABEL = tk('跟随系统')
const BY_ID = new Map(UI_THEMES.map((t) => [t.id, t]))
export const isThemeId = (x: unknown): x is ThemeId => typeof x === 'string' && BY_ID.has(x as ThemeId)
export const isUiTheme = (x: unknown): x is UiTheme => x === 'system' || isThemeId(x)
export const themeInfo = (id: ThemeId) => BY_ID.get(id) ?? UI_THEMES[0]
export const kindOf = (id: ThemeId): ThemeKind => themeInfo(id).kind
export const themeLabel = (t: UiTheme) => (t === 'system' ? SYSTEM_THEME_LABEL : themeInfo(t).label)

export const ICON_SIZES: { id: IconSize; label: string; zoom: number }[] = [
  { id: 'small', label: tk('size|小'), zoom: 1 }, { id: 'medium', label: tk('size|中'), zoom: 1.15 }, { id: 'large', label: tk('size|大'), zoom: 1.3 },
]
/** 界面缩放档位（整体缩放：文字、图标、间距一起） */
export const UI_ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]

/** 跟随系统时深 / 浅各用哪套（uiThemeDark / uiThemeLight）；不合法或类型不对回落 暗黑 / 明亮 */
export type SystemThemeMap = { uiThemeDark?: unknown; uiThemeLight?: unknown }
const pick = (x: unknown, kind: ThemeKind, d: ThemeId): ThemeId => (isThemeId(x) && kindOf(x) === kind ? x : d)
export const systemDarkTheme = (m?: SystemThemeMap) => pick(m?.uiThemeDark, 'dark', 'dark')
export const systemLightTheme = (m?: SystemThemeMap) => pick(m?.uiThemeLight, 'light', 'light')

/** 偏好 → 具体主题；system 按系统是否深色 + 映射；未知值（含缺省）= 暗黑 */
export function resolveTheme(pref: unknown, systemDark: boolean, map?: SystemThemeMap): ThemeId {
  if (pref === 'system') return systemDark ? systemDarkTheme(map) : systemLightTheme(map)
  return isThemeId(pref) ? pref : 'dark'
}
/** 原生主题来源（nativeTheme.themeSource）：跟随系统交给系统，其余按主题深浅 */
export const themeSourceOf = (pref: unknown, map?: SystemThemeMap): 'system' | ThemeKind =>
  pref === 'system' ? 'system' : kindOf(resolveTheme(pref, true, map))

export const iconZoomOf = (s: IconSize | undefined) => ICON_SIZES.find((x) => x.id === s)?.zoom ?? 1

/** 规整缩放：非档位值取最近的档位，非法回落 100% */
export function normalizeZoom(z: unknown): number {
  if (typeof z !== 'number' || !Number.isFinite(z)) return 1
  return UI_ZOOMS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a))
}
/** 快捷键调缩放：dir = 1 放大一档 / -1 缩小一档 / 0 复位；到头不动 */
export function stepZoom(cur: number, dir: 1 | -1 | 0): number {
  if (dir === 0) return 1
  const i = UI_ZOOMS.indexOf(normalizeZoom(cur))
  return UI_ZOOMS[Math.min(UI_ZOOMS.length - 1, Math.max(0, i + dir))]
}

/** 终端配色：auto = 跟随界面主题（用该主题对应的终端配色，见 UI_THEMES.terminal） */
export const resolveTerminalTheme = (id: TerminalThemeId | undefined, ui: ThemeId): Exclude<TerminalThemeId, 'auto'> =>
  !id || id === 'auto' ? themeInfo(ui).terminal : id

/**
 * 老配置迁移：没有 uiTheme 字段 = 外观功能之前存的配置，那时 terminalTheme 'dark' 是默认值（存盘时整份带上），
 * 分不清是不是用户选的；深色界面下 auto 与 dark 完全一样，所以按「跟随界面主题」解读。用户选过的其它配色不动
 */
export function migrateAppearance(sys: Partial<SystemSettings> | undefined): Partial<SystemSettings> | undefined {
  if (!sys || sys.uiTheme !== undefined || sys.terminalTheme !== 'dark') return sys
  return { ...sys, terminalTheme: 'auto' }
}
