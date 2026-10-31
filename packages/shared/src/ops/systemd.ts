// systemd 服务视图：systemctl 命令构造 + 纯解析 / 过滤 / 排序。只支持 Linux 的 SSH 终端，走独立 exec channel（execRead），不碰交互 shell。
// 列表 = list-units（加载了的服务：运行状态 + 描述）合并 list-unit-files（开机自启状态，含没加载的服务）。
// 启停等操作：root 直接跑，否则 sudo -n（免密 sudo 才行，要密码直接失败，stderr 原样给人看）
import { shq } from '../files/explorer.js'
import type { TermOs, TerminalType } from '../protocol/index.js'
import { tk, tr } from '../i18n/i18n.js'

export type SvcAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'
export interface SvcRow {
  name: string          // nginx.service
  description: string
  load: string          // loaded / not-found / masked / ''（没加载）
  active: string        // active / inactive / failed / activating / deactivating / reloading
  sub: string           // running / exited / dead / failed …
  enabled?: string      // enabled / disabled / static / masked / indirect / generated …（list-unit-files 没有该服务时为空）
}
export interface SvcList { rows: SvcRow[]; noSystemd?: string }   // noSystemd 有值 = 这台主机不能用 systemctl（原因）

export const SYSTEMD_TIMEOUT_MS = 15_000
export const SYSTEMD_ACTION_TIMEOUT_MS = 90_000   // restart 会等服务起来，给足时间
export const SVC_ACTIONS: SvcAction[] = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']
export const SVC_ACTION_LABEL: Record<SvcAction, string> = {
  start: tk('启动'), stop: tk('停止'), restart: tk('重启'), reload: tk('重新加载'), enable: tk('设为开机自启'), disable: tk('取消开机自启'),
}
export const systemdSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows' && os !== 'macos'
export const isSvcAction = (s: unknown): s is SvcAction => typeof s === 'string' && (SVC_ACTIONS as string[]).includes(s)
// 服务名只允许 systemd 单元字符（含转义用的 \），且必须是 .service；拼命令时仍会加引号
const UNIT = /^[\w@.:\\-]{1,256}$/
export const isSvcName = (s: unknown): s is string => typeof s === 'string' && UNIT.test(s) && s.endsWith('.service') && !s.startsWith('-')

const RC = '@@rc:'
const NO = '@@nosystemd:'
const wrap = (script: string) => `sh -c ${shq(`export LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat; ${script}`)}`
const name = (s: string) => { if (!isSvcName(s)) throw new Error(tr('非法的服务名：{name}', { name: s })); return shq(s) }

export const systemdListCommand = () => wrap([
  `command -v systemctl >/dev/null 2>&1 || { echo "${NO}missing"; exit 0; }`,
  // 容器 / WSL 里有 systemctl 但 PID 1 不是 systemd：systemctl 会报 not been booted with systemd，解析时认
  'echo "@@units"; systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1',
  'echo "@@files"; systemctl list-unit-files --type=service --no-pager --plain --no-legend 2>&1',
].join('; '))
export const systemdStatusCommand = (svc: string, lines = 30) => wrap(`systemctl status ${name(svc)} --no-pager -l -n ${Math.max(1, Math.floor(lines))} 2>&1; echo "${RC}$?"`)
export const systemdActionCommand = (a: SvcAction, svc: string) => {
  if (!isSvcAction(a)) throw new Error(tr('非法的服务操作'))
  const cmd = `systemctl ${a} ${name(svc)}`
  return wrap(`if [ "$(id -u)" = 0 ]; then ${cmd}; else sudo -n ${cmd}; fi 2>&1; echo "${RC}$?"`)
}
// 执行记录里的命令（给人看，非 root 时实际是 sudo -n 前缀）
export const systemdAuditCommand = (a: SvcAction, svc: string) => `systemctl ${a} ${svc}`
export const SYSTEMD_DECISION_PREFIX = 'systemd_'
export const systemdDecision = (a: SvcAction) => `${SYSTEMD_DECISION_PREFIX}${a}`
export function systemdAuditLabel(decision: string): string | undefined {
  const a = decision.startsWith(SYSTEMD_DECISION_PREFIX) ? decision.slice(SYSTEMD_DECISION_PREFIX.length) : ''
  return isSvcAction(a) ? tr('服务·{action}（手动）', { action: tr(SVC_ACTION_LABEL[a]) }) : undefined
}

/** 拆出末尾的退出码标记 */
export function splitSvcRc(out: string): { rc?: number; text: string } {
  const i = out.lastIndexOf(RC)
  if (i < 0) return { text: out.trimEnd() }
  const rc = Number.parseInt(out.slice(i + RC.length), 10)
  return { rc: Number.isFinite(rc) ? rc : undefined, text: out.slice(0, i).trimEnd() }
}

const NO_TEXT: Record<string, string> = {
  missing: tk('这台主机没有 systemctl 命令（不是 systemd 系统，比如 Alpine / 老版 CentOS 6 用的是 OpenRC / SysV init）。'),
  notbooted: tk('这台主机有 systemctl，但系统不是用 systemd 启动的（常见于容器、WSL），服务没法用 systemctl 管理。'),
}

