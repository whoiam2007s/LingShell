// 证书与域名巡检（纯逻辑见 shared/ops/certCheck.ts）：本机用 Node tls.connect 读服务器证书链（零依赖），
// 内网域名可选「从某台主机检查」：经该主机的独立 exec channel 跑 openssl s_client（只读）。
// 每天自动查一次（只在应用运行时，同定时巡检）；到期分级变严重 / 3 天内每天 → 系统通知 + 群机器人（复用 webhook.ts）。
// 数据：<配置目录>/certs.json（目标、设置、最近结果、提醒记录）
import tls from 'node:tls'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from '@lingshell/config'
import {
  CERT_CHECK_TIMEOUT_MS, CERT_MAX_TARGETS, CERT_RUN_INTERVAL_MS, DEFAULT_CERT_CONFIG, certAlertLine, certAlerts, certDiscoverCommand, certTargetLabel,
  chainFromNodeError, daysBetween, hostnameMatches, isIpHost, opensslCheckCommand, parseCertDiscover, parseCertSpec, parseOpensslCheck, runPool,
  type CertConfig, type CertNotified, type CertResult, type CertState, type CertTarget, type CertTargetInput,
} from '@lingshell/shared'
import { tr } from '@lingshell/shared'

const errText = (e: unknown) => {
  const c = (e as { code?: string })?.code
  if (c === 'ECONNREFUSED') return tr('连接被拒绝（端口没开）')
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return tr('域名解析失败')
  if (c === 'ECONNRESET') return tr('连接被重置（可能不是 HTTPS 端口）')
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return tr('网络不可达')
  return e instanceof Error ? e.message : String(e)
}
const nameOf = (o: Record<string, string | string[] | undefined> | undefined) => {
  const v = (k: string) => { const x = o?.[k]; return Array.isArray(x) ? x[0] : x }
  const cn = v('CN'), org = v('O')
  return cn && org && cn !== org ? tr('{cn}（{org}）', { cn, org }) : cn ?? org ?? ''
}

/** 本机直连读证书：不校验也能拿到证书，校验结果（authorizationError）单独判断证书链。ca 只给测试用 */
export function checkTls(host: string, port: number, o: { now?: Date; timeoutMs?: number; ca?: string | string[] } = {}): Promise<CertResult> {
  const now = o.now ?? new Date(), at = now.toISOString()
  return new Promise((resolve) => {
    let done = false
    const finish = (r: CertResult) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(r) } }
    const sock = tls.connect({ host, port, rejectUnauthorized: false, ...(isIpHost(host) ? {} : { servername: host }), ...(o.ca ? { ca: o.ca } : {}) }, () => {
      const c = sock.getPeerCertificate(true)
      if (!c || !c.valid_to) return finish({ at, ok: false, error: tr('服务器没有发证书') })
      // 链深度：服务器发来的证书（issuerCertificate 指回自己 = 到顶）
      let depth = 1
      for (let x = c; x.issuerCertificate && x.issuerCertificate !== x && x.issuerCertificate.fingerprint256 !== x.fingerprint256 && depth < 10; x = x.issuerCertificate) depth++
      const san = (c.subjectaltname ?? '').split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '').trim()).filter(Boolean)
      const raw = sock.authorized ? undefined : String((sock.authorizationError as unknown as { code?: string })?.code ?? sock.authorizationError ?? '')
      const err = raw === 'ERR_TLS_CERT_ALTNAME_INVALID' ? undefined : raw   // 域名不符单独看 nameMatch
      const notAfter = new Date(c.valid_to).toISOString()
      const cn = Array.isArray(c.subject?.CN) ? c.subject.CN[0] : c.subject?.CN
      finish({
        at, ok: true, subject: nameOf(c.subject as never), issuer: nameOf(c.issuer as never),
        notBefore: new Date(c.valid_from).toISOString(), notAfter, daysLeft: daysBetween(notAfter, now), san,
        nameMatch: hostnameMatches(host, san, cn), chain: chainFromNodeError(err || undefined, depth), ...(err ? { chainError: err } : {}),
        chainDepth: depth, protocol: sock.getProtocol() ?? undefined,
      })
    })
    const timer = setTimeout(() => finish({ at, ok: false, error: tr('连接超时（{s}s）', { s: (o.timeoutMs ?? CERT_CHECK_TIMEOUT_MS) / 1000 }) }), o.timeoutMs ?? CERT_CHECK_TIMEOUT_MS)
    sock.on('error', (e) => finish({ at, ok: false, error: errText(e) }))
  })
}

