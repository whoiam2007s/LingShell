// 本地 ↔ 远程目录比较与同步的纯逻辑（WinSCP Synchronize 风格）：glob 排除、按相对路径对齐判定、生成同步计划、远程 sha256 命令与解析。
// 主进程 main/dirSync.ts 负责两边遍历与执行；界面 DirSyncDialog 用同一个 buildSyncPlan 预览计划，主进程按同样规则重算后执行（不信任渲染层传来的路径）。
import { shq, shScript, NO_TOOL } from './explorer.js'
import { tk, tr } from '../i18n/i18n.js'

/** 遍历上限：超过任一项就拒绝比较（列表不完整时「镜像删除」会误删） */
export const SYNC_CAP = 10000
export const SYNC_MAX_DEPTH = 32
/** 修改时间容差（秒）：FAT / 部分 SFTP 服务器只到 2 秒精度 */
export const SYNC_MTIME_TOLERANCE = 2
export const SYNC_DEFAULT_EXCLUDES = '.git, node_modules'
export const SYNC_DECISION = 'dir_sync'

/** 一边遍历出的一项。rel 用 / 分隔、不带前导 /；mtime 为秒 */
export interface SyncEntry { rel: string; isDir: boolean; isLink?: boolean; size: number; mtime: number }
export interface SyncSide { isDir: boolean; isLink?: boolean; size: number; mtime: number }
export type SyncStatus = 'localOnly' | 'remoteOnly' | 'same' | 'diff'
export interface SyncRow {
  rel: string
  isDir: boolean
  status: SyncStatus
  local?: SyncSide
  remote?: SyncSide
  newer?: 'local' | 'remote'   // diff 时哪边修改时间较新（相差不超过容差则无）
  byHash?: boolean             // 判定用了 sha256
  skip?: string                // 不能同步的原因（符号链接 / 一边文件一边目录），其下的项也一并跳过
}

export type SyncDirection = 'upload' | 'download' | 'both'
export const SYNC_DIRECTION_LABEL: Record<SyncDirection, string> = { upload: tk('本地 → 远程（上传）'), download: tk('远程 → 本地（下载）'), both: tk('双向（较新者覆盖）') }

// ── glob 排除 ──

/** 排除规则文本 → 规则列表：逗号或换行分隔，# 开头为注释 */
export function parseExcludes(text: string): string[] {
  return text.split(/[,\n，]/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
}

function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export type ExcludeMatcher = (rel: string, isDir: boolean) => boolean

/**
 * 规则语义（近似 .gitignore）：不含 / 的规则匹配任意一级的名字（`.git`、`*.log`）；含 / 的规则从同步根起匹配相对路径（`dist/assets`、`/build`、`**`/tmp）；
 * 结尾 / 只匹配目录。目录被排除时整棵子树都不遍历（由调用方剪枝）。
 */
export function excludeMatcher(patterns: string[]): ExcludeMatcher {
  const rules = patterns.map((p) => {
    const dirOnly = p.endsWith('/')
    const q = p.replace(/\/+$/, '')
    const anchored = q.includes('/')
    return { re: globRe(anchored ? q.replace(/^\/+/, '') : q), dirOnly, anchored }
  }).filter((r) => r.re.source !== '^$')
  return (rel, isDir) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    return rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : name))
  }
}

// ── 对齐与判定 ──

