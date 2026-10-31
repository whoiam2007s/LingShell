// 按回合撤销 AI 改过的文件（回合末「本轮改了 N 个文件」汇总条背后的主进程逻辑）。
// 汇总只从执行记录（audit）聚合，见 shared/ai/turnChanges.ts；这里负责：撤销前检查（文件是否已被后续改动覆盖）、
// 查看差异（本轮之前 → 当前）、撤销（修改的用本轮第一次写之前的备份还原，新建的先备份再删除）。
// 撤销前的当前内容一律先备份，并记一条 turn_undo 执行记录（带备份，执行记录里还能再「还原」回来）。
import { createHash } from 'node:crypto'
import {
  aggregateTurnChanges, undoOrder, decodeText,
  type AuditEntry, type TurnChanges, type TurnFileChange, type TurnFileCheck, type TurnFileState, type TurnUndoResult, tr,
} from '@lingshell/shared'
import { backupFile, writeWithBackup, type FileAccess } from '../files/index.js'

export const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex')

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 文件当前状态：与本轮写入后的内容比对 */
export async function checkFile(fa: FileAccess, f: TurnFileChange): Promise<TurnFileState> {
  const cur = await fa.read(f.path)
  if (cur === undefined) return 'missing'
  if (!f.afterHash) return 'unknown'
  return sha256(cur) === f.afterHash ? 'same' : 'changed'
}

/** 撤销一个文件。返回结果与撤销前当前内容的备份（无当前内容则无备份） */
export async function undoFile(fa: FileAccess, f: TurnFileChange, now = new Date()): Promise<{ result: TurnUndoResult; backupPath?: string }> {
  const base = { key: f.key, path: f.path }
  if (f.created) {
    const cur = await fa.read(f.path)
    if (cur === undefined) return { result: { ...base, ok: true, action: 'skipped', error: tr('文件已不存在，无需删除') } }
    if (!fa.remove) throw new Error(tr('该主机不支持删除文件'))
    const backupPath = await backupFile(fa, f.path, cur, now)
    await fa.remove(f.path)
    return { result: { ...base, ok: true, action: 'deleted' }, backupPath }
  }
  if (!f.backupPath) throw new Error(tr('没有本轮改动前的备份，无法还原'))
  const original = await fa.read(f.backupPath)
  if (original === undefined) throw new Error(tr('备份文件已不存在：{path}', { path: f.backupPath }))
  const r = await writeWithBackup(fa, f.path, original, now)
  return { result: { ...base, ok: true, action: 'restored' }, backupPath: r.backupPath }
}

export interface TurnUndoDeps {
  handle(channel: string, fn: (...args: any[]) => unknown): void   // eslint-disable-line @typescript-eslint/no-explicit-any
  entries(sessionId: string): AuditEntry[]
  dshIdOf(sessionId: string): string
  access(hostKey: string): Promise<FileAccess>
  audit(e: Omit<AuditEntry, 'at'>): void
  diff(before: string, after: string, path: string): string
}

export function registerTurnUndo(d: TurnUndoDeps) {
  const turnsOf = (sid: string): TurnChanges[] => aggregateTurnChanges(d.entries(sid), d.dshIdOf(sid))
  const filesOf = (sid: string, turnId: string, keys?: string[]): TurnFileChange[] => {
    const files = turnsOf(sid).find((t) => t.turnId === turnId)?.files ?? []
    return Array.isArray(keys) ? files.filter((f) => keys.includes(f.key)) : files
  }
  const accessOr = async (hostKey: string): Promise<FileAccess | Error> => d.access(hostKey).catch((e: unknown) => new Error(msg(e)))

  d.handle('turnChanges:list', (_e, sid: string) => turnsOf(String(sid)))

  // 撤销前检查：哪些已被后续改动覆盖、哪些已不在、哪些主机连不上
  d.handle('turnChanges:check', async (_e, sid: string, turnId: string, keys?: string[]): Promise<TurnFileCheck[]> => {
    const out: TurnFileCheck[] = []
    for (const f of filesOf(String(sid), String(turnId), keys)) {
      const fa = await accessOr(f.hostKey)
      if (fa instanceof Error) { out.push({ key: f.key, state: 'unknown', error: fa.message }); continue }
      try { out.push({ key: f.key, state: await checkFile(fa, f) }) } catch (e) { out.push({ key: f.key, state: 'unknown', error: msg(e) }) }
    }
    return out
  })

  // 查看差异：本轮之前（新建 = 空）→ 当前内容
  d.handle('turnChanges:diff', async (_e, sid: string, turnId: string, key: string) => {
    const f = filesOf(String(sid), String(turnId), [String(key)])[0]
    if (!f) throw new Error(tr('找不到这条改动记录'))
    const fa = await d.access(f.hostKey)
    const before = f.created ? '' : f.backupPath ? await fa.read(f.backupPath) : undefined
    if (before === undefined) throw new Error(tr('本轮改动前的备份已不存在，无法对比'))
    const cur = await fa.read(f.path)
    const text = (b: Buffer | string) => (typeof b === 'string' ? b : decodeText(b, fa.encoding))
    return {
      state: cur === undefined ? 'missing' : !f.afterHash ? 'unknown' : sha256(cur) === f.afterHash ? 'same' : 'changed',
      diff: d.diff(text(before), cur === undefined ? '' : text(cur), f.path) || tr('（内容无变化）'),
    }
  })

  // 撤销（全部或指定文件）：最后改的先还原，逐个执行、逐个出结果，一个失败不影响其他
  d.handle('turnChanges:undo', async (_e, sid: string, turnId: string, keys?: string[]): Promise<TurnUndoResult[]> => {
    const results: TurnUndoResult[] = []
    const dshId = d.dshIdOf(String(sid))
    for (const f of undoOrder(filesOf(String(sid), String(turnId), keys))) {
      if (f.undoneAt) { results.push({ key: f.key, path: f.path, ok: true, action: 'skipped', error: tr('已撤销过') }); continue }
      try {
        const fa = await d.access(f.hostKey)
        const { result, backupPath } = await undoFile(fa, f)
        results.push(result)
        d.audit({
          sessionId: String(sid), terminalId: f.terminalId, terminalTitle: f.terminalTitle, hostKey: f.hostKey,
          command: result.action === 'deleted' ? `撤销本轮改动：删除 AI 新建的 ${f.path}`   // i18n-ignore 执行记录原文
            : result.action === 'skipped' ? `撤销本轮改动：${f.path} 已不存在，无需删除` : `撤销本轮改动：还原 ${f.path} ← ${f.backupPath}`,   // i18n-ignore 执行记录原文
          decision: 'turn_undo', filePath: f.path, ...(backupPath ? { backupPath } : {}), dshId, undoOf: String(turnId),
        })
      } catch (e) {
        results.push({ key: f.key, path: f.path, ok: false, action: f.created ? 'deleted' : 'restored', error: msg(e) })
      }
    }
    return results
  })
}
