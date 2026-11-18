// i18n-ignore-file 本文件的中文都是给模型看的设置名与校验说明，不进界面翻译
import type { SystemSettings } from '../protocol/types.js'

/**
 * AI 可读写应用设置的白名单。
 *
 * 设计原则：
 * - 只暴露 `settings.json` 里的**偏好类**字段，绝不碰密钥 / 凭据 / 供应商密钥密文；
 * - 每项都有类型与范围，越界直接拒（不静默夹到边界，让模型知道自己的值被拒了）；
 * - `writable: false` 的项 AI 能读不能改（供应商、模型名这类改了会直接影响会话）。
 */

export type SettingType = 'number' | 'boolean' | 'string' | 'enum'

export interface SettingSpec {
  /** 点号路径，如 system.terminalFontSize */
  key: string
  type: SettingType
  min?: number
  max?: number
  /** 数字项的步长：省略 = 必须是整数（如字号）；给了就按它校验小数（如界面缩放 0.05） */
  step?: number
  /** 数字项的合法取值清单（如界面缩放只能选固定档位）；给了就只认这些值 */
  choices?: readonly number[]
  maxLen?: number
  values?: readonly string[]
  /** 中文名（给模型和授权卡看） */
  label: string
  /** AI 能不能改；false = 只读 */
  writable: boolean
  /** 改了要不要重启应用才生效（提示用） */
  needsRestart?: boolean
}

export const APP_SETTING_SPECS: readonly SettingSpec[] = [
  { key: 'system.terminalFontSize', type: 'number', min: 10, max: 24, label: '终端字号', writable: true },
  {
    key: 'system.terminalTheme', type: 'enum', writable: true, label: '终端配色',
    values: ['auto', 'dark', 'light', 'solarized-dark', 'dracula', 'one-dark', 'monokai', 'github-light', 'tokyo-night', 'nord', 'solarized-light', 'high-contrast', 'rose-pine'],
  },
  { key: 'system.terminalHighlight', type: 'boolean', label: '终端关键字高亮', writable: true },
  { key: 'system.terminalRecording', type: 'boolean', label: '允许终端录屏（审计）', writable: true },
  { key: 'system.recordingRetentionDays', type: 'number', min: 0, max: 365, label: '录像保留天数（0=不清理）', writable: true },
  { key: 'system.historyLimit', type: 'number', min: 10, max: 1000, label: '每主机历史命令上限', writable: true },
  { key: 'system.execTimeoutSec', type: 'number', min: 10, max: 300, label: '命令执行超时（秒）', writable: true },
  { key: 'system.confirmDangerous', type: 'boolean', label: '危险命令逐次确认', writable: true },
  { key: 'system.aiRedact', type: 'boolean', label: '发给 AI 前脱敏', writable: true },
  { key: 'system.uploadEncrypt', type: 'boolean', label: '上传默认加密', writable: true },
  { key: 'system.contextLimitTokens', type: 'number', min: 10000, max: 2000000, label: '自动压缩阈值（tokens）', writable: true },
  { key: 'system.contextResetSteps', type: 'number', min: 10, max: 1000, label: '建议开新会话的步数', writable: true },
  { key: 'system.subagentTimeoutSec', type: 'number', min: 60, max: 1800, label: '子代理默认超时（秒，默认 600 = 10 分钟）', writable: true },
  // ── 界面外观（与 shared/ui/appearance.ts 的 UI_THEMES / UI_ZOOMS / ICON_SIZES 对齐）──
  // 「界面主题」和「终端配色」是两件事：uiTheme 换整个界面，terminalTheme 只换终端区域
  {
    key: 'system.uiTheme', type: 'enum', writable: true, label: '界面主题（跟随系统 / 深色 7 套 / 浅色 3 套）',
    values: ['system', 'dark', 'midnight', 'dracula', 'nord', 'solarized', 'rose', 'contrast', 'light', 'lavender', 'sepia'],
  },
  {
    key: 'system.uiThemeDark', type: 'enum', writable: true, label: '跟随系统时用的深色主题',
    values: ['dark', 'midnight', 'dracula', 'nord', 'solarized', 'rose', 'contrast'],
  },
  {
    key: 'system.uiThemeLight', type: 'enum', writable: true, label: '跟随系统时用的浅色主题',
    values: ['light', 'lavender', 'sepia'],
  },
  { key: 'system.uiZoom', type: 'number', min: 0.8, max: 1.5, choices: [0.8, 0.9, 1, 1.1, 1.25, 1.5], label: '界面缩放（只能选档位 0.8 / 0.9 / 1 / 1.1 / 1.25 / 1.5）', writable: true },
  { key: 'system.iconSize', type: 'enum', writable: true, label: '图标大小', values: ['small', 'medium', 'large'] },
  // 提醒与锁屏：用户常让 AI 顺手关掉「桌面通知」「锁屏时间」
  { key: 'system.notifyDesktop', type: 'boolean', label: '任务完成弹桌面通知', writable: true },
  { key: 'system.notifySound', type: 'boolean', label: '通知带提示音', writable: true },
  { key: 'system.lockIdleMinutes', type: 'number', min: 0, max: 1440, label: '空闲自动锁定（分钟，0 = 不按空闲锁）', writable: true },
  { key: 'system.terminalFontFamily', type: 'string', maxLen: 60, label: '终端字体（留空 = 默认等宽）', writable: true },
  { key: 'system.terminalScrollback', type: 'number', min: 1000, max: 200000, label: '终端回滚行数', writable: true },
  { key: 'system.localNotes', type: 'string', maxLen: 2000, label: '本机备注（AI 处理本地终端时可见）', writable: true },
  // 只读：改了会直接影响当前会话或涉及安全策略，让 AI 看但不让动
  { key: 'system.customRules', type: 'string', maxLen: 8000, label: '全局自定义规则', writable: false },
  { key: 'provider', type: 'string', maxLen: 40, label: '模型供应商', writable: false },
  { key: 'model', type: 'string', maxLen: 80, label: '默认模型', writable: false },
  { key: 'baseUrl', type: 'string', maxLen: 200, label: '接口地址', writable: false },
  { key: 'defaultProfileId', type: 'string', maxLen: 40, label: '默认模型配置', writable: false },
]

