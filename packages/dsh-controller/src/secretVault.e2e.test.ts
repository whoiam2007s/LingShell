// 端到端：真实 DshController 一轮对话里（假）模型调 exec_in_terminal 执行 echo {{secret:demo}}。
// 证明：系统提示里有密钥段（占位符没被模板插值吃掉、没有值）；终端收到的是明文；模型收到的工具结果、
// 授权卡、执行记录里只有占位符；范围不符时不执行、原因回给模型；用户消息里贴的明文进模型前换回占位符。
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/secretVault.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSecretRefs, expandSecrets, maskToolText, buildSecretsPrompt, type AgentEvent, type SecretSummary, type SessionMeta } from '@lingshell/shared'
import type { DshController, ApprovalRequest } from './DshController.js'
import type { AuditRecord } from './terminalTools.js'
import type { SecretVault } from './secretVault.js'

const V = 'S3cr3t-xyz-123'
const sums: SecretSummary[] = [{ id: 's1', name: 'demo', description: '演示密钥', scope: 'local', targets: [], hasValue: true, createdAt: '', updatedAt: '' }]
const hostOf: Record<string, string> = { term_l: 'local', term_s: 'h1' }
const vault: SecretVault = {
  check: (tid, cmd) => (hostOf[tid] ? checkSecretRefs(cmd, sums, hostOf[tid], undefined, tid) : undefined),
  expand: (tid, cmd) => { const e = vault.check(tid, cmd); if (e) throw new Error(e); return expandSecrets(cmd, () => V) },
  mask: (s) => maskToolText(s, [{ name: 'demo', value: V }]),
  prompt: () => buildSecretsPrompt(sums),
}

// 用户消息里写 [[t:<终端>]]：首个请求调 exec_in_terminal 到那个终端；已有工具结果就回文本收尾
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
      const tid = /\[\[t:(\w+)\]\]/.exec(user)?.[1]
      if (tid && !(body.messages ?? []).some((m: any) => m.role === 'tool')) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_in_terminal', arguments: JSON.stringify({ terminal_id: tid, command: 'echo {{secret:demo}}', explain: '打印密钥' }) } }] })
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

describe.skipIf(!hasZstd)('密钥保险箱端到端（真实 DshController + 假模型）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-e2e-'))
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  const audits: AuditRecord[] = []
  const sent: { tid: string; shown: string; wire?: string }[] = []
  let ctrl: DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const toolResult = () => String(reqs[reqs.length - 1].messages.find((m: any) => m.role === 'tool')?.content ?? '')

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: {
        list: () => [{ id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false }, { id: 'term_s', title: 'web1', type: 'ssh', status: 'running', locked: false }],
        readSnapshot: () => '',
        // 假终端：按 wire 执行（echo 出明文），记下回显 / 实际发送的内容
        execCapture: async (tid, cmd, _s, _t, o) => {
          sent.push({ tid, shown: cmd, wire: o?.wire })
          const m = /^echo '(.*)'$/.exec(o?.wire ?? cmd)
          return { output: m ? m[1] : cmd, exitCode: 0 }
        },
      },
      resolveHostKey: (tid) => hostOf[tid] ?? 'local',
      decide: () => ({ kind: 'prompt', reason: 'first_access', risk: 'safe' }),
      grant: () => {},
      audit: (r) => { audits.push(r) },
      requestApproval: async (r) => { approvals.push(r); return { decision: 'allow' } },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      secretVault: vault,
    })
  })
  beforeEach(() => { reqs.length = 0; approvals.length = 0; audits.length = 0; sent.length = 0 })
  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('范围内：终端收到明文，模型 / 授权卡 / 执行记录只见占位符；系统提示有密钥段', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '打印一下 [[t:term_l]]')
    expect(sent).toEqual([{ tid: 'term_l', shown: 'echo {{secret:demo}}', wire: `echo '${V}'` }])
    expect(JSON.parse(toolResult()).output).toBe('{{secret:demo}}')
    const all = JSON.stringify(reqs)
    expect(all).not.toContain(V)
    const system = JSON.stringify(reqs[0].messages.filter((m: any) => m.role === 'system'))
    expect(system).toContain('{{secret:demo}}：演示密钥（可用范围：仅本地终端）')
    expect(approvals).toHaveLength(1)
    expect(approvals[0].command).toBe('echo {{secret:demo}}')
    expect(JSON.stringify(approvals) + JSON.stringify(audits)).not.toContain(V)
    expect(audits.some((a) => a.decision === 'exec_allowed' && a.command === 'echo {{secret:demo}}')).toBe(true)
  }, 60_000)

  it('范围不符：不弹卡、不执行，原因回给模型，记一条拒绝', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '在 web1 上打印 [[t:term_s]]')
    expect(sent).toHaveLength(0)
    expect(approvals).toHaveLength(0)
    expect(toolResult()).toMatch(/secret_scope.*仅本地终端/)
    expect(audits.map((a) => a.decision)).toEqual([expect.stringMatching(/^deny:secret_scope/)])
  }, 60_000)

  it('用户消息里贴了明文：进模型前换回占位符', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, `终端里看到 ${V}，这是什么？`)
    expect(JSON.stringify(reqs)).not.toContain(V)
    expect(JSON.stringify(reqs[0].messages)).toContain('终端里看到 {{secret:demo}}')
  }, 60_000)
})
