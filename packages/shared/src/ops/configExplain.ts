// 配置文件带解释查看：按文件名认出常见配置（nginx / sshd / MySQL / Redis / docker-compose / systemd 单元 / fstab / sysctl），
// 一次性模型调用逐段给中文说明 + 风险提示；结果按（类型 + 内容）哈希缓存在数据目录，没改动不重复请求（缓存在主进程，见 desktop/main/ops/configExplainIpc.ts）
import { tk, tr } from '../i18n/i18n.js'

export type ConfigKind = 'nginx' | 'sshd' | 'mysql' | 'redis' | 'compose' | 'systemd' | 'fstab' | 'sysctl'
export const CONFIG_KIND_LABEL: Record<ConfigKind, string> = {
  nginx: tk('nginx 配置'), sshd: tk('OpenSSH 服务端配置（sshd_config）'), mysql: tk('MySQL / MariaDB 配置（my.cnf）'), redis: tk('Redis 配置（redis.conf）'),
  compose: tk('docker-compose 编排文件'), systemd: tk('systemd 单元文件'), fstab: tk('/etc/fstab 挂载表'), sysctl: tk('sysctl 内核参数'),
}
export const EXPLAIN_MAX_LINES = 1500
export const EXPLAIN_MAX_CHARS = 80_000
export const EXPLAIN_VERSION = 1   // 提示词 / 格式变了就加一，旧缓存自动失效

/** 按路径认配置类型（只看文件名和所在目录），认不出 undefined */
export function configKind(path: string): ConfigKind | undefined {
  const p = path.replace(/\\/g, '/').toLowerCase()
  const name = p.split('/').pop() ?? ''
  if (name === 'nginx.conf' || /\/nginx\/(conf\.d|sites-(enabled|available)|vhosts?)\/[^/]+$/.test(p) || /\/nginx\/.+\.conf$/.test(p)) return 'nginx'
  if (name === 'sshd_config' || /\/sshd_config\.d\/[^/]+\.conf$/.test(p)) return 'sshd'
  if (name === 'my.cnf' || name === 'mysqld.cnf' || name === 'mariadb.cnf' || /\/(mysql|mariadb|my\.cnf\.d)\/.*\.cnf$/.test(p)) return 'mysql'
  if (/^redis(-\w+)?\.conf$/.test(name) || /\/redis\/.+\.conf$/.test(p)) return 'redis'
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name)) return 'compose'
  if (/\.(service|timer|socket|mount|path|target|automount|slice)$/.test(name) || /\/systemd\/.+\.d\/[^/]+\.conf$/.test(p)) return 'systemd'
  if (name === 'fstab') return 'fstab'
  if (name === 'sysctl.conf' || /\/sysctl\.d\/[^/]+\.conf$/.test(p)) return 'sysctl'
  return undefined
}

export type ExplainLevel = 'ok' | 'warn' | 'danger'
export interface ExplainItem { start: number; end: number; title: string; explain: string; risk?: string; level: ExplainLevel }
export interface ExplainResult { kind: ConfigKind; items: ExplainItem[]; truncated: boolean; cached?: boolean; at: string }

/** 发给模型的正文：带行号；太长截断（截断的部分不解释） */
export function numberedText(text: string): { body: string; lines: number; truncated: boolean } {
  let ls = text.replace(/\r/g, '').split('\n')
  if (ls.at(-1) === '') ls = ls.slice(0, -1)
  let truncated = ls.length > EXPLAIN_MAX_LINES
  ls = ls.slice(0, EXPLAIN_MAX_LINES)
  const w = String(ls.length).length
  let body = ls.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join('\n')
  if (body.length > EXPLAIN_MAX_CHARS) { body = body.slice(0, EXPLAIN_MAX_CHARS).replace(/\n[^\n]*$/, ''); truncated = true }
  return { body, lines: body.split('\n').length, truncated }
}

export function buildExplainPrompt(r: { kind: ConfigKind; path: string; text: string }): { system: string; user: string; lines: number; truncated: boolean } {
  const n = numberedText(r.text)
  const system = [
    `你是资深 Linux 运维。用户给你一份${CONFIG_KIND_LABEL[r.kind]}（每行前面是行号），请逐段（按块 / 指令）用中文解释它在做什么，并指出风险。`,   // i18n-ignore 提示词
    '要求：',   // i18n-ignore 提示词
    '1. 覆盖所有有效配置，按行号顺序；注释和空行不用单独解释；相关的相邻几行可合成一项，块（如 server { … }、[mysqld]、services: web:）先给一项概述再解释里面的关键指令。',   // i18n-ignore 提示词
    '2. explain 用一两句大白话说明这行 / 这段的作用和当前取值的含义。',   // i18n-ignore 提示词
    '3. 有安全或稳定性风险时写 risk：说明风险并给出建议的改法（如「PermitRootLogin yes：允许 root 远程登录，建议改为 prohibit-password」）；没有就留空字符串。',   // i18n-ignore 提示词
    '4. level：ok = 没问题；warn = 值得注意 / 不是最佳实践；danger = 明显的安全或稳定性风险。',   // i18n-ignore 提示词
    '只输出 JSON 数组，不要代码块、不要其他文字：[{"start":1,"end":1,"title":"指令或块名","explain":"…","risk":"","level":"ok"}]',   // i18n-ignore 提示词
  ].join('\n')
  return { system, user: `文件：${r.path}\n${n.body}`, lines: n.lines, truncated: n.truncated }   // i18n-ignore 提示词
}

/** 模型输出 → 条目（行号夹到 1..lines，按起始行排序，去掉空说明） */
export function parseExplain(raw: string, lines: number): ExplainItem[] | { error: string } {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```(?:json)?/g, '').trim()
  const i = s.indexOf('['), j = s.lastIndexOf(']')
  let arr: unknown
  try { arr = JSON.parse(s.slice(i, j + 1)) } catch { return { error: tr('模型没有按格式返回，请重试') } }
  if (!Array.isArray(arr)) return { error: tr('模型没有按格式返回，请重试') }
  const clamp = (n: unknown) => Math.min(Math.max(1, Math.floor(Number(n) || 1)), Math.max(1, lines))
  const items = arr.flatMap((x): ExplainItem[] => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const explain = String(o.explain ?? '').trim()
    if (!explain) return []
    const start = clamp(o.start ?? o.line), end = Math.max(start, clamp(o.end ?? o.start ?? o.line))
    const level: ExplainLevel = o.level === 'danger' || o.level === 'warn' ? o.level : 'ok'
    const risk = String(o.risk ?? '').trim()
    return [{ start, end, title: String(o.title ?? '').trim().slice(0, 120), explain: explain.slice(0, 1000), ...(risk ? { risk: risk.slice(0, 1000) } : {}), level: risk && level === 'ok' ? 'warn' : level }]
  })
  if (!items.length) return { error: tr('模型没有给出解释，请重试') }
  return items.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** 这一行落在哪些条目里（点行号 / 高亮联动用） */
export const itemsAtLine = (items: ExplainItem[], line: number) => items.filter((x) => line >= x.start && line <= x.end)
