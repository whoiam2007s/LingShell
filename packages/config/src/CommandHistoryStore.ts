import { join } from 'node:path'
import type { CommandHistoryEntry } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 命令历史：明文 JSON（命令非敏感；一次性密码永不入历史）。按 hostKey 分组，每组超 limit 丢最旧。
// list 返回“新在前”；内部数组“旧在前”（push 追加、越界丢头）。
// 内存常驻一份，首次用到时从文件载入；之后只在变更时原子写盘（每次回车不再整文件同步读）。
type Data = Record<string, CommandHistoryEntry[]>

export class CommandHistoryStore {
  private filePath: string
  private cache?: Data
  // limit 可传 getter：主进程传 () => 系统设置里的值，改了设置下一条命令即生效
  constructor(private dir: string, private limit: number | (() => number)) {
    this.filePath = join(dir, 'command-history.json')
  }

  // 追加一条。hostKey/at 由本方法补全（调用方传业务字段，主进程补 hostKey）。
  add(hostKey: string, e: Omit<CommandHistoryEntry, 'hostKey' | 'at'> & { at?: string }): void {
    const data = this.read()
    const arr = data[hostKey] ?? (data[hostKey] = [])
    arr.push({ ...e, hostKey, at: e.at ?? new Date().toISOString() })
    const limit = typeof this.limit === 'function' ? this.limit() : this.limit
    if (arr.length > limit) arr.splice(0, arr.length - limit)   // 丢最旧
    this.write()
  }

  list(hostKey: string): CommandHistoryEntry[] {
    const arr = this.read()[hostKey] ?? []
    return [...arr].reverse()   // 新在前
  }

  // index 对应 list() 的顺序（新在前）→ 换算回内部数组下标
  delete(hostKey: string, index: number): void {
    const arr = this.read()[hostKey]
    if (!arr) return
    const internal = arr.length - 1 - index
    if (internal < 0 || internal >= arr.length) return
    arr.splice(internal, 1)
    this.write()
  }

  // 删该主机所有这条命令的记录（补全浮层里 Shift+Delete：按命令文本删，前后空白不计）。返回删了几条
  deleteCommand(hostKey: string, command: string): number {
    const arr = this.read()[hostKey]
    const c = command.trim()
    if (!arr || !c) return 0
    const keep = arr.filter((e) => e.command.trim() !== c)
    const n = arr.length - keep.length
    if (n) { this.read()[hostKey] = keep; this.write() }
    return n
  }

  clear(hostKey: string): void {
    const data = this.read()
    if (!(hostKey in data)) return
    delete data[hostKey]
    this.write()
  }

  private read(): Data { return (this.cache ??= readJson<Data>(this.filePath) ?? {}) }
  private write(): void { writeJson(this.filePath, this.cache ?? {}) }
}
