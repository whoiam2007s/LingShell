// 真机验收：真实 DshController（真 dsh agent、真工具执行、真落盘）+ 真实 AuthRegistry（四档）
// + 假模型（OpenAI 兼容流式）。只有「模型」是假的，其余走产品真实链路：
//   sendTurn → agent 决定调工具 → tools/pre-execute 网关（预演/decideFor/模式层）
//   → 需要就问 requestApproval（等价于弹授权卡）→ 工具体执行 → 文件真写到磁盘 → 记执行记录
//
// 用户消息里写标签，假模型据此返回工具调用：
//   [[write:<终端>:<绝对路径>]]   → write_file（content = ACCEPT_CONTENT）
//   [[exec:<终端>:<命令>]]        → exec_in_terminal
// jsonl 持久化要 zstd（Node ≥22.15 / Electron 的 Node），没有就跳过。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import * as zlib from 'node:zlib'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, SessionMeta } from '@lingshell/shared'
import { tr } from '@lingshell/shared'
import { AuthRegistry, JsonAuthStore } from '@lingshell/auth-registry'
import type { ApprovalRequest } from './DshController.js'
import type { AuditRecord } from './terminalTools.js'

const CONTENT = 'hello from acceptance'
const hasZstd = typeof (zlib as any).zstdCompressSync === 'function'

