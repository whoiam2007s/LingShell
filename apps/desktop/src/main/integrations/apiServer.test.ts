import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@lingshell/shared'
import { awaitTurn, ApiServer } from './apiServer.js'

function fakeBus() {
  const hs = new Set<(ev: AgentEvent) => void>()
  return {
    onEvent: (h: (ev: AgentEvent) => void) => { hs.add(h); return () => { hs.delete(h) } },
    emit: (ev: AgentEvent) => { hs.forEach((h) => h(ev)) },
    subscribers: () => hs.size,
  }
}

const msg = (sessionId: string, text: string): AgentEvent =>
  ({ type: 'agent:itemUpdated', sessionId, turnId: 't1', itemId: 'i1', kind: 'agent_message', status: 'completed', text })
const finished = (sessionId: string): AgentEvent => ({ type: 'agent:turnCompleted', sessionId, turnId: 't1' })

describe('awaitTurn', () => {
  it('turnCompleted：返回最后一条 AI 回复作总结，并退订', async () => {
    const bus = fakeBus()
    const { promise } = awaitTurn(bus.onEvent, 's1', 5000)
    bus.emit(msg('s1', '第一段'))
    bus.emit(msg('s1', '最终答复'))
    bus.emit(finished('s1'))
    expect(await promise).toEqual({ status: 'completed', summary: '最终答复', sessionId: 's1' })
    expect(bus.subscribers()).toBe(0)
  })

  it('turnFailed：带 error 返回，summary 保留已收到的部分', async () => {
    const bus = fakeBus()
    const { promise } = awaitTurn(bus.onEvent, 's1', 5000)
    bus.emit(msg('s1', '干到一半'))
    bus.emit({ type: 'agent:turnFailed', sessionId: 's1', turnId: 't1', error: 'boom' })
    expect(await promise).toEqual({ status: 'failed', summary: '干到一半', sessionId: 's1', error: 'boom' })
  })

  it('超时：返回 timeout + 已攒到的文本（不中断 turn）', async () => {
    const bus = fakeBus()
    const { promise } = awaitTurn(bus.onEvent, 's1', 10)
    bus.emit(msg('s1', '还没说完'))
    expect(await promise).toEqual({ status: 'timeout', summary: '还没说完', sessionId: 's1' })
    expect(bus.subscribers()).toBe(0)
  })

  it('只认本会话：其它会话的事件不串台', async () => {
    const bus = fakeBus()
    const { promise } = awaitTurn(bus.onEvent, 's1', 5000)
    bus.emit(msg('s2', '别人的回复'))
    bus.emit(finished('s2'))
    bus.emit(msg('s1', '我的回复'))
    bus.emit(finished('s1'))
    expect((await promise).summary).toBe('我的回复')
  })

  it('cancel：sendTurn 失败时退订，不留悬挂订阅', () => {
    const bus = fakeBus()
    const { cancel } = awaitTurn(bus.onEvent, 's1', 5000)
    expect(bus.subscribers()).toBe(1)
    cancel()
    expect(bus.subscribers()).toBe(0)
  })
})

