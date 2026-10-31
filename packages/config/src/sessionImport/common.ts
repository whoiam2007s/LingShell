// 会话导入公共部分：解析结果类型、文本解码（UTF-16LE / UTF-8 / GBK）、简易 INI 解析
import { tr, tk } from '@lingshell/shared'

/** 从其它客户端解析出的一条 SSH 会话（不含任何凭据） */
export interface ImportedSession {
  name: string
  host: string
  port: number
  username: string
  group?: string           // 原软件里的文件夹，多级用 / 连接
  warnings: string[]
}
/** 解析一批的结果：warnings 含非 SSH 等被跳过的说明 */
export interface ParsedSessions { sessions: ImportedSession[]; warnings: string[] }

/** 字节 → 文本：认 BOM（UTF-16LE/BE、UTF-8）；无 BOM 时按 UTF-16LE 特征 / 合法 UTF-8 / GBK 依次判断 */
export function decodeBytes(b: Uint8Array): string {
  const buf = Buffer.from(b)
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) return buf.toString('utf16le')   // 无 BOM 的 UTF-16LE（ASCII 开头）
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch {
    try { return new TextDecoder('gbk').decode(buf) } catch { return buf.toString('latin1') }   // 中文 Windows 的 ANSI 码页
  }
}

/** INI → 段名(小写) → 键(小写) → 值。键值以第一个 = 分隔；; 和 # 开头为注释 */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  let cur = new Map<string, string>()
  out.set('', cur)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.*)\]$/.exec(line)
    if (sec) {
      const name = sec[1].trim().toLowerCase()
      cur = out.get(name) ?? new Map()
      out.set(name, cur)
      continue
    }
    const i = line.indexOf('=')
    if (i > 0) cur.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  return out
}

/** 端口：合法则用，否则 22 并给警告 */
export function portOf(v: string | undefined, warnings: string[], radix = 10): number {
  if (v === undefined || v === '') return 22
  const n = parseInt(v, radix)
  if (Number.isInteger(n) && n > 0 && n < 65536) return n
  warnings.push(tr('端口无效（{port}），按 22 处理', { port: v }))
  return 22
}

/** 地址里带 user@ 时拆出来（PuTTY 的 HostName 允许这么写） */
export function splitUserHost(host: string): { user?: string; host: string } {
  const i = host.lastIndexOf('@')
  return i > 0 ? { user: host.slice(0, i), host: host.slice(i + 1) } : { host }
}

// 显示处（各来源 push 进 warnings 时）再 tr()
export const noUserWarning = tk('原会话未设置用户名：导入后请编辑主机填写')
