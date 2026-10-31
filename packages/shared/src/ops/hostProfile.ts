// 主机体检 / 主机档案 / 配置漂移 / 变更前后快照（纯逻辑：采集脚本构造 + 输出解析 + 问题判定 + 差异计算）。
// 采集走独立 exec channel 一次跑完（见 desktop/main/ops/hostCheck.ts），脚本只读：不改任何东西、不用 sudo。
// 每段有自己的超时（有 timeout 命令时），任何一段失败只是那段缺数据，不影响其他段。
import { parsePorts, type ListenPort } from './ports.js'
import type { TermOs, TerminalType } from '../protocol/index.js'
import { tr } from '../i18n/i18n.js'

export type ProfileType = 'check' | 'snapshot'   // check = 用户点「开始体检」；snapshot = AI 变更前后自动拍的轻量快照

export interface DiskUse { mount: string; fs: string; sizeKb: number; usedPct: number; inodePct?: number }
export interface Container { name: string; image: string; state: string; status?: string }
export interface ConfigFile { path: string; sha256?: string; size?: number; unreadable?: boolean; content?: boolean }   // content=本次存了内容
export interface LoginRec { user: string; ip: string; time: string }
export interface CertInfo { path: string; notAfter?: string; error?: string }
export interface UpdatesInfo { manager: 'dnf' | 'yum' | 'apt' | 'none'; total?: number; security?: number; unknown?: 'timeout' | 'error' }

export interface HostProfile {
  version: 1
  id?: string               // 存盘后的 id（时间戳 + 类型）
  type: ProfileType
  at: string                // ISO
  hostKey: string
  hostLabel?: string
  sys?: { os?: string; kernel?: string; arch?: string; hostname?: string; uptimeSec?: number }
  cpu?: { cores?: number; load?: [number, number, number] }
  mem?: { totalKb?: number; availKb?: number; swapTotalKb?: number; swapFreeKb?: number }
  disks?: DiskUse[]
  ports?: ListenPort[] | null           // null = 远端没有 ss / netstat
  failedUnits?: string[] | null         // null = 没有 systemctl
  containers?: Container[] | null       // null = 没有 docker（或无权限）
  files?: ConfigFile[]
  uid0?: string[]
  logins?: LoginRec[]
  sshd?: { permitRootLogin?: string; passwordAuthentication?: string; source: 'sshd -T' | 'config' }
  certs?: CertInfo[]
  updates?: UpdatesInfo
  partial?: boolean                     // 采集超时被截断（后面的段可能缺）
  notes?: string[]                      // 采不到的段的说明
}

export interface ProfileMeta { id: string; type: ProfileType; at: string; issues: number; label?: string }

export const HOSTCHECK_TIMEOUT_MS = 45_000
export const SNAPSHOT_TIMEOUT_MS = 10_000
export const PROFILE_KEEP = 20
export const CONFIG_MAX_BYTES = 256 * 1024
export const HOSTCHECK_MAX_OUTPUT = 6 * 1024 * 1024
export const hostCheckSupported = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows' && os !== 'macos'

// 关键配置文件（存在才采；nginx conf.d 下的 *.conf 全收）
export const CONFIG_FILES = ['/etc/ssh/sshd_config', '/etc/nginx/nginx.conf', '/etc/nginx/conf.d/*.conf', '/etc/my.cnf', '/etc/crontab', '/etc/hosts', '/etc/fstab', '/etc/resolv.conf', '/etc/sysctl.conf']

const SEC = '@@hc:'

