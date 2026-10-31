import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AuditEntry } from '@lingshell/shared'
import { writeJsonLines, readJsonLines } from './jsonFile.js'

// AI 操作终端的审计记录（执行了什么、在哪台主机、谁批准、退出码），供「执行记录」面板回查。
// JSONL 追加写：每条命令只追加一行，不整文件重写；崩溃最多丢最后半行（读时跳过）。
// 总量超 max 时在下次载入时裁掉最旧的并重写一次。
export class AuditStore {
  private file: string
  private cache?: AuditEntry[]
  constructor(dir: string, private max = 5000) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'audit.jsonl')
  }

  add(e: AuditEntry): void {
    this.load().push(e)
    appendFileSync(this.file, JSON.stringify(e) + '\n', 'utf8')
  }

  /** 某会话的记录，新在前 */
  listForSession(sessionId: string, limit = 500): AuditEntry[] {
    const out: AuditEntry[] = []
    const all = this.load()
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) if (all[i].sessionId === sessionId) out.push(all[i])
    return out
  }

  /** 按会话 + 时间戳定位一条（「还原」用：路径从记录里取，不信渲染层传来的路径） */
  find(sessionId: string, at: string): AuditEntry | undefined {
    return this.load().find((e) => e.sessionId === sessionId && e.at === at)
  }

  /** 所有会话的最近记录，新在前（「执行记录 · 全部会话」：不用记得改动是在哪个会话里做的） */
  listRecent(limit = 500): AuditEntry[] {
    return this.load().slice(-limit).reverse()
  }

  private load(): AuditEntry[] {
    if (this.cache) return this.cache
    const all = readJsonLines<AuditEntry>(this.file)
    if (all.length > this.max) { all.splice(0, all.length - this.max); writeJsonLines(this.file, all) }
    return (this.cache = all)
  }
}
