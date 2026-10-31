import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeJson } from '@lingshell/config'
import { redactAi, tr, tk, type AppEvent, type ApprovalAnswer, type MobileAddress, type MobileDevice, type MobileStatus, type SessionMeta } from '@lingshell/shared'
import { DEVICE_TTL_MS, PairingGate, bindAddressError, deviceNameOf, hashToken, newToken, pickBindAddress, randomPort, sameHash, PORT_MIN, PORT_MAX } from './mobileAuth.js'
import { MobileHub, mobileAllowBlock, type PendingApproval } from './mobileHub.js'
import { MobileServer, type DeviceRef } from './mobileServer.js'

// 手机查看与授权（设置 →「手机访问」）：配置 / 已配对设备存 <config>/mobile.json（令牌只存 sha256），
// 授权应答走与桌面端同一个 decideApproval（见 ipc.ts），来自手机的授权在执行记录里标「手机授权」。

type Handle = (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => void
type Log = (level: 'info' | 'warn', message: string, data?: unknown) => void

interface StoredDevice extends MobileDevice { tokenHash: string }
interface MobileConfig { enabled: boolean; address?: string; port: number; devices: StoredDevice[] }

export interface MobileDeps {
  handle: Handle
  file: string                                   // mobile.json
  page: string                                   // 手机页 HTML
  addresses(): MobileAddress[]                   // 本机私有网段地址
  validate?(addr: string, list: MobileAddress[]): string | undefined   // 缺省 bindAddressError（测试可放行回环）
  sessions(): SessionMeta[]
  hostInfo(hostKey: string): { label: string; prod: boolean }
  // 与桌面端 auth:decide 同一路径；返回 false = 已超时 / 已被处理
  decideApproval(approvalId: string, ans: ApprovalAnswer, mobileSessionId: string): boolean
  isLocked(): boolean
  secrets(): string[]
  mask?(text: string): string                    // 密钥保险箱明文 → 占位符（不受脱敏开关影响）
  log: Log
  now?(): number
}

const REASON: Record<string, string> = { first_access: tk('首次访问该主机'), elevation: tk('请求提升为写入权限'), dangerous_command: tk('命中危险命令模式') }

export function registerMobile(d: MobileDeps) {
  const now = d.now ?? Date.now
  const load = (): MobileConfig => {
    try {
      const c = JSON.parse(readFileSync(d.file, 'utf8')) as Partial<MobileConfig>
      return { enabled: c.enabled === true, address: typeof c.address === 'string' ? c.address : undefined, port: Number(c.port) || randomPort(), devices: Array.isArray(c.devices) ? c.devices : [] }
    } catch { return { enabled: false, port: randomPort(), devices: [] } }
  }
  const cfg = load()
  // 原子写：写到一半崩溃不会把已配对设备清单清空（以前直接 writeFileSync，解析失败按「没有设备」处理）
  const save = () => writeJson(d.file, cfg)

  const hub = new MobileHub(now)
  const gate = new PairingGate()
  // 脱敏：保险箱值先回写成 {{secret:名称}}（4 位也认，不受脱敏开关影响），再按已知机密 + 样式识别；机密清单 5 秒缓存
  let secretCache: { at: number; list: string[] } | undefined
  const invalidateSecrets = () => { secretCache = undefined }
  const red = (s: string | undefined) => {
    if (!s) return s
    if (!secretCache || now() - secretCache.at > 5000) { try { secretCache = { at: now(), list: d.secrets() } } catch { secretCache = { at: now(), list: [] } } }
    return redactAi(s, secretCache.list, d.mask)
  }
  const expiresOf = (dev: { createdAt: number; expiresAt?: number }) => dev.expiresAt ?? (Number.isFinite(dev.createdAt) ? dev.createdAt + DEVICE_TTL_MS : 0)

  const approvalView = (a: PendingApproval) => {
    const au = a.auth
    const host = au ? d.hostInfo(au.terminalId) : undefined
    const targets = au?.targets?.map((t) => d.hostInfo(t.hostKey))
    const prod = !!host?.prod || !!targets?.some((t) => t.prod) || !!a.plan?.steps.some((s) => d.hostInfo(s.hostKey).prod)
    const block = mobileAllowBlock(a, prod)
    return {
      approvalId: a.approvalId, kind: a.kind, deadline: a.deadline, prod, canAllow: !block, ...(block ? { block } : {}),
      ...(au ? {
        tool: au.tool, risk: au.risk, reason: au.mcp ? tr('外部工具调用') : au.tool === 'write_file' ? tr('修改文件（改动详情请在电脑上查看）') : REASON[au.reason] ? tr(REASON[au.reason]) : au.reason,
        command: red(au.command ?? (au.mcp ? `${au.mcp.server} · ${au.mcp.tool}` : '')),
        host: targets?.length ? targets.map((t) => t.label).join(tr('、')) : host?.label,
        ...(au.explain ? { explain: red(au.explain) } : {}),
        ...(au.rule ? { rule: au.rule } : {}),
        ...(au.rollback ? { rollback: red(au.rollback) } : {}),
        ...(au.rollbackMissing ? { rollbackMissing: true } : {}),
      } : {}),
      ...(a.plan ? { title: red(a.plan.title), steps: a.plan.steps.map((s) => ({ host: d.hostInfo(s.hostKey).label, command: red(s.command), dangerous: s.dangerous })) } : {}),
    }
  }
  const updatedOf = (m: SessionMeta) => Math.max(Date.parse(m.lastActiveAt) || 0, hub.updatedAt(m.id) ?? 0)

  const server = new MobileServer({
    page: d.page,
    isLocked: d.isLocked,
    verify: (token, ip) => {
      const h = hashToken(token)
      const i = cfg.devices.findIndex((x) => sameHash(x.tokenHash, h))
      if (i < 0) return undefined
      const dev = cfg.devices[i]
      const t = now()
      if (t >= expiresOf(dev)) {
        cfg.devices.splice(i, 1); save()
        d.log('info', '手机设备已过期', { device: dev.name })   // i18n-ignore 日志
        return undefined
      }
      if (!dev.lastSeenAt || t - dev.lastSeenAt > 60_000 || dev.lastIp !== ip) { dev.lastSeenAt = t; dev.lastIp = ip; save() }
      return { id: dev.id, name: dev.name }
    },
    pair: (code, name, ua, ip) => {
      const r = gate.attempt(code, now(), ip)
      if (r !== 'ok') return { error: r }
      const token = newToken()
      const dev: StoredDevice = { id: randomUUID(), name: deviceNameOf(ua, name), createdAt: now(), expiresAt: now() + DEVICE_TTL_MS, lastSeenAt: now(), lastIp: ip, tokenHash: hashToken(token) }
      cfg.devices.push(dev); save()
      return { token, device: { id: dev.id, name: dev.name } }
    },
    sessions: () => ({
      sessions: [...d.sessions()].sort((a, b) => updatedOf(b) - updatedOf(a)).slice(0, 50).map((m) => ({
        id: m.id, title: red(m.title), status: hub.status(m.id), updatedAt: updatedOf(m), pending: hub.pending(m.id).length,
      })),
    }),
    session: (id) => {
      const m = d.sessions().find((x) => x.id === id)
      if (!m) return undefined
      return {
        id, title: red(m.title), status: hub.status(id), updatedAt: updatedOf(m),
        items: hub.items(id).map((it) => ({ ...it, text: red(it.text) })),
        approvals: hub.pending(id).map(approvalView),
      }
    },
    decide: (approvalId, decision, device: DeviceRef, ip) => {
      const a = hub.approval(approvalId)
      if (!a || a.deadline <= now()) return { error: tr('这条授权已处理或已超时'), status: 410 }
      if (decision === 'allow') {
        const block = approvalView(a).block
        if (block) return { error: block, status: 403 }
      }
      if (!d.decideApproval(approvalId, { decision }, a.sessionId)) return { error: tr('这条授权已处理或已超时'), status: 410 }
      d.log('info', '手机授权', {   // i18n-ignore 日志
        device: device.name, ip, sessionId: a.sessionId, tool: a.auth?.tool ?? 'plan', decision })
      return { ok: true }
    },
    log: d.log,
  })

  let bound: string | undefined
  let error: string | undefined
  let chain = Promise.resolve()
  // 按当前配置（重新）起停服务；串行，避免连点开关时两次 listen 打架
  const apply = () => (chain = chain.then(async () => {
    server.stop(); bound = undefined; error = undefined
    if (!cfg.enabled) { gate.clear(); return }
    const list = d.addresses()
    const addr = pickBindAddress(cfg.address, list)
    if (!addr) { error = cfg.address ? tr('本机当前没有地址 {addr}（网络可能已切换），请重新选择网卡地址', { addr: cfg.address }) : tr('本机没有局域网私有地址（10.x / 172.16–31.x / 192.168.x），无法开启'); return }
    const bad = (d.validate ?? bindAddressError)(addr, list)
    if (bad) { error = bad; return }
    try {
      await server.start(addr, cfg.port)
      bound = addr
      d.log('info', '手机访问已开启', { address: addr, port: cfg.port })   // i18n-ignore 日志
    } catch (e) {
      const code = (e as { code?: string }).code
      error = code === 'EADDRINUSE' ? tr('端口 {port} 已被占用，请换一个端口', { port: cfg.port }) : tr('启动失败：{err}', { err: (e as Error).message })
      d.log('warn', '手机访问启动失败', { address: addr, port: cfg.port, error })   // i18n-ignore 日志
    }
  }).catch((e: unknown) => { error = String(e) }))

  const status = (): MobileStatus => {
    const t = now()
    return {
      enabled: cfg.enabled, running: server.running, port: cfg.port,
      ...(bound ? { url: `http://${bound}:${cfg.port}/` } : {}),
      ...(cfg.address ? { address: cfg.address } : {}),
      addresses: d.addresses(),
      ...(error ? { error } : {}),
      devices: cfg.devices.map(({ tokenHash: _h, ...x }) => ({ ...x, expiresAt: expiresOf(x) })),
      ...(server.running && gate.current(t) ? { pairing: gate.current(t) } : {}),
    }
  }

  d.handle('mobile:status', () => status())
  d.handle('mobile:setEnabled', async (_e, on) => {
    cfg.enabled = on === true; save()
    if (!cfg.enabled) d.log('info', '手机访问已关闭')   // i18n-ignore 日志
    await apply()
    return status()
  })
  d.handle('mobile:configure', async (_e, raw) => {
    const c = (raw ?? {}) as { address?: unknown; port?: unknown }
    if (c?.address !== undefined) {
      const addr = String(c.address)
      const bad = (d.validate ?? bindAddressError)(addr, d.addresses())
      if (bad) throw new Error(bad)
      cfg.address = addr
    }
    if (c?.port !== undefined) {
      const p = Math.floor(Number(c.port))
      if (!(p >= PORT_MIN && p <= PORT_MAX)) throw new Error(tr('端口须在 {min}–{max} 之间', { min: PORT_MIN, max: PORT_MAX }))
      cfg.port = p
    }
    save()
    if (cfg.enabled) await apply()
    return status()
  })
  d.handle('mobile:newPairCode', () => {
    if (!server.running) throw new Error(tr('请先开启手机访问'))
    // 某个来源 IP 被锁不影响重新发码：否则局域网里任何人都能靠乱试让用户一直配不上手机
    gate.issue(now())
    d.log('info', '已生成手机配对码')   // i18n-ignore 日志
    return status()
  })
  d.handle('mobile:revoke', (_e, id) => {
    const dev = cfg.devices.find((x) => x.id === id)
    cfg.devices = cfg.devices.filter((x) => x.id !== id); save()
    if (dev) d.log('info', '已撤销手机设备', { device: dev.name })   // i18n-ignore 日志
    return status()
  })
  d.handle('mobile:revokeAll', () => {
    const n = cfg.devices.length
    cfg.devices = []; save()
    if (n) d.log('info', '已撤销全部手机设备', { count: n })   // i18n-ignore 日志
    return status()
  })

  if (cfg.enabled) void apply()
  return {
    onEvent: (ev: AppEvent) => hub.onEvent(ev),
    stop: () => { server.stop() },
    invalidateSecrets,   // 保险箱值改动后立即生效（不必等 5 秒缓存）
    ready: () => chain,   // 测试用：等当前起停完成
  }
}
