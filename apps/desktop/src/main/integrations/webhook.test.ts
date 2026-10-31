import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ResolvedWebhook } from '@lingshell/config'
import { dingtalkSign, feishuSign, tailSummary, buildRequest, sendWebhook, selectWebhooks, pushAlerts, testAlert, SUMMARY_BYTES, type AlertInfo } from './webhook.js'

const info: AlertInfo = { scheduleName: '每日磁盘', status: 'abnormal', hosts: ['web1', 'db1'], time: '2026-10-10 09:00:00', summary: 'a\n\n磁盘 92%\n状态: 异常' }
const wh = (p: Partial<ResolvedWebhook>): ResolvedWebhook => ({ id: 'w1', name: '群A', type: 'generic', enabled: true, url: 'https://x/hook', ...p })

describe('签名', () => {
  it('钉钉：urlencode(base64(HMAC(secret, ts\\nsecret)))', () => {
    const ts = 1700000000000, secret = 'SEC0123abc+/='
    const want = encodeURIComponent(createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64'))
    expect(dingtalkSign(secret, ts)).toBe(want)
    expect(dingtalkSign(secret, ts)).not.toMatch(/[+/=]/)   // 已 urlencode
  })
  it('飞书：base64(HMAC(key=ts\\nsecret, msg=空))', () => {
    const ts = 1700000000, secret = 'abc'
    const want = createHmac('sha256', Buffer.from(`${ts}\n${secret}`)).update(Buffer.alloc(0)).digest('base64')
    expect(feishuSign(secret, ts)).toBe(want)
  })
})

describe('消息', () => {
  it('摘要取尾部、按字节截断不切坏中文', () => {
    expect(tailSummary('x\n\n y \n', 100)).toBe('x\n y')
    const s = tailSummary('中'.repeat(2000), 100)
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(100)
    expect(s.startsWith('…中')).toBe(true)
    expect(s).not.toContain('�')
    expect(tailSummary(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), 9999).split('\n')).toHaveLength(20)
  })
  it('钉钉：markdown + 加签参数', () => {
    const r = buildRequest(wh({ type: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 's' }), info, 1700000000000)
    expect(r.url).toBe(`https://oapi.dingtalk.com/robot/send?access_token=t&timestamp=1700000000000&sign=${dingtalkSign('s', 1700000000000)}`)
    const b = r.body as { msgtype: string; markdown: { title: string; text: string } }
    expect(b.msgtype).toBe('markdown')
    expect(b.markdown.title).toBe('巡检「每日磁盘」异常')
    expect(b.markdown.text).toContain('web1、db1')
    expect(b.markdown.text).toContain('> 磁盘 92%')
  })
  it('钉钉：每条消息（含测试消息、任意状态）标题和正文都带关键词「巡检」', () => {
    for (const a of [info, testAlert(), { ...info, scheduleName: 'x', status: 'failed' as const, summary: '' }]) {
      const b = buildRequest(wh({ type: 'dingtalk' }), a).body as { markdown: { title: string; text: string } }
      expect(b.markdown.title).toContain('巡检')
      expect(b.markdown.text).toContain('巡检')
    }
  })
  it('企微：markdown 整条不超 4096 字节', () => {
    const r = buildRequest(wh({ type: 'wecom' }), { ...info, summary: '很长的行'.repeat(3000), error: 'e'.repeat(1000) })
    const b = r.body as { msgtype: string; markdown: { content: string } }
    expect(b.msgtype).toBe('markdown')
    expect(Buffer.byteLength(b.markdown.content)).toBeLessThanOrEqual(4096)
  })
  it('飞书：text + timestamp/sign；无密钥不带签名', () => {
    const r = buildRequest(wh({ type: 'feishu', secret: 'k' }), info, 1700000000999)
    expect(r.body).toMatchObject({ timestamp: '1700000000', sign: feishuSign('k', 1700000000), msg_type: 'text' })
    expect((r.body as { content: { text: string } }).content.text).toContain('状态：异常')
    expect(buildRequest(wh({ type: 'feishu' }), info).body).not.toHaveProperty('sign')
  })
  it('通用：JSON 字段，摘要截断', () => {
    const b = buildRequest(wh({}), { ...info, summary: 'x'.repeat(10000) }).body as Record<string, unknown>
    expect(b).toMatchObject({ scheduleName: '每日磁盘', status: 'abnormal', statusText: '异常', hosts: ['web1', 'db1'], time: info.time })
    expect(Buffer.byteLength(b.summary as string)).toBeLessThanOrEqual(SUMMARY_BYTES.generic)
  })
})

