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
      if (!Number.isInteger(value)) return `「${spec.label}」要整数`
      if (spec.min !== undefined && value < spec.min) return `「${spec.label}」不能小于 ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `「${spec.label}」不能大于 ${spec.max}`
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
      ? `${s.min}–${s.max}`
      : s.type === 'enum'
        ? (s.values ?? []).join('|')
        : s.type === 'string'
          ? `≤${s.maxLen} 字`
          : 'true|false'
    return `${s.key}（${s.label}，${range}${s.writable ? '' : '，只读'}）`
  }).join('\n')
}