// 整段放进 sh -c '...'：脚本里不能有单引号。$R 是文件路径前缀（远端恒为空；回环测试把假文件放在临时目录里用它指过去）
const HEAD = [
  'exec 2>/dev/null',
  'export LC_ALL=C',
  'R="${LINGSHELL_HC_ROOT:-}"',
  'T() { s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi; }',
  'S() { echo "' + SEC + '$1"; }',
]
const PORTS = [
  'S ports',
  'if o=$(T 5 ss -ltnpH) || o=$(T 5 ss -ltnp); then echo "@@tool:ss"; printf "%s\\n" "$o"',
  'elif o=$(T 5 netstat -ltnp) || o=$(T 5 netstat -ltn); then echo "@@tool:netstat"; printf "%s\\n" "$o"',
  'else echo "@@none"; fi',
]
const FAILED = [
  'S failed',
  'if command -v systemctl >/dev/null 2>&1; then T 5 systemctl list-units --state=failed --no-legend --plain --no-pager; else echo "@@none"; fi',
]
const DOCKER = [
  'S docker',
  'if command -v docker >/dev/null 2>&1; then T 8 docker ps -a --format "{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}" || echo "@@error"; else echo "@@none"; fi',
]
// 哈希 + 文本内容（≤256KB、非二进制、有 base64 才存内容），base64 包起来避免内容里的行和分隔符撞上
const FILES = [
  'S files',
  `for f in ${CONFIG_FILES.map((p) => '$R' + p).join(' ')}; do`,
  '  [ -f "$f" ] || continue; p=${f#$R}',
  '  if [ ! -r "$f" ]; then echo "@@file $p|-|"; continue; fi',
  '  h=$(sha256sum "$f" | cut -d" " -f1); n=$(wc -c < "$f" | tr -d " ")',
  '  echo "@@file $p|$h|$n"',
  '  if [ "$n" -le ' + CONFIG_MAX_BYTES + ' ] && command -v base64 >/dev/null 2>&1 && { [ "$n" -eq 0 ] || grep -qI . "$f"; }; then echo "@@content $p"; base64 "$f"; echo "@@end"; fi',
  'done',
]
const FULL_ONLY = [
  'S sys',
  'echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"',
  'echo "hostname=$(hostname || cat /proc/sys/kernel/hostname)"',
  '[ -r /proc/uptime ] && echo "uptime=$(cut -d. -f1 /proc/uptime)"',
  '[ -r $R/etc/os-release ] && ( . $R/etc/os-release; echo "os=$PRETTY_NAME" )',
  'S cpu',
  'echo "cores=$(nproc || grep -c ^processor /proc/cpuinfo)"',
  '[ -r /proc/loadavg ] && echo "load=$(cut -d" " -f1-3 /proc/loadavg)"',
  'S mem',
  'grep -E "^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo',
  'S df', 'T 5 df -P -k',
  'S dfi', 'T 5 df -P -i',
]
const FULL_TAIL = [
  'S uid0',
  'grep -E "^[^:]*:[^:]*:0:" $R/etc/passwd | cut -d: -f1',
  'S last',
  'T 5 last -n 10 -w -i',
  'S sshd',
  'D=$(command -v sshd || echo /usr/sbin/sshd)',
  'if o=$(T 5 "$D" -T) && [ -n "$o" ]; then echo "@@src:sshd-T"; printf "%s\\n" "$o" | grep -Ei "^(permitrootlogin|passwordauthentication) "',
  'elif [ -r $R/etc/ssh/sshd_config ]; then echo "@@src:config"; grep -Ei "^[[:space:]]*(permitrootlogin|passwordauthentication|match)[[:space:]]" $R/etc/ssh/sshd_config',
  'else echo "@@none"; fi',
  'S certs',
  '{ for f in $R/etc/letsencrypt/live/*/cert.pem; do [ -f "$f" ] && echo "${f#$R}"; done',
  '  sed -n "s/^[[:space:]]*ssl_certificate[[:space:]][[:space:]]*\\([^;]*\\);.*/\\1/p" $R/etc/nginx/nginx.conf $R/etc/nginx/conf.d/*.conf; } | tr -d "\\"" | sort -u | while read -r p; do',
  '  case "$p" in *\\$*|"") continue;; /*) ;; *) p=/etc/nginx/$p;; esac',
  '  if command -v openssl >/dev/null 2>&1; then echo "@@cert $p|$(T 5 openssl x509 -noout -enddate -in "$R$p" | cut -d= -f2)"; else echo "@@cert $p|@@noopenssl"; fi',
  'done',
]
// 可更新包：放后台和其它段并行跑（限时 15s），最后再收；只读本地缓存（-C / apt list），不联网刷新
const UPDATES_FN = [
  'upd() {',
  '  if command -v dnf >/dev/null 2>&1; then m=dnf; elif command -v yum >/dev/null 2>&1; then m=yum; elif command -v apt >/dev/null 2>&1; then m=apt; else echo "mgr=none"; return; fi',
  '  echo "mgr=$m"',
  '  if [ $m = apt ]; then o=$(T 15 apt list --upgradable); rc=$?; [ $rc = 124 ] && { echo "@@timeout"; return; }',
  '    echo "total=$(printf "%s\\n" "$o" | grep -c /)"; echo "security=$(printf "%s\\n" "$o" | grep -c -- -security)"',
  '  else o=$(T 15 $m -q -C check-update); rc=$?; [ $rc = 124 ] && { echo "@@timeout"; return; }; [ $rc = 1 ] && { echo "@@error"; return; }',
  '    echo "total=$(printf "%s\\n" "$o" | grep -cE "^[[:alnum:]_.+-]+\\.[[:alnum:]_]+[[:space:]]")"',
  '    if s=$(T 10 $m -q -C updateinfo list --security); then echo "security=$(printf "%s\\n" "$s" | grep -c .)"; fi',
  '  fi',
  '}',
  'U=$(mktemp || echo /tmp/.lingshell-hc-$$); upd > "$U" & UP=$!',
]
const UPDATES_COLLECT = ['wait $UP; S updates; cat "$U"; rm -f "$U"']

