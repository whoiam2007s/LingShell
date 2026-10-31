// 资源管理器文件操作的纯逻辑（UI 预校验与主进程共用）：名称校验、路径拼接、同名改名、多选范围、删除确认文案。

/** 递归删除 / 下载目录的上限：超过就中止（远程 SFTP 逐个删/传太慢且难回头，请改用命令） */
export const TREE_CAP = 10000
export const TREE_MAX_DEPTH = 64

import { tk, tr } from '../i18n/i18n.js'

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 新建/重命名的名称校验；win = 本地 Windows（额外禁 <>:"|?* 、保留名、结尾空格或点）。合法返回 undefined */
export function nameError(name: string, win: boolean): string | undefined {
  if (!name) return tr('名称不能为空')
  if (name === '.' || name === '..') return tr('名称不能是 . 或 ..')
  if (/[/\\]/.test(name)) return tr('名称不能包含 / 或 \\')
  if (name.includes('\0')) return tr('名称不能包含空字符')
  if (win) {
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(name)) return tr('名称不能包含 < > : " | ? *')
    if (/[ .]$/.test(name)) return tr('名称不能以空格或 . 结尾')
    if (WIN_RESERVED.test(name)) return tr('{name} 是 Windows 保留名', { name })
  }
  return undefined
}

/** 路径看着像 Windows 本地路径（C:\ 或含反斜杠） */
export const isWinPath = (p: string) => /^[A-Za-z]:/.test(p) || p.includes('\\')

/** 目录 + 名称：按目录自带的分隔符拼（Windows 路径用 \，远程/posix 用 /） */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[A-Za-z]:$/.test(dir) ? '\\' : '/'
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name
}

/** 父目录：'/a' → '/'，'C:\a' → 'C:\'，'/a/b' → '/a' */
export function parentPath(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const d = p.slice(0, i)
  if (d === '') return '/'
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d
}

export function baseName(p: string): string {
  const q = p.replace(/[/\\]+$/, '')
  return q.slice(Math.max(q.lastIndexOf('/'), q.lastIndexOf('\\')) + 1)
}

/** 根目录或根下一级目录（/etc、C:\Windows）：不许删除/重命名，一手滑整机就废了 */
export function isProtectedDir(p: string): boolean {
  const q = p.replace(/[/\\]+$/, '').replace(/^\/([A-Za-z]:)/, '$1')   // Windows OpenSSH 的 /C:/x 当 C:/x 看
  if (q === '' || /^[A-Za-z]:$/.test(q)) return true
  return !/[/\\]/.test(q.replace(/^[A-Za-z]:/, '').slice(1))
}

/** 同名自动改名：a.txt → a (1).txt → a (2).txt；无扩展名/点开头文件整名加后缀 */
export function conflictName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let i = 1; ; i++) {
    const n = `${stem} (${i})${ext}`
    if (!taken(n)) return n
  }
}

