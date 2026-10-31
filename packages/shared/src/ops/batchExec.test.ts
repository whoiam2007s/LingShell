import { describe, it, expect } from 'vitest'
import {
  batchGroups, toggleGroup, pickedTargets, batchGate, batchStatusText, isBatchFailed, maybeExecuted, groupOutputs, outliers, batchMarkdown, batchTsv, runPool, batchAuditLabel, fmtMs, firstLine, clampInt,
  type BatchRow,
} from './batchExec.js'
import type { HostSummary, TerminalInfo } from '../protocol/index.js'

const host = (id: string, group?: string, env?: 'prod'): HostSummary => ({ id, label: id.toUpperCase(), host: `${id}.x`, port: 22, username: 'root', authType: 'password', group, env })
const term = (id: string, p: Partial<TerminalInfo>): TerminalInfo => ({ id, title: id, type: 'ssh', status: 'running', locked: false, ...p })
const done = (status: 'ok' | 'fail', output: string, exitCode = status === 'ok' ? 0 : 1): BatchRow => ({ status, result: { status, exitCode, output, ms: 10 } })

describe('目标解析', () => {
  const hosts = [host('w1', 'web', 'prod'), host('d1', 'db'), host('x'), host('w2', 'web')]
  const terms = [term('t1', { hostId: 'w1' }), term('t9', { title: '临时', detail: 'u@1.2.3.4:22' }), term('t8', { status: 'disconnected' })]
  const gs = batchGroups(hosts, terms)

  it('按分组排（有名分组按名称，未分组在后）→ 未保存的在线终端 → 本机；prod / live 标记带上', () => {
    expect(gs.map((g) => g.name)).toEqual(['db', 'web', '未分组', '未保存的在线终端', '本机'])
    expect(gs[1].items.map((c) => [c.key, c.env, c.live])).toEqual([['host:w1', 'prod', true], ['host:w2', undefined, false]])
    expect(gs[3].items.map((c) => c.target)).toEqual([{ kind: 'terminal', terminalId: 't9' }])   // 断线的不算
    expect(gs[4].items[0].target).toEqual({ kind: 'local' })
  })
  it('没有未保存终端时不出那一组', () => {
    expect(batchGroups([host('a')], []).map((g) => g.name)).toEqual(['未分组', '本机'])
  })
  it('组头全选 / 全取消；勾选结果按列表顺序', () => {
    const web = gs[1].items.map((c) => c.key)
    let p = toggleGroup(['local'], web)
    expect(p).toEqual(['local', 'host:w1', 'host:w2'])
    p = toggleGroup(['host:w2'], web)                 // 部分选 → 补齐
    expect(p).toEqual(['host:w2', 'host:w1'])
    expect(toggleGroup(p, web)).toEqual([])           // 全选 → 全取消
    expect(pickedTargets(gs, ['local', 'host:w2', 'host:d1']).map((c) => c.key)).toEqual(['host:d1', 'host:w2', 'local'])
  })
})

describe('batchGate', () => {
  const t = [{ label: 'A', env: 'prod' as const }, { label: 'B' }, { label: 'C', env: 'prod' as const }]
  it('无生产目标 → none（危险命令也不拦）', () => {
    expect(batchGate('rm -rf /tmp/x', [{ label: 'B' }])).toEqual({ level: 'none', prod: [] })
  })
  it('有生产目标 → prod；再加危险命令 → danger，列出生产主机', () => {
    expect(batchGate('uptime', t)).toEqual({ level: 'prod', prod: ['A', 'C'] })
    expect(batchGate('cd /data\nrm -rf old', t)).toEqual({ level: 'danger', prod: ['A', 'C'] })
    expect(batchGate('reboot', t).level).toBe('danger')
  })
  it('分批执行：主命令安全、健康检查命令危险 → 仍然 danger（每批每台都会跑健康检查）', () => {
    expect(batchGate(['systemctl reload app', 'curl -f localhost/health || systemctl reboot'], t).level).toBe('danger')
    expect(batchGate(['systemctl reload app', ''], t).level).toBe('prod')
  })
})

it('maybeExecuted：超时 / 执行中被取消的主机命令可能已跑过；没轮到的取消不算', () => {
  expect(maybeExecuted({ status: 'timeout' })).toBe(true)
  expect(maybeExecuted({ status: 'canceled', result: { status: 'canceled', output: 'x', ms: 1 } })).toBe(true)
  expect(maybeExecuted({ status: 'canceled' })).toBe(false)
  expect(maybeExecuted({ status: 'fail', result: { status: 'fail', exitCode: 1, ms: 1 } })).toBe(false)
  expect(batchStatusText({ status: 'canceled', result: { status: 'canceled', output: '', ms: 1 } })).toBe('中途中止')
  expect(batchStatusText({ status: 'canceled' })).toBe('已取消')
})

