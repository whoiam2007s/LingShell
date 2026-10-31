import { describe, it, expect, afterAll } from 'vitest'
import tls from 'node:tls'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { certDiscoverCommand, opensslCheckCommand, parseCertDiscover, parseOpensslCheck } from '@lingshell/shared'
import { CertMonitor, CertStore, checkTls } from './certCheck.js'
import { findBash } from '../core/index.js'
import { localRunner } from './batchExec.js'
import { INTER, LEAF, LEAF_KEY, MIS, MIS_KEY, ROOT, SELF, SELF_KEY } from './certCheck.fixtures.js'

// 本机起自签名 TLS 服务（夹具证书，不连公网）：完整链 / 缺中间证书 / 自签名 / 域名不匹配，核对各项判断
const servers: tls.Server[] = []
const serve = (cert: string, key: string) => new Promise<number>((res) => {
  const s = tls.createServer({ cert, key }, (sock) => { sock.on('error', () => {}); sock.end() })
  s.on('tlsClientError', () => {})
  servers.push(s)
  s.listen(0, '127.0.0.1', () => res((s.address() as AddressInfo).port))
})
afterAll(() => { for (const s of servers) s.close() })

const NOT_AFTER = new Date(new (await import('node:crypto')).X509Certificate(LEAF).validTo)

describe('checkTls（本机 tls.connect）', () => {
  it('完整链 + 信任根：ok、域名匹配、协议', async () => {
    const port = await serve(LEAF + INTER, LEAF_KEY)
    const r = await checkTls('localhost', port, { ca: ROOT })
    expect(r).toMatchObject({ ok: true, chain: 'ok', nameMatch: true, subject: 'leaf.test', protocol: 'TLSv1.3' })
    expect(r.san).toEqual(['localhost', '127.0.0.1'])
    expect(r.chainDepth).toBeGreaterThanOrEqual(2)
  })
  it('完整链但根不受信任 → 不受信任；IP 访问按 IP SAN 匹配', async () => {
    const port = await serve(LEAF + INTER, LEAF_KEY)
    expect(await checkTls('127.0.0.1', port)).toMatchObject({ ok: true, chain: 'untrusted', nameMatch: true })
  })
  it('只发叶子证书 → 缺中间证书', async () => {
    const port = await serve(LEAF, LEAF_KEY)
    expect((await checkTls('localhost', port, { ca: ROOT })).chain).toBe('incomplete')
  })
  it('自签名', async () => {
    const port = await serve(SELF, SELF_KEY)
    expect(await checkTls('localhost', port)).toMatchObject({ chain: 'self-signed', nameMatch: false })
  })
  it('域名不匹配（证书给 other.example）', async () => {
    const port = await serve(MIS + INTER, MIS_KEY)
    expect(await checkTls('localhost', port, { ca: ROOT })).toMatchObject({ chain: 'ok', nameMatch: false, san: ['other.example'] })
  })
  it('注入当前时间：剩 2 天 / 已过期', async () => {
    const port = await serve(LEAF + INTER, LEAF_KEY)
    expect((await checkTls('localhost', port, { now: new Date(NOT_AFTER.getTime() - 2.5 * 86_400_000) })).daysLeft).toBe(2)
    expect((await checkTls('localhost', port, { now: new Date(NOT_AFTER.getTime() + 86_400_000) })).daysLeft).toBeLessThan(0)
  })
  it('连不上：拒绝 / 超时', async () => {
    const s = tls.createServer({ cert: SELF, key: SELF_KEY }); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port; s.close()
    expect(await checkTls('127.0.0.1', port)).toMatchObject({ ok: false, error: '连接被拒绝（端口没开）' })
    const net = await import('node:net')
    const silent = net.createServer(() => {}); await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    expect((await checkTls('127.0.0.1', (silent.address() as AddressInfo).port, { timeoutMs: 300 })).error).toContain('超时')
    silent.close()
  })
})

// 「从主机检查」走 openssl s_client：本机 Git Bash 自带 openssl，跑同一条命令（相当于假 SSH 的 exec）
const bash = findBash()
describe.skipIf(!bash && process.platform === 'win32')('openssl s_client 命令（经 bash）', () => {
  it('缺中间证书 / 自签名，与 tls.connect 结论一致', async () => {
    const run = localRunner(bash ?? undefined)
    const p1 = await serve(LEAF, LEAF_KEY), p2 = await serve(SELF, SELF_KEY)
    const r1 = parseOpensslCheck((await run.exec(opensslCheckCommand('localhost', p1), { timeoutMs: 20_000 })).output, 'localhost', new Date())
    if (r1.error?.includes('openssl')) return   // 没装 openssl 的机器跳过
    expect(r1).toMatchObject({ ok: true, chain: 'incomplete', nameMatch: true, subject: 'leaf.test' })
    const r2 = parseOpensslCheck((await run.exec(opensslCheckCommand('selfsigned.test', p2).replace("-connect 'selfsigned.test:", "-connect '127.0.0.1:"), { timeoutMs: 20_000 })).output, 'selfsigned.test', new Date())
    expect(r2).toMatchObject({ ok: true, chain: 'self-signed', nameMatch: true })
  }, 30_000)
})

