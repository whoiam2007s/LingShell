// 端到端：真实 DshController + 假模型。
//  - ask_user：模型调提问卡 → requestAsk 拿到问题 / 选项 → 用户的选择作为工具结果回到模型；没回答 / 停止本轮按「未回答」返回；系统提示里有用法。
//  - @ 引用 / 终端块：sendTurn 带 context 附件 → 模型收到的用户消息末尾有 <context> 块（密钥保险箱明文同样换回占位符）。
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/askUser.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AskAnswer, AskRequest, SessionMeta } from '@lingshell/shared'
import type { DshController } from './DshController.js'

const ASK_ARGS = { question: '要重启 nginx 还是 reload？', options: [{ label: 'reload', description: '不中断连接' }, { label: '重启', description: '会断开现有连接' }, { label: 'reload' }], allow_other: true }

// 用户消息含 [[ask]]：首个请求调 ask_user；已有工具结果就回文本收尾
function fakeOpenAi(reqs: any[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      reqs.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      const user = JSON.stringify(body.messages.filter((m: any) => m.role === 'user'))
      if (user.includes('[[ask]]') && !(body.messages ?? []).some((m: any) => m.role === 'tool')) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(ASK_ARGS) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: '好的' })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
}

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('ask_user / 上下文标签 端到端（真实 DshController + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ask-e2e-'))
  const store = new Map<string, SessionMeta>()
  const asks: AskRequest[] = []
  let answer: (req: AskRequest, signal?: AbortSignal) => Promise<AskAnswer | null> = async () => null
  let ctrl: DshController

  const runTurn = (sid: string, text: string, atts?: any[]) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text, atts).catch(reject)
  })
  const toolResult = () => String(reqs[reqs.length - 1].messages.find((m: any) => m.role === 'tool')?.content ?? '')

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local',
      decide: () => ({ kind: 'allow' }),
      grant: () => {},
      audit: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      requestAsk: (r, s) => { asks.push(r); return answer(r, s) },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      secretVault: { check: () => undefined, expand: (_t, c) => c, mask: (s) => s.replaceAll('S3cr3t-xyz', '{{secret:demo}}'), prompt: () => '' },
    })
  })
  beforeEach(() => { reqs.length = 0; asks.length = 0 })
  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('选了选项：选择作为工具结果回到模型；问题 / 选项（去重后）交给 requestAsk；系统提示里有提问卡用法', async () => {
    answer = async () => ({ selected: ['reload'], other: '先看看连接数' })
    const s = await ctrl.createSession()
    await runTurn(s.id, '帮我处理下 nginx [[ask]]')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ sessionId: s.id, question: '要重启 nginx 还是 reload？', multiSelect: false, allowOther: true })
    expect(asks[0].options).toEqual([{ label: 'reload', description: '不中断连接' }, { label: '重启', description: '会断开现有连接' }])
    expect(JSON.parse(toolResult())).toEqual({ answered: true, selected: ['reload'], other: '先看看连接数' })
    const system = JSON.stringify(reqs[0].messages.filter((m: any) => m.role === 'system'))
    expect(system).toContain('ask_user')
    expect(reqs[0].tools.map((t: any) => t.function?.name)).toContain('ask_user')
  }, 60_000)

  it('没回答（超时 / 跳过）：按未回答返回，不报错', async () => {
    answer = async () => null
    const s = await ctrl.createSession()
    await runTurn(s.id, '[[ask]]')
    expect(JSON.parse(toolResult()).answered).toBe(false)
  }, 60_000)

  it('停止本轮：等待中的提问卡收到 abort，本轮结束', async () => {
    let aborted = false
    answer = (_r, signal) => new Promise((resolve) => { signal?.addEventListener('abort', () => { aborted = true; resolve(null) }) })
    const s = await ctrl.createSession()
    const ended = new Promise<void>((resolve) => { const off = ctrl.onEvent((e) => { if ((e.type === 'agent:turnFailed' || e.type === 'agent:turnCompleted') && e.sessionId === s.id) { off(); resolve() } }) })
    void ctrl.sendTurn(s.id, '[[ask]]')
    for (let i = 0; i < 100 && !asks.length; i++) await new Promise((r) => setTimeout(r, 50))
    expect(asks).toHaveLength(1)
    await ctrl.interruptTurn(s.id)
    await ended
    expect(aborted).toBe(true)
  }, 60_000)

  it('上下文标签：用户消息末尾带 <context> 块，明文换回占位符', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '这个输出什么意思', [
      { kind: 'context', ctx: 'terminal', name: '本地 1', text: '用户指定在终端「本地 1」（terminal_id: term_x）上操作。' },
      { kind: 'context', ctx: 'shell', name: 'env', text: '$ env\nPASS=S3cr3t-xyz' },
    ])
    const user = JSON.stringify(reqs[0].messages.filter((m: any) => m.role === 'user'))
    expect(user).toContain('这个输出什么意思\\n\\n<context type=\\"terminal\\" name=\\"本地 1\\">')
    expect(user).toContain('terminal_id: term_x')
    expect(user).toContain('PASS={{secret:demo}}')
    expect(user).not.toContain('S3cr3t-xyz')
  }, 60_000)
})
