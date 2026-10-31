// 用 VS Code Remote-SSH 打开远程目录 / 文件：VS Code 走系统 ssh，认 ~/.ssh/config 里的 Host 别名。
// 第一次用某台主机时（经用户确认）往 ~/.ssh/config 末尾写一段带标记注释的托管 Host 块；只增删改自己标记里的内容，用户自己的条目一字不动。
// 不写私钥（应用密钥存在应用里）：agent 主机直接能连，密钥主机要该私钥在 ssh-agent 或 ~/.ssh 里，密码主机由 VS Code 自己弹框问密码。
import { createHash } from 'node:crypto'
import type { AuthType, HostSummary } from '@lingshell/shared'
import { tr } from '@lingshell/shared'

// 写进 ~/.ssh/config 的标记行：靠它找回自己的块，必须固定不翻译
export const BEGIN = (alias: string) => `# >>> 灵壳 LingShell 托管 ${alias}（自动生成，改动会被覆盖）`   // i18n-ignore 配置文件标记
export const END = (alias: string) => `# <<< 灵壳 LingShell 托管 ${alias}`   // i18n-ignore 配置文件标记
const head = (alias: string) => BEGIN(alias).split('（')[0] + '（'   // i18n-ignore 配置文件标记

export interface SshHostEntry { alias: string; host: string; port: number; user: string; proxyJump?: string; proxyCommand?: string }

/** 别名：lingshell-<名称里的 ASCII 部分>-<4 位哈希>（哈希按主机 key，改名不变；不同主机不撞） */
export function remoteAlias(key: string, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return `lingshell-${slug ? `${slug}-` : ''}${createHash('sha256').update(key).digest('hex').slice(0, 4)}`
}

// ssh_config 的值：含空白要加引号（不允许引号与换行，防注入）
const val = (v: string) => { if (/["\r\n]/.test(v)) throw new Error(tr('ssh config 值不能含引号或换行：{v}', { v })); return /\s/.test(v) ? `"${v}"` : v }

export function hostBlock(e: SshHostEntry): string {
  return [
    BEGIN(e.alias),
    `Host ${e.alias}`,
    `  HostName ${val(e.host)}`,
    `  Port ${e.port}`,
    `  User ${val(e.user)}`,
    ...(e.proxyJump ? [`  ProxyJump ${val(e.proxyJump)}`] : []),
    ...(e.proxyCommand ? [`  ProxyCommand ${e.proxyCommand.replace(/[\r\n]+/g, ' ')}`] : []),
    END(e.alias),
  ].join('\n')
}

/** 插入或替换一段托管块（按 BEGIN/END 标记找）；内容没变 changed=false。其它行原样保留，换行风格跟随原文件 */
export function upsertManagedBlock(text: string, alias: string, block: string): { text: string; changed: boolean } {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.length ? text.split(/\r?\n/) : []
  const b = lines.findIndex((l) => l.startsWith(head(alias)))
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && l.trim() === END(alias)) : -1
  const blk = block.split('\n')
  if (b >= 0 && e > b) {
    if (lines.slice(b, e + 1).join('\n') === block) return { text, changed: false }
    lines.splice(b, e - b + 1, ...blk)
    return { text: lines.join(nl), changed: true }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { text: [...lines, ...(lines.length ? [''] : []), ...blk, ''].join(nl), changed: true }
}

export function removeManagedBlock(text: string, alias: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const b = lines.findIndex((l) => l.startsWith(head(alias)))
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && l.trim() === END(alias)) : -1
  if (b < 0 || e < b) return text
  lines.splice(b, e - b + 1 + (lines[e + 1] === '' && b > 0 && lines[b - 1] === '' ? 1 : 0))
  return lines.join(nl)
}

/** 已保存主机 → 托管条目（跳板机递归写成 ProxyJump 别名，最多 5 层）。返回从目标到最外层跳板的条目 */
export function entriesForHost(h: Pick<HostSummary, 'id' | 'label' | 'host' | 'port' | 'username' | 'jumpHostId' | 'proxyCommand'>, find: (id: string) => HostSummary | undefined, depth = 0): SshHostEntry[] {
  if (depth > 5) throw new Error(tr('跳板机层数太多'))
  const jump = h.jumpHostId ? find(h.jumpHostId) : undefined
  const chain = jump ? entriesForHost(jump, find, depth + 1) : []
  const e: SshHostEntry = { alias: remoteAlias(h.id, h.label), host: h.host, port: h.port, user: h.username, ...(chain[0] ? { proxyJump: chain[0].alias } : {}), ...(h.proxyCommand && !jump ? { proxyCommand: h.proxyCommand } : {}) }
  return [e, ...chain]
}

export function authNote(auth: AuthType | undefined): string {
  if (auth === 'agent') return tr('用系统 ssh-agent 认证，VS Code 可以直接连上。')
  if (auth === 'key') return tr('私钥保存在灵壳里，VS Code 拿不到：请把这把私钥加进 ssh-agent（或放在 ~/.ssh 下），否则 VS Code 会改为问密码。')
  if (auth === 'password') return tr('密码主机：VS Code 连接时会自己弹框要密码（灵壳不会把密码写进 ssh config）。')
  return ''
}

/** folder-uri 里的路径按段编码：encodeURI 不编码 # 和 ?，目录名里有它们会把 URI 截断 */
const uriPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/** code 的参数：目录用 --folder-uri；文件用 --remote + -g 路径:行:列 */
export function vscodeRemoteArgs(alias: string, path: string, o: { dir?: boolean; line?: number; col?: number }): string[] {
  if (o.dir) return ['--folder-uri', `vscode-remote://ssh-remote+${alias}${uriPath(path)}`]
  return ['--remote', `ssh-remote+${alias}`, ...(o.line ? ['-g', `${path}:${o.line}:${o.col ?? 1}`] : [path])]
}
