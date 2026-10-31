import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeRunbook, type Runbook, type RunbookInput } from '@lingshell/shared'
import { readJson, writeJson } from './jsonFile.js'

// 运维手册：<dir>/runbooks.json。保存前校验规整，原子写。
export class RunbookStore {
  private file: string
  constructor(dir: string) { this.file = join(dir, 'runbooks.json') }

  list(): Runbook[] { return readJson<Runbook[]>(this.file) ?? [] }

  save(input: RunbookInput): Runbook {
    const n = normalizeRunbook(input)
    const all = this.list()
    const rb: Runbook = { ...n, id: n.id ?? `rb_${randomUUID().slice(0, 8)}`, updatedAt: new Date().toISOString() }
    const i = all.findIndex((x) => x.id === rb.id)
    if (i >= 0) all[i] = rb; else all.push(rb)
    writeJson(this.file, all)
    return rb
  }

  delete(id: string): void { writeJson(this.file, this.list().filter((r) => r.id !== id)) }
}