// list-units 一行：UNIT LOAD ACTIVE SUB DESCRIPTION…（老版本失败的单元前面带 ● / *）
function unitLine(l: string): SvcRow | null {
  const t = l.replace(/^\s*[●*]\s*/, '').trim().split(/\s+/)
  if (t.length < 4 || !t[0].endsWith('.service')) return null
  const desc = l.replace(/^\s*[●*]\s*/, '').trim().replace(/^(\S+\s+){4}/, '')
  return { name: t[0], load: t[1], active: t[2], sub: t[3], description: t.length > 4 ? desc : '' }
}

/** 解析 systemdListCommand 的输出：两段合并，按服务名去重；模板单元（foo@.service）跳过 */
export function parseSystemd(out: string): SvcList {
  const no = out.indexOf(NO)
  if (no >= 0) {
    const why = out.slice(no + NO.length).split(/\r?\n/)[0].trim()
    return { rows: [], noSystemd: tr(NO_TEXT[why] ?? NO_TEXT.missing) }
  }
  if (/not been booted with systemd|Failed to connect to bus/i.test(out)) return { rows: [], noSystemd: NO_TEXT.notbooted }
  const lines = out.split(/\r?\n/)
  const iu = lines.indexOf('@@units'), iff = lines.indexOf('@@files')
  const units = iu >= 0 ? lines.slice(iu + 1, iff > iu ? iff : undefined) : []
  const files = iff >= 0 ? lines.slice(iff + 1) : []
  const by = new Map<string, SvcRow>()
  for (const l of units) {
    const r = unitLine(l)
    if (r && !by.has(r.name)) by.set(r.name, r)
  }
  for (const l of files) {
    const [n, state] = l.trim().split(/\s+/)
    if (!n?.endsWith('.service') || !state || n.endsWith('@.service')) continue
    const r = by.get(n)
    if (r) r.enabled = state
    else by.set(n, { name: n, description: '', load: '', active: 'inactive', sub: 'dead', enabled: state })
  }
  return { rows: [...by.values()] }
}

export const svcFailed = (r: SvcRow) => r.active === 'failed' || r.sub === 'failed'
// 开机自启：enabled / enabled-runtime / alias / indirect 都算会被拉起；static / generated 不能 enable
export const svcAutostart = (r: SvcRow): boolean | undefined =>
  !r.enabled ? undefined : /^(enabled|enabled-runtime|alias|linked)$/.test(r.enabled) ? true : /^(disabled|masked|masked-runtime)$/.test(r.enabled) ? false : undefined

/** 过滤：名字 / 描述子串（不分大小写，空格分隔的词都要命中）；onlyFailed 只留失败的 */
export function filterSvcs(rows: SvcRow[], q: string, onlyFailed = false): SvcRow[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((r) => (!onlyFailed || svcFailed(r)) && words.every((w) => `${r.name}\n${r.description}`.toLowerCase().includes(w)))
}
/** 排序：失败置顶（可关）→ 运行中 → 其它，同组按名字 */
export function sortSvcs(rows: SvcRow[], failedFirst = true): SvcRow[] {
  const rank = (r: SvcRow) => (failedFirst && svcFailed(r) ? 0 : r.active === 'active' ? 1 : 2)
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** 「问 AI」引用到对话输入框的文本：服务概况 + systemctl status（含最近日志） */
export function svcQuote(host: string, r: SvcRow, status: string): string {
  const fence = '```'
  const auto = svcAutostart(r)
  const facts = [`运行状态 ${r.active}${r.sub ? `（${r.sub}）` : ''}`, r.load ? `加载 ${r.load}` : '', r.enabled ? `开机自启 ${r.enabled}${auto === undefined ? '' : auto ? '（是）' : '（否）'}` : ''].filter(Boolean).join(' · ')   // i18n-ignore 发给 AI 的话
  return `终端「${host}」所在主机上的 systemd 服务 ${r.name}${r.description ? `（${r.description}）` : ''}：\n${facts}\nsystemctl status 与最近日志：\n${fence}\n${status.trim().slice(-8000)}\n${fence}\n`   // i18n-ignore 发给 AI 的话
}

/** 操作失败的错误文本：sudo 要密码等给个白话说明，原文附后 */
export function svcActionError(text: string, rc?: number): string {
  const raw = text.trim().slice(0, 2000)
  const hint = /a password is required|a terminal is required|sudo: .*password/i.test(raw) ? tr('需要 root 权限，而这台主机的 sudo 要输密码（这里只用免密 sudo -n）。可在终端里手动执行 sudo systemctl …')
    : /sudo: (command )?not found|sudo: not found/i.test(raw) ? tr('需要 root 权限，但这台主机没有 sudo。')
      : /Interactive authentication required|Access denied/i.test(raw) ? tr('没有权限（需要 root）。')
        : ''
  return [hint, raw || tr('退出码 {rc}', { rc: rc ?? tr('rc|未知') })].filter(Boolean).join('\n')
}