/** 假模型：按用户消息里的标签决定调哪个工具；已有工具结果就回文本收尾 */
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
      let at = -1
      msgs.forEach((x, i) => { if (x.role === 'user' && /\[\[(write|exec):/.test(JSON.stringify(x.content))) at = i })
      const m = at < 0 ? null : /\[\[(write|exec):(\w+):([^\]]+)\]\]/.exec(JSON.stringify(msgs[at].content))
      if (m && !msgs.slice(at).some((x) => x.role === 'tool')) {
        const [, kind, tid, arg] = m
        const call = kind === 'write'
          ? { name: 'write_file', arguments: JSON.stringify({ terminal_id: tid, path: arg, content: CONTENT }) }
          : { name: 'exec_in_terminal', arguments: JSON.stringify({ terminal_id: tid, command: arg, explain: '验收', rollback: 'true', rollback_note: '验收' }) }
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

describe.skipIf(!hasZstd)('四档执行模式真机验收（真实控制器 + 假模型 + 真落盘）', () => {
  const reqs: any[] = []
  const server = fakeOpenAi(reqs)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-execmode-e2e-'))
  const WORK = join(dir, 'work')
  const store = new Map<string, SessionMeta>()
  const approvals: ApprovalRequest[] = []
  const audits: AuditRecord[] = []
  const ran: string[] = []
  const prodHosts = new Set<string>(['hp'])
  let ctrl: import('./DshController.js').DshController

  const runTurn = (sid: string, text: string) => new Promise<void>((resolve, reject) => {
    const off = ctrl.onEvent((e: AgentEvent) => {
      if (!('sessionId' in e) || e.sessionId !== sid) return
      if (e.type === 'agent:turnCompleted') { off(); resolve() }
      if (e.type === 'agent:turnFailed') { off(); reject(new Error(e.error)) }
    })
    ctrl.sendTurn(sid, text).catch(reject)
  })
  const toolResult = () => String(reqs[reqs.length - 1].messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '')
  const exists = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const modeLabels = () => audits.filter((a) => a.rule?.includes('执行模式')).map((a) => a.rule)

  beforeAll(async () => {
    mkdirSync(WORK, { recursive: true })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`
    const auth = new AuthRegistry({ store: new JsonAuthStore(join(dir, 'auth.json')) })
    ctrl = new (await import('./DshController.js')).DshController({
      baseDir: dir,
      terminals: {
        list: () => [
          { id: 'term_l', title: '本地', type: 'local', status: 'running', locked: false },
          { id: 'term_p', title: '生产机', type: 'ssh', status: 'running', locked: false },
        ],
        readSnapshot: () => '',
        execCapture: async (_tid, cmd) => { ran.push(cmd); return { output: `ran ${cmd}`, exitCode: 0 } },
      },
      resolveHostKey: (tid) => (tid === 'term_p' ? 'hp' : 'local'),
      // 真实授权链：信任档由四档派生、授权按主机+级别记
      decide: (sid, hostKey, needed, command) => auth.decide(sid, hostKey, needed, command, true, prodHosts.has(hostKey)),
      grant: (sid, hostKey, level) => auth.grant(sid, hostKey, level),
      audit: (r) => { audits.push(r) },
      isReadOnly: (c) => /^(ls|cat|pwd|df)\b/.test(c),
      // 四档：与 apps/desktop/src/main/ai/register.ts 的接线一致
      execModeOf: (sid) => auth.getExecMode(sid),
      setExecMode: (sid, mode) => auth.setExecMode(sid, mode),
      hostMeta: (tid) => (tid === 'term_p' ? { env: 'prod' } : {}),
      requestApproval: async (r) => { approvals.push(r); return { decision: 'allow' } },
      resolveSettings: () => ({ provider: 'openai-compatible', model: 'fake', apiKey: 'sk-ok', baseUrl }),
      sessionStore: { upsert: (m) => { store.set(m.id, m) }, remove: (id) => { store.delete(id) }, list: () => [...store.values()], touch: () => {} },
      // 真实文件读写（判「是否真落盘」靠这个）
      readFile: async (_tid, p) => exists(p) ?? undefined,
      writeFile: async (_tid, p, content) => { writeFileSync(p, content, 'utf8'); return { path: p } },
    })
  }, 60_000)
  beforeEach(() => { reqs.length = 0; approvals.length = 0; audits.length = 0; ran.length = 0 })
  afterAll(async () => {
    await ctrl.stopAll()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const newSession = async (mode?: 'confirm' | 'auto' | 'trust' | 'preview') => {
    const s = await ctrl.createSession()
    await ctrl.setWorkDir(s.id, WORK)
    if (mode) ctrl.setExecMode(s.id, mode)
    return s
  }

  it('默认档（逐条确认）：每次写都弹授权卡，文件真落盘，执行记录是普通 allow', async () => {
    const s = await newSession()
    expect(ctrl.execModeOf(s.id)).toBe('confirm')
    await runTurn(s.id, `写第一个 [[write:term_l:${join(WORK, 'a.txt')}]]`)
    expect(approvals).toHaveLength(1)
    expect(approvals[0].tool).toBe('write_file')
    expect(approvals[0].diff).toContain(CONTENT)          // 卡上有 diff
    expect(exists(join(WORK, 'a.txt'))).toBe(CONTENT)      // 真写进磁盘
    expect(audits.some((a) => a.decision.startsWith('allow'))).toBe(true)   // 执行记录里落了「允许」
    expect(modeLabels()).toEqual([])                       // 默认档不放宽 → 不带模式标注

    await runTurn(s.id, `写第二个 [[write:term_l:${join(WORK, 'b.txt')}]]`)
    expect(approvals).toHaveLength(2)                      // 每条写都再问
    expect(exists(join(WORK, 'b.txt'))).toBe(CONTENT)
  }, 90_000)

  it('确认一次：同类只问一次，第二份文件不再弹卡，执行记录带「执行模式：确认一次」', async () => {
    const s = await newSession('auto')
    await runTurn(s.id, `写 a [[write:term_l:${join(WORK, 'c.txt')}]]`)
    expect(approvals).toHaveLength(1)
    await runTurn(s.id, `写 b [[write:term_l:${join(WORK, 'd.txt')}]]`)
    expect(approvals).toHaveLength(1)                      // 没再问
    expect(exists(join(WORK, 'd.txt'))).toBe(CONTENT)
    // 第二次放行走的是授权链（主机 + 级别的 allow），也要注明是哪个档放行的（B10）
    expect(modeLabels()).toEqual([tr('执行模式：{m}', { m: tr('确认一次') })])
  }, 90_000)

  it('确认一次：目录外的写第一次问，同一个目录批过就不再问（B2）', async () => {
    const s = await newSession('auto')
    await runTurn(s.id, `写 a [[write:term_l:${join(WORK, 'j.txt')}]]`)
    expect(approvals).toHaveLength(1)
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    await runTurn(s.id, `写外面 [[write:term_l:${join(outside, 'k.txt')}]]`)
    expect(approvals).toHaveLength(2)                     // 目录外第一次必须问
    expect(exists(join(outside, 'k.txt'))).toBe(CONTENT)   // 允许后真的写进去
    // 同一个目录里再写一个文件：批过这个目录了，不再问
    await runTurn(s.id, `写外面二 [[write:term_l:${join(outside, 'l.txt')}]]`)
    expect(approvals).toHaveLength(2)
    expect(exists(join(outside, 'l.txt'))).toBe(CONTENT)
    // 换一个目录（work 的兄弟目录）：没批过，仍要问
    const other = join(dir, 'other')
    mkdirSync(other, { recursive: true })
    await runTurn(s.id, `写别的目录 [[write:term_l:${join(other, 'm.txt')}]]`)
    expect(approvals).toHaveLength(3)
  }, 90_000)

  it('信任：目录外的写第一次问，批过同目录之后不再问（B2）', async () => {
    const s = await newSession('trust')
    const outside = join(dir, 'outside-trust')
    mkdirSync(outside, { recursive: true })
    await runTurn(s.id, `写 [[write:term_l:${join(outside, 'n.txt')}]]`)
    expect(approvals).toHaveLength(1)                      // 工作目录外：第一次问
    await runTurn(s.id, `再写 [[write:term_l:${join(outside, 'o.txt')}]]`)
    expect(approvals).toHaveLength(1)                      // 同一个目录：不再问
    expect(exists(join(outside, 'o.txt'))).toBe(CONTENT)
  }, 90_000)

  it('信任：工作目录内写直接落盘不问；危险命令仍然弹卡', async () => {
    const s = await newSession('trust')
    await runTurn(s.id, `写 [[write:term_l:${join(WORK, 'e.txt')}]]`)
    expect(approvals).toHaveLength(0)
    expect(exists(join(WORK, 'e.txt'))).toBe(CONTENT)

    await runTurn(s.id, '删 [[exec:term_l:rm -rf /tmp/lingshell-acceptance-x]]')
    expect(approvals).toHaveLength(1)                      // 危险命令照旧问
    expect(ran).toContain('rm -rf /tmp/lingshell-acceptance-x')
  }, 90_000)

  it('预演：写操作被拒、文件不存在、拒绝原因回给模型', async () => {
    const s = await newSession('preview')
    await runTurn(s.id, `写 [[write:term_l:${join(WORK, 'f.txt')}]]`)
    expect(approvals).toHaveLength(0)
    expect(exists(join(WORK, 'f.txt'))).toBeNull()
    expect(toolResult()).toContain('预演')
    expect(audits.some((a) => a.decision === 'deny:preview_mode')).toBe(true)
  }, 90_000)

  it('生产主机 + 信任：写工作目录内仍要弹卡', async () => {
    const s = await newSession('trust')
    await runTurn(s.id, `写 [[write:term_p:${join(WORK, 'g.txt')}]]`)
    expect(approvals).toHaveLength(1)
    expect(exists(join(WORK, 'g.txt'))).toBe(CONTENT)
  }, 90_000)

  it('换档即忘：确认一次批过的同类，切回逐条确认后重新弹卡', async () => {
    const s = await newSession('auto')
    await runTurn(s.id, `写 a [[write:term_l:${join(WORK, 'h.txt')}]]`)
    expect(approvals).toHaveLength(1)
    ctrl.setExecMode(s.id, 'confirm')
    await runTurn(s.id, `写 b [[write:term_l:${join(WORK, 'i.txt')}]]`)
    expect(approvals).toHaveLength(2)
  }, 90_000)

  it('接续：把「摘要 + 最近几轮」重组成种子，新会话一打开就有历史（B3）', async () => {
    const s = await newSession()
    await runTurn(s.id, '你好第一句')
    await runTurn(s.id, '你好第二句')
    const r = await ctrl.continueSession(s.id, { title: '接续测试' })
    expect(r.session.id).not.toBe(s.id)
    expect(store.get(r.session.id)?.title).toBe('接续测试')
    expect(r.digest).toBe('')                              // 有种子就不再额外带 digest（同一段上下文别发两遍）
    // 种子那一轮真的进了模型上下文（新会话不用重新输入）
    await runTurn(r.session.id, '你好第三句')
    expect(JSON.stringify(reqs.at(-1))).toContain('你好第二句')
  }, 90_000)

  it('思考深度：写进会话记录，关掉再恢复还在，「跟随配置」= 删掉（B7）', async () => {
    const s = await newSession()
    await ctrl.setSessionThinking(s.id, 'high')
    expect(store.get(s.id)?.thinking).toBe('high')
    await ctrl.closeSession(s.id)
    expect(ctrl.sessionThinking(s.id).level).toBe('high')   // 不在内存时读会话记录
    await ctrl.reconnectSession(store.get(s.id)!)
    expect(ctrl.sessionThinking(s.id).level).toBe('high')   // 恢复会话时带回来
    await ctrl.setSessionThinking(s.id, undefined)
    expect(store.get(s.id)?.thinking).toBeUndefined()
  }, 90_000)

  it('模式持久化：档位写在 auth.json 里，重启后还在', async () => {
    const s = await newSession('trust')
    expect(ctrl.execModeOf(s.id)).toBe('trust')
    const reloaded = new AuthRegistry({ store: new JsonAuthStore(join(dir, 'auth.json')) })
    expect(reloaded.getExecMode(s.id)).toBe('trust')
    expect(reloaded.getTrust(s.id)).toBe('autonomous')
  }, 30_000)
})
