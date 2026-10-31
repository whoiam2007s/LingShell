// 定时任务视图：crontab（当前用户 / root / /etc/crontab / /etc/cron.d/*）+ systemd timer 的读取命令、纯解析、
// cron 表达式翻成人话 / 算下次运行时间、编辑当前用户 crontab（新增 / 删除 / 注释）、AI 生成任务的提示词与结果解析。
// 只支持 Linux 的 SSH 终端，走独立 exec channel。写只改当前用户自己的 crontab（crontab -），系统文件只读
import { shq } from '../files/explorer.js'
import type { TermOs } from '../protocol/index.js'
import { getLocale, tk, tr } from '../i18n/i18n.js'

export const CRON_TIMEOUT_MS = 20_000
export type CronSource = 'user' | 'root' | string   // string = 系统文件路径（/etc/crontab、/etc/cron.d/x）
export interface CronEntry {
  source: CronSource
  line: number          // 在来源里的行号（1 起）
  raw: string           // 原行（删除 / 注释时校验没被别人改过）
  schedule: string      // 5 段表达式或 @daily 等宏
  command: string
  user?: string         // 系统文件第 6 段的运行用户
  disabled?: boolean    // 被 # 注释掉的任务
}
export interface TimerRow {
  unit: string          // logrotate.timer
  activates: string     // logrotate.service
  next?: string         // 原文 NEXT 列（n/a 时为空）
  left?: string
  last?: string
  calendar?: string     // OnCalendar=…（多个用 ; 连）
  monotonic?: string    // OnUnitActiveSec=1d 等
}
export interface CronList {
  user: string                  // 当前登录用户
  isRoot: boolean
  userCrontab?: string          // 当前用户 crontab 原文（没有 crontab 时 undefined）
  entries: CronEntry[]
  timers: TimerRow[]
  now: number                   // 主机当前时间（秒）
  tzOffsetMin: number           // 主机时区偏移（分钟，东八区 480）
  rootDenied?: boolean          // 非 root 且免密 sudo 不可用：读不到 root 的 crontab
  noTimers?: boolean            // 没有 systemctl
}

const R = '${LINGSHELL_HC_ROOT:-}'   // 测试用：系统文件根目录（真实主机上为空）
export const cronListCommand = () => `sh -c ${shq([
  'export LC_ALL=C SYSTEMD_COLORS=0',
  `R="${R}"`,
  'echo "@@me:$(id -un 2>/dev/null || whoami)"; echo "@@uid:$(id -u)"; echo "@@now:$(date +%s) $(date +%z)"',
  'echo "@@user"; crontab -l 2>/dev/null; rc=$?; echo; echo "@@rc:$rc"',
  'if [ "$(id -u)" != 0 ]; then if sudo -n true 2>/dev/null; then echo "@@root"; sudo -n crontab -l -u root 2>/dev/null; echo; else echo "@@rootdenied"; fi; fi',
  'for f in "$R/etc/crontab" "$R"/etc/cron.d/*; do [ -f "$f" ] && [ -r "$f" ] || continue; echo "@@file:${f#$R}"; cat "$f"; echo; done',
  'if command -v systemctl >/dev/null 2>&1; then echo "@@timers"; systemctl list-timers --all --no-pager 2>/dev/null',
  '  u=$(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -o "[^ ]*\\.timer" | sort -u)',
  '  if [ -n "$u" ]; then echo "@@show"; systemctl show -p Id -p TimersCalendar -p TimersMonotonic $u 2>/dev/null; fi',
  'else echo "@@notimers"; fi',
].join('\n'))}`

// ── cron 表达式 ──
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
}
interface Field { set: Set<number>; star: boolean; step?: number; text: string }
export interface CronSpec { min: Field; hour: Field; dom: Field; mon: Field; dow: Field; reboot?: boolean }

