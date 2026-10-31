// 端到端：真实 DshController + 假模型（OpenAI 兼容流式），验证安全与流程：
//  - 分层规则：用到某主机后，下一次模型请求的系统提示里带该主机的规则；
//  - 预演模式：写命令被拦（不执行、原因回给模型、记执行记录），只读照常；propose_plan 不弹审批、回预演结果；
//    「执行选中步骤」（approvePlan）后同一命令免卡执行；
//  - AI 复核：拦截 → 不弹卡、不执行、理由回给模型；只提示 → 授权卡带复核结果，执行记录也带。
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/safety.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta, AiReviewResult } from '@lingshell/shared'
import type { DshController, ApprovalRequest, ReviewRequest } from './DshController.js'
import type { AuditRecord } from './terminalTools.js'
import type { PlanRequest } from './plan.js'

// 用户消息里写 [[exec:<终端>:<命令>]] → 首个请求调 exec_in_terminal；[[plan:<终端>:<命令>]] → 调 propose_plan；已有工具结果就回文本收尾
function fakeOpenAi(reqs: any[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      reqs.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      // 最近一条带标签的用户消息之后还没有工具结果 → 这一轮该调工具（dsh 会在末尾再附一条运行时上下文的 user 消息）
      const msgs: any[] = body.messages ?? []
      let at = -1
      msgs.forEach((x, i) => { if (x.role === 'user' && /\[\[(exec|plan):/.test(JSON.stringify(x.content))) at = i })
      const m = at < 0 ? null : /\[\[(exec|plan):(\w+):([^\]]+)\]\]/.exec(JSON.stringify(msgs[at].content))
      if (m && !msgs.slice(at).some((x) => x.role === 'tool')) {
        const [, kind, tid, cmd] = m
        const call = kind === 'exec'
          ? { name: 'exec_in_terminal', arguments: JSON.stringify({ terminal_id: tid, command: cmd, explain: '测试', rollback: 'true', rollback_note: '测试' }) }
          : { name: 'propose_plan', arguments: JSON.stringify({ title: '测试方案', steps: [{ terminal_id: tid, command: cmd, purpose: '目的' }] }) }
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${reqs.length}`, type: 'function', function: call }] })
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

describe.skipIf(!hasZstd)('安全与流程端到端（真实 DshController + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-safety-e2e-'))
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  const plans: PlanRequest[] = []
  const audits: AuditRecord[] = []
  const ran: string[] = []
  const reviews: ReviewRequest[] = []
  let review: { review: AiReviewResult; action: 'deny' | 'allow' | 'ask' } | undefined
  let ctrl: DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const toolResult = () => String(reqs[reqs.length - 1].messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '')
  const systemOf = (r: any) => JSON.stringify(r.messages.filter((m: any) => m.role === 'system'))

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: {
        list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }, { id: 'term_s', title: 'db-1', type: 'ssh', status: 'running', locked: false }],
        readSnapshot: () => '',
        execCapture: async (_tid, cmd) => { ran.push(cmd); return { output: `ran ${cmd}`, exitCode: 0 } },
      },
      resolveHostKey: (tid) => (tid === 'term_s' ? 'h1' : 'local'),
      decide: () => ({ kind: 'prompt', reason: 'elevation', risk: 'safe' }),
      isReadOnly: (c) => /^(ls|cat)\b/.test(c),
      grant: () => {},
      audit: (r) => { audits.push(r) },
      requestApproval: async (r) => { approvals.push(r); return { decision: 'allow' } },
      requestPlan: async (r) => { plans.push(r); return { decision: 'allow' } },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      layeredRules: (keys) => (keys.includes('h1') ? '## 分层规则\n### 分组「db」\n禁止重启 mysqld，变更前先 mysqldump' : ''),
      reviewCommand: async (r) => { reviews.push(r); return review },
    })
  }, 60_000)
  beforeEach(() => { reqs.length = 0; approvals.length = 0; plans.length = 0; audits.length = 0; ran.length = 0; reviews.length = 0; review = undefined })
  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('分层规则：用到主机前没有，用到后下一次请求的系统提示里有', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '看看 [[exec:term_s:ls /etc]]')
    expect(reqs).toHaveLength(2)
    expect(systemOf(reqs[0])).not.toContain('禁止重启 mysqld')
    expect(systemOf(reqs[1])).toContain('禁止重启 mysqld，变更前先 mysqldump')
  }, 60_000)

  it('预演模式：写命令被拦（不执行、原因回模型、记执行记录），只读照常；系统提示有预演段', async () => {
    const s = await ctrl.createSession()
    ctrl.setPreview(s.id, true)
    await runTurn(s.id, '重启 [[exec:term_s:systemctl restart nginx]]')
    expect(ran).toEqual([])
    expect(approvals).toHaveLength(0)
    expect(toolResult()).toContain('预演模式：请把要执行的命令列成计划，不要执行')
    expect(audits).toContainEqual(expect.objectContaining({ terminalId: 'term_s', decision: 'deny:preview_mode', command: 'systemctl restart nginx' }))
    expect(systemOf(reqs[0])).toContain('预演模式（只说不做')
    await runTurn(s.id, '只读 [[exec:term_s:cat /etc/nginx/nginx.conf]]')
    expect(ran).toEqual(['cat /etc/nginx/nginx.conf'])
  }, 60_000)

  it('预演里 propose_plan 不弹审批；执行选中步骤（approvePlan）后同一命令免卡执行，预演关闭', async () => {
    const s = await ctrl.createSession()
    ctrl.setPreview(s.id, true)
    await runTurn(s.id, '出方案 [[plan:term_s:systemctl reload nginx]]')
    expect(plans).toHaveLength(0)
    expect(JSON.parse(toolResult())).toMatchObject({ preview: true, approved: false, steps: [{ terminal_id: 'term_s', command: 'systemctl reload nginx', hostKey: 'h1' }] })
    expect(ctrl.approvePlan(s.id, [{ terminal_id: 'term_s', command: 'systemctl reload nginx' }])).toBe(1)
    expect(ctrl.isPreview(s.id)).toBe(false)
    await runTurn(s.id, '执行 [[exec:term_s:systemctl reload nginx]]')
    expect(approvals).toHaveLength(0)
    expect(ran).toEqual(['systemctl reload nginx'])
    expect(audits).toContainEqual(expect.objectContaining({ decision: 'allow:plan', command: 'systemctl reload nginx' }))
  }, 60_000)

  it('AI 复核拦截：不弹卡、不执行，理由回给模型，执行记录带复核结果', async () => {
    const s = await ctrl.createSession()
    review = { review: { verdict: 'block', reason: '违反分组规则：禁止重启 mysqld', model: '便宜模型' }, action: 'deny' }
    await runTurn(s.id, '重启数据库 [[exec:term_s:systemctl restart mysqld]]')
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ tool: 'exec_in_terminal', hostKeys: ['h1'], command: 'systemctl restart mysqld' })
    expect(reviews[0].context).toContain('用户：重启数据库')
    expect(approvals).toHaveLength(0)
    expect(ran).toEqual([])
    expect(toolResult()).toContain('AI 复核判定拦截')
    expect(toolResult()).toContain('违反分组规则')
    expect(audits).toContainEqual(expect.objectContaining({ decision: expect.stringMatching(/^deny:ai_review:违反分组规则/), review: review.review }))
  }, 60_000)

  it('AI 复核只提示：授权卡带复核结果，用户允许后执行，执行记录也带', async () => {
    const s = await ctrl.createSession()
    review = { review: { verdict: 'risky', reason: '会中断服务几秒' }, action: 'ask' }
    await runTurn(s.id, '重启 [[exec:term_s:systemctl restart nginx]]')
    expect(approvals).toHaveLength(1)
    expect(approvals[0].review).toEqual(review.review)
    expect(ran).toEqual(['systemctl restart nginx'])
    expect(audits).toContainEqual(expect.objectContaining({ decision: 'exec_allowed', review: review.review }))
  }, 60_000)

  it('AI 复核自动放行：不弹卡直接执行，授权记录注明「AI 复核通过」', async () => {
    const s = await ctrl.createSession()
    review = { review: { verdict: 'safe', reason: '只是重载' }, action: 'allow' }
    await runTurn(s.id, '重载 [[exec:term_s:systemctl reload nginx]]')
    expect(approvals).toHaveLength(0)
    expect(ran).toEqual(['systemctl reload nginx'])
    expect(audits).toContainEqual(expect.objectContaining({ decision: 'allow:elevation', rule: 'AI 复核通过', review: review.review }))
  }, 60_000)
})
