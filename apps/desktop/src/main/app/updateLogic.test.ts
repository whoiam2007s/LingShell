import { describe, it, expect } from 'vitest'
import { resolveUpdateSource, nextUpdateStatus } from './updateLogic.js'

const YML = 'provider: generic\nurl: https://dl.example.com/LingShell\nupdaterCacheDirName: lingshell-updater\n'

describe('resolveUpdateSource', () => {
  it('开发模式一律禁用', () => {
    expect(resolveUpdateSource({ isPackaged: false, envUrl: 'https://x', appUpdateYml: YML })).toEqual({ enabled: false })
  })
  it('无环境变量也无 app-update.yml → 禁用', () => {
    expect(resolveUpdateSource({ isPackaged: true })).toEqual({ enabled: false })
    expect(resolveUpdateSource({ isPackaged: true, envUrl: '  ', appUpdateYml: 'provider: generic\n' })).toEqual({ enabled: false })
  })
  it('读打包生成的 app-update.yml', () => {
    expect(resolveUpdateSource({ isPackaged: true, appUpdateYml: YML }))
      .toEqual({ enabled: true, url: 'https://dl.example.com/LingShell', override: false })
    expect(resolveUpdateSource({ isPackaged: true, appUpdateYml: "url: 'http://127.0.0.1:8080'\n" }))
      .toEqual({ enabled: true, url: 'http://127.0.0.1:8080', override: false })
  })
  it('运行时环境变量优先', () => {
    expect(resolveUpdateSource({ isPackaged: true, envUrl: ' http://localhost:8080/ ', appUpdateYml: YML }))
      .toEqual({ enabled: true, url: 'http://localhost:8080/', override: true })
  })
  it('非 http(s) 地址视为未配置', () => {
    expect(resolveUpdateSource({ isPackaged: true, envUrl: 'file:///c:/x', appUpdateYml: 'url: ftp://a/b\n' })).toEqual({ enabled: false })
  })
})

describe('nextUpdateStatus', () => {
  const idle = { state: 'none' as const }
  it('映射各事件', () => {
    expect(nextUpdateStatus(idle, 'checking-for-update')).toEqual({ state: 'checking' })
    expect(nextUpdateStatus(idle, 'update-not-available', { version: '0.1.0' })).toEqual({ state: 'none' })
    expect(nextUpdateStatus(idle, 'update-available', { version: '0.2.0' })).toEqual({ state: 'available', version: '0.2.0' })
    expect(nextUpdateStatus(idle, 'update-downloaded', { version: '0.2.0' })).toEqual({ state: 'downloaded', version: '0.2.0' })
  })
  it('下载进度沿用版本号、百分比取整', () => {
    expect(nextUpdateStatus({ state: 'available', version: '0.2.0' }, 'download-progress', { percent: 42.6 }))
      .toEqual({ state: 'downloading', version: '0.2.0', percent: 43 })
  })
  it('错误带消息', () => {
    expect(nextUpdateStatus(idle, 'error', new Error('net::ERR'))).toEqual({ state: 'error', version: undefined, error: 'net::ERR' })
  })
  it('未知事件返回 undefined', () => {
    expect(nextUpdateStatus(idle, 'update-cancelled')).toBeUndefined()
  })
})
