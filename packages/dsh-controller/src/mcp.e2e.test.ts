// 端到端：真起 stdio MCP 服务 → McpManager 注册成 dsh 工具 → 真实 DshController 一轮对话里由（假）模型调用。
// 证明：工具带命名空间出现在模型请求里；默认弹授权卡（服务/工具/参数/说明）；允许后真的调到服务、explain 不外发；
// 拒绝带原因能回给模型；只读档与免确认；每次调用落审计。
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/mcp.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, ApprovalAnswer, SessionMeta, TrustLevel } from '@lingshell/shared'
import type { DshController, ApprovalRequest } from './DshController.js'
import type { AuditRecord } from './terminalTools.js'
import { McpManager } from './mcp.js'

const FIXTURE = fileURLToPath(new URL('./__fixtures__/mcp-server.mjs', import.meta.url))
const TOOL = 'mcp__fix__echo'
// 用 Electron 的 Node 跑时 execPath 是 electron.exe，子进程不带这个变量会起成 GUI 应用（stdio 子进程只继承安全默认环境变量）
const CHILD_ENV = { ELECTRON_RUN_AS_NODE: '1' }

// 首个请求回一个 MCP 工具调用；已有工具结果就回文本收尾
function fakeOpenAi(reqs: any[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      reqs.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (!(body.messages ?? []).some((m: any) => m.role === 'tool')) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: TOOL, arguments: JSON.stringify({ text: 'hi', explain: '回显一下' }) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: '好了' })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
}

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('MCP 工具端到端（真 stdio MCP 服务 + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-e2e-'))
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  const audits: AuditRecord[] = []
  let answer: ApprovalAnswer = { decision: 'allow' }
  let trust: TrustLevel = 'autonomous'
  const mcp = new McpManager()
  let ctrl: DshController

  const runTurn = (sid: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, '调一下 echo').catch(reject)
  })
  // 第二个模型请求里的工具结果 = 模型看到的内容
  const toolResult = () => String(reqs[reqs.length - 1].messages.find((m: any) => m.role === 'tool')?.content ?? '')

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    await mcp.apply([{ id: 's1', name: 'fix', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE], env: CHILD_ENV }])
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local',
      decide: () => ({ kind: 'allow' }),
      grant: () => {},
      audit: (r) => { audits.push(r) },
      requestApproval: async (r) => { approvals.push(r); return answer },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      mcp,
      trustOf: () => trust,
      isUnattended: () => false,
    })
  })
  beforeEach(() => { reqs.length = 0; approvals.length = 0; audits.length = 0; answer = { decision: 'allow' }; trust = 'autonomous' })
  afterAll(async () => {
    await ctrl.stopAll()
    await mcp.close()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认弹授权卡；允许后真的调到 MCP 服务（explain 不外发），结果回给模型并落审计', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id)
    const tool = reqs[0].tools.find((t: any) => t.function.name === TOOL)
    expect(tool.function.description).toBe('[MCP · fix] 回显参数')
    expect(tool.function.parameters.properties).toHaveProperty('explain')
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ tool: TOOL, terminalId: 'mcp:fix', explain: '回显一下', mcp: { server: 'fix', tool: 'echo', args: '{\n  "text": "hi"\n}' } })
    expect(toolResult()).toBe('echo:{"text":"hi"}')
    expect(audits).toEqual([expect.objectContaining({ decision: 'mcp_call', exitCode: 0, mcpServer: 'fix', mcpTool: 'echo', command: 'echo {"text":"hi"}' })])
  }, 60_000)

  it('拒绝并写原因：原因作为工具错误回给模型，审计记 deny:user:<原因>', async () => {
    answer = { decision: 'deny', note: '别动生产库' }
    const s = await ctrl.createSession()
    await runTurn(s.id)
    expect(toolResult()).toContain('别动生产库')
    expect(audits.map((a) => a.decision)).toEqual(['deny:user:别动生产库'])
  }, 60_000)

  it('只读信任档：不弹卡直接拒；标了免确认则不弹卡直接执行', async () => {
    trust = 'readonly'
    const s = await ctrl.createSession()
    await runTurn(s.id)
    expect(approvals).toHaveLength(0)
    expect(toolResult()).toContain('只读')
    expect(audits[0].decision).toMatch(/^deny:mcp: 只读/)

    reqs.length = 0; audits.length = 0
    await mcp.apply([{ id: 's1', name: 'fix', enabled: true, transport: 'stdio', command: process.execPath, args: [FIXTURE], env: CHILD_ENV, autoApprove: ['echo'] }])
    await runTurn((await ctrl.createSession()).id)   // 新会话：假模型见到历史里有工具结果就不再调用
    expect(approvals).toHaveLength(0)
    expect(toolResult()).toBe('echo:{"text":"hi"}')
    expect(audits[0].decision).toBe('mcp_call')
  }, 60_000)
})
