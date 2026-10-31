import { join } from 'node:path'
import { DEFAULT_QUICK_COMMANDS, normalizeQuickCommands, migrateQuickCommands, type QuickCommandsData } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 快速命令栏：<dir>/quick-commands.json，整份读写，保存前校验规整，原子写。文件不存在时给内置默认组
export class QuickCommandStore {
  readonly file: string
  constructor(dir: string) { this.file = join(dir, 'quick-commands.json') }

  get(): QuickCommandsData {
    const raw = readJson<QuickCommandsData>(this.file)
    if (!raw) return structuredClone(DEFAULT_QUICK_COMMANDS)
    let d: QuickCommandsData
    try { d = normalizeQuickCommands(raw) } catch { return structuredClone(DEFAULT_QUICK_COMMANDS) }   // 手改坏了就回退默认，不让命令栏打不开
    // 旧版内置默认命令升级成分系统版本（只动没改过的），升级后落盘
    const up = migrateQuickCommands(d)
    if (!up) return d
    try { writeJson(this.file, up) } catch { /* 写不了下次再升 */ }
    return up
  }

  save(data: QuickCommandsData): QuickCommandsData {
    const n = normalizeQuickCommands(data)
    writeJson(this.file, n)
    return n
  }
}