/** 采集命令：full = 体检全量；snapshot = 变更前后快照（端口 / 失败服务 / 容器 / 关键配置文件） */
export function hostCheckCommand(type: ProfileType): string {
  const body = type === 'check'
    ? [...HEAD, ...UPDATES_FN, ...FULL_ONLY, ...PORTS, ...FAILED, ...DOCKER, ...FILES, ...FULL_TAIL, ...UPDATES_COLLECT]
    : [...HEAD, ...PORTS, ...FAILED, ...DOCKER, ...FILES]
  return `sh -c '${body.join('\n')}'`
}

// ── 解析 ─────────────────────────────────────────────

function sections(out: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  let cur: string[] | undefined
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith(SEC)) { cur = []; m.set(line.slice(SEC.length).trim(), cur); continue }
    cur?.push(line)
  }
  return m
}
const kv = (lines: string[]) => {
  const o: Record<string, string> = {}
  for (const l of lines) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim() }
  return o
}
const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

// df -P：Filesystem 1024-blocks Used Available Capacity Mounted-on。文件系统名 / 挂载点可能带空格（Git Bash 的 C:/Program Files/Git）：
// 以「三个数字 + 百分比（或 -）」这一组为锚
function parseDf(lines: string[]): { fs: string; mount: string; size: number; pct?: number }[] {
  const out: { fs: string; mount: string; size: number; pct?: number }[] = []
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    for (let i = 4; i < t.length; i++) {
      if (!/^(\d+%|-)$/.test(t[i]) || ![1, 2, 3].every((k) => /^(\d+|-)$/.test(t[i - k]))) continue
      const pct = t[i] === '-' ? undefined : Number(t[i].slice(0, -1))
      out.push({ fs: t.slice(0, i - 4 + 1).join(' '), size: Number(t[i - 3]) || 0, pct, mount: t.slice(i + 1).join(' ') })
      break
    }
  }
  return out
}
const PSEUDO_FS = /^(tmpfs|devtmpfs|udev|overlay|shm|none|efivarfs|cgroup2?|proc|sysfs)$/
// overlay 在容器 / 不可变系统上是根文件系统：不能一律当伪文件系统丢掉，否则根盘满了体检也说没问题
const pseudo = (fs: string, mount: string) => (PSEUDO_FS.test(fs) && !(fs === 'overlay' && mount === '/')) || fs.startsWith('/dev/loop') || /^\/(run|dev|sys|proc|snap)(\/|$)/.test(mount) || !mount

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** openssl 的 notAfter（"Jan  1 00:00:00 2026 GMT"）→ ISO；认不出返回 undefined */
export function parseOpensslDate(s: string): string | undefined {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(s.trim())
  if (!m || MONTHS.indexOf(m[1]) < 0) return undefined
  return new Date(Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))).toISOString()
}