interface CertFile { targets?: CertTarget[]; config?: Partial<CertConfig>; results?: Record<string, CertResult>; notified?: Record<string, CertNotified>; lastRunAt?: string }


export class CertStore {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'certs.json') }
  private read(): CertFile { return readJson<CertFile>(this.file) ?? {} }
  private write(f: CertFile): void { writeJson(this.file, f) }
  state(): CertState {
    const f = this.read()
    return { targets: f.targets ?? [], config: { ...DEFAULT_CERT_CONFIG, ...f.config }, results: f.results ?? {}, ...(f.lastRunAt ? { lastRunAt: f.lastRunAt } : {}) }
  }
  notified(): Record<string, CertNotified> { return this.read().notified ?? {} }
  save(input: CertTargetInput): CertTarget {
    const p = parseCertSpec(String(input?.spec ?? ''))
    if ('error' in p) throw new Error(p.error)
    const via = typeof input.via === 'string' && input.via && input.via !== 'local' ? input.via : undefined
    const f = this.read(), all = f.targets ?? []
    if (all.some((t) => t.id !== input.id && t.host === p.host && t.port === p.port && t.via === via)) throw new Error(tr('{target} 已在列表里', { target: certTargetLabel(p) }))
    const i = input.id ? all.findIndex((t) => t.id === input.id) : -1
    if (i < 0 && all.length >= CERT_MAX_TARGETS) throw new Error(tr('最多 {n} 个', { n: CERT_MAX_TARGETS }))
    const t: CertTarget = { id: i >= 0 ? all[i].id : `crt_${randomUUID().slice(0, 8)}`, host: p.host, port: p.port, ...(via ? { via } : {}),
      ...(typeof input.note === 'string' && input.note.trim() ? { note: input.note.trim().slice(0, 100) } : {}), createdAt: i >= 0 ? all[i].createdAt : new Date().toISOString() }
    if (i >= 0) { all[i] = t; delete f.results?.[t.id] } else all.push(t)
    this.write({ ...f, targets: all })
    return t
  }
  delete(id: string): void {
    const f = this.read()
    delete f.results?.[id]; delete f.notified?.[id]
    this.write({ ...f, targets: (f.targets ?? []).filter((t) => t.id !== id) })
  }
  setConfig(patch: Partial<CertConfig>): CertConfig {
    const f = this.read(), cur = { ...DEFAULT_CERT_CONFIG, ...f.config }
    const next: CertConfig = {
      enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : cur.enabled,
      webhooks: typeof patch?.webhooks === 'boolean' ? patch.webhooks : cur.webhooks,
      warnDays: Number.isInteger(patch?.warnDays) && patch.warnDays! >= 1 && patch.warnDays! <= 365 ? patch.warnDays! : cur.warnDays,
    }
    this.write({ ...f, config: next })
    return next
  }
  putResults(rs: Record<string, CertResult>, o: { notified?: Record<string, CertNotified>; ranAt?: string } = {}): void {
    const f = this.read()
    const ids = new Set((f.targets ?? []).map((t) => t.id))
    const results = Object.fromEntries(Object.entries({ ...f.results, ...rs }).filter(([k]) => ids.has(k)))
    this.write({ ...f, results, ...(o.notified ? { notified: o.notified } : {}), ...(o.ranAt ? { lastRunAt: o.ranAt } : {}) })
  }
}

export interface CertMonitorDeps {
  store: CertStore
  now(): Date
  /** 从已保存主机跑命令（openssl / 发现域名），连不上抛错 */
  runVia(hostId: string, command: string, timeoutMs: number): Promise<string>
  hostLabel(hostId: string): string
  notify(title: string, body: string): void
  /** 群机器人；返回失败原因 */
  push(title: string, lines: string[], hosts: string[]): Promise<string | undefined>
  log?(level: 'info' | 'warn', message: string, data?: unknown): void
  tickMs?: number
}

export class CertMonitor {
  private timer?: ReturnType<typeof setInterval>
  private first?: ReturnType<typeof setTimeout>
  private running?: Promise<CertState>
  constructor(private d: CertMonitorDeps) {}

