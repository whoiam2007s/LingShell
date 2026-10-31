// 端到端：真实 DshController 一轮对话里（假）模型调 propose_runbook / propose_quick_commands。
// 证明：两个工具注册进了 dsh、系统提示里有使用时机说明（没被模板插值吃掉）、带参数占位的入参原样到达工具、
// 不弹授权卡、不记执行记录；入参不合法时错误原因回给模型。
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/proposals.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { DshController, ApprovalRequest } from './DshController.js'
import type { AuditRecord } from './terminalTools.js'

const CALLS: Record<string, { name: string; args: unknown }> = {
  rb: { name: 'propose_runbook', args: { title: '磁盘排查', description: '磁盘告警时用', steps: [{ title: '看占用', command: 'df -h {{mount}}', kind: 'check' }, { title: '大目录', command: 'du -sh {{mount}}/*' }], params: [{ name: 'mount', label: '挂载点', default: '/data' }] } },
  qc: { name: 'propose_quick_commands', args: { set_name: 'nginx 检查', commands: [{ name: '状态', command: 'systemctl status nginx', description: '看运行状态' }, { name: '配置', command: 'nginx -t' }] } },
  bad: { name: 'propose_runbook', args: { title: '空手册', steps: [] } },
}

// 用户消息里写 [[p:<键>]]：首个请求调对应工具；已有工具结果就回文本收尾
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
      const key = /\[\[p:(\w+)\]\]/.exec(user)?.[1]
      if (key && CALLS[key] && !(body.messages ?? []).some((m: any) => m.role === 'tool')) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: CALLS[key].name, arguments: JSON.stringify(CALLS[key].args) } }] })
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

describe.skipIf(!hasZstd)('AI 生成快速命令 / 运维手册端到端（真实 DshController + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proposal-e2e-'))
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  const audits: AuditRecord[] = []
  const events: AgentEvent[] = []
  let ctrl: DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      events.push(e)
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const toolResult = () => String(reqs[reqs.length - 1].messages.find((m: any) => m.role === 'tool')?.content ?? '')
  const toolItems = () => events.filter((e): e is Extract<AgentEvent, { type: 'agent:itemUpdated' }> => e.type === 'agent:itemUpdated' && e.kind === 'tool_call' && e.status === 'completed')

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local',
      decide: () => ({ kind: 'prompt', reason: 'first_access', risk: 'safe' }),
      grant: () => {},
      audit: (r) => { audits.push(r) },
      requestApproval: async (r) => { approvals.push(r); return { decision: 'allow' } },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
    })
  })
  beforeEach(() => { reqs.length = 0; approvals.length = 0; audits.length = 0; events.length = 0 })
  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('propose_runbook：工具已注册、系统提示有使用时机；参数占位原样到达；不弹卡、不记执行记录', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '把刚才这套检查存成手册 [[p:rb]]')
    const tools = (reqs[0].tools ?? []).map((t: any) => t.function?.name)
    expect(tools).toEqual(expect.arrayContaining(['propose_runbook', 'propose_quick_commands']))
    const system = JSON.stringify(reqs[0].messages.filter((m: any) => m.role === 'system'))
    expect(system).toContain('存成快速命令')
    expect(system).toContain('propose_runbook')
    expect(JSON.parse(toolResult())).toMatchObject({ ok: true, title: '磁盘排查', steps: 2, params: ['mount'] })
    // 界面据工具入参（itemStarted 带的 input）出预览卡
    const started = events.find((e) => e.type === 'agent:itemStarted' && e.tool?.name === 'propose_runbook' && e.tool.input) as Extract<AgentEvent, { type: 'agent:itemStarted' }>
    expect((started.tool!.input as any).steps[0].command).toBe('df -h {{mount}}')
    expect(toolItems().some((e) => e.itemId === started.itemId)).toBe(true)   // 工具成功结束（卡片据此显示可保存）
    expect(approvals).toHaveLength(0)
    expect(audits).toHaveLength(0)
  }, 60_000)

  it('propose_quick_commands：返回组名与条数', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '存成快速命令 [[p:qc]]')
    expect(JSON.parse(toolResult())).toMatchObject({ ok: true, set_name: 'nginx 检查', count: 2 })
    expect(approvals).toHaveLength(0)
  }, 60_000)

  it('入参不合法：错误原因回给模型，本轮照常结束', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '存成手册 [[p:bad]]')
    expect(toolResult()).toContain('手册至少要有一个步骤')
  }, 60_000)
})
