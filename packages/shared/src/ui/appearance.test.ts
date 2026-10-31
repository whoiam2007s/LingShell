import { describe, it, expect } from 'vitest'
import { UI_THEMES, UI_ZOOMS, iconZoomOf, isUiTheme, kindOf, migrateAppearance, normalizeZoom, resolveTerminalTheme, resolveTheme, stepZoom, themeSourceOf } from './appearance.js'
import { KEY_ACTION_BY_ID, findConflict, resolveKeybindings, shellKeyConflict } from './keybindings.js'
import { DEFAULT_SYSTEM_SETTINGS } from '../protocol/index.js'

describe('主题解析', () => {
  it('深色 / 浅色固定，跟随系统按系统值，缺省深色', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme(undefined, false)).toBe('dark')
  })
  it('10 套主题：固定选择原样返回，未知值回落暗黑', () => {
    expect(UI_THEMES.map((t) => t.id)).toEqual(['dark', 'midnight', 'dracula', 'nord', 'solarized', 'rose', 'contrast', 'light', 'lavender', 'sepia'])
    for (const t of UI_THEMES) expect(resolveTheme(t.id, false)).toBe(t.id)
    expect(resolveTheme('purple', true)).toBe('dark')
    expect(resolveTheme(null, true)).toBe('dark')
  })
  it('kindOf：明亮 / 薰衣草 / 护眼米黄是浅色，其余深色', () => {
    expect(UI_THEMES.filter((t) => kindOf(t.id) === 'light').map((t) => t.id)).toEqual(['light', 'lavender', 'sepia'])
    expect(kindOf('contrast')).toBe('dark')
    expect(kindOf('midnight')).toBe('dark')
  })
  it('跟随系统：按 uiThemeDark / uiThemeLight 映射，类型不符或非法回落暗黑 / 明亮', () => {
    const m = { uiThemeDark: 'nord', uiThemeLight: 'sepia' }
    expect(resolveTheme('system', true, m)).toBe('nord')
    expect(resolveTheme('system', false, m)).toBe('sepia')
    expect(resolveTheme('system', true, { uiThemeDark: 'sepia' })).toBe('dark')     // 浅色主题不能当深色用
    expect(resolveTheme('system', false, { uiThemeLight: 'dracula' })).toBe('light')
    expect(resolveTheme('system', false, { uiThemeLight: 'xx' })).toBe('light')
    expect(resolveTheme('nord', false, m)).toBe('nord')   // 非跟随系统时映射不起作用
  })
  it('老配置 dark / light / system 完全兼容', () => {
    for (const t of ['dark', 'light', 'system']) expect(isUiTheme(t)).toBe(true)
    expect(resolveTheme('light', true, {})).toBe('light')
    expect(resolveTheme('system', true, {})).toBe('dark')
    expect(resolveTheme('system', false, undefined)).toBe('light')
  })
  it('原生主题来源：跟随系统交给系统，其余按深浅', () => {
    expect(themeSourceOf('system')).toBe('system')
    expect(themeSourceOf('sepia')).toBe('light')
    expect(themeSourceOf('dracula')).toBe('dark')
    expect(themeSourceOf(undefined)).toBe('dark')
  })
  it('终端配色 auto 跟随界面主题对应的配色，选过的保持', () => {
    expect(resolveTerminalTheme('auto', 'light')).toBe('light')
    expect(resolveTerminalTheme('auto', 'dark')).toBe('dark')
    expect(resolveTerminalTheme(undefined, 'light')).toBe('light')
    expect(resolveTerminalTheme('auto', 'midnight')).toBe('tokyo-night')
    expect(resolveTerminalTheme('auto', 'dracula')).toBe('dracula')
    expect(resolveTerminalTheme('auto', 'nord')).toBe('nord')
    expect(resolveTerminalTheme('auto', 'solarized')).toBe('solarized-dark')
    expect(resolveTerminalTheme('auto', 'sepia')).toBe('solarized-light')
    expect(resolveTerminalTheme('auto', 'contrast')).toBe('high-contrast')
    expect(resolveTerminalTheme('dracula', 'light')).toBe('dracula')
    expect(resolveTerminalTheme('dark', 'sepia')).toBe('dark')
  })
  it('老配置：没有 uiTheme 时默认 dark 配色按跟随界面解读，其它不动', () => {
    expect(migrateAppearance({ terminalTheme: 'dark' })?.terminalTheme).toBe('auto')
    expect(migrateAppearance({ terminalTheme: 'monokai' })?.terminalTheme).toBe('monokai')
    expect(migrateAppearance({ terminalTheme: 'dark', uiTheme: 'light' })?.terminalTheme).toBe('dark')
    expect(migrateAppearance(undefined)).toBeUndefined()
  })
  it('默认值：深色界面、100%、小图标、终端跟随界面', () => {
    expect(DEFAULT_SYSTEM_SETTINGS).toMatchObject({ uiTheme: 'dark', uiThemeDark: 'dark', uiThemeLight: 'light', uiZoom: 1, iconSize: 'small', terminalTheme: 'auto' })
  })
})

describe('缩放档位', () => {
  it('档位 80%–150% 升序，含 100%', () => {
    expect(UI_ZOOMS).toEqual([0.8, 0.9, 1, 1.1, 1.25, 1.5])
  })
  it('非档位取最近档，非法回落 100%', () => {
    expect(normalizeZoom(1.12)).toBe(1.1)
    expect(normalizeZoom(3)).toBe(1.5)
    expect(normalizeZoom(0.1)).toBe(0.8)
    expect(normalizeZoom('x')).toBe(1)
    expect(normalizeZoom(NaN)).toBe(1)
  })
  it('逐档放大缩小、到头不动、复位 100%', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1.5, 1)).toBe(1.5)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(0.8, -1)).toBe(0.8)
    expect(stepZoom(1.25, 0)).toBe(1)
  })
  it('图标大小：小 1 / 中 1.15 / 大 1.3，未知按小', () => {
    expect(iconZoomOf('small')).toBe(1)
    expect(iconZoomOf('medium')).toBe(1.15)
    expect(iconZoomOf('large')).toBe(1.3)
    expect(iconZoomOf(undefined)).toBe(1)
  })
})

describe('界面缩放快捷键', () => {
  const b = resolveKeybindings({})
  it('默认 Ctrl+Shift+= / - / 0，全局生效', () => {
    expect([b['app.zoomIn'], b['app.zoomOut'], b['app.zoomReset']]).toEqual(['Ctrl+Shift+=', 'Ctrl+Shift+-', 'Ctrl+Alt+0'])
    for (const id of ['app.zoomIn', 'app.zoomOut', 'app.zoomReset']) expect(KEY_ACTION_BY_ID[id].scope).toBe('global')
  })
  it('不与终端字号 Ctrl+= / - / 0 及其它默认键冲突，不占终端常用键', () => {
    expect([b['term.fontUp'], b['term.fontDown'], b['term.fontReset']]).toEqual(['Ctrl+=', 'Ctrl+-', 'Ctrl+0'])
    for (const id of ['app.zoomIn', 'app.zoomOut', 'app.zoomReset']) {
      expect(findConflict(id, b[id]!, b)).toBeNull()
      expect(shellKeyConflict(b[id]!)).toBeNull()
    }
  })
})
