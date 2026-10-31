// 磁盘空间分析（只读）：逐层 du、大文件、常见占用、已删除仍被占用。命令拼装 + 输出解析都是纯函数，主进程见 desktop/main/ops/diskUsageIpc.ts。
// 全部命令只读：du / find / df / lsof / 读 /proc，不删不改；每段带 timeout，超时显示已统计的部分。
import type { TerminalType, TermOs } from '../protocol/index.js'
import { shq } from '../files/explorer.js'
import { tk, tr } from '../i18n/i18n.js'

export const DISK_LEVEL_TIMEOUT_SEC = 25
export const DISK_BIG_TIMEOUT_SEC = 40
export const DISK_BIG_MIN_MB = 50
export const DISK_BIG_LIMIT = 50
export const DISK_EXEC_MARGIN_MS = 10_000   // exec 通道超时 = 命令自带 timeout + 余量
export const DISK_COMMON_BUDGET_SEC = 20     // 「常见占用」整段最多算这么久（逐项 10s，加起来的可能远超 exec 超时）
export const DISK_PROC_MAX_FDS = 20_000      // /proc 回退扫 fd 的硬上限（没有 lsof 时的兜底）

/** 本地终端（Windows 走 Git Bash）和非 Windows 的 SSH 终端都能用 */
export const diskSupported = (type: TerminalType, os?: TermOs): boolean => type === 'local' || os !== 'windows'
/** 常见占用 / 已删除仍被占用只认 Linux 的目录与 /proc */
export const diskLinuxOnly = (type: TerminalType, os?: TermOs): boolean => type === 'ssh' && os !== 'windows' && os !== 'macos'

export interface DiskEntry { name: string; path: string; kb: number; dir: boolean }
export interface DiskFs { fs: string; mount: string; sizeKb: number; usedKb: number; availKb: number; usedPct: number }
export interface DiskLevel {
  dir: string
  totalKb: number
  entries: DiskEntry[]        // 按大小倒序
  truncated: boolean          // 超时：只统计了一部分
  denied: number              // 没权限读的子目录数（统计偏小）
  fs?: DiskFs
}
export interface DiskBigFile { path: string; bytes: number }
export interface DiskBigFiles { dir: string; minMb: number; files: DiskBigFile[]; truncated: boolean }
export interface DiskCommonItem { path: string; label: string; kb?: number; tip: string }
export interface DiskCommon { root: boolean; items: DiskCommonItem[]; journal?: string; truncated?: boolean }   // truncated = 总时长用完，后面几项没统计
export interface DiskDeletedItem { pid: number; command: string; fd?: string; bytes: number; path: string }
export interface DiskDeleted { source: 'lsof' | 'proc'; root: boolean; items: DiskDeletedItem[]; totalBytes: number }


/** Windows 本地路径给 Git Bash：C:\x → C:/x（MSYS 认 C:/ 形式）；其它原样 */
export const bashPath = (p: string): string => (/^[A-Za-z]:/.test(p) ? p.replace(/\\/g, '/') : p)

/** 子路径：dir + '/' + name（根目录 / 盘符根不重复斜杠） */
export const diskJoin = (dir: string, name: string): string => (/[/\\]$/.test(dir) ? dir + name : `${dir}/${name}`)

// 有 timeout 就套上（busybox / 老系统可能没有）
const T_FN = 'T() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }'
const CD = (dir: string) => `cd -- ${shq(bashPath(dir))} 2>/dev/null || { echo "@@nodir"; exit 0; }`

/** 一层：df（所在分区）+ 子目录名单 + du -a 深度 1（GNU 用 --max-depth，busybox / macOS 用 -d）。stderr 并进来数「没权限」 */
export function diskLevelCommand(dir: string, timeoutSec = DISK_LEVEL_TIMEOUT_SEC): string {
  return [
    T_FN, CD(dir),
    'echo "@@df"; df -kP . 2>/dev/null | tail -n 1',
    'echo "@@dirs"; for f in .[!.]* ..?* *; do [ -d "$f" ] && [ ! -L "$f" ] && printf "%s\\n" "$f"; done',
    'if du --version >/dev/null 2>&1; then DEP=--max-depth=1; else DEP="-d 1"; fi',
    `echo "@@du"; T ${timeoutSec} du -x -k -a $DEP . 2>&1; echo "@@rc $?"`,
  ].join('\n')
}

const lines = (s: string) => s.split(/\r?\n/)
// 按 @@标记 切段（标记行本身带的参数放进 head）
function sections(out: string): Map<string, { head: string; body: string[] }> {
  const m = new Map<string, { head: string; body: string[] }>()
  let cur: { head: string; body: string[] } | undefined
  for (const l of lines(out)) {
    const k = /^@@(\w+)\s?(.*)$/.exec(l)
    if (k) { cur = { head: k[2], body: [] }; m.set(k[1], cur); continue }
    cur?.body.push(l)
  }
  return m
}

