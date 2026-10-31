import { describe, it, expect } from 'vitest'
import { templateVars, fillTemplate, detectWebhookType, explainWebhookError } from './ops.js'

describe('detectWebhookType', () => {
  it('识别三家平台（带查询串）', () => {
    expect(detectWebhookType('https://oapi.dingtalk.com/robot/send?access_token=abc')).toBe('dingtalk')
    expect(detectWebhookType('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k-1')).toBe('wecom')
    expect(detectWebhookType('https://open.feishu.cn/open-apis/bot/v2/hook/xxxx-yyyy')).toBe('feishu')
    expect(detectWebhookType('https://open.larksuite.com/open-apis/bot/v2/hook/xxxx')).toBe('feishu')
  })
  it('其它 https / 本机 http = generic', () => {
    expect(detectWebhookType('https://example.com/hook?a=1')).toBe('generic')
    expect(detectWebhookType('https://oapi.dingtalk.com/other')).toBe('generic')
    expect(detectWebhookType('https://open.feishu.cn/open-apis/bot/v2/hook')).toBe('generic')   // 缺 hook id
    expect(detectWebhookType('https://evil.com/robot/send?x=oapi.dingtalk.com')).toBe('generic')
    expect(detectWebhookType('http://localhost:8080/robot/send')).toBe('generic')
  })
  it('不合法地址 = undefined', () => {
    expect(detectWebhookType('')).toBeUndefined()
    expect(detectWebhookType('oapi.dingtalk.com/robot/send')).toBeUndefined()
    expect(detectWebhookType('http://oapi.dingtalk.com/robot/send?access_token=a')).toBeUndefined()
    expect(detectWebhookType('ftp://x.com/a')).toBeUndefined()
  })
})

describe('explainWebhookError', () => {
  it('钉钉 310000 按 errmsg 细分，否则统一说明', () => {
    expect(explainWebhookError('310000 keywords not in content')).toContain('巡检')
    expect(explainWebhookError('310000 sign not match')).toContain('密钥')
    expect(explainWebhookError('310000 ip X not in whitelist')).toContain('白名单')
    expect(explainWebhookError('310000')).toContain('签名或关键词')
  })
  it('常见码与 HTTP/超时；认不出 = undefined', () => {
    expect(explainWebhookError('300001 token is not exist')).toContain('token')
    expect(explainWebhookError('93000 invalid webhook url')).toContain('地址无效')
    expect(explainWebhookError('19021 sign match fail')).toContain('签名')
    expect(explainWebhookError('HTTP 404')).toContain('地址不存在')
    expect(explainWebhookError('超时（10s）')).toBeDefined()
    expect(explainWebhookError('HTTP 500')).toBeUndefined()
    expect(explainWebhookError('12345 whatever')).toBeUndefined()
  })
})

describe('模板占位符', () => {
  it('提取去重、保序', () => {
    expect(templateVars('在 {{主机}} 查 {{ 端口 }}，再看 {{主机}}')).toEqual(['主机', '端口'])
    expect(templateVars('无占位符')).toEqual([])
  })
  it('填充；空值/未给的保留原样', () => {
    expect(fillTemplate('在 {{主机}} 查 {{端口}}', { 主机: 'web1', 端口: '' })).toBe('在 web1 查 {{端口}}')
  })
})
