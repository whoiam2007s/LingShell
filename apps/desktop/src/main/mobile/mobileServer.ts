import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { DEVICE_TTL_MS, isPrivateIPv4, type PairResult } from './mobileAuth.js'
import { tr, tk } from '@lingshell/shared'

// 手机查看与授权的 HTTP 服务（局域网，HTTP + 配对令牌）。
// 为什么不是 HTTPS：自签证书在手机浏览器上必报警告，用户习惯性点「继续」反而更危险；局域网内用
// 一次性配对码换长期设备令牌（HttpOnly + SameSite=Strict cookie），所有接口校验令牌。
// 防护：只绑用户选的私有网段地址；只接受私有网段 / 回环来源；校验 Host（挡 DNS 重绑定）；
// POST 要求 JSON + 同源（挡跨站表单）；响应 CSP（脚本 / 样式只认页面内联块的哈希）+ no-store。

export const COOKIE = 'aish_dev'
// cookie 与服务端令牌同一有效期：服务端 verify 也会按 DEVICE_TTL_MS 拒绝过期设备
export const COOKIE_MAX_AGE = Math.floor(DEVICE_TTL_MS / 1000)
const MAX_BODY = 4096

export type DeviceRef = { id: string; name: string }
export interface MobileServerDeps {
  page: string                                     // 手机页 HTML（内联唯一的 <style> 与 <script>）
  isLocked(): boolean
  verify(token: string, ip: string): DeviceRef | undefined
  pair(code: string, name: unknown, ua: string | undefined, ip: string): { token: string; device: DeviceRef } | { error: PairResult }
  sessions(): unknown
  session(id: string): unknown | undefined
  decide(approvalId: string, decision: 'allow' | 'deny', device: DeviceRef, ip: string): { ok: true } | { error: string; status?: number }
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
}

