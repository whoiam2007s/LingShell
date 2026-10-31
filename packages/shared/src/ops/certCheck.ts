// 证书与域名巡检（纯逻辑）：目标解析、域名匹配、证书链判定、到期分级、openssl 输出解析、提醒去重、从主机配置发现域名。
// 主进程（本机 tls.connect / 经主机 openssl s_client、每天调度、通知与群机器人）见 desktop/main/ops/certCheck.ts
import { shq } from '../files/explorer.js'
import { parseOpensslDate } from './hostProfile.js'
import { tk, tr } from '../i18n/i18n.js'

export interface CertTarget {
  id: string
  host: string
  port: number
  via?: string          // 从哪台已保存主机检查（内网域名）；缺省 = 本机
  note?: string
  createdAt: string
}
export interface CertTargetInput { id?: string; spec: string; via?: string; note?: string }

export type ChainState = 'ok' | 'incomplete' | 'self-signed' | 'untrusted' | 'expired'
export interface CertResult {
  at: string
  ok: boolean               // 连上并拿到证书
  error?: string
  subject?: string
  issuer?: string
  notBefore?: string        // ISO
  notAfter?: string         // ISO
  daysLeft?: number
  san?: string[]
  nameMatch?: boolean
  chain?: ChainState
  chainError?: string       // 原始错误码 / openssl verify 文本
  chainDepth?: number       // 服务器发来的证书数（含叶子）
  protocol?: string
}
export interface CertConfig { enabled: boolean; warnDays: number; webhooks: boolean }
export const DEFAULT_CERT_CONFIG: CertConfig = { enabled: true, warnDays: 30, webhooks: true }
export const CERT_CHECK_TIMEOUT_MS = 10_000
export const CERT_RUN_INTERVAL_MS = 24 * 3600_000
export const CERT_MAX_TARGETS = 200

export type CertLevel = 'error' | 'expired' | 'red' | 'orange' | 'yellow' | 'ok'
export const CERT_LEVEL_LABEL: Record<CertLevel, string> = { error: tk('检查失败'), expired: tk('已过期'), red: tk('3 天内到期'), orange: tk('14 天内到期'), yellow: tk('即将到期'), ok: tk('正常') }
const RANK: Record<CertLevel, number> = { ok: 0, yellow: 1, orange: 2, red: 3, expired: 4, error: 1 }

/** 剩余天数分级：<0 已过期；≤3 红；≤14 橙；≤warnDays（默认 30）黄 */
export function certLevel(r: CertResult | undefined, warnDays = 30): CertLevel {
  if (!r) return 'ok'
  if (!r.ok || r.daysLeft === undefined) return 'error'
  const d = r.daysLeft
  return d < 0 ? 'expired' : d <= 3 ? 'red' : d <= 14 ? 'orange' : d <= warnDays ? 'yellow' : 'ok'
}

const DAY = 86_400_000
export const daysBetween = (notAfter: string, now: Date) => Math.floor((Date.parse(notAfter) - now.getTime()) / DAY)

/** 「域名[:端口]」：也接受 https://x/y、[::1]:8443、1.2.3.4:443；端口缺省 443 */
export function parseCertSpec(spec: string): { host: string; port: number } | { error: string } {
  let s = spec.trim()
  if (!s) return { error: tr('请填写域名或 主机:端口') }
  s = s.replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
  s = s.replace(/^[^@]*@/, '')
  let host = s, port = 443
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) { host = v6[1]; if (v6[2]) port = +v6[2] }
  else {
    const m = /^([^:]+):(\d+)$/.exec(s)
    if (m) { host = m[1]; port = +m[2] }
    else if (s.includes(':')) return { error: tr('IPv6 地址请写成 [地址]:端口') }
  }
  host = host.toLowerCase().replace(/\.$/, '')
  if (!/^[a-z0-9.\-_:]+$/.test(host) || host.length > 253) return { error: tr('不是有效的域名或地址：{v}', { v: host }) }
  if (!(port >= 1 && port <= 65535)) return { error: tr('端口要在 1–65535 之间') }
  return { host, port }
}

export const isIpHost = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')
export const certTargetLabel = (t: Pick<CertTarget, 'host' | 'port'>) => (t.host.includes(':') ? `[${t.host}]` : t.host) + (t.port === 443 ? '' : `:${t.port}`)

/** SAN 列表 + CN 判断域名是否匹配；通配符只配一级（*.a.com 配 x.a.com，不配 a.com、x.y.a.com） */
export function hostnameMatches(host: string, san: string[], cn?: string): boolean {
  const h = host.toLowerCase()
  const names = san.length ? san : cn ? [cn] : []
  return names.some((raw) => {
    const n = raw.toLowerCase().replace(/^(dns|ip address|ip):/i, '').trim()
    if (n === h) return true
    if (!n.startsWith('*.')) return false
    const rest = n.slice(2), i = h.indexOf('.')
    return i > 0 && h.slice(i + 1) === rest && !isIpHost(h)
  })
}