export function parseDfLine(line: string): DiskFs | undefined {
  const m = /^(.*\S)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim())
  if (!m) return undefined
  return { fs: m[1], sizeKb: +m[2], usedKb: +m[3], availKb: +m[4], usedPct: +m[5], mount: m[6] }
}

const relName = (p: string) => p.replace(/^\.\//, '')

export function parseDiskLevel(out: string, dir: string): DiskLevel {
  const s = sections(out)
  if (s.has('nodir')) throw new Error(tr('目录不存在或没有权限进入：{dir}', { dir }))
  if (!s.has('du')) throw new Error(tr('读不到目录占用：远端命令没有输出'))
  const dirs = new Set((s.get('dirs')?.body ?? []).filter(Boolean))
  const rc = Number(s.get('rc')?.head)
  let total: number | undefined, denied = 0
  const entries: DiskEntry[] = []
  for (const l of s.get('du')!.body) {
    const m = /^(\d+)\t(.+)$/.exec(l)
    if (!m) { if (/denied|不允许|拒绝/i.test(l)) denied++; continue }   // i18n-ignore 匹配命令输出
    if (m[2] === '.') { total = +m[1]; continue }
    const name = relName(m[2])
    if (!name || name.includes('/')) continue   // 只要深度 1
    entries.push({ name, path: diskJoin(dir, name), kb: +m[1], dir: dirs.has(name) })
  }
  entries.sort((a, b) => b.kb - a.kb || a.name.localeCompare(b.name))
  const fsLine = s.get('df')?.body.find((l) => l.trim())
  return {
    dir, entries, denied,
    totalKb: total ?? entries.reduce((n, e) => n + e.kb, 0),
    truncated: total === undefined || rc === 124 || rc === 137,
    ...(fsLine && parseDfLine(fsLine) ? { fs: parseDfLine(fsLine) } : {}),
  }
}

// 结束标记用超大数排在 sort -rn 的最前面（不写临时文件也能带回 find 的退出码）
const RC_KEY = '99999999999999999999'
/** 大文件：find -xdev -size +NM，GNU 用 -printf 取字节数，没有 -printf（macOS / busybox）退回 du -k */
export function diskBigCommand(dir: string, minMb = DISK_BIG_MIN_MB, limit = DISK_BIG_LIMIT, timeoutSec = DISK_BIG_TIMEOUT_SEC): string {
  const sz = `-size +${Math.max(1, Math.floor(minMb))}M`
  return [
    T_FN, CD(dir),
    'echo "@@big"',
    '{ if find . -maxdepth 0 -printf "" >/dev/null 2>&1; then',
    `    T ${timeoutSec} find . -xdev -type f ${sz} -printf "%s\\t%p\\n" 2>/dev/null`,
    '  else',
    `    T ${timeoutSec} find . -xdev -type f ${sz} -exec du -k {} + 2>/dev/null | awk -F "\\t" "{ printf \\"%d\\t%s\\n\\", \\$1*1024, \\$2 }"`,
    `  fi; echo "${RC_KEY}\t@@rc $?"; } | sort -rn | head -n ${limit + 1}`,
  ].join('\n')
}

export function parseDiskBig(out: string, dir: string, minMb = DISK_BIG_MIN_MB): DiskBigFiles {
  const s = sections(out)
  if (s.has('nodir')) throw new Error(tr('目录不存在或没有权限进入：{dir}', { dir }))
  if (!s.has('big')) throw new Error(tr('读不到大文件列表：远端命令没有输出'))
  let truncated = true
  const files: DiskBigFile[] = []
  for (const l of s.get('big')!.body) {
    const m = /^(\d+)\t(.+)$/.exec(l)
    if (!m) continue
    const rc = /^@@rc (\d+)$/.exec(m[2])
    if (rc) { truncated = rc[1] === '124' || rc[1] === '137'; continue }
    files.push({ path: diskJoin(dir, relName(m[2])), bytes: +m[1] })
  }
  return { dir, minMb, files: files.slice(0, DISK_BIG_LIMIT), truncated }
}

/** 常见占用点：路径、名称、清理建议（只给建议，不替用户执行） */
export const DISK_COMMON: { path: string; label: string; tip: string }[] = [
  { path: '/var/log', label: tk('系统日志'), tip: tk('旧的轮转日志（*.gz、*.1）可以删；长期偏大要调 /etc/logrotate.d 里的保留份数') },
  { path: '/var/log/journal', label: tk('systemd 日志（journal）'), tip: tk('`journalctl --vacuum-size=500M` 只保留最近 500M；长期限制改 /etc/systemd/journald.conf 的 SystemMaxUse') },
  { path: '/var/lib/docker', label: tk('Docker 镜像 / 容器 / 卷'), tip: tk('先 `docker system df` 看哪类大；`docker image prune` 清悬空镜像，`docker system prune` 还会删已停止的容器（谨慎）') },
  { path: '/var/lib/containerd', label: 'containerd', tip: tk('`crictl rmi --prune` 清理不用的镜像（K8s 节点）') },
  { path: '/var/cache/apt/archives', label: tk('apt 包缓存'), tip: tk('`apt-get clean` 清空已下载的安装包') },
  { path: '/var/cache/yum', label: tk('yum 缓存'), tip: '`yum clean all`' },
  { path: '/var/cache/dnf', label: tk('dnf 缓存'), tip: '`dnf clean all`' },
  { path: '/var/lib/snapd', label: tk('snap 软件包'), tip: tk('每个 snap 默认保留 3 个旧版本：`snap set system refresh.retain=2` 后删 disabled 的旧版本') },
  { path: '/var/crash', label: tk('崩溃转储'), tip: tk('确认不再需要分析后删除') },
  { path: '/var/lib/systemd/coredump', label: tk('core 文件（systemd-coredump）'), tip: tk('`coredumpctl list` 查看；确认不需要后删除') },
  { path: '/tmp', label: tk('临时目录 /tmp'), tip: tk('先看是谁写的大文件，正在被用的不要删') },
  { path: '/var/tmp', label: tk('临时目录 /var/tmp'), tip: tk('重启不会自动清；确认无用后删除') },
  { path: '$HOME/.cache', label: tk('当前用户缓存 ~/.cache'), tip: tk('pip / npm 等工具的缓存，删了只是下次重新下载') },
]

export function diskCommonCommand(timeoutSec = 10, budgetSec = DISK_COMMON_BUDGET_SEC): string {
  return [
    T_FN,
    'echo "@@uid $(id -u 2>/dev/null)"',
    'echo "@@items"',
    'start=$(date +%s)',
    'cut=0',
    `for p in ${DISK_COMMON.map((c) => (c.path.startsWith('$HOME') ? `"${c.path}"` : shq(c.path))).join(' ')}; do`,
    '  [ -e "$p" ] || continue',
    '  left=$(( ' + budgetSec + ' - ($(date +%s) - start) ))',
    '  if [ "$left" -le 0 ]; then cut=1; break; fi',
    `  [ "$left" -gt ${timeoutSec} ] && left=${timeoutSec}`,
    '  printf "%s\\t%s\\n" "$p" "$(T "$left" du -sxk "$p" 2>/dev/null | tail -n 1 | cut -f1)"',
    'done',
    'echo "@@cut $cut"',
    'echo "@@journal"; T 5 journalctl --disk-usage 2>/dev/null | tail -n 1',
  ].join('\n')
}

export function parseDiskCommon(out: string): DiskCommon {
  const s = sections(out)
  if (!s.has('items')) throw new Error(tr('读不到常见占用：远端命令没有输出'))
  const items: DiskCommonItem[] = []
  for (const l of s.get('items')!.body) {
    const m = /^([^\t]+)\t(\d*)$/.exec(l)
    if (!m) continue
    // $HOME 已展开：按后缀对回 ~/.cache
    const c = DISK_COMMON.find((x) => x.path === m[1]) ?? (m[1].endsWith('/.cache') ? DISK_COMMON.find((x) => x.path === '$HOME/.cache') : undefined)
    if (!c) continue
    items.push({ path: m[1], label: tr(c.label), tip: tr(c.tip), ...(m[2] ? { kb: +m[2] } : {}) })
  }
  items.sort((a, b) => (b.kb ?? -1) - (a.kb ?? -1))
  const journal = s.get('journal')?.body.find((l) => l.trim())?.trim()
  return { root: s.get('uid')?.head.trim() === '0', items, ...(journal ? { journal } : {}), ...(s.get('cut')?.head.trim() === '1' ? { truncated: true } : {}) }
}

/** 已删除仍被占用：有 lsof 用 lsof +L1，没有就扫 /proc/<pid>/fd 里指向「(deleted)」的链接 */
export function diskDeletedCommand(timeoutSec = 20): string {
  return [
    T_FN,
    'echo "@@uid $(id -u 2>/dev/null)"',
    'if command -v lsof >/dev/null 2>&1; then',
    `  echo "@@lsof"; T ${timeoutSec} lsof -nP +L1 2>/dev/null`,
    'else',
    '  echo "@@proc"',
    '  cnt=0',
    '  for f in /proc/[0-9]*/fd/*; do',
    `    cnt=$((cnt+1)); [ "$cnt" -gt ${DISK_PROC_MAX_FDS} ] && break`,
    '    l=$(readlink "$f" 2>/dev/null) || continue',
    '    case "$l" in *" (deleted)")',
    '      p=${f#/proc/}; p=${p%%/*}; n=${f##*/}',
    '      sz=$(stat -L -c %s "$f" 2>/dev/null)',
    '      printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$(cat /proc/$p/comm 2>/dev/null)" "$n" "${sz:-0}" "$l";;',
    '    esac',
    '  done',
    'fi',
  ].join('\n')
}

const stripDeleted = (p: string) => p.replace(/\s+\(deleted\)$/, '')

/** lsof +L1：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NLINK NODE NAME；只要普通文件，同进程同 inode 只算一次 */
export function parseLsofDeleted(lines0: string[]): DiskDeletedItem[] {
  const seen = new Set<string>()
  const out: DiskDeletedItem[] = []
  for (const l of lines0) {
    const f = l.trim().split(/\s+/)
    if (f.length < 10 || !/^\d+$/.test(f[1]) || f[4] !== 'REG') continue
    const name = l.trim().split(/\s+/).slice(9).join(' ')
    if (!/\(deleted\)$/.test(name)) continue
    const key = `${f[1]}:${f[8]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pid: +f[1], command: f[0], fd: f[3].replace(/[^\d]/g, '') || f[3], bytes: /^\d+$/.test(f[6]) ? +f[6] : 0, path: stripDeleted(name) })
  }
  return out
}

export function parseProcDeleted(lines0: string[]): DiskDeletedItem[] {
  const seen = new Set<string>()
  const out: DiskDeletedItem[] = []
  for (const l of lines0) {
    const m = /^(\d+)\t([^\t]*)\t(\d+)\t(\d+)\t(.+)$/.exec(l)
    if (!m || m[5].startsWith('/memfd:') || m[5].startsWith('/dev/')) continue
    const key = `${m[1]}:${m[5]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pid: +m[1], command: m[2] || '?', fd: m[3], bytes: +m[4], path: stripDeleted(m[5]) })
  }
  return out
}

