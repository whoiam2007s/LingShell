// 端到端：真实 DshController + 真实 dsh 运行时 + 本地 Skill 库，模型是本地假 OpenAI 兼容服务。
// 证明：skill 目录进了请求（catalog）；用户 `/名字` 显式调用把 skill 正文注入本轮请求；
// 模型调 skill 工具拿到 <skill_content>；停用 / 关掉「AI 可自动调用」后立即生效（无需重启）。
// jsonl 持久化要 zstd（Electron 的 Node），手动跑：
//   ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/electron.exe node_modules/vitest/vitest.mjs run packages/dsh-controller/src/skills.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import type { DshController } from './DshController.js'
import { LocalSkills } from './skills.js'

const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

describe.skipIf(!hasZstd)('Skills 端到端', () => {
  const bodies: any[] = []
  // 用户消息带 CALL-SKILL 时首步回一个 skill 工具调用；其余回文本
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      bodies.push(body)
      const all = JSON.stringify(body.messages ?? [])
      const hasToolResult = (body.messages ?? []).some((m: any) => m.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      const chunk = (delta: any, finish: string | null = null) => send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      if (all.includes('CALL-SKILL') && !hasToolResult) {
        chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name: 'disk-check' }) } }] })
        chunk({}, 'tool_calls')
      } else { chunk({ role: 'assistant', content: 'ok' }); chunk({}, 'stop') }
      send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } })
      res.end('data: [DONE]\n\n')
    })
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-e2e-'))
  const skillsDir = join(dir, 'skills')
  const store = new Map<string, SessionMeta>()
  const events: AgentEvent[] = []
  let ctrl: DshController, lib: LocalSkills, base = ''

  beforeAll(async () => {
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(srv.address() as any).port}/v1`
    mkdirSync(join(skillsDir, 'disk-check', 'scripts'), { recursive: true })
    writeFileSync(join(skillsDir, 'disk-check', 'SKILL.md'), '---\nname: disk-check\ndescription: 排查磁盘占用\n---\n\n先跑 df -h，再 du 找大目录。SECRET-BODY-MARK')
    writeFileSync(join(skillsDir, 'disk-check', 'scripts', 'du.sh'), 'du -sh *')
    lib = new LocalSkills(skillsDir)
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: { list: () => [], readSnapshot: () => '', execCapture: async () => ({ output: '', exitCode: 0 }) } as any,
      resolveHostKey: () => 'local', decide: () => ({ kind: 'allow' }), grant: () => {}, audit: () => {},
      requestApproval: async () => ({ decision: 'allow' }),
      resolveSettings: () => ({ profileId: 'c', provider: 'openai-compatible', model: 'm', apiKey: 'k', baseUrl: base }),
      sessionStore: { upsert: (m: SessionMeta) => { store.set(m.id, m) }, remove: () => {}, list: () => [...store.values()], touch: () => {} },
      contextLimitTokens: () => 600000,
    } as any)
    ctrl.attachSkills(lib)
    ctrl.onEvent((e) => events.push(e))
  })
  afterAll(async () => { await ctrl.stopAll(); srv.close(); rmSync(dir, { recursive: true, force: true }) })

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const text = (b: any) => JSON.stringify(b.messages ?? [])

  it('请求里带 skill 目录与 skill 工具；用户 /disk-check 显式调用 → 本轮请求注入 skill 正文', async () => {
    const s = await ctrl.createSession()
    bodies.length = 0
    await runTurn(s.id, '/disk-check 看下这台机器')
    expect(bodies[0].tools.map((t: any) => t.function.name)).toContain('skill')
    expect(text(bodies[0])).toContain('<available_skills>')
    expect(text(bodies[0])).toContain('disk-check')
    expect(text(bodies[0])).toContain('<skill_content name=\\"disk-check\\">')
    expect(text(bodies[0])).toContain('SECRET-BODY-MARK')
  }, 60_000)

  it('模型调 skill 工具：结果是 <skill_content>（含资源目录提示）', async () => {
    const s = await ctrl.createSession()
    bodies.length = 0
    await runTurn(s.id, 'CALL-SKILL 帮我查磁盘')
    const tool = bodies[1].messages.find((m: any) => m.role === 'tool')
    expect(String(tool.content)).toContain('<skill_content name="disk-check">')
    expect(String(tool.content)).toContain('SECRET-BODY-MARK')
    expect(String(tool.content)).toContain(join(skillsDir, 'disk-check'))
    expect(text(bodies[0])).not.toContain('SECRET-BODY-MARK')   // 只有目录，没有正文
  }, 60_000)

  it('关掉「AI 可自动调用」→ 目录里撤掉、工具拒绝；停用 → 用户 /名字 也不再注入（都无需重启）', async () => {
    const s = await ctrl.createSession()
    await lib.setFlags('disk-check', { modelInvocable: false })
    bodies.length = 0
    await runTurn(s.id, 'CALL-SKILL 帮我查磁盘')
    const tool = bodies[1].messages.find((m: any) => m.role === 'tool')
    expect(String(tool.content)).toMatch(/not available for model invocation|unknown/)
    await lib.setFlags('disk-check', { enabled: false })
    bodies.length = 0
    await runTurn(s.id, '/disk-check 再看看')
    expect(text(bodies[0])).not.toContain('SECRET-BODY-MARK')
  }, 60_000)
})
