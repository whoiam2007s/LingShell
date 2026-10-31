import { describe, it, expect } from 'vitest'
import {
  parseCheckOutput, stepWatchdog, pushHistory, resolveWatchdogTargets, checkWatchdogInput, buildWatchdogPrompt, parseWatchdogGen,
  watchdogSessionPrompt, WATCHDOG_HISTORY, type WatchdogHostState, type CheckOutcome, type WatchdogInput,
} from './watchdog.js'

describe('parseCheckOutput：退出码 0 正常 / 1 触发 / 其他失败，当前值取最后一个非空行', () => {
  it.each([
    [{ status: 'ok', exitCode: 0, output: '不存在\n' }, { kind: 'ok', value: '不存在' }],
    [{ status: 'fail', exitCode: 1, output: 'warn: x\r\n/data 使用率 93%\n\n' }, { kind: 'trigger', value: '/data 使用率 93%' }],
    [{ status: 'fail', exitCode: 1, output: '' }, { kind: 'trigger', value: '' }],
    [{ status: 'fail', exitCode: 127, output: 'bash: foo: command not found' }, { kind: 'error', value: '检查失败（退出码 127）：bash: foo: command not found' }],
    [{ status: 'fail', exitCode: null, output: '' }, { kind: 'error', value: '检查失败（退出码 无）' }],
    [{ status: 'timeout', output: 'x' }, { kind: 'error', value: '检查超时' }],
    [{ status: 'conn_error', error: 'ECONNREFUSED' }, { kind: 'error', value: '连接失败：ECONNREFUSED' }],
  ] as const)('%j', (r, want) => expect(parseCheckOutput(r)).toEqual(want))

  it('去 ANSI、截 200 字', () => {
    expect(parseCheckOutput({ status: 'ok', exitCode: 0, output: '\x1b[31m红\x1b[0m' }).value).toBe('红')
    expect(parseCheckOutput({ status: 'ok', exitCode: 0, output: 'a'.repeat(300) }).value).toHaveLength(200)
  })
})

describe('stepWatchdog 状态机', () => {
  const ok: CheckOutcome = { kind: 'ok', value: '正常' }
  const hit: CheckOutcome = { kind: 'trigger', value: '超了' }
  const err: CheckOutcome = { kind: 'error', value: '连接失败' }
  const run = (seq: CheckOutcome[], threshold: number) => {
    let s: WatchdogHostState | undefined
    const events: (string | undefined)[] = []
    for (const o of seq) { const r = stepWatchdog(s, o, threshold, 't'); s = r.next; events.push(r.event) }
    return { s: s!, events }
  }

  it('默认 1 次即报警；持续触发不重复报警；恢复正常发一次 recover', () => {
    const { s, events } = run([ok, hit, hit, hit, ok, ok], 1)
    expect(events).toEqual([undefined, 'fire', undefined, undefined, 'recover', undefined])
    expect(s).toMatchObject({ status: 'ok', streak: 0, alerted: false })
  })

  it('连续 N 次才报警：中途恢复清零重计', () => {
    const r = run([hit, hit, ok, hit, hit, hit], 3)
    expect(r.events).toEqual([undefined, undefined, undefined, undefined, undefined, 'fire'])
    expect(run([hit, hit], 3).s).toMatchObject({ status: 'pending', streak: 2, alerted: false })
  })

  it('检查失败不打断连续计数、不算恢复；报警中失败后再触发也不重复报警', () => {
    expect(run([hit, err, hit], 2).events).toEqual([undefined, undefined, 'fire'])
    const r = run([hit, err, hit, err], 1)
    expect(r.events).toEqual(['fire', undefined, undefined, undefined])
    expect(r.s).toMatchObject({ status: 'error', value: '连接失败', alerted: true })
  })

  it('同一轮报警只开一次会话：sessionId 留到恢复才清', () => {
    let { next } = stepWatchdog(undefined, hit, 1, 't1')
    next = { ...next, sessionId: 'sess_1' }
    const again = stepWatchdog(next, hit, 1, 't2')
    expect(again.event).toBeUndefined()
    expect(again.next.sessionId).toBe('sess_1')
    const rec = stepWatchdog(again.next, ok, 1, 't3')
    expect(rec.event).toBe('recover')
    expect(rec.next.sessionId).toBeUndefined()
    expect(stepWatchdog(rec.next, hit, 1, 't4').event).toBe('fire')
  })

  it('pushHistory 新在前，最多保留 20 条', () => {
    let h = [] as ReturnType<typeof pushHistory>
    for (let i = 0; i < 25; i++) h = pushHistory(h, { at: String(i), hostKey: 'local', kind: 'fire' })
    expect(h).toHaveLength(WATCHDOG_HISTORY)
    expect(h[0].at).toBe('24')
  })
})