export function parseDiskDeleted(out: string): DiskDeleted {
  const s = sections(out)
  const root = s.get('uid')?.head.trim() === '0'
  const lsof = s.get('lsof'), proc = s.get('proc')
  if (!lsof && !proc) throw new Error(tr('读不到已删除文件：远端命令没有输出'))
  const items = (lsof ? parseLsofDeleted(lsof.body) : parseProcDeleted(proc!.body)).sort((a, b) => b.bytes - a.bytes)
  return { source: lsof ? 'lsof' : 'proc', root, items, totalBytes: items.reduce((n, i) => n + i.bytes, 0) }
}

/** 给 AI 的摘要：当前目录前 15 项 + 已统计的大文件 / 常见占用 / 已删除仍被占用（有就带） */
export function diskQuote(o: { host: string; level?: DiskLevel; big?: DiskBigFiles; common?: DiskCommon; deleted?: DiskDeleted; fmt: (bytes: number) => string }): string {
  const L: string[] = [tr('主机「{host}」磁盘空间分析（只读统计）：', { host: o.host })]
  const { level, big, common, deleted, fmt } = o
  if (level) {
    if (level.fs) L.push(tr('所在分区 {mount}：已用 {pct}%（{used} / {size}），剩余 {avail}', { mount: level.fs.mount, pct: level.fs.usedPct, used: fmt(level.fs.usedKb * 1024), size: fmt(level.fs.sizeKb * 1024), avail: fmt(level.fs.availKb * 1024) }))
    L.push(tr('目录 {dir} 合计 {total}{cut}，占用最大的：', { dir: level.dir, total: fmt(level.totalKb * 1024), cut: level.truncated ? tr('（超时，只统计了一部分）') : '' }))
    for (const e of level.entries.slice(0, 15)) L.push(`- ${e.dir ? tr('[目录] ') : ''}${e.path}  ${fmt(e.kb * 1024)}`)
  }
  if (big?.files.length) { L.push(tr('大于 {n}MB 的文件：', { n: big.minMb })); for (const f of big.files.slice(0, 15)) L.push(`- ${f.path}  ${fmt(f.bytes)}`) }
  if (common?.items.length) { L.push(tr('常见占用点：')); for (const c of common.items) L.push(`- ${c.label} ${c.path}  ${c.kb === undefined ? tr('（读不到）') : fmt(c.kb * 1024)}`) }
  if (common?.truncated) L.push(tr('（统计时间到，后面几项常见占用没来得及统计）'))
  if (deleted?.items.length) { L.push(tr('已删除但仍被进程占用（共 {total}）：', { total: fmt(deleted.totalBytes) })); for (const d of deleted.items.slice(0, 10)) L.push(`- ${d.command}(pid ${d.pid}) ${d.path}  ${fmt(d.bytes)}`) }
  L.push('', tr('请告诉我哪些可以安全清理、怎么清理（先给只读的确认命令），不要直接删除。'))
  return L.join('\n')
}