const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
/** 由页面里的内联块算 CSP：除了这两块什么都不许执行 / 加载（不许外链、不许被嵌入） */
export function cspFor(page: string): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
  const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? ''
  return `default-src 'none'; script-src ${sha(script)}; style-src ${sha(style)}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
}

export const remoteIp = (req: IncomingMessage) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
const localSource = (ip: string) => ip === '127.0.0.1' || ip === '::1' || isPrivateIPv4(ip)

export function cookieOf(header: string | undefined, name = COOKIE): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

const PAIR_ERR: Record<Exclude<PairResult, 'ok'>, string> = {
  bad: tk('配对码不对'), expired: tk('配对码已过期，请在电脑上重新生成'), none: tk('电脑上还没有生成配对码'), locked: tk('错误次数过多，已锁定 10 分钟'),
}

export class MobileServer {
  private http?: Server
  private csp: string
  private origin = ''
  private page: string
  // 行尾统一成 \n 再算哈希、再发出去：浏览器解析时会把 \r\n 规整成 \n 再算内联脚本的哈希，
  // 源文件 / 打包产物里带 \r\n（Windows 检出）时两边对不上，脚本被 CSP 拦掉、手机页一片空白
  constructor(private deps: MobileServerDeps) { this.page = deps.page.replace(/\r\n?/g, '\n'); this.csp = cspFor(this.page) }

  get running(): boolean { return !!this.http }

  async start(host: string, port: number): Promise<number> {
    this.stop()
    const http = createServer((req, res) => { this.onRequest(req, res).catch(() => { if (!res.headersSent) this.send(res, 500, { error: 'internal' }) }) })
    http.headersTimeout = 10_000; http.requestTimeout = 15_000
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, host, () => { http.off('error', reject); resolve() })
    })
    this.http = http
    const p = (http.address() as AddressInfo).port
    this.origin = `${host}:${p}`
    return p
  }

  /** 立即停：不再接受新连接，已有的（含 keep-alive）全部断开 */
  stop(): void {
    const h = this.http
    this.http = undefined
    if (!h) return
    h.close()
    h.closeAllConnections()
  }

  private head(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'cache-control': 'no-store', pragma: 'no-cache', 'content-security-policy': this.csp,
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...extra,
    }
  }
  private send(res: ServerResponse, code: number, body: unknown, extra?: Record<string, string>): void {
    res.writeHead(code, this.head({ 'content-type': 'application/json; charset=utf-8', ...extra }))
    res.end(JSON.stringify(body))
  }

  private readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { resolve(undefined); req.destroy() } else chunks.push(c) })
      req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; resolve(v && typeof v === 'object' ? v as Record<string, unknown> : undefined) } catch { resolve(undefined) } })
      req.on('error', () => resolve(undefined))
    })
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = remoteIp(req)
    if (!localSource(ip)) { req.socket.destroy(); return }   // 只服务局域网 / 本机来源
    // Host 必须正好是我们绑的地址:端口（DNS 重绑定时 Host 是攻击者域名）
    if (req.headers.host !== this.origin) return this.send(res, 421, { error: 'bad_host' })
    const url = new URL(req.url ?? '/', `http://${this.origin}`)
    const path = url.pathname

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, this.head({ 'content-type': 'text/html; charset=utf-8' }))
      res.end(this.page)
      return
    }
    if (!path.startsWith('/api/')) return this.send(res, 404, { error: 'not_found' })

    if (req.method === 'POST') {
      // 跨站防护：只收 JSON；带 Origin / Sec-Fetch-Site 的必须同源（SameSite=Strict 之外再加一层）
      const origin = req.headers.origin
      const site = req.headers['sec-fetch-site']
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return this.send(res, 415, { error: 'json_only' })
      if ((origin && origin !== `http://${this.origin}`) || (site && site !== 'same-origin' && site !== 'none')) return this.send(res, 403, { error: 'cross_site' })
    }

    if (req.method === 'POST' && path === '/api/pair') {
      if (this.deps.isLocked()) return this.send(res, 423, { error: 'locked' })
      const body = await this.readJson(req)
      if (!body) return this.send(res, 400, { error: 'bad_json' })
      const r = this.deps.pair(String(body.code ?? ''), body.name, req.headers['user-agent'], ip)
      if ('error' in r) {
        this.deps.log?.('warn', '手机配对失败', { ip, reason: r.error })   // i18n-ignore 日志
        return this.send(res, r.error === 'locked' ? 429 : 403, { error: r.error, message: tr(PAIR_ERR[r.error as Exclude<PairResult, 'ok'>]) })
      }
      this.deps.log?.('info', '手机已配对', { ip, device: r.device.name })   // i18n-ignore 日志
      return this.send(res, 200, { ok: true, name: r.device.name }, {
        'set-cookie': `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      })
    }

    const token = cookieOf(req.headers.cookie)
    const device = token ? this.deps.verify(token, ip) : undefined
    if (!device) return this.send(res, 401, { error: 'unpaired' }, token ? { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` } : undefined)
    if (this.deps.isLocked()) return this.send(res, 423, { error: 'locked' })

    if (req.method === 'GET' && path === '/api/me') return this.send(res, 200, { name: device.name })
    if (req.method === 'GET' && path === '/api/sessions') return this.send(res, 200, this.deps.sessions())
    if (req.method === 'GET' && path === '/api/session') {
      const s = this.deps.session(url.searchParams.get('id') ?? '')
      return s ? this.send(res, 200, s) : this.send(res, 404, { error: 'not_found' })
    }
    if (req.method === 'POST' && path === '/api/decide') {
      const body = await this.readJson(req)
      const decision = body?.decision
      if (!body || typeof body.approvalId !== 'string' || (decision !== 'allow' && decision !== 'deny')) return this.send(res, 400, { error: 'bad_request' })
      const r = this.deps.decide(body.approvalId, decision, device, ip)
      return 'error' in r ? this.send(res, r.status ?? 409, { error: r.error }) : this.send(res, 200, r)
    }
    return this.send(res, 404, { error: 'not_found' })
  }
}
