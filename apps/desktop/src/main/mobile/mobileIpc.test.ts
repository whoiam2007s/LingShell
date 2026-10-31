import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ApprovalAnswer, MobileStatus } from '@lingshell/shared'
import { registerMobile } from './mobileIpc.js'
import { DEVICE_TTL_MS } from './mobileAuth.js'
import page from './mobilePage.html?raw'

// 集成测试：真起 HTTP 服务（绑 127.0.0.1，测试放行回环地址），模拟手机配对 → 列会话 → 授权 → 撤销
const dir = mkdtempSync(join(tmpdir(), 'mobile-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const freePort = () => new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)) }) })

describe('手机访问 HTTP 接口', () => {
  let clock = 1_000_000
  let locked = false
  let secrets = ['topsecret123']
  const decided: [string, ApprovalAnswer, string][] = []
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const m = registerMobile({
    handle: (ch, fn) => handlers.set(ch, fn),
    file: join(dir, 'mobile.json'), page: page.replace(/\r?\n/g, '\r\n'),   // 按 Windows 检出（CRLF）喂，验证行尾规整
    addresses: () => [{ address: '127.0.0.1', name: 'lo' }],
    validate: () => undefined,
    sessions: () => [{ id: 's1', title: '部署 password=hunter2abc', threadId: '', createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z' }],
    hostInfo: (hk) => ({ label: hk === 'prod1' ? '生产库' : '测试机', prod: hk === 'prod1' }),
    decideApproval: (id, ans, sid) => { decided.push([id, ans, sid]); return true },
    isLocked: () => locked,
    secrets: () => secrets,
    mask: (t) => t.split('pin4').join('{{secret:pin}}'),
    log: () => {},
    now: () => clock,
  })
  const call = async (ch: string, ...a: unknown[]) => await handlers.get(ch)!(null, ...a) as MobileStatus
  let base = ''
  let cookie = ''
  const get = (p: string, c = cookie) => fetch(base + p, { headers: c ? { cookie: c } : {} })
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) })

  it('开启后监听，页面带 CSP / no-store；未配对 401；Host 不符 421', async () => {
    const port = await freePort()
    await call('mobile:configure', { port })
    const st = await call('mobile:setEnabled', true)
    expect(st.running).toBe(true)
    base = st.url!.replace(/\/$/, '')
    expect(base).toBe(`http://127.0.0.1:${port}`)
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[^']+'; style-src 'sha256-/)
    // 浏览器按 \n 行尾的脚本原文算哈希：发出去的页面不能带 \r，CSP 里的哈希要和它对得上（否则手机页脚本被拦、一片空白）
    const html = await r.clone().text()
    expect(html).not.toMatch(/\r/)
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]
    expect(r.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect((await get('/api/sessions')).status).toBe(401)
    const code = await new Promise<number>((res) => request({ host: '127.0.0.1', port, path: '/api/sessions', headers: { host: 'evil.example:80' } }, (x) => { x.resume(); res(x.statusCode!) }).end())
    expect(code).toBe(421)
  })

  it('配对码：错 5 次只锁该设备；桌面端仍可重新发码；配对成功 cookie 带 30 天有效期', async () => {
    expect((await post('/api/pair', { code: '000000' })).status).toBe(403)
    const st = await call('mobile:newPairCode')
    const good = st.pairing!.code
    const bad = good === '999999' ? '888888' : '999999'
    for (let i = 0; i < 4; i++) expect((await post('/api/pair', { code: bad })).status).toBe(403)
    expect((await post('/api/pair', { code: bad })).status).toBe(429)
    expect((await post('/api/pair', { code: good })).status).toBe(429)   // 这个 IP 已被锁
    // 关键：桌面端仍能生成新码（以前会被全局锁定拒绝），局域网里其他人不能靠乱试把配对锁死
    const again = await call('mobile:newPairCode')
    expect(again.pairing).toBeTruthy()
    clock += 10 * 60_000
    const code = (await call('mobile:newPairCode')).pairing!.code
    const r = await post('/api/pair', { code })
    expect(r.status).toBe(200)
    const sc = r.headers.get('set-cookie')!
    expect(sc).toMatch(/HttpOnly/)
    expect(sc).toMatch(/SameSite=Strict/)
    expect(sc).toContain(`Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}`)
    cookie = sc.split(';')[0]
    expect((await post('/api/pair', { code })).status).toBe(403)   // 一次性
    // 本地只存令牌哈希
    expect(readFileSync(join(dir, 'mobile.json'), 'utf8')).not.toContain(cookie.split('=')[1])
    const devices = (await call('mobile:status')).devices
    expect(devices).toHaveLength(1)
    expect(devices[0].expiresAt).toBe(clock + DEVICE_TTL_MS)
  })

  it('会话列表 / 详情脱敏；待授权卡；允许走 decideApproval；生产危险命令只能拒绝', async () => {
    const list = await (await get('/api/sessions')).json() as any
    expect(list.sessions[0]).toMatchObject({ id: 's1', status: 'done', pending: 0 })
    expect(list.sessions[0].title).not.toContain('hunter2abc')
    m.onEvent({ type: 'agent:turnStarted', sessionId: 's1', turnId: 't1' })
    m.onEvent({ type: 'agent:itemUpdated', sessionId: 's1', turnId: 't1', itemId: 'u1', kind: 'user_message', status: 'completed', text: '用 topsecret123 登录，保险箱 pin4' })
    m.onEvent({ type: 'auth:request', approvalId: 'ap1', sessionId: 's1', terminalId: 'h1', needed: 'write', reason: 'first_access', risk: 'safe', tool: 'exec_in_terminal', command: 'mysql -ptopsecret123 -e "select 1"', deadlineMs: 300_000 })
    m.onEvent({ type: 'auth:request', approvalId: 'ap2', sessionId: 's1', terminalId: 'prod1', needed: 'write', reason: 'dangerous_command', risk: 'dangerous', tool: 'exec_in_terminal', command: 'rm -rf /data', deadlineMs: 300_000 })
    const s = await (await get('/api/session?id=s1')).json() as any
    expect(s.status).toBe('waiting')
    expect(JSON.stringify(s)).not.toContain('topsecret123')
    expect(JSON.stringify(s)).not.toContain('pin4')          // 保险箱回写在脱敏开关之外生效
    expect(s.items[0]).toMatchObject({ role: 'user' })
    // 新增的机密立即生效，不用等 5 秒缓存（保存密钥时会调 invalidateSecrets）
    secrets = [...secrets, 'later777']
    m.onEvent({ type: 'agent:itemUpdated', sessionId: 's1', turnId: 't1', itemId: 'u2', kind: 'agent_message', status: 'completed', text: 'later777 已使用' })
    m.invalidateSecrets()
    expect(JSON.stringify(await (await get('/api/session?id=s1')).json())).not.toContain('later777')
    const [a1, a2] = s.approvals
    expect(a1).toMatchObject({ approvalId: 'ap1', canAllow: true, host: '测试机', prod: false, reason: '首次访问该主机' })
    expect(a2).toMatchObject({ approvalId: 'ap2', canAllow: false, prod: true, risk: 'dangerous' })
    expect(a2.block).toMatch(/生产/)

    expect((await fetch(base + '/api/decide', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{"approvalId":"ap1","decision":"allow"}' })).status).toBe(415)
    expect((await post('/api/decide', { approvalId: 'ap1', decision: 'allow' }, { origin: 'http://evil.example' })).status).toBe(403)
    expect((await post('/api/decide', { approvalId: 'ap2', decision: 'allow' })).status).toBe(403)
    expect((await post('/api/decide', { approvalId: 'ap1', decision: 'allow' })).status).toBe(200)
    m.onEvent({ type: 'auth:resolved', approvalId: 'ap1', result: 'allow' })
    expect((await post('/api/decide', { approvalId: 'ap1', decision: 'allow' })).status).toBe(410)
    expect((await post('/api/decide', { approvalId: 'ap2', decision: 'deny' })).status).toBe(200)
    expect(decided).toEqual([['ap1', { decision: 'allow' }, 's1'], ['ap2', { decision: 'deny' }, 's1']])
  })

  it('应用锁定时 423；设备 30 天过期；全部撤销后 401；关闭开关立即停止服务', async () => {
    locked = true
    expect((await get('/api/sessions')).status).toBe(423)
    locked = false
    clock += DEVICE_TTL_MS
    expect((await get('/api/sessions')).status).toBe(401)     // 服务端也按有效期拒绝，不只是 cookie
    expect((await call('mobile:status')).devices).toHaveLength(0)   // 过期设备被清掉

    // 重新配对后测「全部撤销」
    const code = (await call('mobile:newPairCode')).pairing!.code
    const r = await post('/api/pair', { code })
    expect(r.status).toBe(200)
    cookie = r.headers.get('set-cookie')!.split(';')[0]
    expect((await get('/api/sessions')).status).toBe(200)
    await call('mobile:revokeAll')
    expect((await get('/api/sessions')).status).toBe(401)
    const off = await call('mobile:setEnabled', false)
    expect(off.running).toBe(false)
    await expect(fetch(base + '/')).rejects.toThrow()
    m.stop()
  })
})
