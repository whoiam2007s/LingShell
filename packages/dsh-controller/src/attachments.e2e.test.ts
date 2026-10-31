// 端到端：真实 DshController + 真实 dsh 运行时 + 本地假模型服务，验证对话附件：
//  - OpenAI 兼容路由：图片作为 image_url（data URL base64）进请求；文件 / 目录路径进用户消息文本；
//  - DeepSeek Anthropic Messages 路由：图片作为 image source base64 块（Files API 不可用时内联）；
//  - 没开「支持图片」的配置：带图片直接拒绝，不发请求；
//  - 重连（从磁盘日志恢复）后回放的用户消息仍带附件（路径 + 图片存档 id），存档能按 id 读回。
// 需要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过，手动跑法见 providers.e2e.test.ts。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta, TurnAttachment } from '@lingshell/shared'
import type { DshController } from './DshController.js'

// 2×1 的 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DAwMDAwAAAD/UB/1T2zQIAAAAASUVORK5CYII='

function fake(reqs: { url: string; body: any }[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url?.endsWith('/messages') && !req.url?.endsWith('/chat/completions')) { res.writeHead(404); return res.end() }   // Files API 等：不支持
      const body = JSON.parse(raw || '{}')
      reqs.push({ url: req.url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url.endsWith('/messages')) {
        const send = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
        send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '看到了' } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
        send('message_stop', {})
        return res.end()
      }
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '看到了' })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    })
  })
}

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('对话附件端到端', () => {
  const reqs: { url: string; body: any }[] = []
  const srv = fake(reqs)
  const store = new Map<string, SessionMeta>()
  const events: AgentEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-att-'))
  type P = { provider: string; model: string; apiKey: string; baseUrl: string; multimodal?: boolean }
  const profiles: Record<string, P> = {}
  let ctrl: DshController

  const runTurn = (sid: string, text: string, atts: TurnAttachment[]) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text, atts).catch((e) => { off(); reject(e) })
  })

  beforeAll(async () => {
    const base = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as any).port}/v1`)))
    profiles.vl = { provider: 'openai-compatible', model: 'fake-vl', apiKey: 'sk-a', baseUrl: base, multimodal: true }
    profiles.ds = { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-d', baseUrl: base, multimodal: true }
    profiles.txt = { provider: 'openai-compatible', model: 'fake-text', apiKey: 'sk-a', baseUrl: base, multimodal: false }
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) } as any,
      resolveHostKey: () => 'local', decide: () => ({ kind: 'allow' }), grant: () => {}, audit: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      resolveSettings: (id?: string) => { const pid = id && profiles[id] ? id : 'vl'; return { profileId: pid, ...profiles[pid] } },
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
    })
    ctrl.onEvent((e) => events.push(e))
  })
  afterAll(async () => {
    await ctrl.stopAll()
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const img: TurnAttachment = { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: PNG }

  it('OpenAI 兼容：image_url data URL + 路径进文本', async () => {
    const s = await ctrl.createSession()
    reqs.length = 0
    await runTurn(s.id, '看看这张图', [img, { kind: 'file', path: 'C:\\logs\\a.log' }, { kind: 'dir', path: 'D:\\proj' }])
    const user = reqs[0].body.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'))
    expect(user).toBeTruthy()
    const url = user.content.find((c: any) => c.type === 'image_url').image_url.url as string
    expect(url).toBe(`data:image/png;base64,${PNG}`)
    const text = JSON.stringify(user.content)
    expect(text).toContain('看看这张图')
    expect(text).toContain('C:\\\\logs\\\\a.log')
    expect(text).toContain('D:\\\\proj')
    if (process.platform === 'win32') expect(text).toContain('/c/logs/a.log')
  }, 60_000)

  it('DeepSeek Anthropic Messages：image source base64', async () => {
    const s = await ctrl.createSession()
    await ctrl.setSessionModel(s.id, 'ds')
    reqs.length = 0
    await runTurn(s.id, '这是什么', [img])
    const r = reqs.find((x) => x.url.endsWith('/messages'))!
    const blocks = r.body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    const im = blocks.find((b: any) => b.type === 'image')
    expect(im?.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG })
  }, 60_000)

  it('没开「支持图片」：拒绝且不发请求；只带路径照常发', async () => {
    const s = await ctrl.createSession()
    await ctrl.setSessionModel(s.id, 'txt')
    reqs.length = 0
    await expect(ctrl.sendTurn(s.id, 'x', [img])).rejects.toThrow(/不支持图片/)
    expect(reqs).toHaveLength(0)
    await runTurn(s.id, '看日志', [{ kind: 'file', path: '/var/log/syslog' }])
    expect(JSON.stringify(reqs[0].body.messages)).toContain('/var/log/syslog')
  }, 60_000)

  it('重连回放：用户消息带附件（路径 + 图片存档 id），存档可读回', async () => {
    const sid = [...store.values()].find((m) => !m.modelProfileId || m.modelProfileId === 'vl')!.id
    await ctrl.closeSession(sid)
    events.length = 0
    await ctrl.reconnectSession(store.get(sid)!)
    const u = events.find((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message' && e.attachments?.length) as any
    expect(u.text).toBe('看看这张图')
    expect(u.attachments.map((a: any) => a.kind)).toEqual(['file', 'dir', 'image'])
    expect(u.attachments[0]).toMatchObject({ name: 'a.log', path: 'C:\\logs\\a.log' })
    const id = u.attachments[2].imageId
    expect(await ctrl.readImage(id)).toBe(`data:image/png;base64,${PNG}`)
  }, 60_000)
})