/** Shift 多选：按可见顺序取 anchor 到 target 之间（含两端）；anchor 不在可见列表里就只选 target */
export function rangeSelect(order: string[], anchor: string | undefined, target: string): string[] {
  const a = anchor === undefined ? -1 : order.indexOf(anchor)
  const b = order.indexOf(target)
  if (a < 0 || b < 0) return [target]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** 选中项里去掉「祖先也被选中」的：删/下载父目录已包含它们，避免重复处理 */
export function topLevelPaths(paths: string[]): string[] {
  const under = (p: string, d: string) => p !== d && p.startsWith(d) && (/[/\\]$/.test(d) || /[/\\]/.test(p[d.length]))
  return paths.filter((p) => !paths.some((d) => d !== p && under(p, d)))
}

export interface DeletePlan { files: number; dirs: number; over: boolean }

/** 删除确认文案：本地进回收站可恢复；远程不可恢复，超上限直接拒绝 */
export function deleteConfirmText(plan: DeletePlan, local: boolean): string {
  const n = plan.over ? tr('超过 {n} 项', { n: TREE_CAP }) : tr('{files} 个文件、{dirs} 个文件夹', { files: plan.files, dirs: plan.dirs })
  if (local) return tr('将把 {n} 移到回收站（可从回收站恢复）。', { n })
  if (plan.over) return tr('{n}，超出单次删除上限，请在终端里用命令处理。', { n })
  return tr('将删除 {n}，不可恢复。', { n })
}

// ── 远程文件属性 / chmod / 打包解压 / 按名称搜索（服务器命令都走独立 exec channel，不往交互终端打字）──

/** shell 单引号转义：整体包进 '…'，内部的 ' 写成 '\''。所有拼进服务器命令的路径/名称都必须过它 */
export function shq(s: string): string {
  if (s.includes('\0')) throw new Error(tr('参数不能包含空字符'))   // 命令行里 \0 会截断，引号就失效了
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 用 sh 跑一段脚本：用户登录 shell 可能是 fish/csh，{ } 2>/dev/null 等写法不通用 */
export const shScript = (script: string) => `sh -c ${shq(script)}`

/** 权限位 → 'rwxr-xr-x'（含 setuid/setgid/sticky 的 s/S/t/T） */
export function modeString(mode: number): string {
  const bit = (b: number, c: string) => (mode & b ? c : '-')
  const special = (x: string, on: boolean, ch: string) => (on ? (x === '-' ? ch.toUpperCase() : ch) : x)
  const ux = special(bit(0o100, 'x'), !!(mode & 0o4000), 's')
  const gx = special(bit(0o010, 'x'), !!(mode & 0o2000), 's')
  const ox = special(bit(0o001, 'x'), !!(mode & 0o1000), 't')
  return bit(0o400, 'r') + bit(0o200, 'w') + ux + bit(0o040, 'r') + bit(0o020, 'w') + gx + bit(0o004, 'r') + bit(0o002, 'w') + ox
}

/** 权限位 → 八进制文本：无特殊位 3 位（755），有则 4 位（4755） */
export const modeOctal = (mode: number) => (mode & 0o7777).toString(8).padStart(mode & 0o7000 ? 4 : 3, '0')

/** 八进制输入（3–4 位 0–7）→ 权限位；不合法 undefined */
export const parseOctal = (s: string): number | undefined => (/^[0-7]{3,4}$/.test(s.trim()) ? parseInt(s.trim(), 8) : undefined)

/** SFTP readdir 的 longname（ls -l 格式）取属主/属组；格式不像 ls -l 就返回 undefined（由调用方回退 uid/gid） */
export function longnameOwner(longname: string): { owner: string; group: string } | undefined {
  const f = longname.trim().split(/\s+/)
  if (f.length < 4 || !/^[-dlcbps][-rwxsStT]{9}/.test(f[0])) return undefined
  return { owner: f[2], group: f[3] }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

/** 悬浮提示：权限 / 属主 / 大小 / 修改时间（只显示有的字段） */
export function attrsTooltip(e: { name: string; isDir: boolean; mode?: number; owner?: string; group?: string; size?: number; mtime?: number }): string {
  const lines = [e.name]
  if (e.mode !== undefined) lines.push(tr('权限：{mode}（{octal}）', { mode: modeString(e.mode), octal: modeOctal(e.mode) }))
  if (e.owner) lines.push(tr('属主：{v}', { v: `${e.owner}${e.group ? `:${e.group}` : ''}` }))
  if (!e.isDir && e.size !== undefined) lines.push(tr('大小：{v}', { v: formatSize(e.size) }))
  if (e.mtime) lines.push(tr('修改时间：{v}', { v: new Date(e.mtime * 1000).toLocaleString() }))
  return lines.join('\n')
}

export type ArchiveKind = 'tar.gz' | 'tar' | 'zip'
export function archiveKind(name: string): ArchiveKind | undefined {
  const n = name.toLowerCase()
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz'
  if (n.endsWith('.tar')) return 'tar'
  if (n.endsWith('.zip')) return 'zip'
  return undefined
}

/** 压缩包名：base.tar.gz，冲突改 base (1).tar.gz（不用 conflictName：它会改成 base.tar (1).gz） */
export function archiveName(base: string, taken: (n: string) => boolean): string {
  for (let i = 0; ; i++) {
    const n = `${base}${i ? ` (${i})` : ''}.tar.gz`
    if (!taken(n)) return n
  }
}

/** 命令输出里的「服务器缺工具」标记：NO_TOOL + 工具名 */
export const NO_TOOL = '__LINGSHELL_NO_TOOL__:'
export function missingTool(output: string): string | undefined {
  const i = output.indexOf(NO_TOOL)
  return i < 0 ? undefined : output.slice(i + NO_TOOL.length).trim().split(/\s/)[0]
}

/** 打包 dir 下的若干项到 out（绝对路径）。名称前加 ./ 防止以 - 开头被 tar 当选项 */
export const packCommand = (dir: string, names: string[], out: string) =>
  shScript(`command -v tar >/dev/null 2>&1 || { echo ${NO_TOOL}tar; exit 127; }; tar -czf ${shq(out)} -C ${shq(dir)} ${names.map((n) => shq(`./${n}`)).join(' ')}`)

/** 解压到压缩包所在目录。不覆盖已有文件（tar -k / unzip -n），同名的保留原文件并报错 */
export function unpackCommand(path: string, kind: ArchiveKind, dir: string): string {
  if (kind === 'zip') return shScript(`command -v unzip >/dev/null 2>&1 || { echo ${NO_TOOL}unzip; exit 127; }; unzip -n -q ${shq(path)} -d ${shq(dir)}`)
  return shScript(`command -v tar >/dev/null 2>&1 || { echo ${NO_TOOL}tar; exit 127; }; tar -x${kind === 'tar.gz' ? 'z' : ''}kf ${shq(path)} -C ${shq(dir)}`)
}

/** 按名称搜索的限制：深度、条数、超时 */
export const SEARCH_MAX_DEPTH = 6
export const SEARCH_LIMIT = 500
export const SEARCH_TIMEOUT_MS = 20_000

/**
 * root 下递归找名称匹配的项（不区分大小写；不含 * ? [ 时按「包含」匹配）。
 * 单次遍历：目录经 printf 输出成「d /path」，其余直接 -print「/path」；head 截断后 find 写管道收到 SIGPIPE 退出
 */
export function searchCommand(root: string, query: string, depth = SEARCH_MAX_DEPTH, limit = SEARCH_LIMIT): string {
  const pat = /[*?[]/.test(query) ? query : `*${query}*`
  return shScript(`find ${shq(root)} -mindepth 1 -maxdepth ${depth} -iname ${shq(pat)} \\( -type d -exec printf 'd %s\\n' {} \\; -o -print \\) 2>/dev/null | head -n ${limit + 1}`)
}

export interface SearchHit { name: string; path: string; isDir: boolean }
export function parseSearchOutput(out: string, limit = SEARCH_LIMIT): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = []
  for (const line of out.split('\n')) {
    const dir = line.startsWith('d /')
    const path = dir ? line.slice(2) : line
    if (!path.startsWith('/')) continue
    hits.push({ name: baseName(path), path, isDir: dir })
  }
  return { hits: hits.slice(0, limit), truncated: hits.length > limit }
}

// ── 快速过滤（纯前端，只过滤已加载、已展开的条目；与服务器 find 的「按名称搜索」不同）──

/** 过滤词 → 匹配函数：含 * ? 按通配匹配整个名称，否则按子串；都不区分大小写。空白返回 undefined（不过滤） */
export function nameFilter(query: string): ((name: string) => boolean) | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  if (!/[*?]/.test(q)) return (n) => n.toLowerCase().includes(q)
  const re = new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's')
  return (n) => re.test(n.toLowerCase())
}

/** 名称里要高亮的区间 [起, 止)：子串模式标出首个出现处；通配模式整名 */
export function filterHighlight(name: string, query: string): [number, number] | undefined {
  const q = query.trim().toLowerCase()
  if (!q || !nameFilter(q)?.(name)) return undefined
  if (/[*?]/.test(q)) return [0, name.length]
  const i = name.toLowerCase().indexOf(q)
  return [i, i + q.length]
}

/**
 * 在已加载的树上过滤：只看 root 及已展开目录里的条目（折叠目录不往里看）。
 * hits = 名称命中的；show = 要显示的（命中的 + 展开后里面有命中项的父目录）
 */
export function filterTree(
  children: Record<string, { path: string; name: string; isDir: boolean }[]>, root: string,
  expanded: ReadonlySet<string>, match: (name: string) => boolean,
): { show: Set<string>; hits: Set<string> } {
  const show = new Set<string>(), hits = new Set<string>()
  const walk = (dir: string): boolean => {
    let any = false
    for (const e of children[dir] ?? []) {
      const hit = match(e.name)
      const inner = e.isDir && expanded.has(e.path) && walk(e.path)
      if (hit) hits.add(e.path)
      if (hit || inner) { show.add(e.path); any = true }
    }
    return any
  }
  walk(root)
  return { show, hits }
}

/** 资源管理器写操作的执行记录 decision → 中文（AuditList / 会话报告共用） */
export function explorerAuditLabel(d: string): string | undefined {
  const l = ({ file_chmod: tk('修改权限'), file_chown: tk('修改属主'), file_copy: tk('复制'), file_move: tk('移动'), file_archive: tk('压缩'), file_extract: tk('解压'), file_edit_external: tk('外部编辑回传'), dir_sync: tk('目录同步') } as Record<string, string>)[d]
  return l === undefined ? undefined : tr(l)
}

// ── 浏览：排序 / 面包屑 / 出错说明 / 隐藏文件 / 按键跳转 ──
export type SortKey = 'name' | 'size' | 'mtime'
export interface SortSpec { key: SortKey; desc: boolean }
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
// 英文 / 数字 / 符号开头的在前，中文等其余的在后（各自内部再按自然顺序、中文按拼音）；只用 zh-CN 排序会把中文全排到英文前面
const asciiLead = (n: string) => n.charCodeAt(0) < 128
export const nameCompare = (a: string, b: string) => (asciiLead(a) === asciiLead(b) ? collator.compare(a, b) : asciiLead(a) ? -1 : 1)
/** 目录永远在前；其余按指定列，同值再按名称（名称用自然排序：file2 在 file10 前） */
export function sortEntries<T extends { name: string; isDir: boolean; size?: number; mtime?: number }>(list: T[], s: SortSpec): T[] {
  const dir = s.desc ? -1 : 1
  return [...list].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const byName = nameCompare(a.name, b.name)
    if (s.key === 'name') return byName * dir
    const va = s.key === 'size' ? (a.isDir ? 0 : a.size ?? 0) : a.mtime ?? 0
    const vb = s.key === 'size' ? (b.isDir ? 0 : b.size ?? 0) : b.mtime ?? 0
    return va === vb ? byName : (va - vb) * dir
  })
}
export const isHiddenName = (name: string) => name.startsWith('.') && name !== '.' && name !== '..'

