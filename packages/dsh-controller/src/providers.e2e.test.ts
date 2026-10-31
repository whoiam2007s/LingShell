// 端到端：真实 DshController + 真实 dsh 运行时，模型换成本地假 OpenAI 兼容服务（node:http，两个端口模拟两家提供商）。
// 证明：请求打到配置的 baseURL、带对的 model 与 Authorization；工具调用真的执行；
// 每套模型配置各走各的路由与 key；会话级切换模型下一回合生效（回合进行中切换不打断本回合）；一次性调用用默认配置。
// jsonl 持久化要 zlib zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑（Electron 的 Node）：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/providers.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
// 动态导入：静态导入时 jsonl 插件在没有 zstd 的 Node 上加载即报错，连 skip 都走不到
import type { DshController } from './DshController.js'

interface Req { port: string; url: string; auth: string; body: any }

// 首个请求回一个 exec_in_terminal 工具调用；对话里已有工具结果就回一句文本收尾。都是 SSE 流。
// gate：用户消息带 SLOW 的首个请求挂住，直到测试放行（模拟回合进行中）
function fakeOpenAi(name: string, reqs: Req[], gate: { wait?: Promise<void> }): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      const xKey = req.headers['x-api-key']
      reqs.push({ port: name, url: req.url ?? '', auth: xKey ? `x-api-key ${xKey}` : String(req.headers.authorization ?? ''), body })
      // DeepSeek 官方适配器（dsh 0.2）走 Anthropic Messages：/v1/messages（同样受 gate 控制）
      if (req.url?.endsWith('/messages')) {
        // 只看最后一条（会话里可能已有带工具结果的旧历史）：是带 SLOW 的用户消息就挂住
        const last = JSON.stringify((body.messages ?? []).at(-1) ?? {})
        if (!last.includes('"tool_result"') && last.includes('SLOW') && gate.wait) await gate.wait
        return anthropic(body, res)
      }
      // 仿 Ollama：不支持工具的模型收到 tools 直接 400
      if (body.model === 'notools') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'registry.ollama.ai/library/notools:latest does not support tools', type: 'api_error' } }))
      }
      const hasToolResult = (body.messages ?? []).some((m: any) => m.role === 'tool')
      if (!hasToolResult && JSON.stringify(body.messages ?? []).includes('SLOW') && gate.wait) await gate.wait
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const chunk = (delta: any, finish: string | null = null) => send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      if (!body.tools?.length) {   // 一次性补全（complete）：不带工具，回一段带围栏的命令
        chunk({ role: 'assistant', content: '```bash\nlsof -i :8080\n```' })
        chunk({}, 'stop')
      } else if (!hasToolResult) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_in_terminal', arguments: '' } }] })
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ terminal_id: 'term_1', command: 'echo hi' }) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: '执行完毕' })
        chunk({}, 'stop')
      }
      send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 } })
      res.end('data: [DONE]\n\n')
    })
  })
}

