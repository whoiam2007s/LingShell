import { describe, it, expect } from 'vitest'
import type { AppEvent } from './events.js'
import type { CommandHistoryEntry, DirEntry } from './types.js'
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_SETTINGS, contextWindowOf, protocolOf, endpointBaseOf } from './types.js'
import { DEFAULT_HIGHLIGHT_RULES } from '../terminal/index.js'

describe('接口协议', () => {
  it('protocolOf：DeepSeek 缺省 / 非法值 = anthropic，可选 openai；其它提供商一律 openai', () => {
    expect(protocolOf('deepseek')).toBe('anthropic')
    expect(protocolOf('deepseek', 'bogus')).toBe('anthropic')
    expect(protocolOf('deepseek', 'openai')).toBe('openai')
    expect(protocolOf('qwen')).toBe('openai')
    expect(protocolOf('moonshot', 'anthropic')).toBe('openai')
  })
  it('endpointBaseOf：DeepSeek 官方地址按协议修正，自定义地址与其它提供商原样（去尾斜杠）', () => {
    const ds = (baseUrl: string, protocol?: 'anthropic' | 'openai') => endpointBaseOf({ provider: 'deepseek', baseUrl, protocol })
    expect(ds('')).toBe('https://api.deepseek.com/anthropic')
    expect(ds('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/anthropic')
    expect(ds('', 'openai')).toBe('https://api.deepseek.com')
    expect(ds('https://api.deepseek.com/anthropic', 'openai')).toBe('https://api.deepseek.com')
    expect(ds('https://api.deepseek.com/anthropic/', 'anthropic')).toBe('https://api.deepseek.com/anthropic')
    expect(ds('http://gw.local/anthropic', 'openai')).toBe('http://gw.local/anthropic')
    expect(ds(' http://gw.local/v1/ ', 'openai')).toBe('http://gw.local/v1')
    expect(endpointBaseOf({ provider: 'qwen', baseUrl: '' })).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })
})

describe('contextWindowOf', () => {
  it('用户覆盖 > 预置模型值 > provider 默认值', () => {
    expect(contextWindowOf('deepseek', 'deepseek-v4-pro')).toBe(1_000_000)
    expect(contextWindowOf('qwen', 'qwen-max')).toBe(32_768)
    expect(contextWindowOf('ollama', 'llama3.1:8b')).toBe(32_768)
    expect(contextWindowOf('ollama', 'llama3.1:8b', 8192)).toBe(8192)
    expect(contextWindowOf('qwen', 'qwen-max', 0)).toBe(32_768)
  })
})

describe('AppEvent discrimination', () => {
  it('narrows by type', () => {
    const ev: AppEvent = { type: 'terminal:data', terminalId: 't1', chunk: 'hi' }
    if (ev.type === 'terminal:data') {
      expect(ev.chunk).toBe('hi')
      expect(ev.terminalId).toBe('t1')
    } else {
      throw new Error('should narrow to terminal:data')
    }
  })
})

describe('阶段二类型', () => {
  it('CommandHistoryEntry / DirEntry 形状', () => {
    const e: CommandHistoryEntry = { command: 'ls', terminalId: 't1', terminalTitle: '本地 1', hostKey: 'local', at: '2026-07-04T00:00:00Z', source: 'user' }
    const d: DirEntry = { name: 'a', path: '/a', isDir: true }
    expect(e.source).toBe('user')
    expect(d.isDir).toBe(true)
  })
})

describe('阶段三：SystemSettings', () => {
  it('SystemSettings 默认值', () => {
    expect(DEFAULT_SYSTEM_SETTINGS).toEqual({
      historyLimit: 200, execTimeoutSec: 50, uploadEncrypt: true,
      contextLimitTokens: 600000, contextResetSteps: 100, confirmDangerous: true, aiRedact: true,
      customRules: '', localNotes: '',
      terminalFontSize: 13, terminalTheme: 'auto',
      terminalRecording: false, recordingRetentionDays: 30,
      terminalHighlight: true, highlightRules: DEFAULT_HIGHLIGHT_RULES,
      sessionLog: false, sessionLogDir: '', sessionLogRetentionDays: 30, sessionLogTimestamps: false,
      lockIdleMinutes: 10,
      sshAutoReconnect: false,
      hostStats: false, hostStatsIntervalSec: 10, hostStatsProd: false,
      terminalFontFamily: '', terminalLineHeight: 1.3, terminalCursorStyle: 'block', terminalCursorBlink: true, terminalScrollback: 5000,
      terminalNotifySec: 30,
      externalEditor: '',
      transferConcurrency: 2,
      terminalAutoComplete: false,
      terminalPasteCheck: true,
      terminalBell: 'notify',
      sshUrlHandler: false,
      bashPath: '',
      keybindings: {},
      commandRules: [],
      uiTheme: 'dark', uiThemeDark: 'dark', uiThemeLight: 'light', uiZoom: 1, iconSize: 'small',
    })
    expect(DEFAULT_SETTINGS.system).toEqual(DEFAULT_SYSTEM_SETTINGS)
  })
})
