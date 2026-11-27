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
const safeSegment = (id: string) => id.replace(/[^\w.-]/g, '_')

/**
 * 子代理明文执行记录（live.jsonl）的目录：`<baseDir>/subagents/live/<id>`。
 *
 * 为什么不跟会话日志放一起：这份记录在**发任务之前**就得开始写，那一刻子会话的日志还没落盘，
 * 解析不到它的会话目录；旧代码这时回退到 `dsh-sessions/<id>`，而 dsh 的 JSONL 存档把
 * 「根目录下某个目录里直接有 *.jsonl」判成不支持的扁平布局并直接抛错——一个这样的坏目录
 * 就让整个会话存储（历史列表 / 恢复 / 新建）全部打不开。所以固定写在会话存档**之外**，
 * 跟落盘时序无关，也不会再污染 dsh 的根目录。
 */
export function liveLogDir(baseDir: string, subagentId: string): string {
  return join(dirOf(baseDir), 'live', safeSegment(subagentId))
}

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