// 「找不到签发者」：服务器只发了叶子证书 = 缺中间证书；发了多张还找不到 = 根证书不受信任（私有 CA）
/** Node 的 authorizationError 码 → 证书链状态（depth = 服务器发来的证书数） */
export function chainFromNodeError(code: string | undefined, depth = 1): ChainState {
  if (!code || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'ok'   // 域名不符单独看 nameMatch
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'incomplete'
  if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'UNABLE_TO_GET_ISSUER_CERT') return depth > 1 ? 'untrusted' : 'incomplete'
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'self-signed'
  if (code === 'CERT_HAS_EXPIRED') return 'expired'
  return 'untrusted'
}
/** openssl「Verify return code: N (...)」→ 证书链状态 */
export function chainFromOpensslCode(code: number, depth = 1): ChainState {
  if (code === 0) return 'ok'
  if (code === 21) return 'incomplete'
  if (code === 20 || code === 2) return depth > 1 ? 'untrusted' : 'incomplete'
  if (code === 18) return 'self-signed'
  if (code === 10) return 'expired'
  return 'untrusted'
}
export const CHAIN_LABEL: Record<ChainState, string> = { ok: tk('完整可信'), incomplete: tk('缺中间证书'), 'self-signed': tk('自签名'), untrusted: tk('不受信任'), expired: tk('链上有过期证书') }

/** 经主机检查：openssl s_client 取服务器发来的证书链与校验结果，再用 openssl x509 读叶子证书 */
export function opensslCheckCommand(host: string, port: number, timeoutSec = 10): string {
  const addr = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  const sni = isIpHost(host) ? '' : ` -servername ${shq(host)}`
  return [
    'command -v openssl >/dev/null 2>&1 || { echo "@@noopenssl"; exit 0; }',
    'if command -v timeout >/dev/null 2>&1; then TO="timeout ' + timeoutSec + '"; else TO=""; fi',
    `O=$(echo | $TO openssl s_client -connect ${shq(addr)}${sni} -showcerts 2>&1 </dev/null)`,
    'echo "@@sclient"; printf "%s\\n" "$O" | grep -E "Verify return code|Protocol *:|^New, |^ *[0-9]+ s:|errno|connect:|refused|getaddrinfo|Name or service|timed out|no peer certificate|handshake failure" | head -n 40',
    'echo "@@x509"; printf "%s\\n" "$O" | openssl x509 -noout -subject -issuer -startdate -enddate -text 2>&1 | grep -E "^(subject|issuer|notBefore|notAfter)=|DNS:|IP Address:|unable to load" | head -n 20',
  ].join('\n')
}

// subject=CN = a.com, O = x 或 subject= /CN=a.com/O=x → 取 CN（没有就整串）
const cnOf = (s: string) => /CN\s*=\s*([^,/\n]+)/.exec(s)?.[1].trim()
const nameOf = (s: string) => { const o = /\bO\s*=\s*([^,/\n]+)/.exec(s)?.[1].trim(); const cn = cnOf(s); return cn && o && o !== cn ? `${cn}${tr('（{v}）', { v: o })}` : cn ?? o ?? s.trim() }

export function parseOpensslCheck(out: string, host: string, now: Date): CertResult {
  const at = now.toISOString()
  if (out.includes('@@noopenssl')) return { at, ok: false, error: tr('这台主机上没有 openssl 命令') }
  const sec = (k: string) => { const i = out.indexOf(`@@${k}`); if (i < 0) return [] as string[]; const rest = out.slice(i + k.length + 2); const j = rest.indexOf('\n@@'); return (j < 0 ? rest : rest.slice(0, j)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) }
  const sc = sec('sclient'), x = sec('x509')
  const field = (k: string) => x.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim()
  const notAfter = field('notAfter') && parseOpensslDate(field('notAfter')!)
  if (!notAfter) {
    const why = sc.find((l) => /refused/i.test(l)) ? tr('连接被拒绝（端口没开）')
      : sc.find((l) => /getaddrinfo|Name or service|nodename/i.test(l)) ? tr('域名解析失败')
      : sc.find((l) => /timed out/i.test(l)) || !sc.length ? tr('连接超时') : sc.find((l) => /handshake failure|no peer certificate/i.test(l)) ? tr('TLS 握手失败（可能不是 HTTPS 端口）') : (sc[0] ?? tr('拿不到证书'))
    return { at, ok: false, error: why }
  }
  const san = x.flatMap((l) => (/DNS:|IP Address:/.test(l) ? l.split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '').trim()).filter(Boolean) : []))
  const subject = field('subject') ?? ''
  const vr = /Verify return code:\s*(\d+)\s*\(([^)]*)\)/.exec(sc.join('\n'))
  const code = vr ? +vr[1] : undefined
  const proto = /Protocol\s*:\s*(\S+)/.exec(sc.join('\n'))?.[1] ?? /^New, (TLSv[\d.]+)/m.exec(sc.join('\n'))?.[1]
  const notBefore = field('notBefore') && parseOpensslDate(field('notBefore')!)
  const depth = sc.filter((l) => /^\d+ s:/.test(l)).length
  return {
    at, ok: true, subject: nameOf(subject), issuer: nameOf(field('issuer') ?? ''),
    ...(notBefore ? { notBefore } : {}), notAfter, daysLeft: daysBetween(notAfter, now), san,
    nameMatch: hostnameMatches(host, san, cnOf(subject)),
    ...(code !== undefined ? { chain: chainFromOpensslCode(code, depth), ...(code ? { chainError: `${code} (${vr![2]})` } : {}) } : {}),
    ...(depth ? { chainDepth: depth } : {}),
    ...(proto ? { protocol: proto } : {}),
  }
}