describe.skipIf(!bash && process.platform === 'win32')('从主机配置发现域名（用本机 bash 假装远端）', () => {
  const posix = (p: string) => (process.platform === 'win32' ? '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/') : p)
  it('只认没注释、真正启用 HTTPS 的虚拟主机；listen 8443 不算 443', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ga-discover-'))
    const put = (rel: string, text: string) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text) }
    try {
      put('nginx/conf.d/ok.conf', 'server {\n  listen 443 ssl;\n  server_name ok.example.com www.ok.example.com;\n}\n')
      put('nginx/conf.d/star.conf', 'server {\n  listen *:443 ssl;\n  server_name star.example.com;\n}\n')
      put('nginx/conf.d/v6.conf', 'server {\n  listen [::]:443 ssl;\n  server_name v6.example.com;\n}\n')
      put('nginx/conf.d/plain.conf', 'server {\n  listen 80;\n  server_name plain.example.com;\n}\n')
      put('nginx/conf.d/other.conf', 'server {\n  listen 8443;\n  server_name eight.example.com;\n}\n')
      put('nginx/conf.d/comment.conf', '# ssl_certificate /x.pem;\nserver { listen 80; server_name c.example.com; }\n')
      put('apache2/sites-enabled/ok.conf', '<VirtualHost *:443>\n  SSLEngine on\n  ServerName ap.example.com\n</VirtualHost>\n')
      put('apache2/sites-enabled/no.conf', '<VirtualHost *:80>\n  # SSLEngine on\n  ServerName no.example.com\n</VirtualHost>\n')
      const out = (await localRunner(bash ?? undefined).exec(certDiscoverCommand(posix(root)), { timeoutMs: 20_000 })).output
      expect(parseCertDiscover(out)).toEqual(['ap.example.com', 'ok.example.com', 'star.example.com', 'v6.example.com', 'www.ok.example.com'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
})

describe('CertMonitor：调度、存储、提醒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ga-certs-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('3 天内到期触发通知与群机器人；同一天不重复；经主机检查失败标原因', async () => {
    const port = await serve(LEAF + INTER, LEAF_KEY)
    const store = new CertStore(dir)
    store.save({ spec: `localhost:${port}` })
    const via = store.save({ spec: 'intranet.local', via: 'h1' })
    let now = new Date(NOT_AFTER.getTime() - 2.5 * 86_400_000)
    const notes: string[] = [], pushes: string[][] = []
    const m = new CertMonitor({
      store, now: () => now, hostLabel: () => '跳板 1',
      runVia: async () => { throw new Error('连接失败') },
      notify: (t, b) => notes.push(`${t}|${b}`), push: async (_t, lines) => { pushes.push(lines); return undefined },
    })
    const s = await m.checkAll()
    expect(s.lastRunAt).toBe(now.toISOString())
    expect(s.results[via.id]).toMatchObject({ ok: false })
    expect(s.results[via.id].error).toContain('经 跳板 1 检查失败')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('2 项需要关注')
    expect(pushes[0].some((l) => l.includes(`localhost:${port}：2 天后到期`))).toBe(true)
    await m.checkAll()
    expect(notes).toHaveLength(1)   // 同一天不重复
    // 关掉群机器人后第二天：只弹通知
    store.setConfig({ webhooks: false })
    now = new Date(now.getTime() + 86_400_000)
    await m.checkAll()
    expect(notes).toHaveLength(2)
    expect(pushes).toHaveLength(1)
  })
  it('tick：不到 24 小时不跑、关了不跑', async () => {
    const store = new CertStore(mkdtempSync(join(tmpdir(), 'ga-certs2-')))
    store.save({ spec: 'a.example' })
    let calls = 0
    const now = new Date('2026-10-18T00:00:00Z')
    const m = new CertMonitor({ store, now: () => now, hostLabel: () => '', runVia: async () => '', notify: () => {}, push: async () => undefined })
    m.checkOne = async () => { calls++; return { at: '', ok: true, daysLeft: 99 } }
    store.putResults({}, { ranAt: new Date(now.getTime() - 3600_000).toISOString() })
    m.tick(); await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(0)
    store.putResults({}, { ranAt: new Date(now.getTime() - 25 * 3600_000).toISOString() })
    m.tick(); await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    store.setConfig({ enabled: false }); store.putResults({}, { ranAt: '2020-01-01T00:00:00Z' })
    m.tick(); await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
  })
  it('存储校验：重复、非法端口', () => {
    const store = new CertStore(mkdtempSync(join(tmpdir(), 'ga-certs3-')))
    store.save({ spec: 'a.com' })
    expect(() => store.save({ spec: 'https://a.com/' })).toThrow('已在列表里')
    expect(() => store.save({ spec: 'a.com:0' })).toThrow()
    expect(store.save({ spec: 'a.com', via: 'h1' }).via).toBe('h1')   // 不同检查位置不算重复
    expect(store.setConfig({ warnDays: 9999 }).warnDays).toBe(30)
  })
})
