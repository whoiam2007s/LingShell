// 回滚备份的保留策略（纯逻辑，本地与 SSH 主机共用）。
//
// 背景：每次覆盖写都会在 `~/.lingshell/backups/` 留一份，实测已累积 1460 个 / 64MB，
// 而清理逻辑一直没做。这里的规则同时约束三件事：每文件份数、总大小、保留天数。
//
// 文件名格式见 apps/desktop/src/main/files/fileOps.ts 的 backupName()：
//   <YYYYMMDD-HHMMSS-mmm>_<原路径拼平>     例：20261117-222333-144_etc_nginx_nginx.conf

/** 每个原文件最多保留几份 */
export const BACKUP_KEEP_PER_FILE = 5
/** 备份目录总量上限（每个主机各算） */
export const BACKUP_TOTAL_BYTES = 200 * 1024 * 1024
/** 超过这个天数的备份直接清理 */
export const BACKUP_KEEP_DAYS = 30
/** 超过这个大小的文件不做自动备份（全量拷一份代价太大） */
export const BACKUP_SKIP_BYTES = 10 * 1024 * 1024
/** 同一文件在这个窗口内的多次写入，只保留第一次的备份（回滚要的是"改动前"的原件） */
export const BACKUP_DEDUP_MS = 5 * 60_000

const DAY_MS = 24 * 60 * 60 * 1000
const TS_PREFIX = /^\d{8}-\d{6}-\d{3}_/

/** 备份文件名 → 原文件标识（去掉时间戳前缀）；不是备份命名就原样返回 */
export function origKeyOf(backupName: string): string {
  return TS_PREFIX.test(backupName) ? backupName.replace(TS_PREFIX, '') : backupName
}

/** 备份文件名里的时间戳（毫秒）；解析不出来返回 0 */
export function backupTimeOf(backupName: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})_/.exec(backupName)
  if (!m) return 0
  const [, y, mo, d, h, mi, s, ms] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)).getTime()
}

export interface BackupEntry {
  /** 备份目录里的文件名 */
  name: string
  size: number
  /** 修改时间（毫秒） */
  mtimeMs: number
}

export interface PrunePlan {
  /** 要删除的文件名（已排除 protect） */
  del: string[]
  /** 预计释放的字节数 */
  freedBytes: number
  /** 清理后剩下多少个 */
  kept: number
}

/**
 * 算出该删哪些备份。
 * - protect：**不能删**的文件名（被最近执行记录引用、界面还能一键还原的那些）
 * - 三条规则任一条超了都会进入删除集合：每文件份数 / 总量 / 保留天数
 */
export function planBackupPrune(
  entries: BackupEntry[],
  o: {
    now?: number
    keepPerFile?: number
    totalBytes?: number
    keepDays?: number
    protect?: Iterable<string>
  } = {},
): PrunePlan {
  const now = o.now ?? Date.now()
  const keepPerFile = o.keepPerFile ?? BACKUP_KEEP_PER_FILE
  const totalBytes = o.totalBytes ?? BACKUP_TOTAL_BYTES
  const keepDays = o.keepDays ?? BACKUP_KEEP_DAYS
  const protect = new Set(o.protect ?? [])

  const alive = entries.filter((e) => !protect.has(e.name))
  const doomed = new Set<string>()

  // 1) 每个原文件只留最近 keepPerFile 份
  const byKey = new Map<string, BackupEntry[]>()
  for (const e of alive) {
    const k = origKeyOf(e.name)
    const arr = byKey.get(k)
    if (arr) arr.push(e)
    else byKey.set(k, [e])
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const e of arr.slice(keepPerFile)) doomed.add(e.name)
  }

  // 2) 超过保留天数
  const cutoff = now - keepDays * DAY_MS
  for (const e of alive) if (e.mtimeMs > 0 && e.mtimeMs < cutoff) doomed.add(e.name)

  // 3) 总量：先减掉已判定删除的，还超就从最旧的开始继续删
  const survivors = alive.filter((e) => !doomed.has(e.name))
  let total = survivors.reduce((n, e) => n + Math.max(0, e.size), 0)
  if (total > totalBytes) {
    const oldestFirst = [...survivors].sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of oldestFirst) {
      if (total <= totalBytes) break
      doomed.add(e.name)
      total -= Math.max(0, e.size)
    }
  }

  const del = [...doomed]
  const freedBytes = entries.filter((e) => doomed.has(e.name)).reduce((n, e) => n + Math.max(0, e.size), 0)
  return { del, freedBytes, kept: entries.length - del.length }
}

/** 是不是我们生成的备份文件名（带时间戳前缀） */
export const isBackupFileName = (name: string): boolean => TS_PREFIX.test(name)

/**
 * 同一文件 BACKUP_DEDUP_MS 内已经有备份了：这次的写入不必再备一份。
 * 判断依据是已有备份的文件名时间戳，而不是磁盘状态（不额外 IO）。
 */
export function recentBackupExists(entries: BackupEntry[], fileName: string, now = Date.now(), windowMs = BACKUP_DEDUP_MS): boolean {
  const key = origKeyOf(fileName)
  return entries.some((e) => origKeyOf(e.name) === key && now - e.mtimeMs < windowMs)
}
