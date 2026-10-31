import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'
import type { BellMode, CompiledAlert, CompiledHighlight, HighlightRule, ResolvedTheme, SystemSettings, TerminalCursorStyle, TerminalThemeId } from '@lingshell/shared'
import { DEFAULT_SYSTEM_SETTINGS, compileAlerts, compileHighlight, resolveTerminalTheme, tk } from '@lingshell/shared'
import { client } from '../client/index.js'
import { saveSystemPatch } from './systemSave.js'

// 内置终端配色（dark = 原 XTERM_THEME；配色「跟随界面主题」时按界面主题选，对应关系见 shared/ui/appearance.ts 的 UI_THEMES.terminal）
export const TERMINAL_THEMES: Record<Exclude<TerminalThemeId, 'auto'>, { label: string; theme: ITheme }> = {
  dark: { label: tk('深色'), theme: {
    background: '#0d1117', foreground: '#e6edf3', cursor: '#2dd4bf', selectionBackground: '#264f78',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  } },
  light: { label: tk('浅色'), theme: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#0969da', selectionBackground: '#add6ff',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  } },
  // Solarized Dark / Dracula 原版的 black（及 Solarized 的 bright 系灰阶）与底色几乎同色，这里提亮到能看见
  'solarized-dark': { label: 'Solarized Dark', theme: {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#274642',
    black: '#3a6570', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#657b83', brightRed: '#f46d69', brightGreen: '#a3b324', brightYellow: '#d4a21c', brightBlue: '#4fa6e6', brightMagenta: '#9a9ee6', brightCyan: '#35b3a9', brightWhite: '#fdf6e3',
  } },
  dracula: { label: 'Dracula', theme: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#4d5066', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  } },
  'one-dark': { label: 'One Dark', theme: {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451',
    black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#d19a66', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
    brightBlack: '#4f5666', brightRed: '#be5046', brightGreen: '#a5e075', brightYellow: '#e5c07b', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#e6e6e6',
  } },
  monokai: { label: 'Monokai', theme: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  } },
  'github-light': { label: 'GitHub Light', theme: {
    background: '#f6f8fa', foreground: '#24292f', cursor: '#044289', selectionBackground: '#c8e1ff',
    black: '#24292e', red: '#d73a49', green: '#28a745', yellow: '#b08800', blue: '#0366d6', magenta: '#5a32a3', cyan: '#1b7c83', white: '#6a737d',
    brightBlack: '#959da5', brightRed: '#cb2431', brightGreen: '#22863a', brightYellow: '#dbab09', brightBlue: '#2188ff', brightMagenta: '#8a63d2', brightCyan: '#3192aa', brightWhite: '#d1d5da',
  } },
  // 以下四套是界面主题 午夜蓝 / 北极 / 护眼米黄 / 高对比 跟随时用的
  'tokyo-night': { label: 'Tokyo Night', theme: {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
    black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#565f89', brightRed: '#ff8aa0', brightGreen: '#b0e07c', brightYellow: '#f0c27c', brightBlue: '#8db0ff', brightMagenta: '#c9aaff', brightCyan: '#9ad8ff', brightWhite: '#c0caf5',
  } },
  'rose-pine': { label: 'Rosé Pine', theme: {
    background: '#191724', foreground: '#e0def4', cursor: '#ebbcba', cursorAccent: '#191724', selectionBackground: '#403d52',
    black: '#524f67', red: '#eb6f92', green: '#5fb3a1', yellow: '#f6c177', blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
    brightBlack: '#6e6a86', brightRed: '#f08ba8', brightGreen: '#7fcbb9', brightYellow: '#f9d29a', brightBlue: '#b5dde4', brightMagenta: '#d4bdf0', brightCyan: '#f2cfcd', brightWhite: '#ffffff',
  } },
  nord: { label: 'Nord', theme: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#4c566a',
    black: '#4c566a', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#7b88a1', brightRed: '#d08770', brightGreen: '#b5cf9e', brightYellow: '#f0d9a8', brightBlue: '#9ab6d3', brightMagenta: '#c7a6c1', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  } },
  'solarized-light': { label: 'Solarized Light', theme: {
    background: '#fdf6e3', foreground: '#3b3a33', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#e3d8b6',
    black: '#073642', red: '#c0261f', green: '#5f7300', yellow: '#946c00', blue: '#1f6fa8', magenta: '#b42b6f', cyan: '#177d76', white: '#7c7462',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#457000', brightYellow: '#7d5c00', brightBlue: '#2f63b8', brightMagenta: '#6c71c4', brightCyan: '#1f6f6a', brightWhite: '#657b83',
  } },
  'high-contrast': { label: tk('高对比'), theme: {
    background: '#000000', foreground: '#ffffff', cursor: '#ffd60a', cursorAccent: '#000000', selectionBackground: '#1f4e8c',
    black: '#555555', red: '#ff7b7b', green: '#5ef38c', yellow: '#ffd60a', blue: '#79c0ff', magenta: '#ff8cf0', cyan: '#5ef1ff', white: '#e6e6e6',
    brightBlack: '#9a9a9a', brightRed: '#ffa3a3', brightGreen: '#9affb8', brightYellow: '#ffe866', brightBlue: '#a8d6ff', brightMagenta: '#ffb3f5', brightCyan: '#a3f7ff', brightWhite: '#ffffff',
  } },
}
// 设置页的配色选项：auto = 跟随界面主题（用该主题对应的终端配色，见 shared/ui/appearance.ts 的 UI_THEMES.terminal）
export const THEME_OPTIONS: { id: TerminalThemeId; label: string }[] = [
  // 标签用 tk 标记，显示处 tr(label)
  { id: 'auto', label: tk('跟随界面主题（默认）') }, ...Object.entries(TERMINAL_THEMES).map(([id, t]) => ({ id: id as TerminalThemeId, label: t.label })),
]
// ui 缺省取当前界面主题（lib/appearance.ts 写进 prefs.uiTheme）
export const themeOf = (id: TerminalThemeId, ui: ResolvedTheme = prefs.uiTheme ?? 'dark') => (TERMINAL_THEMES[resolveTerminalTheme(id, ui)] ?? TERMINAL_THEMES.dark).theme

export const FONT_MIN = 10, FONT_MAX = 24
export const clampFont = (n: number) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n) || DEFAULT_SYSTEM_SETTINGS.terminalFontSize))
// 字体留空 = 内置等宽字体栈；自填的字体后面总补上它兜底（没装的字体会退回下一个）
export const DEFAULT_FONT_FAMILY = 'JetBrains Mono, Cascadia Code, Consolas, monospace'
export const fontFamilyOf = (f?: string) => (f?.trim() ? `${f.trim()}, ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY)
export const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2]
export const SCROLLBACK_MIN = 500, SCROLLBACK_MAX = 100_000
const clamp = (n: number | undefined, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d)

// 终端外观的进程内状态：所有 TerminalPane 订阅，变化即时应用（不重建 xterm）
// recordingEnabled：系统设置里是否允许录屏——允许时终端工具栏才出现录制按钮
// sessionLogEnabled：会话日志开着时工具栏出现「打开本终端日志」
// highlight/highlightRules：关键字高亮开关与规则（TerminalPane 写入 xterm 前经 getHighlight() 着色；勾了告警的经 getAlerts() 匹配）
// autoReconnect：SSH 意外断线后自动重连（见 ReconnectBanner）
// fontFamily/lineHeight/cursorStyle/cursorBlink/scrollback：外观；notifySec：长命令完成通知阈值（秒，0 = 关）
export type TermPrefs = {
  fontSize: number; theme: TerminalThemeId; recordingEnabled: boolean; sessionLogEnabled?: boolean; highlight?: boolean; highlightRules?: HighlightRule[]; autoReconnect?: boolean
  fontFamily?: string; lineHeight?: number; cursorStyle?: TerminalCursorStyle; cursorBlink?: boolean; scrollback?: number; notifySec?: number
  autoComplete?: boolean   // 命令自动补全（见 CompletionPopup.tsx）
  pasteCheck?: boolean     // 粘贴安全检查（缺省开）
  bell?: BellMode          // 响铃提示（缺省 角标 + 通知）
  failHint?: boolean       // 命令失败时底部「让 AI 排查」横幅（缺省开，见 failHint.ts）
  predict?: boolean        // AI 预测下一条命令（缺省关）
  uiTheme?: ResolvedTheme  // 当前界面主题（配色 auto 跟它走；lib/appearance.ts 写入）
  replayMB?: number        // 即时回放缓冲（MB，0 = 关；缺省 4，见 InstantReplay.tsx）
}
const D = DEFAULT_SYSTEM_SETTINGS
let prefs: TermPrefs = {
  fontSize: D.terminalFontSize, theme: D.terminalTheme, recordingEnabled: false,
  highlight: D.terminalHighlight, highlightRules: D.highlightRules,
  fontFamily: D.terminalFontFamily, lineHeight: D.terminalLineHeight, cursorStyle: D.terminalCursorStyle, cursorBlink: D.terminalCursorBlink, scrollback: D.terminalScrollback, notifySec: D.terminalNotifySec,
}
const subs = new Set<() => void>()
export const getTermPrefs = () => prefs
export function subscribeTermPrefs(f: () => void) { subs.add(f); return () => { subs.delete(f) } }
export function setTermPrefs(p: Partial<TermPrefs>) {
  const next: TermPrefs = { ...prefs, ...p, ...(p.fontSize !== undefined ? { fontSize: clampFont(p.fontSize) } : {}) }
  if ((Object.keys(next) as (keyof TermPrefs)[]).every((k) => next[k] === prefs[k])) return
  prefs = next; subs.forEach((f) => f())
}
export const useTermPrefs = () => useSyncExternalStore(subscribeTermPrefs, getTermPrefs)

// 高亮 / 告警规则编译结果按 prefs 缓存，所有终端共用
let hl: { on?: boolean; rules?: HighlightRule[]; c: CompiledHighlight | null; a: CompiledAlert | null } = { c: null, a: null }
function compiled() {
  if (hl.on !== prefs.highlight || hl.rules !== prefs.highlightRules) {
    const on = !!prefs.highlight && !!prefs.highlightRules
    hl = { on: prefs.highlight, rules: prefs.highlightRules, c: on ? compileHighlight(prefs.highlightRules!) : null, a: on ? compileAlerts(prefs.highlightRules!) : null }
  }
  return hl
}
export const getHighlight = () => compiled().c
export const getAlerts = () => compiled().a
export const highlightPrefsOf = (s: SystemSettings) => ({
  highlight: s.terminalHighlight ?? D.terminalHighlight, highlightRules: s.highlightRules ?? D.highlightRules,
})
// 设置 → 终端偏好（启动加载、设置页保存共用）
export const termPrefsOf = (s: SystemSettings): TermPrefs => ({
  fontSize: s.terminalFontSize, theme: s.terminalTheme, recordingEnabled: !!s.terminalRecording, sessionLogEnabled: !!s.sessionLog, autoReconnect: !!s.sshAutoReconnect,
  ...highlightPrefsOf(s),
  fontFamily: s.terminalFontFamily ?? D.terminalFontFamily,
  lineHeight: clamp(s.terminalLineHeight, 1, 2, D.terminalLineHeight),
  cursorStyle: s.terminalCursorStyle ?? D.terminalCursorStyle,
  cursorBlink: s.terminalCursorBlink ?? D.terminalCursorBlink,
  scrollback: Math.round(clamp(s.terminalScrollback, SCROLLBACK_MIN, SCROLLBACK_MAX, D.terminalScrollback)),
  notifySec: Math.max(0, s.terminalNotifySec ?? D.terminalNotifySec),
  autoComplete: !!s.terminalAutoComplete,
  pasteCheck: s.terminalPasteCheck ?? D.terminalPasteCheck,
  bell: s.terminalBell ?? D.terminalBell,
  failHint: s.terminalFailHint ?? true,
  replayMB: s.terminalReplayMB,
  predict: !!s.terminalPredict,
})
// xterm 外观选项（构造与热更新共用）
// 滚动条概览标尺（见 scrollMarks.ts）的左边框默认是一条亮线：改成底色（看不出来）。按配色对象缓存，引用不变才不会每次都重设主题
const rulerThemes = new WeakMap<ITheme, ITheme>()
const withRuler = (t: ITheme) => { let r = rulerThemes.get(t); if (!r) rulerThemes.set(t, r = { ...t, overviewRulerBorder: t.background }); return r }
export const xtermOptionsOf = (p: TermPrefs) => ({
  fontSize: p.fontSize, theme: withRuler(themeOf(p.theme, p.uiTheme ?? 'dark')), fontFamily: fontFamilyOf(p.fontFamily), lineHeight: p.lineHeight ?? D.terminalLineHeight,
  cursorStyle: p.cursorStyle ?? D.terminalCursorStyle, cursorBlink: p.cursorBlink ?? D.terminalCursorBlink, scrollback: p.scrollback ?? D.terminalScrollback,
})

// 启动时从设置拉一次
export function loadTermPrefs() {
  client.settings.get().then((s) => { if (s.system) setTermPrefs(termPrefsOf({ ...D, ...s.system })) }).catch(() => {})
}

// 快捷键改字号：防抖落盘（读最新 settings 只改字号，不动其它字段）
let saveTimer: ReturnType<typeof setTimeout> | undefined
export function changeFontSize(n: number) {
  setTermPrefs({ fontSize: n })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    // 只改字号；与设置页自动保存串行，避免整份旧 system 覆盖刚存的字段
    void saveSystemPatch({ terminalFontSize: prefs.fontSize }).catch(() => {})
  }, 500)
}

// 标签角标：后台标签里长命令跑完 / 输出命中告警 / 响铃时标记，切到该标签即清除（TerminalView 显示，TerminalPane 写入）
// bell 显示为铃铛图标（不用圆点），优先级最低：不覆盖已有的其它角标
export type TermBadge = { kind: 'alert' | 'done' | 'failed' | 'bell'; text: string }
export const BADGE_CLS: Record<TermBadge['kind'], string> = {
  alert: 'animate-pulse bg-[var(--color-warn)]', done: 'bg-[var(--color-success)]', failed: 'bg-[var(--color-danger)]', bell: '',
}
let badges: ReadonlyMap<string, TermBadge> = new Map()
export const getTermBadge = (id: string) => badges.get(id)
const badgeSubs = new Set<() => void>()
export function setTermBadge(id: string, b: TermBadge | null) {
  if (!b && !badges.has(id)) return
  const next = new Map(badges)
  if (b) next.set(id, b); else next.delete(id)
  badges = next; badgeSubs.forEach((f) => f())
}
export const useTermBadges = () => useSyncExternalStore((f) => { badgeSubs.add(f); return () => { badgeSubs.delete(f) } }, () => badges)
