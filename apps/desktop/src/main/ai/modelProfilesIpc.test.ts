// 测试连接：本机回环假服务（node:http），不请求任何真实服务
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { testModelConnection, registerModelProfiles } from './modelProfilesIpc.js'

const seen: { url: string; auth: string; body: string }[] = []
// /models：带 nomodels 的路径回 404（端点不提供模型列表）；Bearer bad 回 401；/chat/completions 回 200（或 model=bad 时 400）
const server: Server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const xKey = req.headers['x-api-key']
    const auth = xKey ? `x-api-key ${xKey} ${req.headers['anthropic-version'] ?? ''}`.trim() : String(req.headers.authorization ?? '')
    seen.push({ url: req.url ?? '', auth, body })
    res.setHeader('content-type', 'application/json')
    if (auth === 'Bearer sk-bad' || xKey === 'sk-bad') { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-bad' } })) }
    // Anthropic Messages：/am 下支持；/m405 回 405；/html 回 200 但不是 Messages 格式；其余路径 404（只支持 OpenAI 的网关）
    if (req.url?.endsWith('/v1/messages')) {
      if (req.url.startsWith('/am/')) return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'p' }] }))
      if (req.url.startsWith('/m405/')) { res.writeHead(405); return res.end('') }
      if (req.url.startsWith('/html/')) { res.setHeader('content-type', 'text/html'); return res.end('<html>ok</html>') }
      res.writeHead(404); return res.end(JSON.stringify({ error: { message: 'Not Found' } }))
    }
    if (req.url?.endsWith('/models')) {
      if (req.url.includes('nomodels')) { res.writeHead(404); return res.end('{}') }
      return res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }))
    }
    if (JSON.parse(body || '{}').model === 'bad') { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'Model Not Exist' } })) }
    res.end(JSON.stringify({ choices: [{ message: { content: 'p' } }] }))
  })
})
const base = new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
afterAll(() => { server.close() })

