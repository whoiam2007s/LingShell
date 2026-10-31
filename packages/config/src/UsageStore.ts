import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageRecord } from '@lingshell/shared'
import { readJsonLines, writeJsonLines } from './jsonFile.js'

const DAY = 86_400_000

// 模型请求用量（用量统计页）。同 AuditStore：JSONL 追加写，载入时裁掉超出 maxLines / maxDays 的最旧记录并重写一次。
// 一条约 150 字节，20 万条约 30MB，全量进内存聚合足够快。
export class UsageStore {
  readonly file: string
  private cache?: UsageRecord[]
  constructor(dir: string, private maxLines = 200_000, private maxDays = 180, private now = () => Date.now()) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'usage.jsonl')
  }

  add(r: UsageRecord): void {
    this.load().push(r)
    appendFileSync(this.file, JSON.stringify(r) + '\n', 'utf8')
  }

  /** 全部记录（按写入顺序，旧在前） */
  list(): UsageRecord[] { return this.load() }

  private load(): UsageRecord[] {
    if (this.cache) return this.cache
    const all = readJsonLines<UsageRecord>(this.file)
    const from = this.now() - this.maxDays * DAY
    let keep = all.filter((r) => Date.parse(r.at) >= from)
    if (keep.length > this.maxLines) keep = keep.slice(-this.maxLines)
    if (keep.length !== all.length) writeJsonLines(this.file, keep)
    return (this.cache = keep)
  }
}
