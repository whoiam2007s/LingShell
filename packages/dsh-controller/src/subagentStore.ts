// 子代理记录落盘（0.1.15 遗留问题 17）：之前只存内存，重启后主会话标题栏的下拉就空了。
// 一个主会话一个文件：<baseDir>/subagents/<sessionId>.json —— 记录少、全量覆盖写最简单，
// 不放进 dsh 的会话存档（那是引擎自己的格式，别混）。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubagentRecord } from './subagent.js'

/** 每个主会话最多留这么多条（新的在后，超出丢最老的） */
export const SUBAGENT_LOG_MAX = 50

const dirOf = (baseDir: string) => join(baseDir, 'subagents')
const fileOf = (baseDir: string, sessionId: string) => join(dirOf(baseDir), `${sessionId.replace(/[^\w.-]/g, '_')}.json`)

/** 读某个主会话的子代理记录；文件不存在 / 损坏 / 结构不对 → 空数组（不能让列表把应用带崩） */
export async function loadSubagentLog(baseDir: string, sessionId: string): Promise<SubagentRecord[]> {
  if (!baseDir || !sessionId) return []
  try {
    const raw = await readFile(fileOf(baseDir, sessionId), 'utf8')
    const j = JSON.parse(raw) as unknown
    const arr = Array.isArray(j) ? j : (j as { records?: unknown })?.records
    if (!Array.isArray(arr)) return []
    return arr.filter((r): r is SubagentRecord => !!r && typeof r === 'object' && typeof (r as SubagentRecord).subagentId === 'string')
  } catch { return [] }
}

/** 覆盖写某个主会话的子代理记录（只留最近 SUBAGENT_LOG_MAX 条）；失败只记日志，不影响主流程 */
export async function saveSubagentLog(baseDir: string, sessionId: string, records: SubagentRecord[]): Promise<void> {
  if (!baseDir || !sessionId) return
  try {
    const keep = records.slice(-SUBAGENT_LOG_MAX)
    await mkdir(dirOf(baseDir), { recursive: true })
    await writeFile(fileOf(baseDir, sessionId), JSON.stringify({ v: 1, records: keep }), 'utf8')
  } catch { /* 落盘失败不该影响子代理本身（下次状态变化会再写一次） */ }
}
