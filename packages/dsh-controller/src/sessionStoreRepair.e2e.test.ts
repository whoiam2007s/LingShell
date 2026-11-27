// 端到端：真实 DshController + 真实 jsonl 持久化。会话存档根目录里先埋一个 dsh 拒绝的扁平目录
// （`sess_dead/live.jsonl`，0.1.20 子代理踩过的坑），断言：
//   1) 开机自愈把它挪进隔离区，不再让 listSessionDirs 抛 "unsupported flat-file layout"；
//   2) 新建会话能正常跑一轮；
//   3) 关掉再重新打开（resume，就是事故里每次启动都会失败的那条路径）历史能读回。
// 模型是本地假 OpenAI 兼容服务，不碰真实 Key。
// jsonl 持久化要 zstd：Node 22.15+ / Electron 的 Node 都自带。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import * as zlib from 'node:zlib'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { DshController } from './DshController.js'

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('会话存档根目录里已有扁平目录时仍能启动 / 新建 / 恢复', () => {
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '新回答' }, finish_reason: null }] })
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })
      res.end('data: [DONE]\n\n')
    })
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-root-heal-e2e-'))
  const root = join(dir, 'dsh-sessions')
  const store = new Map<string, SessionMeta>()
  const events: AgentEvent[] = []
  const logs: string[] = []
  let ctrl: DshController

  const textsOf = (sid: string) => events.filter((e: any) => e.sessionId === sid).map((e: any) => e.text ?? '').join('\n')
  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })

  beforeAll(async () => {
    // 埋雷：形状和这次线上事故完全一样
    mkdirSync(join(root, 'sess_dead'), { recursive: true })
    writeFileSync(join(root, 'sess_dead', 'live.jsonl'), '{"at":"2026-11-25T15:34:35.719Z","type":"task"}\n')
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const base = `http://127.0.0.1:${(srv.address() as any).port}/v1`
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) } as any,
      resolveHostKey: () => 'local', decide: () => ({ kind: 'allow' }), grant: () => {}, audit: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      resolveSettings: () => ({ profileId: 'c', provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: base }),
      sessionStore: { upsert: (m: SessionMeta) => { store.set(m.id, m) }, remove: () => {}, list: () => [...store.values()], touch: () => {} },
      contextLimitTokens: () => 600000,
      log: (_l: string, m: string, d?: unknown) => logs.push(`${m} ${JSON.stringify(d ?? '')}`),
    } as any)
    ctrl.onEvent((e) => events.push(e))
  })
  afterAll(async () => { await ctrl.stopAll(); srv.close(); rmSync(dir, { recursive: true, force: true }) })

  it('开机把扁平目录挪进隔离区，新建会话能跑、重新打开历史能读回', async () => {
    const s = await ctrl.createSession()
    await runTurn(s.id, '第一句话')
    expect(textsOf(s.id)).toContain('新回答')

    // 事故里每次都失败的那条路径：关掉再打开
    events.length = 0
    await ctrl.closeSession(s.id)
    await ctrl.reconnectSession(store.get(s.id)!)
    expect(textsOf(s.id)).toContain('第一句话')
    expect(logs.filter((l) => l.includes('flat-file'))).toEqual([])

    // 隔离区里留着搬走的东西；根目录下不再有 sess_dead
    expect(existsSync(join(root, 'sess_dead'))).toBe(false)
    const repaired = join(dir, 'repaired', 'session-artifacts')
    const runs = readdirSync(repaired)
    expect(runs.length).toBe(1)
    expect(existsSync(join(repaired, runs[0], 'sess_dead', 'live.jsonl'))).toBe(true)
    expect(logs.some((l) => l.startsWith('flat session artifacts quarantined'))).toBe(true)
  }, 90_000)
})