const IPISH = /^[0-9a-fA-F:.]+$/

/** 解析采集输出。contents：本次带回的配置文件内容（路径 → 文本），由调用方按哈希另存 */
export function parseHostProfile(out: string, base: { type: ProfileType; at: string; hostKey: string; hostLabel?: string }): { profile: HostProfile; contents: Map<string, string> } {
  const s = sections(out)
  const p: HostProfile = { version: 1, ...base }
  const notes: string[] = []
  const contents = new Map<string, string>()

  const sys = s.get('sys')
  if (sys) {
    const o = kv(sys)
    p.sys = { os: o.os || undefined, kernel: o.kernel || undefined, arch: o.arch || undefined, hostname: o.hostname || undefined, uptimeSec: num(o.uptime) }
  }
  const cpu = s.get('cpu')
  if (cpu) {
    const o = kv(cpu)
    const l = (o.load ?? '').split(/\s+/).map(Number)
    p.cpu = { cores: num(o.cores), ...(l.length === 3 && l.every(Number.isFinite) ? { load: l as [number, number, number] } : {}) }
  }
  const mem = s.get('mem')
  if (mem) {
    const o: Record<string, number> = {}
    for (const l of mem) { const m = /^(\w+):\s+(\d+)/.exec(l); if (m) o[m[1]] = Number(m[2]) }
    p.mem = { totalKb: o.MemTotal, availKb: o.MemAvailable ?? o.MemFree, swapTotalKb: o.SwapTotal, swapFreeKb: o.SwapFree }   // 3.14 以前的内核没有 MemAvailable
  }
  const df = s.get('df')
  if (df) {
    const inodes = new Map(parseDf(s.get('dfi') ?? []).map((r) => [r.mount, r.pct]))
    p.disks = parseDf(df).filter((r) => !pseudo(r.fs, r.mount) && r.pct !== undefined)
      .map((r) => ({ mount: r.mount, fs: r.fs, sizeKb: r.size, usedPct: r.pct!, ...(inodes.get(r.mount) !== undefined ? { inodePct: inodes.get(r.mount) } : {}) }))
    if (!p.disks.length && !df.some((l) => l.trim())) notes.push(tr('磁盘：df 没有输出（可能超时）'))
  }
  const ports = s.get('ports')
  if (ports) {
    if (ports.some((l) => l.startsWith('@@none'))) { p.ports = null; notes.push(tr('监听端口：远端没有 ss / netstat')) }
    else p.ports = parsePorts(ports.join('\n')).rows
  }
  const failed = s.get('failed')
  if (failed) {
    if (failed.some((l) => l.startsWith('@@none'))) p.failedUnits = null
    else p.failedUnits = [...new Set(failed.map((l) => l.replace(/^[\s●*]+/, '').split(/\s+/)[0]).filter((u) => /\.(service|socket|mount|timer|target|path|scope|slice|swap|automount|device)$/.test(u)))]
  }
  const docker = s.get('docker')
  if (docker) {
    if (docker.some((l) => l.startsWith('@@none'))) p.containers = null
    else if (docker.some((l) => l.startsWith('@@error'))) { p.containers = null; notes.push(tr('容器：docker 命令执行失败（可能没有权限访问 docker）')) }
    else p.containers = docker.filter((l) => l.includes('|')).map((l) => { const [name, image, state, status] = l.split('|'); return { name, image, state, ...(status ? { status } : {}) } })
  }
  const files = s.get('files')
  if (files) {
    p.files = []
    let cur: { path: string; b64: string[] } | undefined
    for (const l of files) {
      if (cur) {
        if (l === '@@end') {
          try { contents.set(cur.path, new TextDecoder().decode(Uint8Array.from(atob(cur.b64.join('')), (ch) => ch.charCodeAt(0)))) } catch { /* 截断的 base64：不存内容 */ }
          const f = p.files.find((x) => x.path === cur!.path)
          if (f && contents.has(f.path)) f.content = true
          cur = undefined
        } else cur.b64.push(l.trim())
        continue
      }
      const m = /^@@file (.+)\|([0-9a-f]{64}|-)\|(\d*)$/.exec(l)
      if (m) { p.files.push(m[2] === '-' ? { path: m[1], unreadable: true } : { path: m[1], sha256: m[2], size: num(m[3]) }); continue }
      const c = /^@@content (.+)$/.exec(l)
      if (c) cur = { path: c[1], b64: [] }
    }
  }
  const uid0 = s.get('uid0')
  if (uid0) p.uid0 = uid0.map((l) => l.trim()).filter(Boolean)
  const last = s.get('last')
  if (last) {
    p.logins = []
    for (const l of last) {
      const t = l.trim().split(/\s+/)
      if (t.length < 4 || /^(reboot|shutdown|wtmp|btmp)$/.test(t[0]) || !IPISH.test(t[2])) continue
      p.logins.push({ user: t[0], ip: t[2], time: t.slice(3).join(' ') })
    }
  }
  const sshd = s.get('sshd')
  if (sshd && !sshd.some((l) => l.startsWith('@@none'))) {
    const source = sshd.some((l) => l.startsWith('@@src:sshd-T')) ? 'sshd -T' as const : 'config' as const
    const o: Record<string, string> = {}
    for (const l of sshd) {
      const t = l.trim().split(/\s+/)
      const k = t[0]?.toLowerCase()
      if (k === 'match') break                    // Match 块里的只对部分用户生效，不算全局
      if ((k === 'permitrootlogin' || k === 'passwordauthentication') && t[1] && !(k in o)) o[k] = t[1].toLowerCase()   // sshd 取第一个出现的值
    }
    // 没写的取 OpenSSH 默认值（7.0 起 PermitRootLogin 默认 prohibit-password；PasswordAuthentication 默认 yes）
    p.sshd = { permitRootLogin: o.permitrootlogin ?? 'prohibit-password', passwordAuthentication: o.passwordauthentication ?? 'yes', source }
  }
  const certs = s.get('certs')
  if (certs) {
    p.certs = []
    for (const l of certs) {
      const m = /^@@cert (.+?)\|(.*)$/.exec(l)
      if (!m) continue
      const iso = parseOpensslDate(m[2])
      p.certs.push(iso ? { path: m[1], notAfter: iso } : { path: m[1], error: m[2] === '@@noopenssl' ? tr('没有 openssl 命令') : tr('读不到证书（文件不存在或没有权限）') })
    }
  }
  const upd = s.get('updates')
  if (upd) {
    const o = kv(upd)
    const manager = (['dnf', 'yum', 'apt'] as const).find((x) => x === o.mgr) ?? 'none'
    const unknown = upd.some((l) => l.startsWith('@@timeout')) ? 'timeout' as const : upd.some((l) => l.startsWith('@@error')) ? 'error' as const : undefined
    p.updates = { manager, ...(unknown ? { unknown } : { total: num(o.total), security: num(o.security) }) }
  } else if (base.type === 'check') {
    p.updates = { manager: 'none', unknown: 'timeout' }
  }
  if (notes.length) p.notes = notes
  return { profile: p, contents }
}