/** 永不暴露的字段（密钥 / 凭据类），任何接口都不返回 */
export const APP_SETTING_DENY = ['profiles', 'apiKey', 'apiKeyCipher', 'secrets', 'auth', 'vault', 'password'] as const

export const specOf = (key: string): SettingSpec | undefined => APP_SETTING_SPECS.find((s) => s.key === key)

/** 校验一个值是否符合规格；合法返回 undefined，否则返回给模型看的中文原因 */
export function validateSetting(key: string, value: unknown): string | undefined {
  const spec = specOf(key)
  if (!spec) return `没有这个设置项：${key}（可先调 get_app_setting 看全部可用的键）`
  if (!spec.writable) return `「${spec.label}」只读：AI 可以查看，但不能修改`

  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `「${spec.label}」要布尔值 true / false`
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `「${spec.label}」要数字`
      // 固定档位（如界面缩放）：只认清单里的值，避免改成一个界面上没有的中间值
      if (spec.choices) {
        return spec.choices.includes(value) ? undefined : `「${spec.label}」只能是：${spec.choices.join(' / ')}`
      }
      if (spec.step === undefined) {
        if (!Number.isInteger(value)) return `「${spec.label}」要整数`
      } else {
        // 带步长的项（如界面缩放 0.05）：按步长校验，浮点比较留一点余量
        const k = value / spec.step
        if (Math.abs(k - Math.round(k)) > 1e-6) return `「${spec.label}」只能按 ${spec.step} 递增`
      }
      if (spec.min !== undefined && value < spec.min - 1e-9) return `「${spec.label}」不能小于 ${spec.min}`
      if (spec.max !== undefined && value > spec.max + 1e-9) return `「${spec.label}」不能大于 ${spec.max}`
      return undefined
    }
    case 'enum':
      return spec.values?.includes(String(value)) ? undefined : `「${spec.label}」只能是：${spec.values?.join(' / ')}`
    case 'string': {
      if (typeof value !== 'string') return `「${spec.label}」要字符串`
      if (spec.maxLen !== undefined && value.length > spec.maxLen) return `「${spec.label}」最长 ${spec.maxLen} 字`
      return undefined
    }
  }
}

/** 从 AppSettings 里按点号路径取值（只取白名单里的键） */
export function readSetting(settings: Record<string, unknown>, key: string): unknown {
  let cur: unknown = settings
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** 把一份 system 补丁合并进现有 system（只允许白名单可写键） */
export function mergeSystemPatch(cur: SystemSettings, patch: Record<string, unknown>): { next: SystemSettings; applied: string[] } {
  const next = { ...cur }
  const applied: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith('system.')) continue
    const field = key.slice('system.'.length) as keyof SystemSettings
    if (!specOf(key)?.writable) continue
    ;(next as Record<string, unknown>)[field as string] = value
    applied.push(key)
  }
  return { next, applied }
}

/** 给模型看的清单（不含值，值在 get_app_setting 里返回） */
export function describeSettings(): string {
  return APP_SETTING_SPECS.map((s) => {
    const range = s.type === 'number'
      ? `${s.min}–${s.max}${s.step !== undefined ? `（步长 ${s.step}）` : ''}`
      : s.type === 'enum'
        ? (s.values ?? []).join('|')
        : s.type === 'string'
          ? `≤${s.maxLen} 字`
          : 'true|false'
    return `${s.key}（${s.label}，${range}${s.writable ? '' : '，只读'}）`
  }).join('\n')
}
