import { describe, expect, it } from 'vitest'
import { splitBatches, runRollout, healthCommand, httpCheckCommand, rolloutExecuted, rolloutUncertain, batchTagDecision, rolloutAuditLabel, ROLLOUT_DEFAULTS, type RolloutHooks, type RolloutOpts, type RolloutPhase, type RolloutRow } from './rollout.js'
import type { BatchExecResult } from './batchExec.js'

describe('splitBatches', () => {
  it('按台数', () => {
    expect(splitBatches(5, 'count', 2)).toEqual([[0, 1], [2, 3], [4]])
    expect(splitBatches(3, 'count', 10)).toEqual([[0, 1, 2]])
    expect(splitBatches(3, 'count', 0)).toEqual([[0], [1], [2]])
    expect(splitBatches(0, 'count', 2)).toEqual([])
  })
  it('按百分比：向上取整、至少 1 台', () => {
    expect(splitBatches(10, 'percent', 25)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]])
    expect(splitBatches(3, 'percent', 10)).toEqual([[0], [1], [2]])
    expect(splitBatches(4, 'percent', 200)).toEqual([[0, 1, 2, 3]])
  })
})

describe('健康检查命令', () => {
  it('不检查 / 空 → undefined；命令原样；URL 拼 curl', () => {
    expect(healthCommand({ health: 'none', healthCmd: 'x' })).toBeUndefined()
    expect(healthCommand({ health: 'command', healthCmd: '  ' })).toBeUndefined()
    expect(healthCommand({ health: 'command', healthCmd: 'systemctl is-active app' })).toBe('systemctl is-active app')
    const c = healthCommand({ health: 'url', healthCmd: "http://127.0.0.1:8080/health?a=1&b='x'" })!
    expect(c).toContain(`curl -sS -o /dev/null`)
    expect(c).toContain(`'http://127.0.0.1:8080/health?a=1&b='\\''x'\\'''`)
    expect(c).toContain('[ "$c" = "200" ]')
    expect(httpCheckCommand('http://x', 204)).toContain('"204"')
  })
})

const ok = (ms = 1): BatchExecResult => ({ status: 'ok', exitCode: 0, output: 'ok', ms })
const fail = (code = 1): BatchExecResult => ({ status: 'fail', exitCode: code, output: 'bad', ms: 1 })

function harness(o: Partial<RolloutOpts>, n: number, plan: { run?: (i: number) => BatchExecResult; health?: (i: number, try_: number) => BatchExecResult; gate?: boolean | 'abort-during' } = {}) {
  const rows: RolloutRow[] = []
  const phases: RolloutPhase[] = []
  const ran: number[] = [], checked: number[] = [], sleeps: number[] = [], gates: number[] = []
  const tries = new Map<number, number>()
  let abort = false
  const hooks: RolloutHooks = {
    run: async (i, b) => { ran.push(i); void b; return plan.run?.(i) ?? ok() },
    health: async (i) => { checked.push(i); const t = (tries.get(i) ?? 0) + 1; tries.set(i, t); return plan.health?.(i, t) ?? ok() },
    sleep: async (ms) => { sleeps.push(ms) },
    gate: async (b) => { gates.push(b); if (plan.gate === 'abort-during') { abort = true; return false } return plan.gate ?? true },
    row: (i, r) => { rows[i] = r },
    phase: (p) => { phases.push(p) },
    aborted: () => abort,
  }
  const run = () => runRollout(n, { ...ROLLOUT_DEFAULTS, ...o }, 2, hooks)
  return { run, rows, phases, ran, checked, sleeps, gates, setAbort: () => { abort = true } }
}