function field(s: string, lo: number, hi: number, names?: string[]): Field {
  const set = new Set<number>()
  const val = (x: string) => {
    const i = names ? names.indexOf(x.toLowerCase()) : -1
    const n = i >= 0 ? i + (names === MON ? 1 : 0) : /^\d+$/.test(x) ? Number(x) : NaN
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(tr('取值不对：{v}', { v: x }))
    return n
  }
  let step: number | undefined
  for (const part of s.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(tr('看不懂：{v}', { v: part }))
    const st = m[2] ? Number(m[2]) : 1
    if (st < 1) throw new Error(tr('步长不对：{v}', { v: part }))
    if (m[2] && s.split(',').length === 1) step = st
    let a: number, b: number
    if (m[1] === '*') { a = lo; b = hi }
    else if (m[1].includes('-')) { const [x, y] = m[1].split('-'); a = val(x); b = val(y); if (a > b) throw new Error(tr('范围不对：{v}', { v: part })) }
    else { a = val(m[1]); b = m[2] ? hi : a }
    for (let v = a; v <= b; v += st) set.add(v)
  }
  return { set, star: s.startsWith('*'), step, text: s }
}

/** 解析 5 段表达式或宏；不合法抛错（错误文本给人看） */
export function parseCron(expr: string): CronSpec {
  const e = expr.trim().toLowerCase()
  if (e === '@reboot') { const all = field('*', 0, 0); return { min: all, hour: all, dom: all, mon: all, dow: all, reboot: true } }
  const t = (MACROS[e] ?? expr).trim().split(/\s+/)
  if (t.length !== 5) throw new Error(tr('cron 表达式要 5 段：分 时 日 月 周'))
  const dow = field(t[4], 0, 7, DOW)
  if (dow.set.has(7)) { dow.set.delete(7); dow.set.add(0) }
  return { min: field(t[0], 0, 59), hour: field(t[1], 0, 23), dom: field(t[2], 1, 31), mon: field(t[3], 1, 12, MON), dow }
}
export const isCronExpr = (s: string) => { try { parseCron(s); return true } catch { return false } }

const pad = (n: number) => String(n).padStart(2, '0')
const WD = ['日', '一', '二', '三', '四', '五', '六']   // i18n-ignore 中文描述；英文界面走 describeCronEn
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
const isRange = (v: number[]) => v.length > 2 && v.every((x, i) => i === 0 || x === v[i - 1] + 1)