describe('testModelConnection', () => {
  it('模型列表里有：通过；没有：通过但提示核对模型 id', async () => {
    const b = await base
    expect(await testModelConnection({ provider: 'openai-compatible', model: 'm1', baseUrl: `${b}/v1/`, apiKey: 'sk-ok' })).toMatchObject({ ok: true })
    expect(seen.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer sk-ok' })
    const r = await testModelConnection({ provider: 'openai-compatible', model: 'zzz', baseUrl: b, apiKey: 'sk-ok' })
    expect(r.ok).toBe(true)
    expect(r.warning).toContain('zzz')
  })
  it('Key 错：认证失败，错误里抹掉 Key', async () => {
    const r = await testModelConnection({ provider: 'qwen', model: 'm1', baseUrl: await base, apiKey: 'sk-bad' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('认证失败')
    expect(r.error).not.toContain('sk-bad')
  })
  it('端点没有 models 列表：退到极小对话请求（max_tokens=1）', async () => {
    const b = await base
    expect(await testModelConnection({ provider: 'ollama', model: 'm1', baseUrl: `${b}/nomodels`, apiKey: '' })).toMatchObject({ ok: true })
    const last = seen.at(-1)!
    expect(last.url).toBe('/nomodels/chat/completions')
    expect(last.auth).toBe('Bearer no-key')
    expect(JSON.parse(last.body)).toMatchObject({ model: 'm1', max_tokens: 1 })
    expect(await testModelConnection({ provider: 'ollama', model: 'bad', baseUrl: `${b}/nomodels`, apiKey: '' })).toEqual({ ok: false, error: '请求失败（HTTP 400）：Model Not Exist' })
  })
  it('需要 Key 却没填：不发请求；连不上：给出地址与原因', async () => {
    const n = seen.length
    expect(await testModelConnection({ provider: 'deepseek', model: 'x', baseUrl: '', apiKey: '' })).toEqual({ ok: false, error: '还没填 API Key' })
    expect(seen.length).toBe(n)
    const r = await testModelConnection({ provider: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:1', apiKey: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('连不上 http://127.0.0.1:1')
  })
})

describe('testModelConnection：Anthropic Messages 协议', () => {
  it('DeepSeek 缺省走 anthropic：POST {base}/v1/messages（x-api-key + anthropic-version，max_tokens=1）', async () => {
    const b = await base
    expect(await testModelConnection({ provider: 'deepseek', model: 'deepseek-v4-pro', baseUrl: `${b}/am/`, apiKey: 'sk-ok' })).toMatchObject({ ok: true })
    const last = seen.at(-1)!
    expect(last).toMatchObject({ url: '/am/v1/messages', auth: 'x-api-key sk-ok 2023-06-01' })
    expect(JSON.parse(last.body)).toMatchObject({ model: 'deepseek-v4-pro', max_tokens: 1 })
  })
  it('404 / 405 / 返回不是 Messages 格式 → protocolMismatch，提示改用 OpenAI 兼容', async () => {
    const b = await base
    for (const path of ['/gw', '/m405', '/html']) {
      const r = await testModelConnection({ provider: 'deepseek', model: 'x', baseUrl: `${b}${path}`, apiKey: 'sk-ok', protocol: 'anthropic' })
      expect(r).toMatchObject({ ok: false, protocolMismatch: true })
      expect(r.error).toContain('可能不支持 Anthropic 协议')
    }
  })
  it('认证失败 / 其它错误不算协议不匹配；Key 被抹掉', async () => {
    const b = await base
    const r = await testModelConnection({ provider: 'deepseek', model: 'x', baseUrl: `${b}/am`, apiKey: 'sk-bad' })
    expect(r.ok).toBe(false)
    expect(r.protocolMismatch).toBeUndefined()
    expect(r.error).toContain('认证失败')
    expect(r.error).not.toContain('sk-bad')
  })
  it('改用 OpenAI 兼容：同一地址走 /models（Bearer）；DeepSeek 官方 /anthropic 地址修回根地址', async () => {
    const b = await base
    expect(await testModelConnection({ provider: 'deepseek', model: 'm1', baseUrl: `${b}/gw`, apiKey: 'sk-ok', protocol: 'openai' })).toMatchObject({ ok: true })
    expect(seen.at(-1)).toMatchObject({ url: '/gw/models', auth: 'Bearer sk-ok' })
    const urls: string[] = []
    const fake = (async (u: string) => { urls.push(String(u)); return new Response(JSON.stringify({ data: [] })) }) as unknown as typeof fetch
    await testModelConnection({ provider: 'deepseek', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k', protocol: 'openai' }, fake)
    await testModelConnection({ provider: 'deepseek', model: 'm', baseUrl: '', apiKey: 'k' }, fake)
    expect(urls).toEqual(['https://api.deepseek.com/models', 'https://api.deepseek.com/anthropic/v1/messages'])
  })
  it('非 DeepSeek 提供商即使传 anthropic 也按 OpenAI 兼容测', async () => {
    const b = await base
    await testModelConnection({ provider: 'qwen', model: 'm1', baseUrl: `${b}/v1`, apiKey: 'sk-ok', protocol: 'anthropic' })
    expect(seen.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer sk-ok' })
  })
})

describe('registerModelProfiles', () => {
  it('表单没填 Key 用已存的；换了提供商不沿用', async () => {
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerModelProfiles({
      handle: (ch, fn) => h.set(ch, fn),
      stored: (id) => (id === 'a' ? { provider: 'qwen', apiKey: 'sk-stored' } : undefined),
      setSessionModel: async () => ({ pending: false }), sessionModel: () => ({ pending: false }),
    })
    const b = await base
    await h.get('modelProfiles:test')!(null, { id: 'a', provider: 'qwen', model: 'm1', baseUrl: b })
    expect(seen.at(-1)!.auth).toBe('Bearer sk-stored')
    expect(await h.get('modelProfiles:test')!(null, { id: 'a', provider: 'moonshot', model: 'm1', baseUrl: b })).toEqual({ ok: false, error: '还没填 API Key' })
    // 表单的接口协议透传
    await h.get('modelProfiles:test')!(null, { id: 'n', provider: 'deepseek', model: 'm1', baseUrl: `${b}/gw`, apiKey: 'sk-ok', protocol: 'openai' })
    expect(seen.at(-1)!.url).toBe('/gw/models')
    await h.get('modelProfiles:test')!(null, { id: 'n', provider: 'deepseek', model: 'm1', baseUrl: `${b}/am`, apiKey: 'sk-ok' })
    expect(seen.at(-1)!.url).toBe('/am/v1/messages')
  })
})