// ── 问题项 ───────────────────────────────────────────

export interface HostIssue { level: 'danger' | 'warn'; kind: 'disk' | 'inode' | 'service' | 'cert' | 'sshd' | 'uid0' | 'updates'; text: string; path?: string }   // path：磁盘问题的挂载点（「分析占用」用）
export const DISK_WARN_PCT = 85
export const CERT_WARN_DAYS = 30
const DAY = 86_400_000

/** 证书还剩几天（负数 = 已过期） */
export const certDaysLeft = (notAfter: string, now: Date) => Math.floor((Date.parse(notAfter) - now.getTime()) / DAY)

export function findIssues(p: HostProfile, now = new Date(p.at)): HostIssue[] {
  const out: HostIssue[] = []
  for (const d of p.disks ?? []) {
    if (d.usedPct > DISK_WARN_PCT) out.push({ level: d.usedPct >= 95 ? 'danger' : 'warn', kind: 'disk', text: tr('磁盘 {mount} 已用 {pct}%', { mount: d.mount, pct: d.usedPct }), path: d.mount })
    if (d.inodePct !== undefined && d.inodePct > DISK_WARN_PCT) out.push({ level: d.inodePct >= 95 ? 'danger' : 'warn', kind: 'inode', text: tr('{mount} 的 inode 已用 {pct}%（小文件太多，空间够也会写不进）', { mount: d.mount, pct: d.inodePct }) })
  }
  for (const u of p.failedUnits ?? []) out.push({ level: 'warn', kind: 'service', text: tr('服务失败：{v}', { v: u }) })
  for (const c of p.certs ?? []) {
    if (!c.notAfter) continue
    const left = certDaysLeft(c.notAfter, now)
    if (left < 0) out.push({ level: 'danger', kind: 'cert', text: tr('证书已过期：{path}（{date}）', { path: c.path, date: c.notAfter.slice(0, 10) }) })
    else if (left <= CERT_WARN_DAYS) out.push({ level: 'warn', kind: 'cert', text: tr('证书 {n} 天后到期：{path}（{date}）', { n: left, path: c.path, date: c.notAfter.slice(0, 10) }) })
  }
  if (p.sshd?.permitRootLogin === 'yes' && p.sshd.passwordAuthentication === 'yes') {
    out.push({ level: 'danger', kind: 'sshd', text: tr('SSH 允许 root 用密码登录（PermitRootLogin yes + PasswordAuthentication yes），容易被暴力破解') })
  }
  const extra = (p.uid0 ?? []).filter((u) => u !== 'root')
  if (extra.length) out.push({ level: 'danger', kind: 'uid0', text: tr('除 root 外还有 UID 0 的用户：{v}', { v: extra.join(tr('、')) }) })
  if (p.updates?.security) out.push({ level: 'warn', kind: 'updates', text: tr('有 {n} 个安全更新可装', { n: p.updates.security }) })
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'danger' ? -1 : 1))
}

