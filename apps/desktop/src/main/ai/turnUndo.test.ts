import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEntry } from '@lingshell/shared'
import { localAccess, writeWithBackup } from '../files/index.js'
import { registerTurnUndo, sha256 } from './turnUndo.js'

// 模拟 AI 在一轮里：新建 a.txt、修改 b.txt（与 write_file 落的执行记录同形）
describe('registerTurnUndo', () => {
  let dir: string
  let audits: AuditEntry[]
  let h: Map<string, (...a: unknown[]) => unknown>
  const call = <T>(ch: string, ...a: unknown[]) => h.get(ch)!({}, ...a) as Promise<T>
  const fa = () => localAccess(join(dir, 'data'))
  const aiWrite = async (path: string, text: string, at: string, turnId = 'turn_1') => {
    const buf = Buffer.from(text)
    const r = await writeWithBackup(fa(), path, buf)
    audits.push({ at, sessionId: 's1', terminalId: 't1', hostKey: 'local', decision: 'write_allowed', filePath: path, backupPath: r.backupPath,
      created: r.backupPath === undefined, afterHash: sha256(buf), dshId: 's1', turnId })
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'turnundo-'))
    audits = []
    h = new Map()
    registerTurnUndo({
      handle: (ch, fn) => h.set(ch, fn),
      entries: () => audits,
      dshIdOf: (sid) => sid,
      access: async () => fa(),
      audit: (e) => audits.push({ ...e, at: new Date(Date.now() + audits.length).toISOString() }),
      diff: (a, b) => `-${a}\n+${b}`,
    })
    writeFileSync(join(dir, 'b.txt'), 'old')
    await aiWrite(join(dir, 'a.txt'), 'new file', '2026-01-01T00:00:01.000Z')
    await aiWrite(join(dir, 'b.txt'), 'changed', '2026-01-01T00:00:02.000Z')
  })

  it('汇总：本轮 2 个文件，一个新建一个修改', async () => {
    const turns = await call<{ turnId: string; files: { path: string; created: boolean }[] }[]>('turnChanges:list', 's1')
    expect(turns).toHaveLength(1)
    expect(turns[0].files.map((f) => [f.path.endsWith('a.txt'), f.created])).toEqual([[true, true], [false, false]])
  })

  it('撤销：新建的删除、修改的恢复原内容；逐条记 turn_undo（带备份），再撤销跳过', async () => {
    const r = await call<{ path: string; ok: boolean; action: string }[]>('turnChanges:undo', 's1', 'turn_1')
    expect(r.map((x) => [x.path.slice(-5), x.ok, x.action])).toEqual([['b.txt', true, 'restored'], ['a.txt', true, 'deleted']])   // 逆序
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('old')
    const undos = audits.filter((a) => a.decision === 'turn_undo')
    expect(undos).toHaveLength(2)
    expect(undos.every((u) => u.undoOf === 'turn_1' && u.backupPath)).toBe(true)   // 撤销前的内容也备份了，可再还原
    const turns = await call<{ files: { undoneAt?: string }[] }[]>('turnChanges:list', 's1')
    expect(turns[0].files.every((f) => f.undoneAt)).toBe(true)
    const again = await call<{ action: string }[]>('turnChanges:undo', 's1', 'turn_1')
    expect(again.map((x) => x.action)).toEqual(['skipped', 'skipped'])
  })

  it('检查：被后续改动覆盖的标 changed、已删的标 missing；diff 给出本轮前 → 当前', async () => {
    writeFileSync(join(dir, 'b.txt'), 'someone else')
    const checks = await call<{ key: string; state: string }[]>('turnChanges:check', 's1', 'turn_1')
    expect(checks.map((c) => c.state)).toEqual(['same', 'changed'])
    const [a] = (await call<{ files: { key: string }[] }[]>('turnChanges:list', 's1'))[0].files
    const d = await call<{ diff: string; state: string }>('turnChanges:diff', 's1', 'turn_1', a.key)
    expect(d).toEqual({ state: 'same', diff: '-\n+new file' })
  })

  it('只撤销指定文件；新建文件已不在时跳过但记为已撤销', async () => {
    const files = (await call<{ files: { key: string; path: string }[] }[]>('turnChanges:list', 's1'))[0].files
    const a = files.find((f) => f.path.endsWith('a.txt'))!
    writeFileSync(join(dir, 'b.txt'), 'kept')
    const { unlinkSync } = await import('node:fs')
    unlinkSync(a.path)
    const r = await call<{ action: string; ok: boolean }[]>('turnChanges:undo', 's1', 'turn_1', [a.key])
    expect(r).toMatchObject([{ ok: true, action: 'skipped' }])
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('kept')   // 没选的不动
  })
})