describe('runRollout', () => {
  it('金丝雀：第一批后暂停，继续后跑完', async () => {
    const h = harness({ size: 1, canary: true }, 3)
    const p = await h.run()
    expect(p.state).toBe('done')
    expect(h.gates).toEqual([0])
    expect(h.ran).toEqual([0, 1, 2])
    expect(h.phases.map((x) => x.state)).toEqual(['running', 'paused', 'running', 'running', 'done'])
    expect(h.rows.map((r) => r.batch)).toEqual([0, 1, 2])
  })
  it('金丝雀暂停时选中止：后面的不跑，标已取消', async () => {
    const h = harness({ size: 1, canary: true }, 3, { gate: false })
    const p = await h.run()
    expect(p.state).toBe('aborted')
    expect(h.ran).toEqual([0])
    expect(h.rows.map((r) => r.status)).toEqual(['ok', 'canceled', 'canceled'])
  })
  it('失败即停：第 2 批健康检查失败（含重试），第 3 批不执行', async () => {
    // 4 台、每批 2 台：第 3 台（下标 2）健康检查一直失败
    const h = harness({ size: 2, canary: false, health: 'command', healthCmd: 'check', retries: 2, intervalSec: 3 }, 4, { health: (i) => (i === 2 ? fail() : ok()) })
    const p = await h.run()
    expect(p).toMatchObject({ state: 'stopped', batch: 1 })
    expect(p.reason).toContain('第 2 批')
    expect(h.ran.sort()).toEqual([0, 1, 2, 3])          // 第 2 批两台都执行了
    expect(h.checked.filter((i) => i === 2)).toHaveLength(3)   // 1 + 2 次重试
    expect(h.sleeps).toEqual([3000, 3000])
    expect(h.rows[2].health).toMatchObject({ status: 'fail', tries: 3 })
    expect(h.rows[3].health).toMatchObject({ status: 'ok', tries: 1 })
  })
  it('失败即停：命令失败不做健康检查，后面的批标已取消', async () => {
    const h = harness({ size: 1, canary: false, health: 'command', healthCmd: 'check' }, 3, { run: (i) => (i === 1 ? fail(2) : ok()) })
    const p = await h.run()
    expect(p.state).toBe('stopped')
    expect(h.ran).toEqual([0, 1])
    expect(h.checked).toEqual([0])
    expect(h.rows.map((r) => r.status)).toEqual(['ok', 'fail', 'canceled'])
  })
  it('跳过这台继续：失败的标 skipped，其余跑完', async () => {
    const h = harness({ size: 1, canary: false, onFail: 'skip' }, 3, { run: (i) => (i === 0 ? fail() : ok()) })
    const p = await h.run()
    expect(p.state).toBe('done')
    expect(h.ran).toEqual([0, 1, 2])
    expect(h.rows[0].skipped).toBe(true)
    expect(h.rows[1].skipped).toBeUndefined()
  })
  it('重试中恢复健康 → 算成功', async () => {
    const h = harness({ size: 2, canary: false, health: 'url', healthCmd: 'http://x/health', retries: 3 }, 2, { health: (_i, t) => (t < 2 ? fail() : ok()) })
    expect((await h.run()).state).toBe('done')
    expect(h.rows[0].health).toMatchObject({ status: 'ok', tries: 2 })
  })
  it('运行中中止：不再起新批', async () => {
    const h = harness({ size: 1, canary: false }, 3, { run: (i) => { if (i === 0) h.setAbort(); return ok() } })
    const p = await h.run()
    expect(p.state).toBe('aborted')
    expect(h.ran).toEqual([0])
  })
})

it('rolloutExecuted：只取命令确实跑过的', () => {
  const rows: RolloutRow[] = [
    { batch: 0, status: 'ok' }, { batch: 0, status: 'fail' }, { batch: 1, status: 'conn_error' }, { batch: 1, status: 'canceled' }, { batch: 1, status: 'timeout' },
  ]
  expect(rolloutExecuted(rows)).toEqual([0, 1, 4])
})

it('执行中被中止的主机（canceled 带输出）也算已执行：回滚不能漏掉半部署的主机', () => {
  const rows: RolloutRow[] = [
    { batch: 0, status: 'ok' },
    { batch: 0, status: 'canceled', result: { status: 'canceled', output: 'deploying…', ms: 5 } },   // 执行中中止
    { batch: 1, status: 'canceled' },                                                          // 没轮到
    { batch: 1, status: 'timeout', result: { status: 'timeout', output: '', ms: 30_000 } },
  ]
  expect(rolloutExecuted(rows)).toEqual([0, 1, 3])
  expect(rolloutUncertain(rows)).toEqual([1, 3])
})

describe('跳过这台继续的底线', () => {
  it('一整批（≥2 台）全部失败：即使选了跳过也停下', async () => {
    const h = harness({ size: 2, canary: false, onFail: 'skip' }, 6, { run: (i) => (i === 2 || i === 3 ? fail() : ok()) })
    const p = await h.run()
    expect(p).toMatchObject({ state: 'stopped', batch: 1 })
    expect(p.reason).toContain('全部失败')
    expect(h.ran.sort()).toEqual([0, 1, 2, 3])   // 第 3 批没跑
  })
  it('累计失败超过 30% 就停（10 台里第 4 台失败时停）', async () => {
    const h = harness({ size: 1, canary: false, onFail: 'skip' }, 10, { run: (i) => (i < 4 ? fail() : ok()) })
    const p = await h.run()
    expect(p.state).toBe('stopped')
    expect(p.reason).toContain('累计')
    expect(h.ran).toEqual([0, 1, 2, 3])
  })
})

it('中止时健康检查标「已取消」而不是「不健康」', async () => {
  let abort = false
  const rows: RolloutRow[] = []
  await runRollout(1, { ...ROLLOUT_DEFAULTS, canary: false, health: 'command', healthCmd: 'check' }, 1, {
    run: async () => { abort = true; return ok() },   // 命令跑完后用户点了中止
    health: async () => ok(), sleep: async () => {}, gate: async () => true,
    row: (i, r) => { rows[i] = r }, phase: () => {}, aborted: () => abort,
  })
  expect(rows[0].health).toMatchObject({ status: 'canceled' })
})

it('执行记录标注', () => {
  expect(batchTagDecision('batch_exec')).toBe('batch_exec')
  expect(batchTagDecision('batch_exec', { kind: 'rollout', batch: 2 })).toBe('batch_exec:rollout:2')
  expect(batchTagDecision('batch_exec', { kind: 'health', batch: 1 })).toBe('batch_exec:health:1')
  expect(batchTagDecision('batch_exec', { kind: 'rollback' })).toBe('batch_exec:rollback')
  expect(rolloutAuditLabel('batch_exec:rollout:2')).toBe('分批执行 · 第 2 批')
  expect(rolloutAuditLabel('batch_exec:health:1')).toBe('分批执行 · 第 1 批健康检查')
  expect(rolloutAuditLabel('batch_exec:rollback')).toBe('分批执行 · 回滚')
  expect(rolloutAuditLabel('batch_exec')).toBeUndefined()
})
