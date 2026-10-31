import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditStore } from '@lingshell/config'
import { rollbackStatus, type AuditEntry } from '@lingshell/shared'
import { checkRollback, runRollback, type RollbackDeps } from './rollbackIpc.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// 真 AuditStore（落盘 JSONL）+ 假终端 / 授权：走完「记录 → 检查 → 执行 → 记回滚 → 原条目已回滚」整条链路
function setup(over: Partial<RollbackDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-')); dirs.push(dir)
  const store = new AuditStore(dir)
  const orig: AuditEntry = {
    at: '2026-10-15T01:00:00.000Z', sessionId: 's1', terminalId: 't1', terminalTitle: 'web-1', hostKey: 'h1',
    command: "sed -i 's/80/8080/' /etc/app.conf", decision: 'exec_allowed', exitCode: 0,
    rollback: 'cp -a /etc/app.conf.bak /etc/app.conf', rollbackNote: '用备份还原', callId: 'call_1',
  }
  store.add(orig)
  const exec = vi.fn(async (_t: string, _c: string) => ({ exitCode: 0, output: 'ok' }))
  const deps: RollbackDeps = {
    find: (sid, at) => store.find(sid, at),
    entries: (sid) => store.listForSession(sid),
    terminals: () => [{ id: 't1', title: 'web-1', hostKey: 'h1' }, { id: 't9', title: 'other', hostKey: 'h2' }],
    decide: () => ({ kind: 'allow' }),
    isProd: () => false,
    dangerous: (c) => /rm -rf/.test(c),
    exec,
    audit: (e) => store.add({ ...e, at: new Date().toISOString() }),
    ...over,
  }
  return { store, orig, exec, deps }
}

describe('一键回滚', () => {
  it('检查：定位原终端，带回滚命令与说明；执行后记 rollback（undoOf=原记录），原条目变「已回滚」，不能再回滚', async () => {
    const { store, orig, exec, deps } = setup()
    expect(checkRollback(deps, 's1', orig.at)).toMatchObject({ command: orig.rollback, note: '用备份还原', terminalId: 't1', verdict: 'allow', dangerous: false })
    expect(rollbackStatus(store.listForSession('s1'), orig)).toBe('none')
    const r = await runRollback(deps, 's1', orig.at, false)
    expect(r.exitCode).toBe(0)
    expect(exec).toHaveBeenCalledWith('t1', orig.rollback)
    const rows = store.listForSession('s1')
    expect(rows[0]).toMatchObject({ decision: 'rollback', undoOf: orig.at, command: orig.rollback, exitCode: 0, hostKey: 'h1', terminalId: 't1' })
    expect(rollbackStatus(rows, orig)).toBe('done')
    expect(() => checkRollback(deps, 's1', orig.at)).toThrow('已回滚过')
  })

  it('回滚失败（非 0）记为 failed，可再次回滚', async () => {
    const { store, orig, deps } = setup({ exec: async () => ({ exitCode: 2, output: 'no such file' }) })
    await runRollback(deps, 's1', orig.at, false)
    expect(rollbackStatus(store.listForSession('s1'), orig)).toBe('failed')
    expect(checkRollback(deps, 's1', orig.at).verdict).toBe('allow')
  })

  it('原终端已关：改用同主机另一个打开的终端；同主机没有终端则报错、不执行', async () => {
    const { orig, deps } = setup({ terminals: () => [{ id: 't5', title: 'web-1 (2)', hostKey: 'h1' }] })
    expect(checkRollback(deps, 's1', orig.at).terminalId).toBe('t5')
    const none = setup({ terminals: () => [] })
    expect(() => checkRollback(none.deps, 's1', none.orig.at)).toThrow('没有打开的终端')
    await expect(runRollback(none.deps, 's1', none.orig.at, false)).rejects.toThrow()
    expect(none.exec).not.toHaveBeenCalled()
  })

  it('不绕过闸门：规则禁止 / 只读会话直接拒、不执行不记录；需确认的给出提示；危险命令须勾选确认', async () => {
    const deny = setup({ decide: () => ({ kind: 'deny', reason: '按规则：禁止 cp', rule: '前缀 cp · 总是禁止' }) })
    expect(checkRollback(deny.deps, 's1', deny.orig.at)).toMatchObject({ verdict: 'deny', reason: '按规则：禁止 cp', rule: '前缀 cp · 总是禁止' })
    await expect(runRollback(deny.deps, 's1', deny.orig.at, true)).rejects.toThrow('回滚被拦截')
    expect(deny.exec).not.toHaveBeenCalled()
    expect(deny.store.listForSession('s1')).toHaveLength(1)

    const ask = setup({ decide: () => ({ kind: 'prompt', reason: 'first_access' }), isProd: () => true })
    expect(checkRollback(ask.deps, 's1', ask.orig.at)).toMatchObject({ verdict: 'confirm', prod: true, reason: expect.stringContaining('一次性') })
    await runRollback(ask.deps, 's1', ask.orig.at, false)
    expect(ask.exec).toHaveBeenCalled()

    const danger = setup({ find: (sid, at) => ({ ...setup().orig, sessionId: sid, at, rollback: 'rm -rf /opt/new' }) })
    expect(checkRollback(danger.deps, 's1', danger.orig.at).dangerous).toBe(true)
    await expect(runRollback(danger.deps, 's1', danger.orig.at, false)).rejects.toThrow('勾选确认')
    expect(danger.exec).not.toHaveBeenCalled()
    await runRollback(danger.deps, 's1', danger.orig.at, true)
    expect(danger.exec).toHaveBeenCalledWith('t1', 'rm -rf /opt/new')
  })

  it('没有回滚方案的记录不能回滚；终端忙给出人话', async () => {
    const { store, deps } = setup({ exec: async () => { throw new Error('terminal_busy') } })
    store.add({ at: '2026-10-15T02:00:00.000Z', sessionId: 's1', terminalId: 't1', hostKey: 'h1', command: 'ls', decision: 'exec_allowed', exitCode: 0 })
    expect(() => checkRollback(deps, 's1', '2026-10-15T02:00:00.000Z')).toThrow('没有回滚方案')
    await expect(runRollback(deps, 's1', '2026-10-15T01:00:00.000Z', false)).rejects.toThrow('终端正忙')
    expect(store.listForSession('s1').some((e) => e.decision === 'rollback')).toBe(false)
  })
})
