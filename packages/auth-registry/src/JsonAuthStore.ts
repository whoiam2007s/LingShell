import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuthState, AuthStore } from './AuthRegistry.js'

// 文件持久化：~/.lingshell/config/auth.json。MVP 同步读写，授权变更不频繁。
export class JsonAuthStore implements AuthStore {
  constructor(private file: string) {}

  load(): AuthState {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return { records: parsed.records ?? [], trust: parsed.trust ?? {} }
    } catch {
      return { records: [], trust: {} }
    }
  }

  save(state: AuthState): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // 原子写：先写临时文件再 rename，避免写一半崩溃留下半截 JSON 导致 load 静默丢全部授权。
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, this.file)
  }
}
