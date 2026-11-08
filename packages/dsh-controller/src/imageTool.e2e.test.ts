// 真机验收：read_image（真实 DshController + 真附件库 + 真 llm.stream 子请求；只有「模型」是假的）
//
// 验的是这三件事，都是线上最容易翻车、单测覆盖不到的地方：
//   1. 工具注册能不能过（schema 写错会在 boot 就炸，所有会话都起不来）；
//   2. 多张图是不是**一次**子请求送出去（而不是逐张调用）；
//   3. 非多模态模型下有没有给中文原因，而不是把图片硬发出去。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { ApprovalRequest } from './DshController.js'

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'
// 1x1 的真 PNG（只有 header 的假图会被 mime 嗅探挡掉）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 假模型：带 tools 的请求当作主循环（按标签给 read_image 工具调用），不带的当作 chatWithImages 的子请求 */
function fakeOpenAi(reqs: any[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      reqs.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: any, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      const msgs: any[] = body.messages ?? []
      // 子请求的判定：请求体里带图片。主循环那一轮只带文本，不会误判。
      // （不能靠 tools 判断：pi-ai 路由会把手建调用也带上工具声明）
      const hasImages = JSON.stringify(msgs).includes('image_url')
      if (hasImages) {
        // 子请求：图片识别的「模型回答」
        chunk({ role: 'assistant', content: '图里是一张二维码截图' })
        chunk({}, 'stop')
        res.end('data: [DONE]\n\n')
        return
      }
      let at = -1
      msgs.forEach((x, i) => { if (x.role === 'user' && /\[\[image:/.test(JSON.stringify(x.content))) at = i })
      const m = at < 0 ? null : /\[\[image:([^\]]+)\]\]/.exec(JSON.stringify(msgs[at].content))
      const already = at >= 0 && msgs.slice(at).some((x) => x.role === 'tool')
      if (m && !already) {
        const paths = m[1].split('|').map((s) => s.replace(/\\\\/g, '\\'))
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${reqs.length}`, type: 'function', function: { name: 'read_image', arguments: JSON.stringify({ paths, question: '看图' }) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: '看完了' })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
}

// 每张图在请求体里是 {type:'image_url', image_url:{url:'data:image/...'}}，
// 按 data:image/ 计数才是「几张图」（image_url 这个字会出现两次）
const imageCount = (req: any): number => (JSON.stringify(req.messages ?? []).match(/data:image\//g) ?? []).length

describe.skipIf(!hasZstd)('read_image 真机验收（真实控制器 + 真附件库 + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-e2e-'))
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  let multimodal = true
  let ctrl: import('./DshController.js').DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const lastToolResult = () => String(reqs[reqs.length - 1].messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '')
  const subRequests = () => reqs.filter((r) => !Array.isArray(r.tools) || r.tools.length === 0)

  beforeAll(async () => {
    mkdirSync(join(dir, 'work'), { recursive: true })
    writeFileSync(join(dir, 'a.png'), PNG)
    writeFileSync(join(dir, 'b.png'), PNG)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local',
      decide: () => 'allow',
      grant: () => {},
      audit: () => {},
      isReadOnly: () => true,
      hostMeta: () => ({}),
      requestApproval: async (r: ApprovalRequest) => { approvals.push(r); return { decision: 'allow' as const } },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'k', baseUrl, multimodal }),
      sessionStore: { upsert: (m: SessionMeta) => { store.set(m.id, m) }, remove: (id: string) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      readFile: async () => undefined,
      writeFile: async () => ({ path: '' }),
    } as never)
  }, 60_000)

  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => { reqs.length = 0; approvals.length = 0 })

  it('多张图一次送：两张图出现在**同一次**子请求里，且不弹授权卡', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, `看图 [[image:${join(dir, 'a.png')}|${join(dir, 'b.png')}]]`)
    const subs = subRequests()
    expect(subs.length, `工具结果=${lastToolResult().slice(0, 300)}`).toBeGreaterThanOrEqual(1)
    expect(imageCount(subs[0])).toBe(2)                    // 两张图在同一次请求里
    expect(approvals).toHaveLength(0)                      // 读图不需要授权卡
    expect(lastToolResult()).toContain('二维码')            // 子请求结果回到主循环
  }, 90_000)

  it('模型不支持图片：给中文原因，不把图硬发出去', async () => {
    multimodal = false
    const s = await ctrl.createSession()
    await runTurn(s.id, `看图 [[image:${join(dir, 'a.png')}]]`)
    expect(lastToolResult()).toContain('当前模型不支持图片')
    expect(subRequests()).toHaveLength(0)                  // 没有发任何图片请求
  }, 90_000)
})