/** 路径 → 面包屑（每段可点）：POSIX 以 / 开头；Windows 以盘符 D:\ 开头 */
export function breadcrumbs(p: string): { label: string; path: string }[] {
  if (isWinPath(p)) {
    const norm = p.replace(/\//g, '\\')
    const m = /^([A-Za-z]:)\\?/.exec(norm)
    if (!m) return [{ label: norm, path: norm }]
    const drive = `${m[1]}\\`
    const parts = norm.slice(m[0].length).split('\\').filter(Boolean)
    return [{ label: drive, path: drive }, ...parts.map((x, i) => ({ label: x, path: drive + parts.slice(0, i + 1).join('\\') }))]
  }
  const parts = p.split('/').filter(Boolean)
  return [{ label: '/', path: '/' }, ...parts.map((x, i) => ({ label: x, path: `/${parts.slice(0, i + 1).join('/')}` }))]
}

/** 列目录出错 → 中文说明（目录点开不再显示成「空」） */
export function fsErrorText(msg: string): string {
  if (/EACCES|EPERM|Permission denied|permission/i.test(msg)) return tr('没有权限打开（当前登录用户无权读取）')
  if (/ENOENT|No such file/i.test(msg)) return tr('不存在（可能已被删除或改名）')
  if (/ENOTDIR|Not a directory/i.test(msg)) return tr('这不是目录')
  if (/ELOOP|Too many (levels of )?symbolic links/i.test(msg)) return tr('符号链接循环')
  if (/not connected|No SFTP|closed|ECONNRESET/i.test(msg)) return tr('连接已断开，重连后再刷新')
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** 按键跳转（同资源管理器）：从当前项之后找第一个以输入前缀开头的，找不到再从头找 */
export function typeAheadTarget(order: { path: string; name: string }[], current: string | undefined, prefix: string): string | undefined {
  const q = prefix.toLowerCase()
  if (!q) return undefined
  const i = current ? order.findIndex((x) => x.path === current) : -1
  // 连续按同一个字母：在同首字母的项里轮转（从下一项开始找）；否则从当前项开始找（当前项也算）
  const same = q.length > 1 && [...q].every((c) => c === q[0])
  const key = same ? q[0] : q
  const start = same || q.length === 1 ? i + 1 : Math.max(i, 0)
  for (let k = 0; k < order.length; k++) {
    const x = order[(start + k) % order.length]
    if (x.name.toLowerCase().startsWith(key)) return x.path
  }
  return undefined
}
/** 方向键移动：返回新的当前项（到头不越界） */
export function moveCursor(order: string[], current: string | undefined, delta: number): string | undefined {
  if (!order.length) return undefined
  const i = current ? order.indexOf(current) : -1
  if (i < 0) return order[delta > 0 ? 0 : order.length - 1]
  return order[Math.min(order.length - 1, Math.max(0, i + delta))]
}
/** 详细信息列的修改时间：今年的显示「月-日 时:分」，往年的显示「年-月-日」 */
export function shortTime(sec: number | undefined, now = Date.now()): string {
  if (!sec) return ''
  const d = new Date(sec * 1000), p = (x: number) => String(x).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return d.getFullYear() === new Date(now).getFullYear() ? `${md} ${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getFullYear()}-${md}`
}

// ── 复制 / 剪切 / 粘贴、属性、校验和、改属主、内容搜索（远程命令都走独立 exec channel，参数一律 shq） ──
export type PasteMode = 'copy' | 'move'
/** 同名冲突怎么办：跳过 / 覆盖（文件夹是合并，同名文件覆盖）/ 保留两者（新的改名 a (1).txt） */
export type ConflictPolicy = 'skip' | 'overwrite' | 'rename'
const trimSep = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p)
/** p 是 dir 本身或在 dir 里面（粘贴文件夹到它自己里面要拦住） */
export function isInside(p: string, dir: string): boolean {
  const a = trimSep(p), b = trimSep(dir)
  return a === b || a.startsWith(b.endsWith('/') || b.endsWith('\\') ? b : b + (b.includes('\\') ? '\\' : '/'))
}
/** 远程复制 / 移动一项；merge = 目标是已存在的文件夹，把内容合并进去（同名文件覆盖） */
export function remotePasteCommand(src: string, dst: string, mode: PasteMode, merge: boolean): string {
  if (merge) {
    const cp = `cp -a ${shq(`${src}/.`)} ${shq(`${dst}/`)}`
    return shScript(mode === 'copy' ? cp : `${cp} && rm -rf -- ${shq(src)}`)
  }
  return shScript(mode === 'copy' ? `cp -a -- ${shq(src)} ${shq(dst)}` : `mv -f -- ${shq(src)} ${shq(dst)}`)
}
/** 统计若干项的文件夹数 / 文件数 / 总字节：GNU find 一次遍历；没有 -printf（busybox）退回 find+du */
export function sizeCommand(paths: string[]): string {
  const ps = paths.map(shq).join(' ')
  return shScript(`if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then find ${ps} -printf '%y %s\\n' 2>/dev/null | awk '{ if ($1 == "d") d++; else { f++; s += $2 } } END { printf "%d %d %.0f\\n", d, f, s }'; `
    + `else d=$(find ${ps} -type d 2>/dev/null | wc -l); f=$(find ${ps} ! -type d 2>/dev/null | wc -l); s=$(du -sk ${ps} 2>/dev/null | awk '{ s += $1 } END { printf "%.0f", s * 1024 }'); echo "$d $f $s"; fi`)
}
export function parseSizeOutput(out: string): { dirs: number; files: number; bytes: number } | undefined {
  const m = /(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(out.trim())
  return m ? { dirs: Number(m[1]), files: Number(m[2]), bytes: Number(m[3]) } : undefined
}
export type HashAlgo = 'md5' | 'sha1' | 'sha256'
export const checksumCommand = (path: string, algo: HashAlgo) =>
  shScript(`if command -v ${algo}sum >/dev/null 2>&1; then ${algo}sum -- ${shq(path)}; elif command -v openssl >/dev/null 2>&1; then openssl dgst -${algo} -r ${shq(path)}; else echo ${NO_TOOL}${algo}sum; exit 127; fi`)
export const parseChecksum = (out: string) => /^\\?([0-9a-fA-F]{32,128})\b/m.exec(out.trim())?.[1]?.toLowerCase()
/** 用户名 / 组名：字母数字 . _ -（也允许纯数字 uid / gid）；空 = 不改 */
export const ownerNameOk = (s: string) => /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}\$?$/.test(s)
export function chownCommand(paths: string[], owner: string, group: string, recursive: boolean): string {
  if (!owner && !group) throw new Error(tr('属主和属组至少填一个'))
  for (const x of [owner, group]) if (x && !ownerNameOk(x)) throw new Error(tr('名称不合法：{v}', { v: x }))
  const spec = group ? `${owner}:${group}` : owner
  return `chown ${recursive ? '-R ' : ''}-- ${shq(spec)} ${paths.map(shq).join(' ')}`
}
export const OWNERS_COMMAND = shScript(`(getent passwd 2>/dev/null || cat /etc/passwd) | cut -d: -f1; echo ---; (getent group 2>/dev/null || cat /etc/group) | cut -d: -f1`)
export function parseOwners(out: string): { users: string[]; groups: string[] } {
  const [u = '', g = ''] = out.split(/^---$/m)
  const list = (s: string) => [...new Set(s.split('\n').map((x) => x.trim()).filter(ownerNameOk))].sort()
  return { users: list(u), groups: list(g) }
}
export interface ContentHit { path: string; name: string; line: number; text: string }
/** 字面量 → POSIX ERE 转义（配合 grep -E 用）。不用 grep -F：Git Bash 的 GNU grep 3.0 在 -i -F 下会 abort，stdout 为空 */
export const ereLiteral = (s: string) => s.replace(/[\\.[\]^$*+?{}()|]/g, '\\$&')
/** 内容搜索：不区分大小写、按字面量；每个文件只取第一处；跳过二进制和 .git / node_modules。-Z 让文件名后跟 \0，文件名里有冒号也能分开 */
export const contentSearchCommand = (root: string, q: string, limit = SEARCH_LIMIT) =>
  shScript(`grep -rIinZ -m 1 -E --exclude-dir=.git --exclude-dir=node_modules -- ${shq(ereLiteral(q))} ${shq(root)} 2>/dev/null | head -n ${limit + 1}`)
export function parseContentSearch(out: string, limit = SEARCH_LIMIT): { hits: ContentHit[]; truncated: boolean } {
  const hits: ContentHit[] = []
  for (const line of out.split('\n')) {
    const z = line.indexOf('\0')
    if (z < 0) continue
    const path = line.slice(0, z), rest = line.slice(z + 1)
    const m = /^(\d+):(.*)$/.exec(rest)
    if (!m || !path) continue
    hits.push({ path, name: baseName(path), line: Number(m[1]), text: m[2].trim().slice(0, 200) })
  }
  return { hits: hits.slice(0, limit), truncated: hits.length > limit }
}
/** 「在终端中打开」的 cd 命令。shell：undefined = 远程（POSIX）；bash = 本地 Git Bash；cmd / powershell / wsl:<发行版> */
export function cdCommand(dir: string, shell?: string): string {
  if (shell === 'cmd') return `cd /d "${dir}"`
  // 远程是 Windows 自带 OpenSSH（SFTP 路径 /C:/x）：默认 shell 是 cmd，换回 C:\x
  if (shell === undefined && /^\/[A-Za-z]:(\/|$)/.test(dir)) return `cd /d "${dir.slice(1).replace(/\//g, '\\') || '\\'}"`
  if (shell === 'powershell') return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`
  const p = shell?.startsWith('wsl') ? dir.replace(/^([A-Za-z]):[\\/]?/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/') : dir
  return `cd ${shq(p)}`
}