/** 提醒去重：分级变严重就提醒；红 / 已过期 / 检查失败每天最多一次；恢复正常后清掉记录（下次再到期重新提醒） */
export interface CertNotified { level: CertLevel; day: string }
export function certAlerts(targets: CertTarget[], results: Record<string, CertResult>, notified: Record<string, CertNotified>, now: Date, warnDays = 30):
  { alerts: { target: CertTarget; level: CertLevel; result: CertResult }[]; notified: Record<string, CertNotified> } {
  const day = now.toISOString().slice(0, 10)
  const next: Record<string, CertNotified> = {}
  const alerts: { target: CertTarget; level: CertLevel; result: CertResult }[] = []
  for (const t of targets) {
    const r = results[t.id]
    if (!r) { if (notified[t.id]) next[t.id] = notified[t.id]; continue }
    const level = certLevel(r, warnDays), prev = notified[t.id]
    if (level === 'ok') continue
    const worse = !prev || RANK[level] > RANK[prev.level] || (prev.level === 'error') !== (level === 'error')
    const daily = RANK[level] >= RANK.red || level === 'error'
    if (worse || (daily && prev?.day !== day)) { alerts.push({ target: t, level, result: r }); next[t.id] = { level, day } }
    else next[t.id] = prev
  }
  return { alerts, notified: next }
}

export function certAlertLine(t: CertTarget, r: CertResult, level: CertLevel): string {
  const name = certTargetLabel(t)
  if (level === 'error') return tr('{name}：检查失败（{why}）', { name, why: r.error ?? tr('未知原因') })
  if (level === 'expired') return tr('{name}：已过期 {n} 天（{date}）', { name, n: -(r.daysLeft ?? 0), date: String(r.notAfter?.slice(0, 10)) })
  return tr('{name}：{n} 天后到期（{date}）', { name, n: String(r.daysLeft), date: String(r.notAfter?.slice(0, 10)) })
}

// 从主机配置发现域名：nginx 里有 ssl / 443 的 server 块的 server_name，apache 里 SSLEngine on 的虚拟主机的 ServerName / ServerAlias。
// 只认没注释掉、行首开始的指令；443 前面必须是空白或冒号（避免把 listen 8443 当成 443）
export function certDiscoverCommand(root = '/etc'): string {
  return [
    `R=${shq(root)}`,
    'for f in "$R"/nginx/nginx.conf "$R"/nginx/conf.d/*.conf "$R"/nginx/sites-enabled/*; do',
    '  [ -f "$f" ] && grep -qE \'^[[:space:]]*ssl_certificate|^[[:space:]]*listen[^;]*(:|[[:space:]])443[[:space:];]\' "$f" 2>/dev/null && grep -hE "^[[:space:]]*server_name[[:space:]]" "$f" 2>/dev/null | sed "s/^/@@ng /"',
    'done',
    'for f in "$R"/httpd/conf.d/*.conf "$R"/apache2/sites-enabled/* "$R"/httpd/conf/httpd.conf; do',
    '  [ -f "$f" ] && grep -qiE "^[[:space:]]*SSLEngine[[:space:]]+on" "$f" 2>/dev/null && grep -hiE "^[[:space:]]*Server(Name|Alias)[[:space:]]" "$f" 2>/dev/null | sed "s/^/@@ap /"',
    'done',
    'echo "@@end"',
  ].join('\n')
}

export function parseCertDiscover(out: string): string[] {
  const names = new Set<string>()
  for (const l of out.split(/\r?\n/)) {
    const m = /^@@(ng|ap)\s+\s*(?:server_name|ServerName|ServerAlias)\s+(.*)$/i.exec(l.trim())
    if (!m) continue
    for (let n of m[2].replace(/;.*$/, '').split(/\s+/)) {
      n = n.toLowerCase().replace(/:\d+$/, '')
      if (!n || n === '_' || n === 'localhost' || n.startsWith('*') || n.startsWith('~') || n.includes('$') || !/\./.test(n)) continue
      names.add(n)
    }
  }
  return [...names].sort()
}
export interface CertState { targets: CertTarget[]; config: CertConfig; results: Record<string, CertResult>; lastRunAt?: string }