describe('状态 / 输出分组', () => {
  it('状态文案', () => {
    expect(batchStatusText({ status: 'running' })).toBe('运行中')
    expect(batchStatusText(done('ok', ''))).toBe('成功')
    expect(batchStatusText(done('fail', '', 3))).toBe('失败（3）')
    expect(batchStatusText({ status: 'fail', result: { status: 'fail', exitCode: null, ms: 1 } })).toBe('失败（被信号终止）')
    expect(batchStatusText({ status: 'timeout' })).toBe('超时')
    expect(batchStatusText({ status: 'conn_error' })).toBe('连接失败')
    expect(['ok', 'running', 'fail', 'timeout', 'conn_error', 'canceled'].map((s) => isBatchFailed(s as BatchRow['status']))).toEqual([false, false, true, true, true, true])
  })
  it('相同「退出码 + 输出」归一组，唯一最大且 ≥2 台为多数；超时 / 连接失败不参与分组但算「与多数不同」', () => {
    const rows: BatchRow[] = [done('ok', 'v1\n'), done('ok', 'v2\n'), done('ok', 'v1\n'), { status: 'timeout', result: { status: 'timeout', ms: 1 } }, done('fail', 'v1\n'), { status: 'running' }]
    const g = groupOutputs(rows)
    expect(g.group).toEqual([0, 1, 0, -1, 2, -1])
    expect(g.counts).toEqual([2, 1, 1])
    expect(g.majority).toBe(0)
    expect(outliers(rows)).toEqual([1, 3, 4])   // 运行中的不算
  })
  it('输出被截断的行不参与分组 / 多数（截断点之后可能不同）', () => {
    const rows: BatchRow[] = [done('ok', 'x'), { status: 'ok', result: { status: 'ok', output: 'x', truncated: true, ms: 1 } }, done('ok', 'x')]
    const g = groupOutputs(rows)
    expect(g.group[1]).toBe(-1)
    expect(g.majority).toBe(0)
  })
  it('空输入的超时 / 并发回默认值，不是 1', () => {
    expect(clampInt(Number(''), 1, 300, 30)).toBe(30)
    expect(clampInt(Number(''), 1, 16, 4)).toBe(4)
    expect(clampInt(0, 1, 300, 30)).toBe(30)
    expect(clampInt(5, 1, 300, 30)).toBe(5)
  })
  it('并列或全都不同 → 没有多数', () => {
    expect(groupOutputs([done('ok', 'a'), done('ok', 'a'), done('ok', 'b'), done('ok', 'b')]).majority).toBe(-1)
    expect(groupOutputs([done('ok', 'a'), done('ok', 'b')]).majority).toBe(-1)
    expect(outliers([done('ok', 'a'), done('ok', 'b')])).toEqual([])
  })
  it('首行 / 耗时', () => {
    expect(firstLine('\n  \n hello \nworld')).toBe('hello')
    expect([fmtMs(850), fmtMs(12345), fmtMs(65_000)]).toEqual(['850ms', '12.3s', '1m05s'])
  })
})

describe('导出', () => {
  const rows = [
    { label: 'web|1', row: done('ok', 'a\tb\nline2\n') },
    { label: 'db', row: { status: 'conn_error' as const, result: { status: 'conn_error' as const, error: '认证失败', ms: 1200 } } },
  ]
  it('Markdown：命令 + 汇总表（转义 |）+ 每台完整输出', () => {
    const md = batchMarkdown('echo ```x```', rows)
    expect(md).toContain('````bash\necho ```x```\n````')
    expect(md).toContain('| web\\|1 | 成功 | 10ms | a\tb |')
    expect(md).toContain('| db | 连接失败 | 1.2s | 认证失败 |')
    expect(md).toContain('### web|1\n\n```\na\tb\nline2\n```')
  })
  it('TSV：表头 + 每行一台，含制表符 / 换行的字段加引号', () => {
    expect(batchTsv(rows)).toBe('主机\t状态\t耗时\t输出\nweb|1\t成功\t10ms\t"a\tb\nline2"\ndb\t连接失败\t1.2s\t认证失败\n')
  })
})

describe('runPool', () => {
  const defer = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r }); return { p, resolve } }
  it('按下标顺序起，同时最多 limit 个', async () => {
    const started: number[] = [], gates = Array.from({ length: 5 }, defer)
    let running = 0, peak = 0
    const pool = runPool(5, 2, async (i) => { started.push(i); running++; peak = Math.max(peak, running); await gates[i].p; running-- })
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[1].resolve(); await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([0, 1, 2])
    for (const g of gates) g.resolve()
    await pool
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
  })
  it('中止后不再起新任务，在跑的照常收尾', async () => {
    const ac = new AbortController(), started: number[] = [], finished: number[] = []
    await runPool(6, 2, async (i) => {
      started.push(i)
      if (i === 1) ac.abort()
      await new Promise((r) => setTimeout(r, 5))
      finished.push(i)
    }, ac.signal)
    expect(started).toEqual([0, 1])
    expect(finished.sort()).toEqual([0, 1])
  })
  it('慢任务（如超时）不挡住别的并发槽', async () => {
    const order: number[] = [], slow = defer()
    await runPool(4, 2, async (i) => {
      if (i === 0) await slow.p
      else await Promise.resolve()
      order.push(i)
      if (i === 3) slow.resolve()   // 其余都跑完了，慢的才结束
    })
    expect(order).toEqual([1, 2, 3, 0])
  })
  it('0 个任务直接结束', async () => {
    await expect(runPool(0, 5, async () => { throw new Error('不该调用') })).resolves.toBeUndefined()
  })
})

it('执行记录标签', () => {
  expect(batchAuditLabel('batch_exec')).toBe('批量执行')
  expect(batchAuditLabel('docker_stop')).toBeUndefined()
})
