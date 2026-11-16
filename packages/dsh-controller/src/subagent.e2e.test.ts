// 子代理真机验收：真实 DshController（真 dsh agent、真工具网关、真落盘）+ 假模型。
// 只有「模型」是假的，链路全是真的：
//   主会话 sendTurn → 模型决定调 spawn_subagent → 网关（写档授权）→ 建隐藏子会话
//   → 子会话 sendTurn（子代理系统提示生效）→ 子会话模型返回总结 → 解析成 SubagentResult
//   → 作为工具结果回主会话 → 主会话模型收尾
//
// 用户消息里写标签，假模型据此决定行为：
//   [[spawn]]          主会话：调 spawn_subagent（task = 子任务文本）
//   [[spawn-ask]]      主会话：同上，但子代理会先去调 ask_user（应被网关拒）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { AuditRecord } from './terminalTools.js'

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'
const SUMMARY = '做了什么：跑了 nginx -v\n关键发现：nginx 1.24.0，配置在 /etc/nginx/nginx.conf\n证据：nginx -v → nginx version: nginx/1.24.0\n结论：可以继续\n未尽：无'

/** 假模型：主会话看到标签就派子代理；子会话直接回结构化总结（带 ask 标签时先调一次 ask_user） */
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
      const all = JSON.stringify(msgs)
      const hasTool = msgs.some((x) => x.role === 'tool')

      // 子会话：第一条 user 消息就是任务文本（带 spawn 时下发的内容）
      const subTask = msgs.find((x) => x.role === 'user' && /SUBCHECK|SUBASK/.test(JSON.stringify(x.content)))
      if (subTask) {
        // 子代理想调 ask_user（应被网关拒：子代理不能跟用户交互）
        if (/SUBASK/.test(JSON.stringify(subTask.content)) && !hasTool) {
          chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '要覆盖吗？', options: [{ label: '是' }, { label: '否' }] }) } }] })
          chunk({}, 'tool_calls')
        } else {
          chunk({ role: 'assistant', content: SUMMARY })
          chunk({}, 'stop')
        }
        res.end('data: [DONE]\n\n')
        return
      }

      // 主会话：看到 [[spawn*]] 且还没拿过工具结果 → 派子代理
      const tag = /\[\[(spawn-ask|spawn)\]\]/.exec(all)?.[1]
      if (tag && !hasTool) {
        const task = tag === 'spawn-ask' ? '查一下 nginx 版本（不确定就问）SUBASK' : '查一下 nginx 版本 SUBCHECK'
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${reqs.length}`, type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify({ task, permission: 'read', context_hint: '验收用' }) } }] })
        chunk({}, 'tool_calls')
      } else {
        chunk({ role: 'assistant', content: '好了' })
        chunk({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
}

describe.skipIf(!hasZstd)('子代理真机验收（真实控制器 + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-subagent-e2e-'))
  const store = new Map<string, SessionMeta>()
  const audits: AuditRecord[] = []
  let ctrl: import('./DshController.js').DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  // 主会话最后一条工具结果（spawn_subagent 的返回值）
  const lastToolResult = (): any => {
    const body = reqs[reqs.length - 1]
    const t = body.messages.filter((m: any) => m.role === 'tool').at(-1)
    return JSON.parse(String(t?.content ?? '{}'))
  }

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) },
      resolveHostKey: () => 'local',
      decide: () => ({ kind: 'allow' }),
      grant: () => {},
      audit: (r) => { audits.push(r) },
      isReadOnly: () => true,
      execModeOf: () => 'trust',
      setExecMode: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'k', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
    })
  }, 60_000)
  beforeEach(() => { reqs.length = 0; audits.length = 0 })
  afterAll(async () => { await ctrl.stopAll(); server.close(); rmSync(dir, { recursive: true, force: true }) })

  it('派子代理：结论回到主会话，子会话不进会话列表', async () => {
    const s = await ctrl.createSession()
    const before = store.size
    await runTurn(s.id, '查一下版本 [[spawn]]')

    const r = lastToolResult()
    expect(r.status).toBe('done')
    expect(r.summary).toContain('nginx 1.24.0')
    expect(r.subagentId).toMatch(/^sess_/)

    // 子会话是 hidden：会话列表里没多出来
    expect(store.size).toBe(before)
    // 主会话的下拉列表里有一条已完成的记录
    const list = ctrl.subagentsOf(s.id)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('done')
    expect(list[0].task).toContain('查一下 nginx 版本')
    expect(list[0].summary).toContain('nginx 1.24.0')
  }, 120_000)

  it('子代理想跟用户交互 → 网关直接拒，仍能给出结论', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '查版本并确认 [[spawn-ask]]')

    // 子代理那次 ask_user 被拒，且记进了执行记录
    expect(audits.some((a) => String(a.decision) === 'deny:subagent')).toBe(true)
    // 被拒之后子代理照样收尾：结论回主会话
    const r = lastToolResult()
    expect(r.status).toBe('done')
    expect(r.summary).toContain('结论：可以继续')
  }, 120_000)
})