describe('selectWebhooks', () => {
  const all = [wh({ id: 'a' }), wh({ id: 'b', enabled: false }), wh({ id: 'c' })]
  it('默认只推非正常、推所有启用的', () => {
    expect(selectWebhooks({}, 'normal', all)).toEqual([])
    expect(selectWebhooks({}, 'running', all)).toEqual([])
    expect(selectWebhooks({}, 'timeout', all).map((w) => w.id)).toEqual(['a', 'c'])
  })
  it('always 每次都推；指定列表只推列表内启用的；[] 不推', () => {
    expect(selectWebhooks({ notifyOn: 'always' }, 'normal', all).map((w) => w.id)).toEqual(['a', 'c'])
    expect(selectWebhooks({ notifyWebhooks: ['b', 'c'] }, 'failed', all).map((w) => w.id)).toEqual(['c'])
    expect(selectWebhooks({ notifyWebhooks: [] }, 'failed', all)).toEqual([])
  })
})

describe('发送（本地假服务器）', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>((r) => {
    const s = server
    server = undefined
    if (!s) return r()
    s.closeAllConnections()
    s.close(() => r())
  }))
  const serve = async (h: (req: IncomingMessage, res: ServerResponse, body: string, n: number) => void) => {
    let n = 0
    server = createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => h(req, res, b, ++n)) })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, count: () => n }
  }

  it('成功：POST JSON', async () => {
    let got: unknown
    const s = await serve((req, res, body) => { got = { method: req.method, ct: req.headers['content-type'], body: JSON.parse(body) }; res.end('{"errcode":0}') })
    await sendWebhook(wh({ type: 'wecom', url: s.url }), info)
    expect(got).toMatchObject({ method: 'POST', ct: 'application/json', body: { msgtype: 'markdown' } })
    expect(s.count()).toBe(1)
  })
  it('非 200 → 重试 1 次后报错；报错不含 URL', async () => {
    const s = await serve((_q, res) => { res.statusCode = 500; res.end('x') })
    await expect(sendWebhook(wh({ url: s.url }), info)).rejects.toThrow('HTTP 500')
    expect(s.count()).toBe(2)
  })
  it('HTTP 200 但业务码非 0 视为失败', async () => {
    const s = await serve((_q, res) => { res.end('{"errcode":310000,"errmsg":"sign not match"}') })
    await expect(sendWebhook(wh({ type: 'dingtalk', url: s.url, secret: 'k' }), info, { retries: 0 })).rejects.toThrow('310000 sign not match（签名不匹配')
  })
  it('超时 → 重试，第二次成功', async () => {
    const s = await serve((_q, res, _b, n) => { if (n > 1) res.end('{"code":0}') })   // 第一次不回
    await sendWebhook(wh({ type: 'feishu', url: s.url }), info, { timeoutMs: 300 })
    expect(s.count()).toBe(2)
  })
  it('通用 webhook 不读回包：对端只回头不结束也不会挂到超时', async () => {
    const s = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":') })   // 不 end
    const t0 = Date.now()
    await sendWebhook(wh({ url: s.url }), info, { timeoutMs: 10_000, retries: 0 })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
  it('pushAlerts 汇总失败、不抛', async () => {
    const ok = await serve((_q, res) => { res.end('{}') })
    const err = await pushAlerts([wh({ name: '好', url: ok.url }), wh({ name: '坏', url: 'http://127.0.0.1:1/x' })], info, { retries: 0, timeoutMs: 2000 })
    expect(err).toMatch(/^坏：/)
    expect(err).not.toContain('127.0.0.1:1/x')
  })
})