function dayText(c: CronSpec): string {
  const parts: string[] = []
  const mons = sorted(c.mon.set)
  const monTxt = c.mon.star ? '' : `${mons.join('、')} 月`   // i18n-ignore 中文描述；英文界面走 describeCronEn
  const doms = sorted(c.dom.set), dows = sorted(c.dow.set)
  const domTxt = c.dom.star ? '' : isRange(doms) ? `${doms[0]}–${doms.at(-1)} 日` : `${doms.join('、')} 日`   // i18n-ignore 中文描述；英文界面走 describeCronEn
  const dowTxt = c.dow.star ? '' : dows.join() === '1,2,3,4,5' ? '工作日' : dows.join() === '0,6' ? '周末' : `每周${isRange(dows) ? `${WD[dows[0]]}到周${WD[dows.at(-1)!]}` : dows.map((d) => WD[d]).join('、')}`   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (monTxt) parts.push(`每年 ${monTxt}`)   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (domTxt && dowTxt) parts.push(`${monTxt ? '' : '每月 '}${domTxt}或${dowTxt}`)   // i18n-ignore 中文描述；英文界面走 describeCronEn
  else if (domTxt) parts.push(`${monTxt ? '' : '每月 '}${domTxt}`)   // i18n-ignore 中文描述；英文界面走 describeCronEn
  else if (dowTxt) parts.push(dowTxt)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// 「每 n」：带步长且从范围起点开始（*/5、0/5、0-59/5 都算）。
// 纯 * 要真的覆盖整段才算「每 1 分钟」：`*/5,10` 这种多段写法星号只是其中一段，不能当每分钟
const every = (f: Field, v: number[]) => {
  if (f.step) return v.length && v[0] < f.step ? f.step : 0
  return f.star && v.length > 1 && v.every((x, i) => i === 0 || x === v[i - 1] + 1) ? 1 : 0
}

function timeText(c: CronSpec): { text: string; daily: boolean } {
  const ms = sorted(c.min.set), hs = sorted(c.hour.set)
  const allH = hs.length === 24
  const mE = every(c.min, ms), hE = allH ? 0 : every(c.hour, hs)
  const hRange = !c.hour.star && isRange(hs) ? `${hs[0]} 点到 ${hs.at(-1)} 点` : ''   // i18n-ignore 中文描述；英文界面走 describeCronEn
  const perMin = mE === 1 ? '每分钟' : `每 ${mE} 分钟`   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (mE && allH) return { text: perMin, daily: false }
  if (mE) return { text: `${hE ? `每 ${hE} 小时的那一小时内` : hRange || `${hs.join('、')} 点内`}${perMin}`, daily: !hE }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  const at = (m: number) => (m === 0 ? '整点' : `第 ${m} 分`)   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (ms.length === 1 && allH) return { text: `每小时${at(ms[0])}`, daily: false }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (ms.length === 1 && hE) return { text: `每 ${hE} 小时${at(ms[0])}`, daily: false }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (ms.length === 1 && hRange) return { text: `${hRange}每小时${at(ms[0])}`, daily: true }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (hs.length * ms.length <= 4) return { text: hs.flatMap((h) => ms.map((m) => `${pad(h)}:${pad(m)}`)).join('、'), daily: true }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  if (allH) return { text: `每小时第 ${ms.join('、')} 分`, daily: false }   // i18n-ignore 中文描述；英文界面走 describeCronEn
  return { text: `${hs.join('、')} 点的第 ${ms.join('、')} 分`, daily: true }   // i18n-ignore 中文描述；英文界面走 describeCronEn
}

// ── 英文描述（语序和中文差别大，单独写一份；中文那份保持原样，测试逐字断言） ──
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function dayTextEn(c: CronSpec): string {
  const mons = sorted(c.mon.set), doms = sorted(c.dom.set), dows = sorted(c.dow.set)
  const monTxt = c.mon.star ? '' : `in ${mons.map((m) => MON_EN[m - 1]).join(', ')}`
  const domTxt = c.dom.star ? '' : isRange(doms) ? `on days ${doms[0]}–${doms.at(-1)}` : `on day ${doms.join(', ')}`
  const dowTxt = c.dow.star ? '' : dows.join() === '1,2,3,4,5' ? 'weekdays' : dows.join() === '0,6' ? 'weekends' : isRange(dows) ? `${WD_EN[dows[0]]}–${WD_EN[dows.at(-1)!]}` : dows.map((d) => WD_EN[d]).join(', ')
  const parts: string[] = []
  if (monTxt) parts.push(`yearly ${monTxt}`)
  if (domTxt && dowTxt) parts.push(`${domTxt}${monTxt ? '' : ' of every month'} or ${dowTxt}`)
  else if (domTxt) parts.push(`${domTxt}${monTxt ? '' : ' of every month'}`)
  else if (dowTxt) parts.push(dowTxt === 'weekdays' || dowTxt === 'weekends' ? dowTxt : `every ${dowTxt}`)
  return parts.join(' ')
}
function timeTextEn(c: CronSpec): { text: string; daily: boolean } {
  const ms = sorted(c.min.set), hs = sorted(c.hour.set)
  const allH = hs.length === 24
  const mE = every(c.min, ms), hE = allH ? 0 : every(c.hour, hs)
  const hRange = !c.hour.star && isRange(hs) ? `${hs[0]}:00–${hs.at(-1)}:59` : ''
  const perMin = mE === 1 ? 'every minute' : `every ${mE} minutes`
  if (mE && allH) return { text: perMin, daily: false }
  if (mE) return { text: `${perMin} ${hE ? `in every ${hE}-hour window` : hRange ? `from ${hRange}` : `during hour ${hs.join(', ')}`}`, daily: !hE }
  const at = (m: number) => (m === 0 ? 'on the hour' : `at minute ${m}`)
  if (ms.length === 1 && allH) return { text: `every hour ${at(ms[0])}`, daily: false }
  if (ms.length === 1 && hE) return { text: `every ${hE} hours ${at(ms[0])}`, daily: false }
  if (ms.length === 1 && hRange) return { text: `every hour ${at(ms[0])} from ${hRange}`, daily: true }
  if (hs.length * ms.length <= 4) return { text: `at ${hs.flatMap((h) => ms.map((m) => `${pad(h)}:${pad(m)}`)).join(', ')}`, daily: true }
  if (allH) return { text: `every hour at minute ${ms.join(', ')}`, daily: false }
  return { text: `at minute ${ms.join(', ')} of hour ${hs.join(', ')}`, daily: true }
}
function describeCronEn(c: CronSpec): string {
  if (c.reboot) return 'At every boot'
  const d = dayTextEn(c), t = timeTextEn(c)
  const s = d ? `${d} ${t.text}` : t.daily ? `daily ${t.text}` : t.text
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** 表达式翻成人话：「每天 03:00」「每 5 分钟」「工作日 09:30」「每月 1 日 00:00」；看不懂返回原文 */
export function describeCron(expr: string): string {
  let c: CronSpec
  try { c = parseCron(expr) } catch { return expr }
  if (getLocale() === 'en') return describeCronEn(c)
  if (c.reboot) return '每次开机时'   // i18n-ignore 中文描述
  const d = dayText(c), t = timeText(c)
  return d ? `${d} ${t.text}` : t.daily ? `每天 ${t.text}` : t.text   // i18n-ignore 中文描述
}

/** 下次运行时间（主机本地时间：nowSec + 时区偏移按 UTC 字段算）；@reboot / 找不到返回 undefined */
export function cronNextRun(expr: string, nowSec: number, tzOffsetMin = 0): number | undefined {
  let c: CronSpec
  try { c = parseCron(expr) } catch { return undefined }
  if (c.reboot) return undefined
  const off = tzOffsetMin * 60
  const start = (Math.floor((nowSec + off) / 60) + 1) * 60   // 下一整分钟（主机本地「伪 UTC」）
  const day0 = Math.floor(start / 86400)
  const hs = sorted(c.hour.set), ms = sorted(c.min.set)
  for (let d = day0; d < day0 + 366 * 5; d++) {
    const dt = new Date(d * 86400_000)
    if (!c.mon.set.has(dt.getUTCMonth() + 1)) continue
    const domOk = c.dom.set.has(dt.getUTCDate()), dowOk = c.dow.set.has(dt.getUTCDay())
    // 日、周都限定时按「或」（cron 的规矩），只限定一个时按那一个
    if (!(c.dom.star && c.dow.star ? true : c.dom.star ? dowOk : c.dow.star ? domOk : domOk || dowOk)) continue
    for (const h of hs) for (const m of ms) {
      const t = d * 86400 + h * 3600 + m * 60
      if (t >= start) return t - off
    }
  }
  return undefined
}

/** 主机本地时间显示：「10-18 03:00」；跨年带年份 */
export function fmtHostTime(sec: number, tzOffsetMin: number, nowSec?: number): string {
  const d = new Date((sec + tzOffsetMin * 60) * 1000)
  const y = nowSec !== undefined && new Date((nowSec + tzOffsetMin * 60) * 1000).getUTCFullYear() !== d.getUTCFullYear() ? `${d.getUTCFullYear()}-` : ''
  return `${y}${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
/** 距离现在多久：「5 分钟后」「3 小时后」「2 天后」 */
export function fmtIn(sec: number, nowSec: number): string {
  const s = Math.max(0, sec - nowSec)
  if (s < 3600) return tr('{n} 分钟后', { n: Math.max(1, Math.round(s / 60)) })
  if (s < 86400 * 2) return tr('{n} 小时后', { n: Math.round(s / 3600) })
  return tr('{n} 天后', { n: Math.round(s / 86400) })
}

// ── crontab 行 ──
const ENV = /^[A-Za-z_][A-Za-z0-9_]*\s*=/
/** 一行 crontab → 任务；空行 / 注释 / 环境变量行返回 null。withUser = 系统文件（第 6 段是用户） */
export function parseCronLine(raw: string, withUser: boolean): Omit<CronEntry, 'source' | 'line'> | null {
  let s = raw.trim(), disabled = false
  if (!s) return null
  if (s.startsWith('#')) { s = s.replace(/^#+\s*/, ''); disabled = true; if (!s) return null }
  if (ENV.test(s)) return null
  const t = s.split(/\s+/)
  const n = t[0].startsWith('@') ? 1 : 5
  const schedule = t.slice(0, n).join(' ')
  if (!isCronExpr(schedule)) return null
  if (t.length <= n + (withUser ? 1 : 0)) return null
  const rest = s.replace(new RegExp(`^(\\S+\\s+){${n}}`), '')
  const user = withUser ? t[n] : undefined
  const command = withUser ? rest.replace(/^\S+\s*/, '') : rest
  if (!command) return null
  return { raw, schedule, command, ...(user ? { user } : {}), ...(disabled ? { disabled } : {}) }
}

function parseSource(text: string, source: CronSource): CronEntry[] {
  const withUser = source !== 'user' && source !== 'root'
  return text.split(/\r?\n/).flatMap((l, i) => { const e = parseCronLine(l, withUser); return e ? [{ ...e, source, line: i + 1 }] : [] })
}

// list-timers 按表头列位切（日期里有空格）；最后两列 UNIT / ACTIVATES 用空白切
function parseTimerTable(lines: string[]): TimerRow[] {
  const hi = lines.findIndex((l) => /^NEXT\s+LEFT\s+LAST\s+PASSED\s+UNIT\s+ACTIVATES/.test(l))
  if (hi < 0) return []
  const h = lines[hi], col = (n: string) => h.indexOf(n)
  const [cl, cla, cp, cu] = [col('LEFT'), col('LAST'), col('PASSED'), col('UNIT')]
  const out: TimerRow[] = []
  for (const l of lines.slice(hi + 1)) {
    if (!l.trim() || /timers? listed/.test(l) || l.startsWith('Pass --all')) continue
    const cut = (a: number, b?: number) => { const v = l.slice(a, b).trim(); return v && v !== 'n/a' && v !== '-' ? v : undefined }
    const [unit, activates] = l.slice(cu).trim().split(/\s+/)
    if (!unit?.endsWith('.timer')) continue
    out.push({ unit, activates: activates ?? '', next: cut(0, cl), left: cut(cl, cla), last: cut(cla, cp) })
  }
  return out
}
// systemctl show 的 TimersCalendar={ OnCalendar=*-*-* 03:00:00 ; next_elapse=… }，多个时器以空行分隔
function parseTimerShow(lines: string[]): Map<string, { calendar?: string; monotonic?: string }> {
  const m = new Map<string, { calendar?: string; monotonic?: string }>()
  let id = ''
  const pick = (v: string) => [...v.matchAll(/\{\s*(On\w+)=([^;}]+)/g)].map((x) => `${x[1]}=${x[2].trim()}`).join('; ') || undefined
  for (const l of lines) {
    if (l.startsWith('Id=')) { id = l.slice(3).trim(); m.set(id, {}) }
    else if (id && l.startsWith('TimersCalendar=')) m.get(id)!.calendar = pick(l)
    else if (id && l.startsWith('TimersMonotonic=')) m.get(id)!.monotonic = pick(l)
  }
  return m
}

// crontab -l 原文规整：去 \r、末尾空行收成一个换行（列表与写回前读取用同一规则，行号才对得上）
const normCrontab = (s: string) => { const t = s.replace(/\r/g, '').replace(/\n+$/, ''); return t ? `${t}\n` : '' }

/** 解析 cronListCommand 的输出 */
export function parseCronList(out: string): CronList {
  const lines = out.replace(/\r/g, '').split('\n')
  const val = (k: string) => lines.find((l) => l.startsWith(`@@${k}:`))?.slice(k.length + 3).trim() ?? ''
  const [nowS, tz] = val('now').split(/\s+/)
  // +0800（POSIX）；个别系统 / 环境会输出 +08:00，也认
  const tzm = /^([+-])(\d\d):?(\d\d)$/.exec(tz ?? '')
  const r: CronList = {
    user: val('me'), isRoot: val('uid') === '0', entries: [], timers: [],
    now: Number(nowS) || Math.floor(Date.now() / 1000),
    tzOffsetMin: tzm ? (tzm[1] === '-' ? -1 : 1) * (Number(tzm[2]) * 60 + Number(tzm[3])) : 0,
  }
  // 按 @@ 标记切段
  const secs: { k: string; body: string[] }[] = []
  for (const l of lines) {
    if (/^@@(user|root|rootdenied|timers|show|notimers|file:.*)$/.test(l)) secs.push({ k: l.slice(2), body: [] })
    else if (l.startsWith('@@rc:') && secs.at(-1)?.k === 'user') {
      const s = secs.at(-1)!
      if (l.slice(5).trim() === '0') r.userCrontab = normCrontab(s.body.join('\n'))
    } else if (/^@@(me|uid|now):/.test(l)) continue
    else secs.at(-1)?.body.push(l)
  }
  let show = new Map<string, { calendar?: string; monotonic?: string }>()
  for (const s of secs) {
    if (s.k === 'user') { if (r.userCrontab !== undefined) r.entries.push(...parseSource(r.userCrontab, 'user')) }
    else if (s.k === 'root') r.entries.push(...parseSource(s.body.join('\n'), 'root'))
    else if (s.k === 'rootdenied') r.rootDenied = true
    else if (s.k === 'notimers') r.noTimers = true
    else if (s.k === 'timers') r.timers = parseTimerTable(s.body)
    else if (s.k === 'show') show = parseTimerShow(s.body)
    else if (s.k.startsWith('file:')) r.entries.push(...parseSource(s.body.join('\n'), s.k.slice(5)))
  }
  r.timers = r.timers.map((t) => ({ ...t, ...show.get(t.unit) }))
  return r
}

/** 来源给人看：「我的 crontab」「root 的 crontab」「/etc/cron.d/x」 */
export const cronSourceLabel = (s: CronSource, me = '') => (s === 'user' ? tr('{user} 的 crontab', { user: me || tr('当前用户') }) : s === 'root' ? tr('{user} 的 crontab', { user: 'root' }) : s)

// systemd OnCalendar 翻人话（常见写法），看不懂原样
export function describeCalendar(spec: string): string {
  const one = (x: string) => {
    const v = x.replace(/^OnCalendar=/, '').trim()
    const SHORT: Record<string, string> = { minutely: tr('每分钟'), hourly: tr('每小时整点'), daily: tr('每天 00:00'), weekly: tr('每周一 00:00'), monthly: tr('每月 1 日 00:00'), yearly: tr('每年 1 月 1 日 00:00'), annually: tr('每年 1 月 1 日 00:00'), quarterly: tr('每季度首日 00:00'), semiannually: tr('每半年首日 00:00') }
    if (SHORT[v]) return SHORT[v]
    const m = /^(?:([A-Za-z,.]+)\s+)?(?:(\*|\d{4})-(\*|[\d,]+)-(\*|[\d,]+)\s+)?(\*|[\d,]+(?:\/\d+)?):(\*|[\d,]+(?:\/\d+)?)(?::\d{1,2})?$/.exec(v)
    if (!m) return v
    const [, wd, , mo, dd, hh, mm] = m
    const W: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
    const days = wd ? wd.toLowerCase().split(',').flatMap((p) => {
      const [a, b] = p.split('..').map((s) => W[s.slice(0, 3)])
      if (a === undefined) return []
      if (b === undefined) return [a]
      const r: number[] = []
      for (let i = a; i !== (b + 1) % 7; i = (i + 1) % 7) { r.push(i); if (r.length > 7) break }
      return r
    }) : []
    const dow = days.length ? days.join(',') : '*'
    const num = (s?: string) => (!s ? '*' : s.replace(/(^|[/,])0+(\d)/g, '$1$2'))   // 03 → 3；0/15（systemd 的「从 0 起每 15」）cron 同义
    const expr = `${num(mm)} ${num(hh)} ${num(dd)} ${num(mo)} ${dow}`
    return isCronExpr(expr) ? describeCron(expr) : v
  }
  return spec.split(/;\s*/).filter((x) => x.startsWith('OnCalendar=') || !x.includes('=')).map(one).join(tr('；'))
}
/** 单调定时器：OnUnitActiveSec=1d → 「上次运行后每 1d」 */
export function describeMonotonic(spec: string): string {
  const L: Record<string, string> = { OnBootSec: tk('开机后 {v}'), OnStartupSec: tk('启动后 {v}'), OnUnitActiveSec: tk('上次运行后每 {v}'), OnUnitInactiveSec: tk('上次结束后 {v}'), OnActiveSec: tk('激活后 {v}') }
  return spec.split(/;\s*/).map((x) => { const [k, v] = x.split('='); return L[k] ? tr(L[k], { v }) : x }).join(tr('；'))
}

// ── 编辑当前用户的 crontab（纯函数；行号 / 原文对不上说明被别处改过，抛错让用户刷新） ──
/** cron 里的 % 是换行，命令里原样的 % 要转义 */
export const escapeCronPercent = (cmd: string) => cmd.replace(/(?<!\\)%/g, '\\%')
export function cronLineOf(schedule: string, command: string): string {
  if (!isCronExpr(schedule)) throw new Error(tr('cron 表达式不合法'))
  const c = command.trim()
  if (!c || /[\r\n]/.test(c)) throw new Error(tr('命令必须是一行'))
  return `${schedule.trim()} ${escapeCronPercent(c)}`
}
const ensureNl = (s: string) => (s && !s.endsWith('\n') ? `${s}\n` : s)
export function cronAppend(text: string, schedule: string, command: string, note?: string): string {
  const n = note?.replace(/[\r\n]+/g, ' ').trim()
  return `${ensureNl(text ?? '')}${n ? `# ${n}\n` : ''}${cronLineOf(schedule, command)}\n`
}
function lineAt(text: string, line: number, raw: string): string[] {
  const ls = text.split('\n')
  if (ls[line - 1]?.replace(/\r$/, '') !== raw.replace(/\r$/, '')) throw new Error(tr('这条任务在读取后已被改动，请刷新后再操作'))
  return ls
}
export function cronRemove(text: string, line: number, raw: string): string {
  const ls = lineAt(text, line, raw)
  ls.splice(line - 1, 1)
  return ls.join('\n')
}
/** disable=true 注释掉；false 去掉行首 # 恢复 */
export function cronToggle(text: string, line: number, raw: string, disable: boolean): string {
  const ls = lineAt(text, line, raw)
  ls[line - 1] = disable ? `# ${raw}` : raw.replace(/^(\s*)#+\s?/, '$1')
  return ls.join('\n')
}

/** 写回：先把当前 crontab 备份到 ~/.lingshell/backups/<name>（有的话），再用 base64 内容整体替换（crontab -）。输出 @@backup: / @@rc: */
export function cronWriteCommand(content: string, backupName: string): string {
  if (!/^[\w.-]+$/.test(backupName)) throw new Error(tr('非法的备份文件名'))
  let bin = ''
  for (const b of new TextEncoder().encode(content)) bin += String.fromCharCode(b)
  const b64 = btoa(bin)
  return `sh -c ${shq([
    'd="$HOME/.lingshell/backups"; mkdir -p "$d" && chmod 700 "$d" || { echo "@@rc:90"; exit 0; }',
    `b="$d/${backupName}"`,
    'if crontab -l > "$b" 2>/dev/null; then chmod 600 "$b"; echo "@@backup:$b"; else rm -f "$b"; echo "@@backup:"; fi',
    `printf %s ${b64} | base64 -d | crontab - 2>&1; echo "@@rc:$?"`,
  ].join('\n'))}`
}
export function parseCronWrite(out: string): { rc?: number; backup?: string; text: string } {
  const rc = /@@rc:(\d+)/.exec(out)?.[1]
  const backup = /@@backup:(.*)/.exec(out)?.[1]?.trim()
  return { rc: rc === undefined ? undefined : Number(rc), ...(backup ? { backup } : {}), text: out.replace(/@@(rc|backup):.*\n?/g, '').trim() }
}
export const cronReadCommand = () => 'sh -c \'crontab -l 2>/dev/null; rc=$?; echo; echo "@@rc:$rc"\''
/** cronReadCommand 输出 → 当前 crontab 原文（没有 crontab = ''） */
export function parseCronRead(out: string): string {
  const i = out.lastIndexOf('@@rc:')
  if (i < 0) throw new Error(tr('读不到 crontab'))
  return out.slice(i + 5).trim() === '0' ? normCrontab(out.slice(0, i)) : ''
}

export type CronOp = 'add' | 'delete' | 'disable' | 'enable'
export const CRON_DECISION_PREFIX = 'cron_'
export const CRON_OP_LABEL: Record<CronOp, string> = { add: tk('新增'), delete: tk('删除'), disable: tk('注释（停用）'), enable: tk('恢复') }
export function cronAuditLabel(decision: string): string | undefined {
  const a = decision.startsWith(CRON_DECISION_PREFIX) ? decision.slice(CRON_DECISION_PREFIX.length) : ''
  return a in CRON_OP_LABEL ? tr('定时任务·{op}（手动）', { op: tr(CRON_OP_LABEL[a as CronOp]) }) : undefined
}

// ── AI 生成：一次性模型调用，自然语言 → cron 表达式 + 命令 + 说明 ──
const OS_TEXT: Record<TermOs, string> = { linux: 'Linux', macos: 'macOS', windows: 'Linux', unknown: 'Linux' }
export function buildCronPrompt(r: { description: string; os?: TermOs; prod?: boolean }): { system: string; user: string } {
  const system = [
    '你把用户用自然语言描述的定时任务写成一条 crontab 任务（当前用户的 crontab，5 段格式：分 时 日 月 周）。',   // i18n-ignore 提示词
    `目标主机：${OS_TEXT[r.os ?? 'unknown']}，命令由 /bin/sh 执行，PATH 很短，命令尽量写绝对路径（如 /usr/bin/find）。`,   // i18n-ignore 提示词
    r.prod ? '这是生产主机：命令要稳妥、影响最小，删除类操作要限定目录和条件。' : '',   // i18n-ignore 提示词
    '要求：命令只占一行；需要多步时用 && 连接；不要用 sudo；不要写 crontab 命令本身；% 照常写（程序会转义）。',   // i18n-ignore 提示词
    '输出严格的 JSON（不要代码块、不要其他文字）：{"schedule":"0 3 * * *","command":"…","explain":"一句中文说明这条任务做什么、何时运行"}',   // i18n-ignore 提示词
    '无法写成 cron 任务时只输出：{"error":"原因"}',   // i18n-ignore 提示词
  ].filter(Boolean).join('\n')
  return { system, user: `需求：${r.description.trim()}` }   // i18n-ignore 提示词
}
export interface CronGen { schedule: string; command: string; explain: string }
export function parseCronGen(raw: string): CronGen | { error: string } {
  const s = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```(?:json)?/g, '').trim()
  const i = s.indexOf('{'), j = s.lastIndexOf('}')
  let o: Record<string, unknown>
  try { o = JSON.parse(s.slice(i, j + 1)) } catch { return { error: tr('模型没有按格式返回，请换个说法再试') } }
  if (typeof o.error === 'string' && !o.schedule) return { error: o.error || tr('模型无法生成') }
  const schedule = String(o.schedule ?? '').trim(), command = String(o.command ?? '').trim()
  if (!isCronExpr(schedule)) return { error: tr('模型给出的时间表达式不合法：{v}', { v: schedule || tr('（空）') }) }
  if (!command || /[\r\n]/.test(command)) return { error: tr('模型给出的命令为空或不是一行') }
  return { schedule, command, explain: String(o.explain ?? '').trim().slice(0, 200) }
}
