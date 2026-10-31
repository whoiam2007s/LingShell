import { tr } from '@lingshell/shared'
import { decodeBytes, portOf, splitUserHost, noUserWarning, type ParsedSessions } from './common.js'

// PuTTY 会话在注册表 HKCU\Software\SimonTatham\PuTTY\Sessions\<名称>。
// 读取用 `reg export` 导出的 .reg 文本（UTF-16LE，不受控制台码页影响；用户也可直接选别处导出的 .reg 文件）：
//   [HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\my%20server]
//   "HostName"="1.2.3.4"   "PortNumber"=dword:00000016   "UserName"="root"   "Protocol"="ssh"
// 会话名是 PuTTY 的 %XX 转义（非 ASCII 按系统码页字节转义）。不读密码（PuTTY 本就不存）

/** PuTTY 会话名反转义：%XX → 字节，再按 UTF-8 / GBK 解码 */
export function unescapePuttyName(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const m = s[i] === '%' ? /^[0-9a-fA-F]{2}$/.exec(s.slice(i + 1, i + 3)) : null
    if (m) { bytes.push(parseInt(m[0], 16)); i += 2 }
    else for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b)
  }
  return decodeBytes(Uint8Array.from(bytes))
}

/** .reg 里的字符串值：去引号、反转义 \\ 和 \" */
function regString(v: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(v)
  return m ? m[1].replace(/\\(.)/g, '$1') : undefined
}

export function parsePuttyReg(text: string): ParsedSessions {
  const sessions: ParsedSessions['sessions'] = [], warnings: string[] = []
  const blocks: { name: string; vals: Map<string, string> }[] = []
  let cur: Map<string, string> | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const sec = /^\[(.*)\]$/.exec(line)
    if (sec) {
      const m = /\\PuTTY\\Sessions\\([^\\]+)$/i.exec(sec[1])
      cur = m ? new Map() : undefined
      if (m && cur) blocks.push({ name: unescapePuttyName(m[1]), vals: cur })
      continue
    }
    const kv = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line)
    if (cur && kv) {
      const key = kv[1].toLowerCase(), v = kv[2]
      const dw = /^dword:([0-9a-fA-F]{8})$/.exec(v)
      const s = dw ? String(parseInt(dw[1], 16)) : regString(v)
      if (s !== undefined) cur.set(key, s)
    }
  }
  for (const { name, vals } of blocks) {
    const proto = vals.get('protocol') ?? 'ssh'
    const hostRaw = vals.get('hostname') ?? ''
    if (!hostRaw) { if (name !== 'Default Settings') warnings.push(tr('{name}：没有主机地址，已跳过', { name })); continue }
    if (proto.toLowerCase() !== 'ssh') { warnings.push(tr('{name}：协议 {proto} 不是 SSH，已跳过', { name, proto })); continue }
    const w: string[] = []
    const { user, host } = splitUserHost(hostRaw)
    const username = vals.get('username') || user || ''
    if (!username) w.push(tr(noUserWarning))
    const key = vals.get('publickeyfile')
    if (key) w.push(tr('原会话用私钥文件 {path}：可到「SSH 密钥」导入该文件并给主机选用', { path: key }))
    sessions.push({ name, host, port: portOf(vals.get('portnumber'), w), username, warnings: w })
  }
  return { sessions, warnings }
}
