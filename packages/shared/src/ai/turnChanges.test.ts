import { describe, it, expect } from 'vitest'
import { aggregateTurnChanges, undoOrder, fileKey } from './turnChanges.js'
import type { AuditEntry } from '../protocol/index.js'

const w = (at: string, turnId: string, filePath: string, extra: Partial<AuditEntry> = {}): AuditEntry =>
  ({ at, sessionId: 's', terminalId: 't1', hostKey: 'local', decision: 'write_allowed', dshId: 'd1', turnId, filePath, ...extra })

describe('aggregateTurnChanges', () => {
  it('按轮聚合，同一文件多次写入合成一项：新建取首次、内容摘要取末次', () => {
    const turns = aggregateTurnChanges([
      w('2026-01-01T00:00:03Z', 'turn_1', '/a', { backupPath: '/bk/a2', afterHash: 'h2' }),
      w('2026-01-01T00:00:01Z', 'turn_1', '/a', { created: true, afterHash: 'h1' }),
      w('2026-01-01T00:00:02Z', 'turn_1', '/b', { backupPath: '/bk/b', created: false, afterHash: 'hb' }),
      w('2026-01-01T00:00:05Z', 'turn_2', '/b', { backupPath: '/bk/b2', hostKey: 'h9' }),
    ], 'd1')
    expect(turns.map((t) => t.turnId)).toEqual(['turn_1', 'turn_2'])
    expect(turns[0].files).toMatchObject([
      { path: '/a', created: true, backupPath: undefined, afterHash: 'h2', writes: 2, firstAt: '2026-01-01T00:00:01Z', lastAt: '2026-01-01T00:00:03Z' },
      { path: '/b', created: false, backupPath: '/bk/b', afterHash: 'hb', writes: 1 },
    ])
    expect(turns[1].files[0]).toMatchObject({ hostKey: 'h9', created: false })   // 旧记录无 created：有备份 = 修改
  })
  it('只认本 dsh 会话、带 turnId 的 write_allowed；其他记录与旧记录忽略', () => {
    const turns = aggregateTurnChanges([
      w('1', 'turn_1', '/a', { dshId: 'other' }),
      w('2', 'turn_1', '/a', { turnId: undefined }),
      w('3', 'turn_1', '/a', { decision: 'exec_allowed' }),
      w('4', 'turn_1', '/a', { decision: 'user_edit' }),
    ], 'd1')
    expect(turns).toEqual([])
  })
  it('撤销记录（turn_undo，晚于本轮最后一次写）标记已撤销；按轮次数字排序', () => {
    const turns = aggregateTurnChanges([
      w('2026-01-01T00:00:01Z', 'turn_10', '/a', { created: true }),
      w('2026-01-01T00:00:00Z', 'turn_9', '/a', { created: true }),
      { at: '2026-01-01T00:00:02Z', sessionId: 's', terminalId: 't1', hostKey: 'local', decision: 'turn_undo', dshId: 'd1', undoOf: 'turn_10', filePath: '/a' },
    ], 'd1')
    expect(turns.map((t) => t.turnId)).toEqual(['turn_9', 'turn_10'])
    expect(turns[1].files[0].undoneAt).toBe('2026-01-01T00:00:02Z')
    expect(turns[0].files[0].undoneAt).toBeUndefined()
  })
  it('撤销顺序：最后改的先还原', () => {
    const [t] = aggregateTurnChanges([w('1', 'turn_1', '/a'), w('2', 'turn_1', '/b'), w('3', 'turn_1', '/a')], 'd1')
    expect(undoOrder(t.files).map((f) => f.path)).toEqual(['/a', '/b'])
    expect(t.files[0].key).toBe(fileKey('local', '/a'))
  })
})