// Anthropic Messages 版的同一套剧本：首个请求回 exec_in_terminal 工具调用，已有工具结果就回文本收尾
function anthropic(body: any, res: import('node:http').ServerResponse): void {
  const hasToolResult = JSON.stringify((body.messages ?? []).at(-1) ?? {}).includes('"tool_result"')   // 只看本轮最后一条
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`)
  send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 0 } } })
  if (!hasToolResult && body.tools?.length) {
    send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'exec_in_terminal', input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ terminal_id: 'term_1', command: 'echo hi' }) } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '执行完毕' } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
  }
  send('message_stop', {})
  res.end()
}

const hasZstd =typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('多模型配置端到端（两个假服务）', () => {
  const reqs: Req[] = []
  const gate: { wait?: Promise<void> } = {}
  const srvA = fakeOpenAi('A', reqs, gate), srvB = fakeOpenAi('B', reqs, gate)
  let baseA = '', baseB = ''
  type P = { provider: string; model: string; apiKey: string; baseUrl: string; contextWindow?: number; protocol?: 'anthropic' | 'openai' }
  const profiles: Record<string, P> = {}
  let defaultId = 'compat'
  const ran: string[] = []
  const usage: { sessionId: string; source?: string; provider: string; model: string; input: number; output: number }[] = []
  const store = new Map<string, SessionMeta>()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
  let ctrl: DshController
  const makeCtrl = async () => new (await import('./DshController.js')).DshController({
    baseDir: dir,
    terminals: {
      list: () => [{ id: 'term_1', title: '本地', type: 'local', status: 'running', locked: false }],
      readSnapshot: () => '',
      execCapture: async (_id: string, command: string) => { ran.push(command); return { output: 'hi', exitCode: 0 } },
    } as any,
    resolveHostKey: () => 'local',
    decide: () => ({ kind: 'allow' }),
    grant: () => {},
    audit: () => {},
    requestApproval: async () => ({ decision: 'allow' }),
    resolveSettings: (id?: string) => { const pid = id && profiles[id] ? id : defaultId; return { profileId: pid, ...profiles[pid] } },
    sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
    contextLimitTokens: () => 600000,
    recordUsage: (u) => { usage.push(u) },
  })

  const runTurn = (sid: string, text: string, started?: () => void) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnStarted') started?.()
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as any).port}/v1`)))

  beforeAll(async () => {
    baseA = await listen(srvA); baseB = await listen(srvB)
    profiles.compat = { provider: 'openai-compatible', model: 'fake-model', apiKey: 'sk-compat', baseUrl: baseA }
    profiles.ds = { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-deepseek', baseUrl: baseB }
    profiles.qw = { provider: 'qwen', model: 'qwen-max', apiKey: 'sk-qwen', baseUrl: baseB }
    profiles.qw2 = { provider: 'qwen', model: 'qwen-plus', apiKey: 'sk-qwen-2', baseUrl: baseA }
    profiles.local = { provider: 'ollama', model: 'qwen3:8b', apiKey: '', baseUrl: baseA }
    profiles.nokey = { provider: 'moonshot', model: 'kimi-k2-0905-preview', apiKey: '', baseUrl: baseA }
    ctrl = await makeCtrl()
  })
  afterAll(async () => {
    await ctrl.stopAll()
    srvA.close(); srvB.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('一轮带工具调用的对话：请求发到配置的 baseURL，model/key 正确，工具真的执行；新会话钉住当时的默认配置', async () => {
    const s = await ctrl.createSession()
    expect(store.get(s.id)?.modelProfileId).toBe('compat')
    await runTurn(s.id, '跑一下 echo hi')
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toMatchObject({ port: 'A', url: '/v1/chat/completions', auth: 'Bearer sk-compat' })
    expect(reqs[0].body.model).toBe('fake-model')
    expect(reqs[0].body.tools.map((t: any) => t.function.name)).toContain('exec_in_terminal')
    expect(reqs[0].body.max_completion_tokens).toBeUndefined()   // 兼容写法：不发 OpenAI 专有字段
    expect(reqs[0].body.store).toBeUndefined()
    expect(ran).toEqual(['echo hi'])
    expect(reqs[1].body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true)
  }, 60_000)

  it('会话级切换：下一回合改走新配置（DeepSeek，另一端口、另一 key），历史不丢；用量记新模型；其它会话不受影响', async () => {
    const s = ctrl.listSessions()[0].id
    const other = await ctrl.createSession()
    expect(await ctrl.setSessionModel(s, 'ds')).toEqual({ pending: false })
    expect(store.get(s)?.modelProfileId).toBe('ds')
    reqs.length = 0; usage.length = 0
    await runTurn(s, 'again')
    // DeepSeek 走 Anthropic Messages（/v1/messages + x-api-key）
    expect(reqs.every((r) => r.port === 'B' && r.url === '/v1/messages' && r.auth === 'x-api-key sk-deepseek' && r.body.model === 'deepseek-v4-pro')).toBe(true)
    // 历史还在：上一回合的工具结果随请求带上
    expect(JSON.stringify(reqs[0].body.messages)).toContain('跑一下 echo hi')
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((u) => u.provider === 'deepseek' && u.model === 'deepseek-v4-pro')).toBe(true)
    reqs.length = 0
    await runTurn(other.id, 'hi')
    expect(reqs.every((r) => r.port === 'A' && r.auth === 'Bearer sk-compat')).toBe(true)
  }, 60_000)

  it('同一提供商两套配置（不同地址 / key）各走各的', async () => {
    const a = await ctrl.createSession(), b = await ctrl.createSession()
    await ctrl.setSessionModel(a.id, 'qw'); await ctrl.setSessionModel(b.id, 'qw2')
    reqs.length = 0
    await runTurn(a.id, 'hi')
    expect(reqs.every((r) => r.port === 'B' && r.auth === 'Bearer sk-qwen' && r.body.model === 'qwen-max')).toBe(true)
    reqs.length = 0
    await runTurn(b.id, 'hi')
    expect(reqs.every((r) => r.port === 'A' && r.auth === 'Bearer sk-qwen-2' && r.body.model === 'qwen-plus')).toBe(true)
  }, 60_000)

  it('回合进行中切换：本回合不打断、仍用原模型，返回 pending；下一回合才生效', async () => {
    const s = await ctrl.createSession()   // 默认 compat（A）
    let release!: () => void
    gate.wait = new Promise<void>((r) => { release = r })
    reqs.length = 0
    let started!: () => void
    const turnStarted = new Promise<void>((r) => { started = r })
    const turn = runTurn(s.id, 'SLOW 跑一下', started)
    await turnStarted
    while (!reqs.length) await new Promise((r) => setTimeout(r, 20))
    expect(await ctrl.setSessionModel(s.id, 'ds')).toEqual({ pending: true })
    expect(ctrl.sessionModel(s.id)).toEqual({ profileId: 'ds', pending: true })
    release(); gate.wait = undefined
    await turn
    expect(reqs).toHaveLength(2)
    expect(reqs.every((r) => r.port === 'A' && r.body.model === 'fake-model')).toBe(true)   // 本回合两次请求都在原模型
    reqs.length = 0
    await runTurn(s.id, 'next')
    expect(reqs.every((r) => r.port === 'B' && r.body.model === 'deepseek-v4-pro')).toBe(true)
    expect(ctrl.sessionModel(s.id)).toEqual({ profileId: 'ds', pending: false })
  }, 60_000)

  it('DeepSeek 配置切接口协议：回合进行中不变，下一回合改发 /chat/completions（Bearer），历史保留；切回再发 /v1/messages', async () => {
    // 不新建会话（会触发 LRU 释放，打乱下一条用例取的会话）：用已切到 ds 的那个
    const s = ctrl.listSessions()[0]
    await ctrl.setSessionModel(s.id, 'ds')
    let release!: () => void
    gate.wait = new Promise<void>((r) => { release = r })
    reqs.length = 0
    const turn = runTurn(s.id, 'SLOW 跑一下')
    while (!reqs.length) await new Promise((r) => setTimeout(r, 20))
    profiles.ds = { ...profiles.ds, protocol: 'openai' }   // 用户在设置里改协议并保存（resolveSettings 现读）
    release(); gate.wait = undefined
    await turn
    expect(reqs).toHaveLength(2)
    expect(reqs.every((r) => r.url === '/v1/messages' && r.auth === 'x-api-key sk-deepseek')).toBe(true)
    reqs.length = 0
    await runTurn(s.id, 'next')
    expect(reqs.length).toBeGreaterThan(0)
    expect(reqs.every((r) => r.port === 'B' && r.url === '/v1/chat/completions' && r.auth === 'Bearer sk-deepseek' && r.body.model === 'deepseek-v4-pro')).toBe(true)
    const msgs = reqs[0].body.messages as any[]
    expect(JSON.stringify(msgs)).toContain('SLOW 跑一下')   // 历史（含 Messages 协议下的工具调用）照常带上
    expect(msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true)
    // DeepSeek 兼容写法：回放的助手消息带 reasoning_content；默认开思考、强度 high（同官方适配器）
    expect(msgs.filter((m) => m.role === 'assistant').every((m) => m.reasoning_content !== undefined)).toBe(true)
    expect(reqs[0].body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    profiles.ds = { ...profiles.ds, protocol: 'anthropic' }
    reqs.length = 0
    await runTurn(s.id, 'back')
    expect(reqs.every((r) => r.url === '/v1/messages' && r.auth === 'x-api-key sk-deepseek')).toBe(true)
    const { protocol: _p, ...rest } = profiles.ds
    profiles.ds = rest
  }, 60_000)

  it('重连（释放后从磁盘恢复）沿用会话所选配置', async () => {
    const s = ctrl.listSessions()[0].id   // 已切到 ds
    await ctrl.closeSession(s)
    await ctrl.reconnectSession(store.get(s)!)
    reqs.length = 0
    await runTurn(s, 'after resume')
    expect(reqs.every((r) => r.port === 'B' && r.body.model === 'deepseek-v4-pro')).toBe(true)
  }, 60_000)

  it('切到没填 Key 的配置：拒绝且不改会话', async () => {
    const s = await ctrl.createSession()
    await expect(ctrl.setSessionModel(s.id, 'nokey')).rejects.toThrow(/api_key_not_configured/)
    expect(store.get(s.id)?.modelProfileId).toBe('compat')
  }, 60_000)

  it('无需 key 的本地端点用占位 key', async () => {
    const s = await ctrl.createSession()
    await ctrl.setSessionModel(s.id, 'local')
    reqs.length = 0
    await runTurn(s.id, 'hi')
    expect(reqs[0].body.model).toBe('qwen3:8b')
    expect(reqs[0].auth).toBe('Bearer no-key')
  }, 60_000)

  it('一次性补全：走默认配置的路由与 key，不带工具、不建会话；system 进系统消息', async () => {
    defaultId = 'qw'
    const before = ctrl.listSessions().length
    reqs.length = 0
    usage.length = 0
    expect(await ctrl.complete('只输出一条命令', '查 8080 端口', undefined, 'nl-command')).toBe('```bash\nlsof -i :8080\n```')
    // 用量记一条：不属于会话、带来源标签，tokens 取自 usage 块
    expect(usage).toEqual([expect.objectContaining({ sessionId: '', source: 'nl-command', model: 'qwen-max', input: 1200, output: 8 })])
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({ port: 'B', auth: 'Bearer sk-qwen' })
    expect(reqs[0].body.model).toBe('qwen-max')
    expect(reqs[0].body.tools ?? []).toEqual([])
    expect(JSON.stringify(reqs[0].body.messages)).toContain('只输出一条命令')
    expect(ctrl.listSessions()).toHaveLength(before)
    defaultId = 'compat'
  }, 60_000)

  it('一次性补全报错（端点 4xx）→ 抛出', async () => {
    profiles.local = { ...profiles.local, model: 'notools' }
    defaultId = 'local'
    await expect(ctrl.complete('s', 'u')).rejects.toThrow()
    defaultId = 'compat'
  }, 60_000)

  it('Ollama 模型不支持工具：turn 失败，错误里带明确提示', async () => {
    const s = await ctrl.createSession()
    await ctrl.setSessionModel(s.id, 'local')   // 上一条已把 local 的模型改成 notools：下一回合现读
    await expect(runTurn(s.id, 'hi')).rejects.toThrow(/不支持工具调用/)
  }, 60_000)
})
