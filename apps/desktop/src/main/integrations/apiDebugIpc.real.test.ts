import { it, expect, beforeAll, afterAll } from 'vitest'
import ssh2 from 'ssh2'
import { spawn } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectSsh, execFull, setHostKeyPolicy, type SshConn } from '@lingshell/terminal-core'
import { API_BODY_MAX, newApiRequest, type ApiHistoryItem, type ApiRequest, type ApiResponse, type ApiStore, type TerminalInfo } from '@lingshell/shared'
import { loadApiStore, registerApiDebug } from './apiDebugIpc.js'
import { findBash } from '../core/index.js'

// 本机起一个回显 HTTP 服务；「从主机发送」用本机回环假 sshd（exec 交给本机 Git Bash，用它自带的 curl，stdin 照转）访问同一个服务。
// 密钥用假的展开 / 回写函数；不连任何真实主机、不用真实 API key
const { Server, utils } = ssh2 as unknown as { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
const BASH = findBash()
const SECRET = 'S3cr3t-VALUE-42'
const dir = mkdtempSync(join(tmpdir(), 'lingshell-api-'))
const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = []
const execCmds: string[] = []
let http: HttpServer, base = ''
let srv: { port: number; close(): void } | undefined
let conn: SshConn | undefined

beforeAll(async () => {
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/elsewhere' }); res.end(); return }
      if (req.url === '/png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); return }
      if (req.url === '/partial') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' }); res.write('partial'); setTimeout(() => res.destroy(), 30); return }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(5 * 1024 * 1024) })
        const chunk = 'x'.repeat(64 * 1024)
        for (let i = 0; i < 80; i++) res.write(chunk)
        res.end(); return
      }
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'application/json', 'X-Echo-Auth': String(req.headers.authorization ?? '') })
      res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }))
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const s = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (c) => {
    c.on('authentication', (ctx) => ctx.accept())
    c.on('error', () => {})
    c.on('session', (accept) => {
      accept().on('exec', (ok, _rej, info) => {
        execCmds.push(info.command)
        const ch = ok()
        const p = spawn(BASH!, ['-c', info.command])
        p.stdout.pipe(ch, { end: false }); p.stderr.pipe(ch.stderr, { end: false })
        ch.on('data', (d: Buffer) => p.stdin.write(d))
        ch.on('end', () => p.stdin.end())
        p.stdin.on('error', () => {})
        p.on('close', (code) => { ch.exit(code ?? 0); ch.end() })
      })
    })
  })
  srv = await new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: (s.address() as AddressInfo).port, close: () => s.close() })))
  const db = new Map<string, { keyType: string; fingerprint: string }>()
  setHostKeyPolicy({ lookup: (hp) => db.get(hp), remember: (hp, keyType, fingerprint) => { db.set(hp, { keyType, fingerprint }) }, prompt: async () => true })
  conn = await connectSsh({ host: '127.0.0.1', port: srv!.port, username: 'u', password: 'p' })
}, 30_000)
afterAll(() => { conn?.close(); srv?.close(); http?.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 忽略 */ } })

function setup() {
  const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const file = join(dir, 'api-debug.json')
  registerApiDebug({
    handle: (ch, fn) => { hs.set(ch, fn) },
    file,
    terminal: (id) => (id === 'ssh1' ? ({ id, type: 'ssh', os: 'linux', title: 'test-box' } as TerminalInfo) : id === 'win' ? ({ id, type: 'ssh', os: 'windows', title: 'w' } as TerminalInfo) : undefined),
    hostKey: (id) => (id === 'ssh1' ? 'h1' : 'local'),
    exec: (_id, cmd, o) => execFull(conn!.client, cmd, o),
    // 假保险箱：token 只允许本机和 h1 用
    expandSecrets: (hk, t) => {
      if (!t.includes('{{secret:')) return t
      if (t.includes('{{secret:nope}}')) throw new Error('密钥保险箱里没有「nope」')
      if (hk !== 'local' && hk !== 'h1') throw new Error('不允许在这台主机上使用')
      return t.replaceAll('{{secret:token}}', SECRET)
    },
    mask: (t) => t.replaceAll(SECRET, '{{secret:token}}'),
  })
  const call = <T>(ch: string, ...a: unknown[]) => Promise.resolve().then(() => hs.get(ch)!({}, ...a)) as Promise<T>
  return { call, file }
}
type Sent = { response: ApiResponse; history: ApiHistoryItem[] }
const vars = [{ key: 'base', value: '' }]
const req = (p: Partial<ApiRequest>): ApiRequest => ({ ...newApiRequest('r1', 't'), ...p })

