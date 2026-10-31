import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { NetworkInterfaceInfo } from 'node:os'
import { tr, type MobileAddress } from '@lingshell/shared'

// 手机访问的纯逻辑：绑定地址选择、设备令牌、一次性配对码限流。服务本体见 mobileServer.ts

/** RFC 1918 私有网段（10/8、172.16/12、192.168/16）。回环、链路本地、CGNAT、公网一律不算 */
export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// 排序：无线 / 有线物理网卡在前，虚拟网卡（虚拟机 / WSL / Docker；VirtualBox 仅主机网络默认 192.168.56.x）在后，
// 这样「默认第一个」多半就是手机所在的网络
const rank = (a: MobileAddress) => /vEthernet|VirtualBox|VMware|vmnet|Hyper-V|WSL|docker|br-|veth|Loopback|Tailscale|ZeroTier/i.test(a.name) || a.address.startsWith('192.168.56.') ? 2
  : /WLAN|Wi-?Fi|wlan|wlp|^en0$/i.test(a.name) ? 0 : 1

/** 本机可选的绑定地址：非回环、IPv4、私有网段（os.networkInterfaces() 的结果） */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): MobileAddress[] {
  const out: MobileAddress[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address)) out.push({ address: i.address, name })
  }
  return out.sort((a, b) => rank(a) - rank(b))
}

/** 实际绑定哪个地址：用户选的还在就用它，否则第一个私有地址；都没有 = undefined（不启动） */
export function pickBindAddress(saved: string | undefined, list: MobileAddress[]): string | undefined {
  if (saved && list.some((a) => a.address === saved)) return saved
  return saved ? undefined : list[0]?.address
}

/** 校验用户选的地址：必须是本机当前的私有网段地址（绝不绑 0.0.0.0 / 公网 / 回环） */
export function bindAddressError(addr: string, list: MobileAddress[]): string | undefined {
  if (!isPrivateIPv4(addr)) return tr('{addr} 不是局域网私有地址（只允许 10.x / 172.16–31.x / 192.168.x），为安全起见拒绝', { addr })
  if (!list.some((a) => a.address === addr)) return tr('本机当前没有地址 {addr}（网络可能已切换），请重新选择', { addr })
  return undefined
}

export const PORT_MIN = 1024
export const PORT_MAX = 65535
/** 默认端口：随机高位端口（首次开启时选定并保存，之后 URL 不变） */
export const randomPort = () => randomInt(20000, 61000)

// ── 设备令牌：手机 cookie 里存明文，本地只存 sha256 ──
export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')
/** 定长比较两个 hex 摘要 */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

// ── 配对码：6 位数字、一次性、5 分钟过期；同一来源 IP 错 5 次锁 10 分钟 ──
// 按来源 IP 而不是全局：局域网里任何一台机器连发 5 次错误码，不能把合法手机的配对也锁死（以前会）
export const PAIR_TTL_MS = 5 * 60_000
export const PAIR_MAX_FAILS = 5
export const PAIR_LOCK_MS = 10 * 60_000
export type PairResult = 'ok' | 'bad' | 'expired' | 'none' | 'locked'

export class PairingGate {
  private code?: string
  private expiresAt = 0
  private fails = new Map<string, { n: number; until: number }>()
  constructor(private gen: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0')) {}

  /** 发新码（旧码作废）。某个 IP 被锁不影响桌面端重新发码 */
  issue(now: number): { code: string; expiresAt: number } {
    this.code = this.gen(); this.expiresAt = now + PAIR_TTL_MS
    return { code: this.code, expiresAt: this.expiresAt }
  }

  /** 当前码（过期的不算） */
  current(now: number): { code: string; expiresAt: number } | undefined {
    return this.code && now < this.expiresAt ? { code: this.code, expiresAt: this.expiresAt } : undefined
  }

  lockUntil(now: number, ip = ''): number | undefined {
    const f = this.fails.get(ip)
    return f && f.until > now ? f.until : undefined
  }

  /** 手机提交配对码。成功即作废（一次性）；同一 IP 错误累计到上限只锁这个 IP，不销毁其他人的有效码 */
  attempt(input: string, now: number, ip = ''): PairResult {
    const f = this.fails.get(ip)
    if (f && f.until > now) return 'locked'
    if (!this.code) return 'none'
    if (now >= this.expiresAt) { this.code = undefined; return 'expired' }
    const a = Buffer.from(String(input ?? '').trim()), b = Buffer.from(this.code)
    if (a.length === b.length && timingSafeEqual(a, b)) { this.code = undefined; this.fails.delete(ip); return 'ok' }
    // until=0 表示「只是记错误次数、还没锁」；until>now 的锁在上面的提前返回里已处理，走到这里是锁已到期
    const n = ((f?.until ?? 0) === 0 ? f?.n ?? 0 : 0) + 1
    if (n >= PAIR_MAX_FAILS) { this.fails.set(ip, { n: 0, until: now + PAIR_LOCK_MS }); return 'locked' }
    this.fails.set(ip, { n, until: 0 })
    return 'bad'
  }

  clear(): void { this.code = undefined; this.fails.clear() }
}

/** 已配对设备令牌有效期：绝对过期，到期需重新配对（cookie 的 Max-Age 与它一致） */
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60_000

/** 手机 UA → 好认的设备名（只用于设置页列表辨认，不做任何判断） */
export function deviceNameOf(ua: string | undefined, given?: unknown): string {
  const g = typeof given === 'string' ? [...given.trim()].filter((ch) => ch >= ' ' && ch !== '<' && ch !== '>').join('').slice(0, 40) : ''
  if (g) return g
  const u = ua ?? ''
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : tr('未知设备')
  const br = /MicroMessenger/.test(u) ? tr('微信') : /EdgA?\//.test(u) ? 'Edge' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : tr('浏览器')
  return `${os} · ${br}`
}
