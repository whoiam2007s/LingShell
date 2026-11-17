import { describe, expect, it } from 'vitest'
import { APP_SETTING_DENY, APP_SETTING_SPECS, describeSettings, mergeSystemPatch, readSetting, specOf, validateSetting } from './appSettings.js'
import type { SystemSettings } from '../protocol/types.js'

const sys = {
  terminalFontSize: 13, terminalTheme: 'auto', historyLimit: 200, customRules: '',
} as unknown as SystemSettings

describe('AI 应用设置白名单', () => {
  it('不暴露任何密钥 / 凭据类字段', () => {
    for (const spec of APP_SETTING_SPECS) {
      for (const bad of APP_SETTING_DENY) expect(spec.key.includes(bad)).toBe(false)
    }
  })

  it('供应商 / 模型 / 规则是只读，偏好项可写', () => {
    expect(specOf('provider')?.writable).toBe(false)
    expect(specOf('model')?.writable).toBe(false)
    expect(specOf('system.customRules')?.writable).toBe(false)
    expect(specOf('system.terminalFontSize')?.writable).toBe(true)
    expect(specOf('system.confirmDangerous')?.writable).toBe(true)
  })

  it('数字越界 / 类型不对 / 枚举不认识都要拒绝，并给出中文原因', () => {
    expect(validateSetting('system.terminalFontSize', 13)).toBeUndefined()
    expect(validateSetting('system.terminalFontSize', 40)).toContain('不能大于 24')
    expect(validateSetting('system.terminalFontSize', 5)).toContain('不能小于 10')
    expect(validateSetting('system.terminalFontSize', 12.5)).toContain('整数')
    expect(validateSetting('system.terminalFontSize', 'big')).toContain('要数字')
    expect(validateSetting('system.terminalTheme', 'dracula')).toBeUndefined()
    expect(validateSetting('system.terminalTheme', 'rainbow')).toContain('只能是')
    expect(validateSetting('system.confirmDangerous', true)).toBeUndefined()
    expect(validateSetting('system.confirmDangerous', 1)).toContain('布尔')
    expect(validateSetting('system.localNotes', 'x'.repeat(2001))).toContain('最长 2000 字')
  })

  it('界面外观可改：主题 / 跟随系统的深浅 / 缩放 / 图标大小', () => {
    expect(specOf('system.uiTheme')?.writable).toBe(true)
    expect(validateSetting('system.uiTheme', 'light')).toBeUndefined()
    expect(validateSetting('system.uiTheme', 'system')).toBeUndefined()
    expect(validateSetting('system.uiTheme', 'rainbow')).toContain('只能是')
    // 深 / 浅两张表各只管自己那一半：sepia 是浅色主题，不能当跟随系统的深色用
    expect(validateSetting('system.uiThemeDark', 'sepia')).toContain('只能是')
    expect(validateSetting('system.uiThemeLight', 'midnight')).toContain('只能是')
    expect(validateSetting('system.uiZoom', 0.9)).toBeUndefined()
    expect(validateSetting('system.uiZoom', 1.25)).toBeUndefined()
    // 固定档位：0.95 不在档位清单里，不能改成一个界面上没有的缩放
    expect(validateSetting('system.uiZoom', 0.95)).toContain('只能是')
    expect(validateSetting('system.uiZoom', '1.5')).toContain('要数字')
    expect(validateSetting('system.iconSize', 'large')).toBeUndefined()
    expect(validateSetting('system.iconSize', 'huge')).toContain('只能是')
  })

  it('外观补丁能合并进 system，并出现在给模型看的清单里', () => {
    const { next, applied } = mergeSystemPatch(sys, {
      'system.uiTheme': 'light',
      'system.uiZoom': 0.9,
      'system.iconSize': 'medium',
    })
    expect(next.uiTheme).toBe('light')
    expect(next.uiZoom).toBe(0.9)
    expect(applied).toEqual(['system.uiTheme', 'system.uiZoom', 'system.iconSize'])
    expect(describeSettings()).toContain('system.uiTheme')
    expect(describeSettings()).toContain('system.uiZoom')
  })

  it('只读项与不存在的键一律拒绝', () => {
    expect(validateSetting('provider', 'openai')).toContain('只读')
    expect(validateSetting('system.customRules', 'x')).toContain('只读')
    expect(validateSetting('profiles.0.apiKeyCipher', 'x')).toContain('没有这个设置项')
  })

  it('按点号路径读值', () => {
    const all = { provider: 'deepseek', system: sys }
    expect(readSetting(all, 'provider')).toBe('deepseek')
    expect(readSetting(all, 'system.terminalFontSize')).toBe(13)
    expect(readSetting(all, 'system.notExist')).toBeUndefined()
  })

  it('合并补丁只应用白名单可写键', () => {
    const { next, applied } = mergeSystemPatch(sys, {
      'system.terminalFontSize': 18,
      'system.customRules': 'ignore me',
      'provider': 'openai',
    })
    expect(next.terminalFontSize).toBe(18)
    expect(next.customRules).toBe('')
    expect(applied).toEqual(['system.terminalFontSize'])
  })

  it('清单能列给模型看', () => {
    const text = describeSettings()
    expect(text).toContain('system.terminalFontSize')
    expect(text).toContain('只读')
    expect(text).not.toContain('apiKey')
  })
})