for (const via of ['local', 'ssh1']) {
  it(`发送（${via === 'local' ? '本机 fetch' : '从主机 curl'}）：变量替换、密钥只在线上是明文、响应 / 历史里只有占位符`, async () => {
    vars[0].value = base
    const { call, file } = setup()
    seen.length = 0; execCmds.length = 0
    const r = await call<Sent>('api:send', {
      via, vars,
      request: req({ method: 'POST', url: '{{base}}/items?x=1', bodyType: 'json', body: '{"pw":"{{secret:token}}","q":"it\'s \\"ok\\"\\n"}',
        headers: [{ key: 'Authorization', value: 'Bearer {{secret:token}}' }, { key: 'X-Off', value: '1', off: true }] }),
    })
    // 服务端收到的是明文
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/items?x=1', body: `{"pw":"${SECRET}","q":"it's \\"ok\\"\\n"}` })
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(seen[0].headers['content-type']).toBe('application/json')
    expect(seen[0].headers['x-off']).toBeUndefined()
    // 界面拿到的响应：密钥换回占位符
    expect(r.response.status).toBe(200)
    expect(r.response.ms).toBeGreaterThanOrEqual(0)
    expect(r.response.body).not.toContain(SECRET)
    expect(JSON.parse(r.response.body).auth).toBe('Bearer {{secret:token}}')
    expect(r.response.headers.find(([k]) => k.toLowerCase() === 'x-echo-auth')?.[1]).toBe('Bearer {{secret:token}}')
    expect(r.response.via).toBe(via === 'local' ? '本机' : 'test-box')
    // 历史里存模板 URL：不把环境变量 / token 展开后的值写进 api-debug.json
    expect(r.history[0]).toMatchObject({ method: 'POST', url: '{{base}}/items?x=1', status: 200 })
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    // 远程：命令行里没有 URL / 密钥（都经 stdin 给 curl）
    if (via === 'ssh1') {
      expect(execCmds.length).toBe(1)
      expect(execCmds[0]).not.toContain('127.0.0.1'); expect(execCmds[0]).not.toContain(SECRET)
    }
    // 404 / HEAD / 不跟随重定向 / 二进制
    const nf = await call<Sent>('api:send', { via, vars, request: req({ url: '{{base}}/missing' }) })
    expect(nf.response.status).toBe(404)
    const head = await call<Sent>('api:send', { via, vars, request: req({ method: 'HEAD', url: '{{base}}/h' }) })
    expect([head.response.status, head.response.body]).toEqual([200, ''])
    const rd = await call<Sent>('api:send', { via, vars, request: req({ url: '{{base}}/redirect' }) })
    expect(rd.response.status).toBe(302)
    const png = await call<Sent>('api:send', { via, vars, request: req({ url: '{{base}}/png' }) })
    expect(png.response.body).toContain('二进制内容')
    // 表单里的密钥：先在服务端解开再编码，不能发出 %7B%7Bsecret...
    const form = await call<Sent>('api:send', {
      via, vars,
      request: req({ method: 'POST', url: '{{base}}/form', bodyType: 'form', body: 'user=a b\npass={{secret:token}}\n' }),
    })
    expect(seen.at(-1)!.body).toBe(`user=a%20b&pass=${encodeURIComponent(SECRET)}`)
    expect(form.response.status).toBe(200)
    // multipart：普通字段 + 文件字段（key=@路径）；本机读本机文件，SSH 主机读那台主机上的文件
    const fp = join(dir, 'upload.txt')
    writeFileSync(fp, 'hello-file')
    const mp = await call<Sent>('api:send', {
      via, vars,
      request: req({ method: 'POST', url: '{{base}}/upload', bodyType: 'multipart', body: `name=box\nfile=@${fp.replace(/\\/g, '/')}\n` }),
    })
    expect(mp.response.status).toBe(200)
    const echo = JSON.parse(mp.response.body).body as string
    expect(echo).toContain('name="name"'); expect(echo).toContain('box')
    expect(echo).toContain('filename="upload.txt"'); expect(echo).toContain('hello-file')
    expect(seen.at(-1)!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(mp.response.body).not.toContain(SECRET)
    // 中途断流：HTTP 头已经收到、body 没收完 → 必须报错而不是 200 + 半截内容
    // curl 版本不同，断流时的原文不同（有的给「未完成/中断」，新版给 "end of response with N bytes missing"）
    await expect(call('api:send', { via, vars, request: req({ url: '{{base}}/partial' }) })).rejects.toThrow(/未完成|中断|end of response/)
    if (via === 'local') {
      // 5MB 响应：只保留 2MB，标记截断，但显示真实总大小
      const huge = await call<Sent>('api:send', { via, vars, request: req({ url: '{{base}}/huge' }) })
      expect(huge.response.truncated).toBe(true)
      expect(huge.response.body.length).toBeLessThanOrEqual(API_BODY_MAX)
      expect(huge.response.size).toBe(5 * 1024 * 1024)
    }
  }, 60_000)
}

it('出错：未定义变量 / 非 http / 密钥不可用 / 连不上；失败也记历史', async () => {
  const { call } = setup()
  await expect(call('api:send', { via: 'local', vars: [], request: req({ url: '{{nobase}}/x' }) })).rejects.toThrow('未定义的变量：nobase')
  await expect(call('api:send', { via: 'local', vars: [], request: req({ url: 'file:///etc/passwd' }) })).rejects.toThrow('只支持')
  await expect(call('api:send', { via: 'local', vars: [], request: req({ url: 'http://127.0.0.1:1/{{secret:nope}}' }) })).rejects.toThrow('没有「nope」')
  await expect(call('api:send', { via: 'win', vars: [], request: req({ url: 'http://127.0.0.1:1/' }) })).rejects.toThrow('Windows')
  await expect(call('api:send', { via: 'gone', vars: [], request: req({ url: 'http://127.0.0.1:1/' }) })).rejects.toThrow('已关闭')
  await expect(call('api:send', { via: 'local', vars: [], request: req({ url: 'http://127.0.0.1:1/x' }) })).rejects.toThrow()
  await expect(call('api:send', { via: 'ssh1', vars: [], request: req({ url: 'http://127.0.0.1:1/x' }) })).rejects.toThrow(/curl: \(7\)|Failed to connect|Couldn't connect/)
  const s = await call<ApiStore>('api:load')
  expect(s.history[0]).toMatchObject({ url: 'http://127.0.0.1:1/x', via: 'test-box' })
  expect(s.history[0].error).toBeTruthy()
}, 60_000)

it('集合 / 环境保存：整份覆盖，历史只由发送追加；清空历史', async () => {
  const { call } = setup()
  const before = await call<ApiStore>('api:load')
  const saved = await call<ApiStore>('api:save', { requests: [req({ id: 'k', name: '登录', url: '{{base}}/login' })], envs: [{ id: 'e1', name: 'dev', vars }], activeEnv: 'e1', history: [] })
  expect(saved.requests.map((r) => r.name)).toEqual(['登录'])
  expect(saved.activeEnv).toBe('e1')
  expect(saved.history.length).toBe(before.history.length)   // 渲染层传来的 history 不算数
  await call('api:clearHistory')
  expect((await call<ApiStore>('api:load')).history).toEqual([])
})

it('api-debug.json：损坏时备份成 .corrupt-*，不静默清空；文件仅本人可读', async () => {
  const bad = join(dir, 'corrupt-api.json')
  writeFileSync(bad, '{broken json', 'utf8')
  expect(loadApiStore(bad)).toEqual({ requests: [], envs: [], history: [] })
  expect(readdirSync(dir).some((f) => f.startsWith('corrupt-api.json.corrupt-'))).toBe(true)

  const { call } = setup()
  await call('api:save', { requests: [req({ id: 'mode', name: 'm' })], envs: [], history: [] })
  if (process.platform !== 'win32') expect(statSync(join(dir, 'api-debug.json')).mode & 0o777).toBe(0o600)
})
