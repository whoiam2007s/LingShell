// 回滚备份的清理：本地（fs）与 SSH（SFTP）共用同一套策略（见 shared/files/backupPolicy.ts）。
//
// 为什么必须清：每次覆盖写都留一份，实测累积到 1460 个 / 64MB，而清理逻辑一直没做。
// 调用点：应用启动后一次 + 每天一次（本地）；SSH 主机在下次写入时顺手清（不主动连机器）。
import { basename } from 'node:path'
import {
  BACKUP_KEEP_DAYS, BACKUP_KEEP_PER_FILE, BACKUP_TOTAL_BYTES, isBackupFileName, planBackupPrune,
  type BackupEntry,
} from '@lingshell/shared'
import type { TreeOps } from './fileOps.js'

export interface PruneResult { deleted: number; freedBytes: number; kept: number }

/**
 * 列出备份目录 → 算该删哪些 → 删掉。
 * protect：不能删的文件名（被最近执行记录引用、界面上还能一键还原的那些）。
 * 目录不存在直接跳过（还没备份过）。
 */
export async function pruneBackupDir(ops: TreeOps, dir: string, opts: {
  now?: number
  protect?: Iterable<string>
  keepPerFile?: number
  totalBytes?: number
  keepDays?: number
} = {}): Promise<PruneResult> {
  let items: (BackupEntry & { isDir: boolean })[]
  try {
    const list = await ops.readdir(dir)
    items = []
    for (const it of list) {
      if (it.isDir || !isBackupFileName(it.name)) continue   // 只清我们自己生成的备份文件
      // 本地 readdir 不填 size（目录大时逐个 stat 太慢），这里按需补一次
      const size = it.size || (await ops.lstat(`${dir}/${it.name}`))?.size || 0
      items.push({ name: it.name, size, mtimeMs: (it.mtime ?? 0) * 1000, isDir: false })
    }
  } catch {
    return { deleted: 0, freedBytes: 0, kept: 0 }   // 目录不存在 / 没权限：当作没事
  }
  const plan = planBackupPrune(items, {
    now: opts.now, protect: opts.protect,
    keepPerFile: opts.keepPerFile ?? BACKUP_KEEP_PER_FILE,
    totalBytes: opts.totalBytes ?? BACKUP_TOTAL_BYTES,
    keepDays: opts.keepDays ?? BACKUP_KEEP_DAYS,
  })
  let deleted = 0
  let freedBytes = 0
  for (const name of plan.del) {
    try {
      await ops.unlink(`${dir}/${name}`)
      deleted++
      freedBytes += items.find((e) => e.name === name)?.size ?? 0
    } catch { /* 单个删失败不影响其它 */ }
  }
  return { deleted, freedBytes, kept: plan.kept }
}

/** 从执行记录里取出「还能一键还原」的备份文件名（这些不能被清掉） */
export function protectedBackupNames(paths: (string | undefined)[], limit = 200): string[] {
  const out: string[] = []
  for (const p of paths.slice(0, limit)) {
    if (!p) continue
    const n = basename(p)
    if (isBackupFileName(n)) out.push(n)
  }
  return [...new Set(out)]
}