const segs = (rel: string) => rel.split('/')
/** 按路径段排序：父目录总在其内容之前 */
export function compareRel(a: string, b: string): number {
  const x = segs(a), y = segs(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return x.length - y.length
}
export const parentRel = (rel: string) => rel.slice(0, Math.max(rel.lastIndexOf('/'), 0))
const ancestors = (rel: string) => { const out: string[] = []; for (let p = parentRel(rel); p; p = parentRel(p)) out.push(p); return out }
const isUnder = (rel: string, dir: string) => rel.startsWith(dir + '/')

/** 两边都有、都是普通文件且大小相同的：「按内容比较」时要算 sha256 的 */
export function hashCandidates(local: SyncEntry[], remote: SyncEntry[]): string[] {
  const r = new Map(remote.map((e) => [e.rel, e]))
  return local.filter((l) => {
    const x = r.get(l.rel)
    return x && !l.isDir && !x.isDir && !l.isLink && !x.isLink && l.size === x.size
  }).map((l) => l.rel)
}

/**
 * 对齐两边并判定。文件：大小不同 → 不同；大小相同且两边都有 sha256 → 按哈希；否则修改时间相差超过容差 → 不同。
 * 两边都是目录 → 相同（内容逐项另行比较）。符号链接、一边文件一边目录 → 标 skip，不参与同步。
 */
export function compareTrees(local: SyncEntry[], remote: SyncEntry[], hashes?: { local: Record<string, string>; remote: Record<string, string> }): SyncRow[] {
  const L = new Map(local.map((e) => [e.rel, e])), R = new Map(remote.map((e) => [e.rel, e]))
  const side = (e: SyncEntry): SyncSide => ({ isDir: e.isDir, size: e.size, mtime: e.mtime, ...(e.isLink ? { isLink: true } : {}) })
  const rows: SyncRow[] = []
  for (const rel of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(rel), r = R.get(rel)
    const base = { rel, ...(l ? { local: side(l) } : {}), ...(r ? { remote: side(r) } : {}) }
    const link = (l?.isLink || r?.isLink) ? tr('符号链接不同步') : undefined
    if (!l || !r) { rows.push({ ...base, isDir: (l ?? r)!.isDir && !link, status: l ? 'localOnly' : 'remoteOnly', ...(link ? { skip: link } : {}) }); continue }
    if (link) { rows.push({ ...base, isDir: false, status: 'diff', skip: link }); continue }
    if (l.isDir !== r.isDir) { rows.push({ ...base, isDir: false, status: 'diff', skip: tr('一边是文件、一边是目录') }); continue }
    if (l.isDir) { rows.push({ ...base, isDir: true, status: 'same' }); continue }
    const dt = l.mtime - r.mtime
    const newer = dt > SYNC_MTIME_TOLERANCE ? 'local' as const : dt < -SYNC_MTIME_TOLERANCE ? 'remote' as const : undefined
    const hl = hashes?.local[rel], hr = hashes?.remote[rel]
    let status: SyncStatus, byHash = false
    if (l.size !== r.size) status = 'diff'
    else if (hl && hr) { status = hl === hr ? 'same' : 'diff'; byHash = true }
    else status = newer ? 'diff' : 'same'
    rows.push({ ...base, isDir: false, status, ...(status === 'diff' && newer ? { newer } : {}), ...(byHash ? { byHash } : {}) })
  }
  return rows.sort((a, b) => compareRel(a.rel, b.rel))
}

// ── 同步计划 ──

export type SyncAction = 'upload' | 'download' | 'mkdirRemote' | 'mkdirLocal' | 'deleteRemote' | 'deleteLocal' | 'none'

/** 单行在给定方向下要做什么；不能做时返回原因（skip） */
export function rowAction(row: SyncRow, dir: SyncDirection, mirror: boolean): { action: SyncAction; skip?: string } {
  if (row.skip) return { action: 'none', skip: row.skip }
  const up = dir === 'upload' || dir === 'both', down = dir === 'download' || dir === 'both'
  const del = mirror && dir !== 'both'
  if (row.status === 'localOnly') {
    if (up) return { action: row.isDir ? 'mkdirRemote' : 'upload' }
    return { action: del ? 'deleteLocal' : 'none' }
  }
  if (row.status === 'remoteOnly') {
    if (down) return { action: row.isDir ? 'mkdirLocal' : 'download' }
    return { action: del ? 'deleteRemote' : 'none' }
  }
  if (row.status === 'diff') {
    if (dir === 'upload') return { action: 'upload' }
    if (dir === 'download') return { action: 'download' }
    if (row.newer) return { action: row.newer === 'local' ? 'upload' : 'download' }
    return { action: 'none', skip: tr('两边修改时间相同、内容不同，无法判断哪边较新') }
  }
  return { action: 'none' }
}

export interface SyncPlanFile { rel: string; size: number; mtime: number }
export interface SyncPlan {
  mkdirRemote: string[]                       // 由浅到深
  mkdirLocal: string[]
  upload: SyncPlanFile[]                      // mtime = 源（本地）修改时间，传完设到目标上
  download: SyncPlanFile[]
  deleteRemote: { rel: string; isDir: boolean }[]   // 由深到浅：先删内容再删目录（目录只 rmdir，不递归）
  deleteLocal: { rel: string; isDir: boolean }[]
  skipped: { rel: string; reason: string }[]
}

/**
 * 按勾选项生成计划。勾选的文件所在目录在目标端不存在时自动补建；skip 行下面的项一并跳过；
 * 镜像删除的目录只在其下所有项都勾选时才删（否则保留目录，只删勾选的内容）。
 */
export function buildSyncPlan(rows: SyncRow[], selected: Iterable<string>, dir: SyncDirection, mirror: boolean): SyncPlan {
  const sel = new Set(selected)
  const byRel = new Map(rows.map((r) => [r.rel, r]))
  const blocked = rows.filter((r) => r.skip).map((r) => r.rel)
  const plan: SyncPlan = { mkdirRemote: [], mkdirLocal: [], upload: [], download: [], deleteRemote: [], deleteLocal: [], skipped: [] }
  const mkR = new Set<string>(), mkL = new Set<string>()
  const needDirs = (rel: string, set: Set<string>, onlyStatus: SyncStatus) => {
    for (const a of ancestors(rel)) if (byRel.get(a)?.status === onlyStatus) set.add(a)
  }
  for (const row of rows) {
    if (!sel.has(row.rel)) continue
    const under = blocked.find((b) => isUnder(row.rel, b))
    if (under) { plan.skipped.push({ rel: row.rel, reason: tr('上级 {dir} 不同步', { dir: under }) }); continue }
    const { action, skip } = rowAction(row, dir, mirror)
    if (skip) { plan.skipped.push({ rel: row.rel, reason: skip }); continue }
    switch (action) {
      case 'upload': plan.upload.push({ rel: row.rel, size: row.local!.size, mtime: row.local!.mtime }); needDirs(row.rel, mkR, 'localOnly'); break
      case 'download': plan.download.push({ rel: row.rel, size: row.remote!.size, mtime: row.remote!.mtime }); needDirs(row.rel, mkL, 'remoteOnly'); break
      case 'mkdirRemote': mkR.add(row.rel); needDirs(row.rel, mkR, 'localOnly'); break
      case 'mkdirLocal': mkL.add(row.rel); needDirs(row.rel, mkL, 'remoteOnly'); break
      case 'deleteRemote': case 'deleteLocal': {
        const list = action === 'deleteRemote' ? plan.deleteRemote : plan.deleteLocal
        if (row.isDir && rows.some((r) => isUnder(r.rel, row.rel) && !sel.has(r.rel))) plan.skipped.push({ rel: row.rel, reason: tr('其下有未勾选的项，保留该目录') })
        else list.push({ rel: row.rel, isDir: row.isDir })
        break
      }
    }
  }
  const depth = (r: string) => segs(r).length
  plan.mkdirRemote = [...mkR].sort(compareRel)
  plan.mkdirLocal = [...mkL].sort(compareRel)
  plan.deleteRemote.sort((a, b) => depth(b.rel) - depth(a.rel) || compareRel(a.rel, b.rel))
  plan.deleteLocal.sort((a, b) => depth(b.rel) - depth(a.rel) || compareRel(a.rel, b.rel))
  return plan
}

/** 默认勾选：有差异且能同步的（相同、跳过的不勾） */
export const defaultSelection = (rows: SyncRow[]) => rows.filter((r) => r.status !== 'same' && !r.skip).map((r) => r.rel)

export function planSummary(p: SyncPlan) {
  const bytes = (l: SyncPlanFile[]) => l.reduce((n, f) => n + f.size, 0)
  return {
    upload: p.upload.length, uploadBytes: bytes(p.upload), download: p.download.length, downloadBytes: bytes(p.download),
    mkdirRemote: p.mkdirRemote.length, mkdirLocal: p.mkdirLocal.length, deleteRemote: p.deleteRemote.length, deleteLocal: p.deleteLocal.length,
    skipped: p.skipped.length,
    total: p.upload.length + p.download.length + p.mkdirRemote.length + p.mkdirLocal.length + p.deleteRemote.length + p.deleteLocal.length,
  }
}
/** 计划会改远程（上传 / 建目录 / 删除）：要记执行记录 */
export const planTouchesRemote = (p: SyncPlan) => p.upload.length + p.mkdirRemote.length + p.deleteRemote.length > 0

// ── 远程 sha256（服务器命令走独立 exec channel）──

/** 每批文件数：输出一行约 70 字节 + 路径，500 个远低于 exec 输出上限 */
export const HASH_BATCH = 500

/** root 下一批相对路径算 sha256：优先 sha256sum，没有就 shasum -a 256（macOS），都没有输出 NO_TOOL */
export function sha256Command(root: string, rels: string[]): string {
  const files = rels.map((r) => shq(`./${r}`)).join(' ')
  return shScript(`cd ${shq(root)} || exit 1; if command -v sha256sum >/dev/null 2>&1; then H=sha256sum; elif command -v shasum >/dev/null 2>&1; then H='shasum -a 256'; else echo ${NO_TOOL}sha256sum; exit 127; fi; $H -- ${files}`)
}

/** sha256sum 输出 → rel → 哈希。文件名含 \ 或换行时 GNU 会转义（行首 \），这类不认，按修改时间判定 */
export function parseSha256Output(out: string): Record<string, string> {
  const r: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line.replace(/\r$/, ''))
    if (m) r[m[2]] = m[1]
  }
  return r
}

// ── 主进程 ↔ 界面 ──

export interface DirSyncCompareReq { terminalId: string; localRoot: string; remoteRoot: string; excludes: string[]; byContent: boolean }
export interface DirSyncCompareResult {
  rows: SyncRow[]
  localRoot: string; remoteRoot: string            // 规范化后的两边根
  excluded: number                                 // 被排除规则剪掉的项数（两边合计，排除的目录只算一项）
  hashNote?: string                                // 按内容比较的说明（服务器没有 sha256sum 等）
}
export interface DirSyncProgress {
  phase: 'scan' | 'hash' | 'run' | 'done'
  scanned?: number
  doneItems: number; totalItems: number
  doneBytes: number; totalBytes: number
  current?: string
}
export interface DirSyncRunResult {
  uploaded: number; downloaded: number; mkdirs: number; deletedRemote: number; deletedLocal: number
  failed: { rel: string; error: string }[]
  cancelled: boolean
}
