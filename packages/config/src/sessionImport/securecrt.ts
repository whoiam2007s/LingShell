import { tr } from '@lingshell/shared'
import { portOf, noUserWarning, type ImportedSession } from './common.js'

// SecureCRT 会话文件 Config\Sessions\**\<名称>.ini，一行一个：类型:"键"=值
//   S:"Hostname"=10.0.0.1   S:"Username"=root   S:"Protocol Name"=SSH2   D:"[SSH2] Port"=00000016（十六进制）
// __FolderData__.ini / Default.ini 不是会话，由调用方跳过
export function parseSecureCrt(text: string, name: string, group?: string): ImportedSession | { skip: string } {
  const vals = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([SDB]):"([^"]+)"=(.*)$/.exec(raw)
    if (m) vals.set(`${m[1]}:${m[2].toLowerCase()}`, m[3].trim())
  }
  const proto = vals.get('S:protocol name') ?? 'SSH2'
  if (!/^ssh[12]$/i.test(proto)) return { skip: tr('{name}：协议 {proto} 不是 SSH，已跳过', { name, proto }) }
  const host = vals.get('S:hostname') ?? ''
  if (!host) return { skip: tr('{name}：没有主机地址，已跳过', { name }) }
  const warnings: string[] = []
  const port = portOf(vals.get(proto.toUpperCase() === 'SSH1' ? 'D:[ssh1] port' : 'D:[ssh2] port') ?? vals.get('D:port'), warnings, 16)
  const username = vals.get('S:username') ?? ''
  if (!username) warnings.push(tr(noUserWarning))
  return { name, host, port, username, warnings, ...(group ? { group } : {}) }
}
