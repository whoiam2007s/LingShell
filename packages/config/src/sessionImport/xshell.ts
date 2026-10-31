import { tr } from '@lingshell/shared'
import { parseIni, portOf, noUserWarning, type ImportedSession } from './common.js'

// Xshell 会话文件 .xsh（INI，常见 UTF-16LE 带 BOM，解码由调用方做）：
// [CONNECTION] Protocol/Host/Port；[CONNECTION:AUTHENTICATION] UserName/Method/UserKey。
// Method：0=密码 1=公钥 2=键盘交互 …；用户密钥存在 Xshell 自己的密钥库里，读不到，只提示
export function parseXsh(text: string, name: string, group?: string): ImportedSession | { skip: string } {
  const ini = parseIni(text)
  const conn = ini.get('connection'), auth = ini.get('connection:authentication')
  const protocol = conn?.get('protocol') ?? 'SSH'
  if (protocol.toUpperCase() !== 'SSH') return { skip: tr('{name}：协议 {proto} 不是 SSH，已跳过', { name, proto: protocol }) }
  const host = conn?.get('host') ?? ''
  if (!host) return { skip: tr('{name}：没有主机地址，已跳过', { name }) }
  const warnings: string[] = []
  const port = portOf(conn?.get('port'), warnings)
  const username = auth?.get('username') ?? ''
  if (!username) warnings.push(tr(noUserWarning))
  const key = auth?.get('userkey')
  if (auth?.get('method') === '1' && key) warnings.push(tr('原会话用 Xshell 用户密钥「{key}」：请在 Xshell 里导出私钥，再到「SSH 密钥」导入并给该主机选用', { key }))
  return { name, host, port, username, warnings, ...(group ? { group } : {}) }
}
