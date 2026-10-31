import { join } from 'node:path'
import type { SessionMeta } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 会话元数据持久化：<dir>/sessions.json。无凭据，明文。原子写。
export class SessionStore {
  private filePath: string
  constructor(dir: string) { this.filePath = join(dir, 'sessions.json') }

  list(): SessionMeta[] {
    // 一条缺 lastActiveAt 的旧记录不能让整个列表抛错（否则界面当成「没有会话」，历史看起来全没了）
    return this.read().filter((m) => m && typeof m.id === 'string')
      .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
  }
  upsert(meta: SessionMeta): void {
    const all = this.read()
    const i = all.findIndex((m) => m.id === meta.id)
    if (i >= 0) all[i] = meta; else all.push(meta)
    this.write(all)
  }
  remove(id: string): void { this.write(this.read().filter((m) => m.id !== id)) }
  touch(id: string, at: string): void {
    const all = this.read()
    const m = all.find((x) => x.id === id)
    if (m) { m.lastActiveAt = at; this.write(all) }
  }

  private read(): SessionMeta[] { return readJson<SessionMeta[]>(this.filePath) ?? [] }
  private write(all: SessionMeta[]): void { writeJson(this.filePath, all) }
}