  start(): void {
    this.first ??= setTimeout(() => this.tick(), 60_000)
    this.timer ??= setInterval(() => this.tick(), this.d.tickMs ?? 30 * 60_000)
  }
  stop(): void { clearTimeout(this.first); clearInterval(this.timer); this.first = this.timer = undefined }

  /** 到点（距上次全量检查满 24 小时）就查一遍 */
  tick(): void {
    const s = this.d.store.state()
    if (!s.config.enabled || !s.targets.length) return
    const last = s.lastRunAt ? Date.parse(s.lastRunAt) : 0
    if (this.d.now().getTime() - last >= CERT_RUN_INTERVAL_MS) void this.checkAll().catch((e) => this.d.log?.('warn', '证书巡检失败', { err: String(e) }))   // i18n-ignore 日志
  }

  async checkOne(t: CertTarget): Promise<CertResult> {
    const now = this.d.now()
    if (!t.via) return checkTls(t.host, t.port, { now })
    try { return parseOpensslCheck(await this.d.runVia(t.via, opensslCheckCommand(t.host, t.port), CERT_CHECK_TIMEOUT_MS + 10_000), t.host, now) }
    catch (e) { return { at: now.toISOString(), ok: false, error: tr('经 {host} 检查失败：{err}', { host: this.d.hostLabel(t.via), err: e instanceof Error ? e.message : String(e) }) } }
  }

  /** 查一批（ids 缺省 = 全部；全部时才记「上次全量」并按分级提醒）。同一时刻只跑一轮 */
  async checkAll(ids?: string[]): Promise<CertState> {
    if (this.running && !ids) return this.running
    const run = (async () => {
      const s = this.d.store.state()
      const list = ids ? s.targets.filter((t) => ids.includes(t.id)) : s.targets
      const rs: Record<string, CertResult> = {}
      await runPool(list.length, 4, async (i) => { rs[list[i].id] = await this.checkOne(list[i]) })
      if (ids) { this.d.store.putResults(rs); return this.d.store.state() }
      const all = { ...s.results, ...rs }
      const { alerts, notified } = certAlerts(s.targets, all, this.d.store.notified(), this.d.now(), s.config.warnDays)
      this.d.store.putResults(rs, { notified, ranAt: this.d.now().toISOString() })
      this.d.log?.('info', '证书巡检完成', { targets: list.length, alerts: alerts.length })   // i18n-ignore 日志
      if (alerts.length) {
        const lines = alerts.map((a) => certAlertLine(a.target, a.result, a.level))
        this.d.notify(tr('证书巡检：{n} 项需要关注', { n: alerts.length }), lines.slice(0, 3).join(tr('；')))
        if (s.config.webhooks) {
          const err = await this.d.push(tr('证书到期提醒'), lines, alerts.map((a) => certTargetLabel(a.target))).catch((e: unknown) => String(e))
          if (err) this.d.log?.('warn', `证书提醒推送失败：${err}`)   // i18n-ignore 日志
        }
      }
      return this.d.store.state()
    })()
    if (!ids) this.running = run.finally(() => { this.running = undefined })
    return run
  }

  async discover(hostId: string): Promise<string[]> {
    return parseCertDiscover(await this.d.runVia(hostId, certDiscoverCommand(), 20_000))
  }
}

/** IPC：增删改查 + 立即检查 + 设置 + 从主机发现 */
export function registerCerts(d: { handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void; store: CertStore; monitor: CertMonitor }): void {
  d.handle('certs:list', () => d.store.state())
  d.handle('certs:save', (_e, input) => { d.store.save(input as CertTargetInput); return d.store.state() })
  d.handle('certs:delete', (_e, id) => { if (typeof id === 'string') d.store.delete(id); return d.store.state() })
  d.handle('certs:check', (_e, ids) => d.monitor.checkAll(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : undefined))
  d.handle('certs:setConfig', (_e, patch) => { d.store.setConfig((patch ?? {}) as Partial<CertConfig>); return d.store.state() })
  d.handle('certs:discover', (_e, hostId) => { if (typeof hostId !== 'string' || !hostId) throw new Error(tr('请先选择主机')); return d.monitor.discover(hostId) })
}
