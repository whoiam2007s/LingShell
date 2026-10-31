// 端到端：真实 DshController + 真实 dsh 运行时 + 本地假模型（OpenAI 兼容，回「答:<最后一条用户消息>」），验证
//  - fork：从第 1 条消息之前分叉 = 新的空会话（标题「原标题（分叉）」、工作目录照搬），发改后的内容，请求里没有原会话的内容；
//  - fork：从第 2 条消息之前分叉 = 继承第 1 轮，回放给界面；
//  - regenerate：原地重跑最后一轮——前面的轮不变，请求里第 2 条消息只出现一次；
//  - 重启（新控制器读同一目录）后原会话、分叉会话都能恢复并回放。
// 需要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过，手动跑法见 providers.e2e.test.ts。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { DshController, DshControllerConfig } from './DshController.js'

const textOf = (c: any): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join('') : '')
// 请求里用户说的话（去掉 dsh 注入的 runtime-context 等非用户消息：只认我们发的「问」字开头）
const askedIn = (body: any): string[] => body.messages.filter((m: any) => m.role === 'user').map((m: any) => textOf(m.content)).filter((t: string) => t.startsWith('问'))

function fake(reqs: any[]): Server {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); return res.end() }
      const body = JSON.parse(raw || '{}')
      reqs.push(body)
      const last = askedIn(body).at(-1) ?? ''
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: `答:${last}` })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    })
  })
}

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('对话分叉 / 重新生成端到端', () => {
  const reqs: any[] = []
  const srv = fake(reqs)
  const store = new Map<string, SessionMeta>()
  const events: AgentEvent[] = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fork-'))
  let base = ''
  let ctrl: DshController
  let sid = ''
  let ids: string[] = []   // 原会话两条用户消息的 id

  const make = async () => {
    const cfg: DshControllerConfig = {
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) } as any,
      resolveHostKey: () => 'local', decide: () => ({ kind: 'allow' }), grant: () => {}, audit: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      resolveSettings: () => ({ profileId: 'p', provider: 'openai-compatible', model: 'fake', apiKey: 'sk-a', baseUrl: base }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
    }
    const c = new (await import('./DshController.js')).DshController(cfg)
    c.onEvent((e) => events.push(e))
    return c
  }
  const waitTurn = (s: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e) => {
      if (!('sessionId' in e) || e.sessionId !== s) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
  })
  const runTurn = async (s: string, text: string) => { const w = waitTurn(s); await ctrl.sendTurn(s, text); await w }
  // 某会话收到的消息（user_message / 完成的 agent_message），按顺序
  const msgsOf = (s: string, evs = events) => evs
    .filter((e): e is Extract<AgentEvent, { type: 'agent:itemUpdated' }> => e.type === 'agent:itemUpdated' && e.sessionId === s && (e.kind === 'user_message' || (e.kind === 'agent_message' && e.status === 'completed')))
    .map((e) => `${e.kind === 'user_message' ? 'U' : 'A'}:${e.text}`)

  beforeAll(async () => {
    base = await new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as any).port}/v1`)))
    ctrl = await make()
    const s = await ctrl.createSession({ title: '排查' })
    sid = s.id
    await ctrl.setWorkDir(sid, dir)
    await runTurn(sid, '问一')
    await runTurn(sid, '问二')
    ids = events.filter((e) => e.type === 'agent:itemUpdated' && e.kind === 'user_message' && e.sessionId === sid).map((e: any) => e.itemId)
  }, 60_000)
  afterAll(async () => {
    await ctrl.stopAll()
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('原会话有两轮', () => {
    expect(ids).toHaveLength(2)
    expect(msgsOf(sid)).toEqual(['U:问一', 'A:答:问一', 'U:问二', 'A:答:问二'])
  })

  it('从第 1 条之前分叉：新的空会话，发改后的内容不带原会话内容', async () => {
    events.length = 0
    const r = await ctrl.forkSession(sid, ids[0], 'fork')
    expect(r.text).toBe('问一')
    expect(r.session.id).not.toBe(sid)
    const m = store.get(r.session.id)!
    expect(m.title).toBe('排查（分叉）')
    expect(m.workDir).toBe(dir)
    expect(msgsOf(r.session.id)).toEqual([])
    reqs.length = 0
    await runTurn(r.session.id, '问一改')
    expect(askedIn(reqs[0])).toEqual(['问一改'])
    expect(msgsOf(r.session.id)).toEqual(['U:问一改', 'A:答:问一改'])
  }, 60_000)

  let fork2 = ''
  it('从第 2 条之前分叉：继承第 1 轮并回放', async () => {
    events.length = 0
    const r = await ctrl.forkSession(sid, ids[1], 'fork')
    fork2 = r.session.id
    expect(r.text).toBe('问二')
    expect(msgsOf(fork2)).toEqual(['U:问一', 'A:答:问一'])
    reqs.length = 0
    await runTurn(fork2, '问三')
    expect(askedIn(reqs[0])).toEqual(['问一', '问三'])
  }, 60_000)

  it('重新生成最后一轮：前面不变，最后一条只问一次', async () => {
    events.length = 0
    reqs.length = 0
    const w = waitTurn(sid)
    const r = await ctrl.forkSession(sid, ids[1], 'regenerate')
    await w
    expect(r.session.id).toBe(sid)
    expect(askedIn(reqs[0])).toEqual(['问一', '问二'])
    expect(msgsOf(sid)).toEqual(['U:问一', 'A:答:问一', 'U:问二', 'A:答:问二'])
    expect(store.get(sid)!.dshId).toMatch(new RegExp(`^${sid}_`))
  }, 60_000)

  it('重新生成失败（找不到消息）：会话不变，下次 reconnect 把历史重放回界面', async () => {
    await expect(ctrl.forkSession(sid, 'nope', 'regenerate')).rejects.toThrow(/message_not_found/)
    events.length = 0
    await ctrl.reconnectSession(store.get(sid)!)
    expect(msgsOf(sid)).toEqual(['U:问一', 'A:答:问一', 'U:问二', 'A:答:问二'])
  }, 60_000)

  it('重启后原会话与分叉会话都能恢复', async () => {
    await ctrl.stopAll()
    ctrl = await make()
    events.length = 0
    await ctrl.reconnectSession(store.get(sid)!)
    await ctrl.reconnectSession(store.get(fork2)!)
    expect(msgsOf(sid)).toEqual(['U:问一', 'A:答:问一', 'U:问二', 'A:答:问二'])
    expect(msgsOf(fork2)).toEqual(['U:问一', 'A:答:问一', 'U:问三', 'A:答:问三'])
  }, 60_000)
})