// ── 差异（配置漂移 / 变更报告） ─────────────────────────

export interface FileChange { path: string; kind: 'modified' | 'added' | 'removed'; from?: string; to?: string }   // from/to：前后 sha256
export interface ContainerChange { name: string; from: Pick<Container, 'image' | 'state'>; to: Pick<Container, 'image' | 'state'> }
export interface ProfileDiff {
  portsAdded: ListenPort[]; portsRemoved: ListenPort[]
  servicesFailed: string[]; servicesRecovered: string[]
  containersAdded: Container[]; containersRemoved: Container[]; containersChanged: ContainerChange[]
  files: FileChange[]
  uid0Added: string[]
  newLoginIps: string[]
  disks: { mount: string; from: number; to: number }[]
}

export const DISK_DRIFT_PCT = 10
const portKey = (p: ListenPort) => `${p.addr}|${p.port}`

/** 本次（cur）相对上次（prev）变了什么。只比两边都采到了的部分（快照没有磁盘 / 登录等就不比） */
export function diffProfiles(prev: HostProfile, cur: HostProfile): ProfileDiff {
  const d: ProfileDiff = { portsAdded: [], portsRemoved: [], servicesFailed: [], servicesRecovered: [], containersAdded: [], containersRemoved: [], containersChanged: [], files: [], uid0Added: [], newLoginIps: [], disks: [] }
  if (prev.ports && cur.ports) {
    const a = new Set(prev.ports.map(portKey)), b = new Set(cur.ports.map(portKey))
    d.portsAdded = cur.ports.filter((p) => !a.has(portKey(p)))
    d.portsRemoved = prev.ports.filter((p) => !b.has(portKey(p)))
  }
  if (prev.failedUnits && cur.failedUnits) {
    d.servicesFailed = cur.failedUnits.filter((u) => !prev.failedUnits!.includes(u))
    d.servicesRecovered = prev.failedUnits.filter((u) => !cur.failedUnits!.includes(u))
  }
  if (prev.containers && cur.containers) {
    const a = new Map(prev.containers.map((c) => [c.name, c])), b = new Map(cur.containers.map((c) => [c.name, c]))
    d.containersAdded = cur.containers.filter((c) => !a.has(c.name))
    d.containersRemoved = prev.containers.filter((c) => !b.has(c.name))
    for (const c of cur.containers) {
      const o = a.get(c.name)
      if (o && (o.image !== c.image || o.state !== c.state)) d.containersChanged.push({ name: c.name, from: { image: o.image, state: o.state }, to: { image: c.image, state: c.state } })
    }
  }
  if (prev.files && cur.files) {
    const a = new Map(prev.files.map((f) => [f.path, f])), b = new Map(cur.files.map((f) => [f.path, f]))
    for (const f of cur.files) {
      const o = a.get(f.path)
      if (!o) d.files.push({ path: f.path, kind: 'added', ...(f.sha256 ? { to: f.sha256 } : {}) })
      else if (o.sha256 && f.sha256 && o.sha256 !== f.sha256) d.files.push({ path: f.path, kind: 'modified', from: o.sha256, to: f.sha256 })
    }
    for (const o of prev.files) if (!b.has(o.path)) d.files.push({ path: o.path, kind: 'removed', ...(o.sha256 ? { from: o.sha256 } : {}) })
  }
  if (prev.uid0 && cur.uid0) d.uid0Added = cur.uid0.filter((u) => !prev.uid0!.includes(u))
  if (prev.logins && cur.logins) {
    const seen = new Set(prev.logins.map((l) => l.ip))
    d.newLoginIps = [...new Set(cur.logins.map((l) => l.ip).filter((ip) => ip !== '0.0.0.0' && !seen.has(ip)))]
  }
  if (prev.disks && cur.disks) {
    const a = new Map(prev.disks.map((x) => [x.mount, x.usedPct]))
    for (const x of cur.disks) {
      const o = a.get(x.mount)
      if (o !== undefined && Math.abs(x.usedPct - o) > DISK_DRIFT_PCT) d.disks.push({ mount: x.mount, from: o, to: x.usedPct })
    }
  }
  return d
}