describe('ApiServer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lingshell-api-'))
  const bus = fakeBus()
  const sent: string[] = []
  let activeId: string | undefined = 's1'
  let locked = false
  let server: ApiServer, port: number, token: string

  // sendTurn 只记录不自动完成——由每个用例自己 emit 事件控制任务何时结束
  const call = (method: string, path: string, body?: unknown, auth = `Bearer ${token}`) =>
    new Promise<{ status: number; json: Record<string, string> }>((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body)
      const req = request({
        host: '127.0.0.1', port, path, method,
        headers: {
          ...(auth ? { authorization: auth } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (r) => {
        let b = ''
        r.setEncoding('utf8')
        r.on('data', (c) => { b += c })
        r.on('end', () => resolve({ status: r.statusCode ?? 0, json: JSON.parse(b) as Record<string, string> }))
      })
      req.setTimeout(0)
      req.on('error', reject)
      req.end(payload)
    })

  beforeAll(async () => {
    server = new ApiServer({
      configDir: dir,
      activeSessionId: () => activeId,
      sendTurn: async (_sessionId, text) => { sent.push(text) },
      onEvent: bus.onEvent,
      isLocked: () => locked,
    })
    port = await server.start()
    const cfg = JSON.parse(readFileSync(join(dir, 'api.json'), 'utf8')) as { port: number; token: string }
    token = cfg.token
    expect(cfg.port).toBe(port)
  })
  afterAll(() => { server.stop(); rmSync(dir, { recursive: true, force: true }) })

  it('无 token / 错 token → 401', async () => {
    expect((await call('POST', '/api/send', { text: '喂' }, '')).status).toBe(401)
    expect((await call('POST', '/api/send', { text: '喂' }, `Bearer ${'x'.repeat(token.length)}`)).status).toBe(401)
  })

  it('send 立刻返回 taskId，不等任务跑完', async () => {
    activeId = 'quick'
    const r = await call('POST', '/api/send', { text: '干活' })
    // 没 emit 任何 turn 事件请求就回来了 —— 这就是「不阻塞」
    expect(r.status).toBe(202)
    expect(r.json.taskId).toMatch(/^[0-9a-f]{16}$/)
    expect(r.json.sessionId).toBe('quick')
    expect(sent).toContain('干活')
  })

  it('十几分钟的任务：轮询到点回 running，完成后再查拿到总结', async () => {
    activeId = 'slow'
    const { json: { taskId } } = await call('POST', '/api/send', { text: '慢活' })

    const pending = await call('GET', `/api/result?taskId=${taskId}&waitMs=30`)
    expect(pending.json.status).toBe('running')
    expect(pending.status).toBe(200)

    bus.emit(msg('slow', '终于搞定'))
    bus.emit(finished('slow'))
    const done = await call('GET', `/api/result?taskId=${taskId}&waitMs=50`)
    expect(done.json).toEqual({ status: 'completed', summary: '终于搞定', sessionId: 'slow' })
  })

  it('轮询期间任务完成 → 立刻返回，不等满 waitMs', async () => {
    activeId = 'mid'
    const { json: { taskId } } = await call('POST', '/api/send', { text: '中速' })
    const started = Date.now()
    const polling = call('GET', `/api/result?taskId=${taskId}&waitMs=10000`)
    setTimeout(() => { bus.emit(msg('mid', '提前完成')); bus.emit(finished('mid')) }, 20)
    expect((await polling).json.summary).toBe('提前完成')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('应用锁定 → 所有接口 423，不发消息；解锁后恢复', async () => {
    activeId = 's1'
    const before = sent.length
    locked = true
    expect(await call('POST', '/api/send', { text: '锁着也想发' })).toEqual({ status: 423, json: { error: 'locked' } })
    expect((await call('GET', '/api/result?taskId=nope')).status).toBe(423)
    expect((await call('POST', '/api/send', { text: '锁着' }, '')).status).toBe(401)   // token 校验仍在前
    expect(sent.length).toBe(before)
    locked = false
    expect((await call('GET', '/api/result?taskId=nope')).status).toBe(404)
  })

  it('未知 taskId → 404', async () => {
    expect((await call('GET', '/api/result?taskId=nope')).status).toBe(404)
  })

  it('空文本 → 400；没有打开的会话 → 409', async () => {
    activeId = 's1'
    expect((await call('POST', '/api/send', { text: '  ' })).status).toBe(400)
    activeId = undefined
    expect((await call('POST', '/api/send', { text: '干活' })).status).toBe(409)
    activeId = 's1'
  })

  it('会话有活跃 turn 时拒绝（409 session_busy），结束后放行', async () => {
    activeId = 'busy'
    bus.emit({ type: 'agent:turnStarted', sessionId: 'busy', turnId: 't1' })
    expect((await call('POST', '/api/send', { text: '插队' })).json.error).toBe('session_busy')
    bus.emit(finished('busy'))
    expect((await call('POST', '/api/send', { text: '排队' })).status).toBe(202)
    activeId = 's1'
  })

  it('stop() 清掉 api.json，不给下次留过期端口', async () => {
    const probe = new ApiServer({ configDir: dir, activeSessionId: () => undefined, sendTurn: async () => {}, onEvent: bus.onEvent })
    await probe.start()
    expect(existsSync(join(dir, 'api.json'))).toBe(true)
    probe.stop()
    expect(existsSync(join(dir, 'api.json'))).toBe(false)
  })
})
