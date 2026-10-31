// 端到端：dsh 0.1.1 真实旧日志 → 0.2 resume。真实 DshController + 真实 jsonl 持久化（含官方 v0→v4 迁移链），模型是本地假 OpenAI 兼容服务。
// 夹具 __fixtures__/legacy-v0/session.jsonl.zstd 是用 dsh 0.1.1-rc.2 真跑出来的（回合 1 完成；回合 2 流式中途
// agent.cancel('user')——旧版 LingShell「停止」的同一调用，写下 reason:"user"；回合 3 完成），一个字节没改。
// 其它形态（cause 缺失 / Error 序列化 / 修不了）由它逐行改出来。
// jsonl 持久化要 zstd（Electron 的 Node），手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/legacyRepair.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import * as zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { DshController } from './DshController.js'
import { readLogLines, writeLogLines } from './legacyRepair.js'

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'
const FIXTURE = join(__dirname, '__fixtures__', 'legacy-v0', 'session.jsonl.zstd')
// 夹具 header 的 cwd 决定项目目录名（dsh 的 projectKey），照搬即可
const PROJECT = '--C-Users-cjzong-AppData-Local-Temp-legacy-gen-out-user--'
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

describe.skipIf(!hasZstd || process.platform !== 'win32')('0.1.1 旧日志迁移修复', () => {
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '新回答' }, finish_reason: null }] })
      // 含 SLOW：慢慢吐字，给「停止」留时间
      if (JSON.stringify(body.messages ?? []).includes('SLOW')) {
        for (let i = 0; i < 40 && !res.destroyed; i++) { await new Promise((r) => setTimeout(r, 100)); send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: '…' }, finish_reason: null }] }) }
      }
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      send({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })
      res.end('data: [DONE]\n\n')
    })
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-e2e-'))
  const root = join(dir, 'dsh-sessions', PROJECT)
  const store = new Map<string, SessionMeta>()
  const events: AgentEvent[] = []
  const logs: string[] = []
  let ctrl: DshController

  // 放一份旧日志：id 为会话 id；mutate 改行（不传 = 原样复制真实夹具字节）
  const place = async (id: string, mutate?: (line: string) => string): Promise<string> => {
    const p = join(root, id, 'session.jsonl.zstd')
    mkdirSync(dirname(p), { recursive: true })
    if (!mutate) writeFileSync(p, readFileSync(FIXTURE))
    else {
      const lines = (await readLogLines(FIXTURE)).map((l, i) => (i === 0 ? JSON.stringify({ ...JSON.parse(l), id }) : mutate(l)))
      await writeLogLines(p, lines)
    }
    const at = new Date().toISOString()
    store.set(id, { id, title: id, threadId: id, createdAt: at, lastActiveAt: at, workDir: dir })
    return p
  }
  const textsOf = (sid: string) => events.filter((e: any) => e.sessionId === sid).map((e: any) => e.text ?? '').join('\n')
  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const reopen = async (sid: string) => { await ctrl.closeSession(sid); return ctrl.reconnectSession(store.get(sid)!) }

  beforeAll(async () => {
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

  const expectFullHistory = (sid: string) => {
    const t = textsOf(sid)
    for (const s of ['第一个问题', '回答0', 'SLOW 第二个问题', '正在慢慢', '第三个问题']) expect(t).toContain(s)
    expect(events.some((e) => e.type === 'agent:historyUnrecoverable' && e.sessionId === sid)).toBe(false)
  }

  it('cause 是字符串（真实夹具，用户 sess_38ebd1b5 的情况）→ 修复副本 resume，历史完整回放，原文件字节不变', async () => {
    const sid = 'sess_legacy01'
    const orig = await place(sid)
    const before = sha(orig)
    await ctrl.reconnectSession(store.get(sid)!)
    // 确认真是迁移器拒绝后修好的，而不是本来就能读
    expect(logs.some((l) => l.startsWith('resume failed') && l.includes('abort cause must be a JSON object'))).toBe(true)
    expect(logs.some((l) => l.startsWith('legacy session log repaired'))).toBe(true)
    expectFullHistory(sid)
    const dshId = store.get(sid)!.dshId!
    expect(dshId).toMatch(/^sess_legacy01_[0-9a-f]{8}$/)
    expect(existsSync(join(root, dshId, 'session.v4.jsonl.zstd'))).toBe(true)
    expect(sha(orig)).toBe(before)
    // 修好的会话可以继续聊；中断走 0.2 的 cancel 形状，再打开仍能读回
    await runTurn(sid, '继续聊')
    const dirs = readdirSync(root).length
    events.length = 0
    await reopen(sid)
    expect(textsOf(sid)).toContain('继续聊')
    expect(store.get(sid)!.dshId).toBe(dshId)          // 第二次直接用修好的，不再修 / 新建
    expect(readdirSync(root).length).toBe(dirs)
    expect(sha(orig)).toBe(before)
  }, 60_000)

  it('0.2 下点「停止」写下的日志能原样读回（cancel 传对象 cause，不再产生坏日志）', async () => {
    const s = await ctrl.createSession()
    const ended = new Promise<void>((resolve) => {
      const off = ctrl.onEvent((e) => { if ('sessionId' in e && e.sessionId === s.id && (e.type === 'agent:turnCompleted' || e.type === 'agent:turnFailed')) { off(); resolve() } })
    })
    await ctrl.sendTurn(s.id, 'SLOW 慢慢说')
    await new Promise((r) => setTimeout(r, 500))
    await ctrl.interruptTurn(s.id)
    await ended
    logs.length = 0
    events.length = 0
    await reopen(s.id)
    expect(logs.filter((l) => l.startsWith('resume failed'))).toEqual([])
    expect(textsOf(s.id)).toContain('SLOW 慢慢说')
    expect(store.get(s.id)!.dshId).toBeUndefined()
  }, 60_000)

  it('cause 缺失 → 迁移器原生支持，直接 resume', async () => {
    const sid = 'sess_legacy_nocause'
    await place(sid, (l) => l.replace('{"kind":"aborted","reason":"user"}', '{"kind":"aborted"}'))
    await ctrl.reconnectSession(store.get(sid)!)
    expectFullHistory(sid)
    expect(store.get(sid)!.dshId).toBeUndefined()
  }, 60_000)

  it('cause 是 Error 序列化（{} / {name,message}）→ 修复为 legacy', async () => {
    for (const [sid, cause] of [['sess_legacy_err0', '{}'], ['sess_legacy_err1', '{"name":"Error","message":"stopped"}']]) {
      await place(sid, (l) => l.replace('{"kind":"aborted","reason":"user"}', `{"kind":"aborted","reason":${cause}}`))
      await ctrl.reconnectSession(store.get(sid)!)
      expectFullHistory(sid)
      expect(store.get(sid)!.dshId).toMatch(new RegExp(`^${sid}_`))
    }
  }, 60_000)

  it('修不了（含迁移器拒绝的旧事件 mode/set）→ 新 dshId 开空会话 + 系统提示，不抛 SessionAlreadyExists，可继续聊、可切别的会话', async () => {
    const sid = 'sess_legacy_bad'
    // seq 2 换成已停用的 mode/set（迁移器明确拒绝）；turn/end 的 "user" 仍在 → 会先试修复、修完仍失败、副本被清掉
    const orig = await place(sid, (l) => (l.includes('"seq":2,') ? l.replace(/"type":"agent\/inbox\/spliced"/, '"type":"mode/set"') : l))
    const before = sha(orig)
    events.length = 0
    await ctrl.reconnectSession(store.get(sid)!)
    const n = events.find((e) => e.type === 'agent:historyUnrecoverable' && e.sessionId === sid) as any
    expect(n).toBeTruthy()
    expect(n.reason).toContain('mode/set')
    expect(n.path).toBe(orig)
    expect(logs.some((l) => l.startsWith('repaired log still not resumable'))).toBe(true)
    const dshId = store.get(sid)!.dshId!
    expect(dshId).toMatch(/^sess_legacy_bad_[0-9a-f]{8}$/)
    expect(readdirSync(root).filter((d) => d.startsWith(`${sid}_`))).toEqual([])   // 修复副本已删；新空会话首次写入前不落盘
    await runTurn(sid, '新会话里说话')
    expect(textsOf(sid)).toContain('新回答')
    await reopen(sid)                                   // 再开：用新 id resume，不会 SessionAlreadyExists
    expect(store.get(sid)!.dshId).toBe(dshId)
    await ctrl.reconnectSession(store.get('sess_legacy01')!)   // 切到别的会话照常
    expect(sha(orig)).toBe(before)
  }, 60_000)
})
