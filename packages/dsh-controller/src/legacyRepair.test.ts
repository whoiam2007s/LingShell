import { describe, it, expect } from 'vitest'
import { normalizeTurnEndReason, normalizeAbortCause, repairV0Lines, failureSummary, zstdFrames } from './legacyRepair.js'

describe('turn/end reason 规范化（对照 v0→v1 迁移器的校验）', () => {
  it('abort cause：0.1.1 的字符串 / Error 序列化 / 缺失 / 非法 kind', () => {
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: 'user' })).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: 'parent' })).toEqual({ kind: 'aborted', reason: { kind: 'parent' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: 'stop-button' })).toEqual({ kind: 'aborted', reason: { kind: 'legacy' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: {} })).toEqual({ kind: 'aborted', reason: { kind: 'legacy' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: { name: 'Error', message: 'x' } })).toEqual({ kind: 'aborted', reason: { kind: 'legacy' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: null })).toEqual({ kind: 'aborted', reason: { kind: 'legacy' } })
    expect(normalizeTurnEndReason({ kind: 'aborted', reason: { kind: 'user', extra: 1 } })).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    // 缺 cause：迁移器自己补 legacy，原样留给它
    expect(normalizeTurnEndReason({ kind: 'aborted' })).toEqual({ kind: 'aborted' })
    expect(normalizeAbortCause({ kind: 'hook', reason: 'pre-tool 拒绝' })).toEqual({ kind: 'hook', reason: 'pre-tool 拒绝' })
    expect(normalizeAbortCause({ kind: 'hook', reason: 42 })).toEqual({ kind: 'legacy' })
  })

  it('合规的原样不动', () => {
    for (const r of [{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'error', error: { message: 'm', code: 'C', status: 500 } }, { kind: 'some-future-kind', x: 1 }]) {
      expect(normalizeTurnEndReason(r)).toEqual(r)
    }
  })

  it('多余字段 / 缺字段 / 旧 error 形状', () => {
    expect(normalizeTurnEndReason({ kind: 'completed', at: 1 })).toEqual({ kind: 'completed' })
    expect(normalizeTurnEndReason({ kind: 'disposed', why: 'x' })).toEqual({ kind: 'disposed' })
    expect(normalizeTurnEndReason({ kind: 'error', error: { message: '', retryable: true, status: 999 } })).toEqual({ kind: 'error', error: { message: 'unknown error', code: 'UNKNOWN' } })
    expect(normalizeTurnEndReason({ kind: 'error', step: 1, failure: { message: 'boom', code: 'X', extra: 1 } })).toEqual({ kind: 'error', error: { message: 'boom', code: 'X' } })
    expect(normalizeTurnEndReason({ kind: 'error', step: 1, message: 'boom' })).toEqual({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })
    expect(normalizeTurnEndReason('aborted')).toEqual({ kind: 'aborted' })
    expect(normalizeTurnEndReason(undefined)).toEqual({ kind: 'aborted', reason: { kind: 'legacy' } })
  })
})

describe('repairV0Lines', () => {
  const header = JSON.stringify({ type: 'session', version: 0, id: 'sess_a', createdAt: 1, cwd: 'C:/x', delegationDepth: 0 })
  const end = (seq: number, reason: unknown, extra = {}) => JSON.stringify({ type: 'turn/end', seq, time: 1, data: { turn: 1, reason, ...extra } })

  it('修 turn/end、改 header id 与本会话投递标记；其余行逐字保留', () => {
    const other = '{"type":"step/end","seq":0,"time":1,"data":{"turn":1,"step":1}}'
    const mark = JSON.stringify({ type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 1, data: { sessionId: 'sess_a', throughSeq: 1 } })
    const r = repairV0Lines([header, other, end(1, { kind: 'aborted', reason: 'user' }, { junk: 1 }), mark, 'not json'], 'sess_a', 'sess_a_fix')
    expect(r.changes).toHaveLength(1)
    expect(JSON.parse(r.lines[0]).id).toBe('sess_a_fix')
    expect(r.lines[1]).toBe(other)
    expect(JSON.parse(r.lines[2]).data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(JSON.parse(r.lines[3]).data.sessionId).toBe('sess_a_fix')
    expect(r.lines[4]).toBe('not json')
  })

  it('没有可修的 → changes 为空（调用方据此直接走新会话）', () => {
    expect(repairV0Lines([header, end(1, { kind: 'completed' })], 'sess_a', 'b').changes).toEqual([])
  })
})

describe('其它', () => {
  it('failureSummary 取迁移器报的那条', () => {
    const e = new Error('SessionFormatUnsupportedError: @deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: turn/end 8650 reason abort cause must be a JSON object; source v0 artifact remains unchanged (raw log: C:\\x)')
    expect(failureSummary(e)).toBe('turn/end 8650 reason abort cause must be a JSON object')
    expect(failureSummary(new Error('boom'))).toBe('boom')
    expect(failureSummary(new Error('session "s" contains unsupported legacy mode/set event at seq 2; source v0 artifact remains unchanged (raw log: C:\\x)')))
      .toBe('session "s" contains unsupported legacy mode/set event at seq 2')
  })

  it('zstdFrames：非 zstd / 残缺数据不抛，返回已完整的帧', () => {
    expect(zstdFrames(Buffer.from('hello'))).toEqual([])
    expect(zstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x05]))).toEqual([])
  })
})