export const diffIsEmpty = (d: ProfileDiff) => Object.values(d).every((v) => Array.isArray(v) && v.length === 0)

const baseName = (p: string) => p.split('/').pop() || p

/** 一行一项的摘要（「端口 +1」「nginx.conf 已修改」），变更报告标题和体检「和上次比」共用 */
export function summarizeDiff(d: ProfileDiff): string[] {
  const s: string[] = []
  const pm = (a: number, r: number) => [a ? `+${a}` : '', r ? `-${r}` : ''].filter(Boolean).join(' ')
  if (d.portsAdded.length || d.portsRemoved.length) s.push(tr('端口 {v}', { v: pm(d.portsAdded.length, d.portsRemoved.length) }))
  if (d.servicesFailed.length) s.push(tr('新失败服务 {n}', { n: d.servicesFailed.length }))
  if (d.servicesRecovered.length) s.push(tr('服务恢复 {n}', { n: d.servicesRecovered.length }))
  if (d.containersAdded.length || d.containersRemoved.length) s.push(tr('容器 {v}', { v: pm(d.containersAdded.length, d.containersRemoved.length) }))
  if (d.containersChanged.length) s.push(tr('容器变化 {n}', { n: d.containersChanged.length }))
  for (const f of d.files) s.push(`${baseName(f.path)} ${f.kind === 'modified' ? tr('已修改') : f.kind === 'added' ? tr('新出现') : tr('已消失')}`)
  if (d.uid0Added.length) s.push(tr('新增 UID0 用户 {v}', { v: d.uid0Added.join(tr('、')) }))
  if (d.newLoginIps.length) s.push(tr('新登录来源 {n}', { n: d.newLoginIps.length }))
  for (const x of d.disks) s.push(tr('{mount} 磁盘 {from}%→{to}%', { mount: x.mount, from: x.from, to: x.to }))
  return s
}

// ── 报告文本（「让 AI 解读」） ──────────────────────────

const gb = (kb?: number) => (kb === undefined ? '?' : `${(kb / 1048576).toFixed(1)}G`)

