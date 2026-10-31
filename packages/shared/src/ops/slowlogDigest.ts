// 慢查询归并（纯逻辑，类似 pt-query-digest 的指纹归并）：把字面量换成 ?、IN 列表 / 多行 VALUES 折叠，同一指纹的
// SQL 合成一类，统计次数 / 总耗时 / 平均 / 最大 / 扫描行数，并留一条最慢的原文做示例。
export interface SlowEntry {
  sql: string
  queryTime: number            // 秒
  lockTime?: number
  rowsSent?: number
  rowsExamined?: number
  time?: string                // 发生时间（日志里有就带）
  user?: string
  db?: string
}
export interface SlowDigest {
  fingerprint: string
  count: number
  totalTime: number
  avgTime: number
  maxTime: number
  lockTime: number             // 总锁等待（秒）
  rowsExamined: number         // 平均扫描行数
  rowsSent: number             // 平均返回行数
  example: string              // 最慢那一次的原文（截断）
  first?: string
  last?: string
  users: string[]
  dbs: string[]
}

const EXAMPLE_MAX = 20_000   // 同即席查询 / EXPLAIN 的长度上限：被截断的语句没法 EXPLAIN

/** SQL 指纹：小写、去注释、字面量（字符串 / 数字 / 十六进制）换成 ?、IN (?, ?) 与多行 VALUES 折叠、空白归一 */
export function sqlFingerprint(sql: string): string {
  let s = String(sql ?? '')
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)(--\s|#)[^\n]*/g, ' ')
  s = s.replace(/'(?:[^'\\]|\\.|'')*'/g, '?').replace(/"(?:[^"\\]|\\.|"")*"/g, '?')
  s = s.toLowerCase()
  s = s.replace(/\b0x[0-9a-f]+\b/g, '?').replace(/\b[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/g, '?')
  s = s.replace(/\s+/g, ' ').trim().replace(/\s*;$/, '')
  s = s.replace(/\s*([(),=<>])\s*/g, '$1').replace(/,/g, ', ').replace(/([=<>]+)/g, ' $1 ').replace(/\s+/g, ' ')
  s = s.replace(/\b(in|values)\s*\((\?|\s|,)+\)/g, '$1(?+)')
  s = s.replace(/\b(values\(\?\+\))(, ?\((\?|\s|,)+\))+/g, '$1')
  s = s.replace(/\blimit \?(, ?\?| offset \?)?/g, 'limit ?')
  return s.replace(/`/g, '').trim()
}

const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : undefined }

/**
 * MySQL 慢日志文本 → 条目。识别 `# Time:` / `# User@Host:` / `# Query_time:` 头，`use db;` 与 `SET timestamp=…;` 不算进 SQL。
 * 文件开头的启动横幅、被 tail 截断的半条（第一个头之前的内容）都丢掉
 */
export function parseMysqlSlowLog(text: string): SlowEntry[] {
  const out: SlowEntry[] = []
  let cur: Partial<SlowEntry> & { lines: string[] } | undefined
  let time: string | undefined, user: string | undefined, db: string | undefined
  const flush = () => {
    if (cur && cur.queryTime !== undefined) {
      const sql = cur.lines.join('\n').trim()
      if (sql) out.push({ sql, queryTime: cur.queryTime, lockTime: cur.lockTime, rowsSent: cur.rowsSent, rowsExamined: cur.rowsExamined, ...(time ? { time } : {}), ...(user ? { user } : {}), ...(db ? { db } : {}) })
    }
    cur = undefined
  }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    let m: RegExpExecArray | null
    if ((m = /^# Time:\s*(.+)$/.exec(line))) { flush(); time = m[1].trim(); continue }
    if ((m = /^# User@Host:\s*([^\s[]+)/.exec(line))) { flush(); user = m[1]; continue }
    if ((m = /^# Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/.exec(line))) {
      flush()
      cur = { lines: [], queryTime: Number(m[1]), lockTime: Number(m[2]), rowsSent: Number(m[3]), rowsExamined: Number(m[4]) }
      continue
    }
    if (line.startsWith('# ')) continue                       // 其它注释头（Thread_id、Bytes_sent …）
    if (!cur) continue
    if ((m = /^use\s+`?([^`;\s]+)`?;$/i.exec(line))) { db = m[1]; continue }
    if (/^SET timestamp=\d+;$/i.test(line)) continue
    if (/^\S+, Version: .+ started with:$|^Tcp port: |^Time\s+Id\s+Command\s+Argument$/.test(line)) { flush(); continue }
    cur.lines.push(raw)
  }
  flush()
  return out
}

/** MySQL 的 TIME 列（mysql.slow_log 表的 query_time，形如 00:00:02.500000）→ 秒 */
export function mysqlTimeToSec(v: string): number {
  const m = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(v ?? '').trim())
  if (!m) return num(v) ?? 0
  return (m[1] ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]))
}

/** 按指纹归并，按总耗时降序，最多 top 类 */
export function digestSlow(entries: SlowEntry[], top = 50): SlowDigest[] {
  const map = new Map<string, SlowDigest & { examined: number; sent: number }>()
  for (const e of entries) {
    const fp = sqlFingerprint(e.sql)
    if (!fp) continue
    let d = map.get(fp)
    if (!d) {
      d = { fingerprint: fp, count: 0, totalTime: 0, avgTime: 0, maxTime: -1, lockTime: 0, rowsExamined: 0, rowsSent: 0, example: '', users: [], dbs: [], examined: 0, sent: 0 }
      map.set(fp, d)
    }
    d.count++
    d.totalTime += e.queryTime
    d.lockTime += e.lockTime ?? 0
    d.examined += e.rowsExamined ?? 0
    d.sent += e.rowsSent ?? 0
    if (e.queryTime > d.maxTime) { d.maxTime = e.queryTime; d.example = e.sql.length > EXAMPLE_MAX ? `${e.sql.slice(0, EXAMPLE_MAX)}…` : e.sql }
    if (e.time) { if (!d.first || e.time < d.first) d.first = e.time; if (!d.last || e.time > d.last) d.last = e.time }
    if (e.user && !d.users.includes(e.user) && d.users.length < 5) d.users.push(e.user)
    if (e.db && !d.dbs.includes(e.db) && d.dbs.length < 5) d.dbs.push(e.db)
  }
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6
  return [...map.values()]
    .map(({ examined, sent, ...d }) => ({ ...d, totalTime: r6(d.totalTime), lockTime: r6(d.lockTime), avgTime: r6(d.totalTime / d.count), maxTime: r6(d.maxTime), rowsExamined: Math.round(examined / d.count), rowsSent: Math.round(sent / d.count) }))
    .sort((a, b) => b.totalTime - a.totalTime || b.count - a.count)
    .slice(0, top)
}
