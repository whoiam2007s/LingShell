import type { AuditEntry } from '../protocol/index.js'

// 按回合汇总 AI 改过的文件（回合末「本轮改了 N 个文件」+ 撤销本轮）。数据全部来自执行记录（audit），
// 不依赖内存，历史会话回放 / 重启后照样能出汇总。只认 AI 的 write_file（decision=write_allowed）：
// 经终端命令（sed -i、echo >）改的文件没有备份，无法撤销。

export interface TurnFileChange {
  key: string              // hostKey + 路径，同一轮里同一文件写多次合成一项
  hostKey: string
  terminalId: string
  terminalTitle?: string
  path: string
  created: boolean         // 本轮第一次写之前文件不存在（撤销 = 删除）
  backupPath?: string      // 本轮第一次写之前的原文备份（撤销 = 用它还原）
  afterHash?: string       // 本轮最后一次写入内容的 sha256（与当前不同 = 已被后续改动覆盖）
  firstAt: string
  lastAt: string
  writes: number
  undoneAt?: string        // 本轮最后一次写之后已撤销过（turn_undo）
}

export interface TurnChanges { turnId: string; files: TurnFileChange[] }

export const fileKey = (hostKey: string, path: string) => `${hostKey}\u0000${path}`

/** 某 dsh 会话（dshId）里各轮的文件改动，按轮次先后；轮内按首次写入先后 */
export function aggregateTurnChanges(entries: AuditEntry[], dshId: string): TurnChanges[] {
  const sorted = [...entries].filter((e) => e.dshId === dshId).sort((a, b) => a.at.localeCompare(b.at))
  const turns = new Map<string, Map<string, TurnFileChange>>()
  for (const e of sorted) {
    if (e.decision !== 'write_allowed' || !e.turnId || !e.filePath) continue
    const files = turns.get(e.turnId) ?? new Map<string, TurnFileChange>()
    turns.set(e.turnId, files)
    const key = fileKey(e.hostKey, e.filePath)
    const f = files.get(key)
    if (!f) {
      files.set(key, {
        key, hostKey: e.hostKey, terminalId: e.terminalId, terminalTitle: e.terminalTitle, path: e.filePath,
        created: e.created ?? !e.backupPath, backupPath: e.backupPath, afterHash: e.afterHash, firstAt: e.at, lastAt: e.at, writes: 1,
      })
    } else Object.assign(f, { afterHash: e.afterHash, lastAt: e.at, writes: f.writes + 1 })
  }
  for (const e of sorted) {
    if (e.decision !== 'turn_undo' || !e.undoOf || !e.filePath) continue
    const f = turns.get(e.undoOf)?.get(fileKey(e.hostKey, e.filePath))
    if (f && e.at >= f.lastAt) f.undoneAt = e.at
  }
  const num = (t: string) => Number(t.replace(/^\D+/, '')) || 0
  return [...turns].sort(([a], [b]) => num(a) - num(b)).map(([turnId, files]) => ({ turnId, files: [...files.values()] }))
}

/** 撤销顺序：最后改的先还原（逆序） */
export function undoOrder(files: TurnFileChange[]): TurnFileChange[] {
  return [...files].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

// 撤销前对每个文件的检查结果：same=仍是本轮写入后的内容；changed=之后又被改过（覆盖前要确认）；
// missing=文件已不在；unknown=取不到（主机未连接等）或旧记录没有内容摘要
export type TurnFileState = 'same' | 'changed' | 'missing' | 'unknown'
export interface TurnFileCheck { key: string; state: TurnFileState; error?: string }
export interface TurnUndoResult { key: string; path: string; ok: boolean; action: 'deleted' | 'restored' | 'skipped'; error?: string }
