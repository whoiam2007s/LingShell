// ssh:// 链接唤起（CMDB / 监控告警 / Wiki 里点 ssh://root@10.0.0.5:22）。
// 只取 用户名 / 主机 / 端口：URL 里的密码、路径、参数一概忽略（网页能诱导唤起，绝不接受命令或凭据）
import type { HostSummary } from '../protocol/index.js'

export interface SshUrlTarget { user?: string; host: string; port: number }

// 主机：域名 / IPv4 / IPv6（去掉方括号；可带 %zone）。不许以 - 开头
const HOST_RE = /^(?!-)[A-Za-z0-9._-]+$|^[0-9A-Fa-f:.]+(%[A-Za-z0-9._-]+)?$/

/** 解析 ssh://[user[;参数][:密码]@]host[:port][/...]；不合法返回 null */
export function parseSshUrl(raw: string): SshUrlTarget | null {
  const s = String(raw ?? '').trim()
  if (!/^ssh:\/\//i.test(s) || s.length > 2048) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  let host = u.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  try { host = decodeURIComponent(host) } catch { return null }
  if (!host || !HOST_RE.test(host)) return null
  const port = u.port ? Number(u.port) : 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  let user: string | undefined
  if (u.username) {
    try { user = decodeURIComponent(u.username).split(';')[0] } catch { return null }   // ;fingerprint=… 之类的连接参数丢掉
    // eslint-disable-next-line no-control-regex
    if (!user || user.length > 128 || /[\x00-\x1f\x7f@\s]/.test(user)) return null
  }
  return { ...(user ? { user } : {}), host, port }
}

/** 从命令行参数里找第一个 ssh:// 链接（Windows 由系统协议注册以 "%1" 传入；second-instance 的 argv 同理） */
export function findSshUrlArg(argv: readonly string[]): string | undefined {
  return argv.find((a) => /^ssh:\/\//i.test(a))
}

/** 匹配已保存主机：地址（不分大小写）+ 端口相同；链接带用户名时用户名也要相同 */
export function matchSshUrlHost(hosts: HostSummary[], t: SshUrlTarget): HostSummary | undefined {
  return hosts.find((h) => h.host.trim().toLowerCase() === t.host.toLowerCase() && h.port === t.port && (!t.user || h.username === t.user))
}
