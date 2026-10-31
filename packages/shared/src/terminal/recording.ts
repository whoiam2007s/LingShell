// 终端录像（asciicast v2）：主进程写、UI 回放共用的格式与解析。
// 文件：首行 header JSON，之后每行一个事件 [秒, 'o'|'i'|'r', 数据]。o=输出 i=用户输入 r=尺寸变化('COLSxROWS')

export interface CastHeader {
  version: 2
  width: number
  height: number
  timestamp: number                 // 开始时间（unix 秒）
  title?: string
  env?: Record<string, string>
}
export type CastEventCode = 'o' | 'i' | 'r'
export type CastEvent = [number, CastEventCode, string]

// 录像列表项（「终端录像」面板）
export interface RecordingInfo {
  id: string             // 相对录像根目录的路径：YYYY-MM-DD/<文件名>.cast
  date: string           // YYYY-MM-DD
  title: string          // 终端名
  startedAt: string      // ISO
  size: number           // 字节
  durationSec: number    // 最后一个事件的时间
  active: boolean        // 正在录制
}

export const castHeaderLine = (h: CastHeader): string => JSON.stringify(h) + '\n'
export const castEventLine = (t: number, code: CastEventCode, data: string): string => JSON.stringify([t, code, data]) + '\n'

/** 解析整份 .cast；坏行跳过（录制中被截断的末行很常见） */
export function parseCast(text: string): { header: CastHeader; events: CastEvent[] } {
  const lines = text.split('\n')
  let header: CastHeader = { version: 2, width: 80, height: 24, timestamp: 0 }
  try { header = { ...header, ...JSON.parse(lines[0]) } } catch { /* 无 header 用默认 */ }
  const events: CastEvent[] = []
  for (const ln of lines.slice(1)) {
    if (!ln.trim()) continue
    try {
      const e = JSON.parse(ln)
      if (Array.isArray(e) && typeof e[0] === 'number' && (e[1] === 'o' || e[1] === 'i' || e[1] === 'r') && typeof e[2] === 'string') events.push([e[0], e[1], e[2]])
    } catch { /* 坏行 */ }
  }
  return { header, events }
}

/** 回放用：事件间空闲超过 maxIdle 秒的压成 maxIdle（同 asciinema idle_time_limit），时间单调不减 */
export function limitIdle(events: CastEvent[], maxIdle = 2): CastEvent[] {
  let prev = 0, shift = 0
  return events.map(([t, c, d]) => {
    const gap = t - prev
    if (gap > maxIdle) shift += gap - maxIdle
    prev = t
    return [Math.max(0, t - shift), c, d]
  })
}

/** 'COLSxROWS' → [cols, rows]，非法返回 undefined */
export function parseSize(s: string): [number, number] | undefined {
  const m = /^(\d+)x(\d+)$/.exec(s)
  return m ? [Number(m[1]), Number(m[2])] : undefined
}