export function profileReportText(p: HostProfile, issues: HostIssue[], diff?: ProfileDiff): string {
  const sep = tr('、'), none = tr('无')
  const L: string[] = [tr('主机：{host}，体检时间：{at}', { host: p.hostLabel ?? p.hostKey, at: p.at })]
  if (p.sys) L.push(tr('系统：{os}，内核 {kernel}（{arch}），主机名 {hostname}，已运行 {uptime}', { os: p.sys.os ?? '?', kernel: p.sys.kernel ?? '?', arch: p.sys.arch ?? '?', hostname: p.sys.hostname ?? '?', uptime: p.sys.uptimeSec !== undefined ? tr('{n} 天', { n: Math.floor(p.sys.uptimeSec / 86400) }) : '?' }))
  if (p.cpu) L.push(tr('CPU：{cores} 核，负载 {load}', { cores: p.cpu.cores ?? '?', load: p.cpu.load?.join(' / ') ?? '?' }))
  if (p.mem) L.push(tr('内存：共 {total}，可用 {avail}；swap 共 {swap}，空闲 {swapFree}', { total: gb(p.mem.totalKb), avail: gb(p.mem.availKb), swap: gb(p.mem.swapTotalKb), swapFree: gb(p.mem.swapFreeKb) }))
  if (p.disks?.length) L.push(tr('磁盘：{v}', { v: p.disks.map((d) => `${d.mount} ${d.usedPct}%${d.inodePct !== undefined ? tr('（inode {pct}%）', { pct: d.inodePct }) : ''}`).join(tr('，')) }))
  if (p.ports) L.push(tr('监听端口：{v}', { v: p.ports.map((x) => `${x.port}${x.process ? `(${x.process})` : ''}`).join(sep) || none }))
  if (p.failedUnits) L.push(tr('失败服务：{v}', { v: p.failedUnits.join(sep) || none }))
  if (p.containers) L.push(tr('容器：{v}', { v: p.containers.map((c) => `${c.name}[${c.image}, ${c.state}]`).join(sep) || none }))
  if (p.sshd) L.push(tr('sshd：PermitRootLogin {root}，PasswordAuthentication {pwd}（来自 {src}）', { root: String(p.sshd.permitRootLogin), pwd: String(p.sshd.passwordAuthentication), src: p.sshd.source }))
  if (p.uid0) L.push(tr('UID 0 用户：{v}', { v: p.uid0.join(sep) }))
  if (p.certs?.length) L.push(tr('证书：{v}', { v: p.certs.map((c) => `${c.path} ${c.notAfter ? tr('到期 {date}', { date: c.notAfter.slice(0, 10) }) : String(c.error)}`).join(tr('；')) }))
  if (p.updates) L.push(tr('可更新包（{mgr}）：{v}', { mgr: p.updates.manager, v: p.updates.unknown ? tr('未知（检查超时 / 失败）') : tr('共 {total} 个，安全更新 {security} 个', { total: p.updates.total ?? '?', security: p.updates.security ?? '?' }) }))
  if (p.logins?.length) L.push(tr('最近登录来源：{v}', { v: [...new Set(p.logins.map((l) => `${l.user}@${l.ip}`))].join(sep) }))
  L.push('', issues.length ? `${tr('发现的问题：')}\n${issues.map((i) => `- [${i.level === 'danger' ? tr('严重') : tr('注意')}] ${i.text}`).join('\n')}` : tr('发现的问题：无'))
  if (diff && !diffIsEmpty(diff)) L.push('', tr('和上次体检相比：{v}', { v: summarizeDiff(diff).join(tr('；')) }))
  return L.join('\n')
}

// ── 变更报告（AI 一轮前后快照） ─────────────────────────

export interface TurnHostChange {
  hostKey: string; hostLabel?: string
  beforeId?: string; afterId?: string
  diff?: ProfileDiff
  summary: string[]
  error?: string            // 前 / 后快照没拍成（不影响执行）
}
export interface TurnHostReport { sessionId: string; dshId: string; turnId: string; at: string; hosts: TurnHostChange[] }

/** 存盘用的安全目录名：hostKey 可能是 host:port（Windows 文件名不能有冒号） */
export const hostDirName = (hostKey: string) => hostKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120).replace(/^\.*$/, '_')
