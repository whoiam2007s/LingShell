import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import type { SubagentRecord } from './subagent.js'
import { loadSubagentLog, saveSubagentLog, liveLogDir, SUBAGENT_LOG_MAX } from './subagentStore.js'

const rec = (i: number): SubagentRecord => ({
  subagentId: `sess_sub${i}`, title: `t${i}`, task: `task ${i}`, permission: 'read',
  status: 'done', startedAt: '2026-11-18T00:00:00.000Z',
})

describe('子代理记录落盘', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'lingshell-sub-'))
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('保存后用新的读取（模拟重启）能原样读回', () => withDir(async (dir) => {
    await saveSubagentLog(dir, 'sess_main', [rec(1), rec(2)])
    const back = await loadSubagentLog(dir, 'sess_main')
    expect(back.map((r) => r.subagentId)).toEqual(['sess_sub1', 'sess_sub2'])
    expect(back[0].title).toBe('t1')
  }))

  it('文件不存在 / 内容损坏 → 空数组，不影响界面', () => withDir(async (dir) => {
    expect(await loadSubagentLog(dir, 'nope')).toEqual([])
    await saveSubagentLog(dir, 'sess_bad', [rec(1)])
    writeFileSync(join(dir, 'subagents', 'sess_bad.json'), '{ not json', 'utf8')
    expect(await loadSubagentLog(dir, 'sess_bad')).toEqual([])
  }))

  it('超过上限只留最近的那批', () => withDir(async (dir) => {
    const many = Array.from({ length: SUBAGENT_LOG_MAX + 7 }, (_, i) => rec(i))
    await saveSubagentLog(dir, 'sess_many', many)
    const back = await loadSubagentLog(dir, 'sess_many')
    expect(back).toHaveLength(SUBAGENT_LOG_MAX)
    expect(back.at(-1)!.subagentId).toBe(`sess_sub${SUBAGENT_LOG_MAX + 6}`)   // 最新的一条还在
    expect(back[0].subagentId).toBe(`sess_sub7`)                              // 最老的被丢掉
  }))

  it('会话 id 里的特殊字符不会逃出目录', () => withDir(async (dir) => {
    await saveSubagentLog(dir, '../evil/x', [rec(1)])
    expect((await loadSubagentLog(dir, '../evil/x')).length).toBe(1)
    expect(await loadSubagentLog(dir, 'other')).toEqual([])
  }))

  // 回归：live.jsonl 曾经被写到 dsh 会话存档根目录下的 <id>/（扁平布局），一个坏目录就让整个
  // 会话存储（历史列表 / 恢复 / 新建）全部打不开。它必须永远落在会话存档之外。
  it('子代理 live.jsonl 的目录在 subagents/live 下，绝不进 dsh-sessions', () => withDir((dir) => {
    const live = liveLogDir(dir, 'sess_sub1')
    expect(relative(dir, live)).toBe(join('subagents', 'live', 'sess_sub1'))
    expect(relative(join(dir, 'dsh-sessions'), live).startsWith('..')).toBe(true)   // 不在会话存档里
    return Promise.resolve()
  }))

  it('子代理 id 里的特殊字符同样不会逃出 subagents/live', () => withDir(async (dir) => {
    const live = liveLogDir(dir, '../../evil/x')
    expect(isAbsolute(relative(join(dir, 'subagents', 'live'), live))).toBe(false)
    expect(relative(join(dir, 'subagents', 'live'), live).split(sep).length).toBe(1)
  }))
})