describe('目标与校验', () => {
  it('resolveWatchdogTargets：主机 + 分组展开、去重、去掉已删除主机', () => {
    const hosts = [{ id: 'h1', group: 'web' }, { id: 'h2', group: 'web' }, { id: 'h3', group: 'db' }]
    expect(resolveWatchdogTargets({ targets: ['local', 'h1', 'gone'], groups: ['web'] }, hosts)).toEqual(['local', 'h1', 'h2'])
  })

  it('checkWatchdogInput', () => {
    const base: WatchdogInput = { name: 'a', condition: 'c', script: 'true', targets: ['local'], intervalMin: 5, threshold: 1, autoSession: true, enabled: true }
    expect(checkWatchdogInput(base)).toBeUndefined()
    expect(checkWatchdogInput({ ...base, intervalMin: 2 })).toContain('间隔')
    expect(checkWatchdogInput({ ...base, threshold: 0 })).toContain('连续')
    expect(checkWatchdogInput({ ...base, targets: [], groups: [] })).toContain('主机')
    expect(checkWatchdogInput({ ...base, targets: [], groups: ['web'] })).toBeUndefined()
    expect(checkWatchdogInput({ ...base, script: ' ' })).toContain('脚本')
  })
})

describe('生成检查脚本', () => {
  it('提示词讲清退出码约定与只读要求，用户消息带条件', () => {
    const p = buildWatchdogPrompt({ condition: ' /data 使用率超过 90% ', os: 'linux' })
    expect(p.system).toContain('0 = 正常')
    expect(p.system).toContain('1 = 条件成立')
    expect(p.system).toContain('只读')
    expect(p.user).toBe('监控条件：/data 使用率超过 90%')
  })

  it('parseWatchdogGen：取代码块与说明；去 think / shebang；拒绝与无代码块报错', () => {
    const raw = '<think>想想</think>说明：/tmp/lingshell-wd 存在时报警\n```sh\n#!/bin/sh\ntest -e /tmp/lingshell-wd && { echo 存在; exit 1; } || { echo 不存在; exit 0; }\n```'
    expect(parseWatchdogGen(raw)).toEqual({ script: 'test -e /tmp/lingshell-wd && { echo 存在; exit 1; } || { echo 不存在; exit 0; }', explain: '/tmp/lingshell-wd 存在时报警' })
    expect(parseWatchdogGen('```bash\ndf -h /\n```\n检查根分区')).toEqual({ script: 'df -h /', explain: '检查根分区' })
    expect(parseWatchdogGen('# 需要 root 权限读取，无法只读检查')).toEqual({ error: '需要 root 权限读取，无法只读检查' })
    expect('error' in parseWatchdogGen('随便说说')).toBe(true)
  })

  it('排查会话首条消息：看门狗名、主机、当前值、主机 id', () => {
    const t = watchdogSessionPrompt({ name: '磁盘', condition: '/data > 90%', script: 'df /data' }, { key: 'h1', label: 'web-1' }, '93%')
    expect(t).toContain('看门狗『磁盘』在 web-1 触发：当前值 93%，请排查原因')
    expect(t).toContain('主机 id：h1')
  })
})
