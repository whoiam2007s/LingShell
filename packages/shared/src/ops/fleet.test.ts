import { describe, it, expect } from 'vitest'
import { resolveFleetTargets, fleetRow, summarizeFleet, fleetHostLines, fleetStatusText, type FleetHost } from './fleet.js'

const hosts: FleetHost[] = [
  { id: 'h1', label: 'web-1', group: 'web' },
  { id: 'h2', label: 'web-2', group: 'web', env: 'prod' },
  { id: 'h3', label: 'db-1', group: 'db' },
]

describe('resolveFleetTargets', () => {
  it('id / 分组名 / 主机名都认，去重保序；认不出的列出来', () => {
    expect(resolveFleetTargets(['web', 'h1', 'db-1', 'nope'], hosts)).toEqual({ hosts: [hosts[0], hosts[1], hosts[2]], unknown: ['nope'] })
    expect(resolveFleetTargets('web', hosts)).toEqual({ hosts: [], unknown: [] })   // 不是数组
  })
})

describe('fleetRow / summarizeFleet', () => {
  it('输出取末尾截断、去 \\r；汇总成功数 / 失败 / 相同输出分组', () => {
    const r1 = fleetRow(hosts[0], { status: 'ok', exitCode: 0, output: 'Linux a\r\n', ms: 12 })
    const r2 = fleetRow(hosts[1], { status: 'ok', exitCode: 0, output: 'Linux a\n', ms: 15 })
    const r3 = fleetRow(hosts[2], { status: 'conn_error', error: 'ECONNREFUSED', ms: 3 })
    const big = fleetRow(hosts[2], { status: 'fail', exitCode: 2, output: 'x'.repeat(50) + 'END', ms: 1 }, 10)
    expect(r1).toEqual({ host_id: 'h1', label: 'web-1', group: 'web', status: 'ok', exit_code: 0, ms: 12, output: 'Linux a\n' })
    expect(big.output).toBe('xxxxxxxEND')
    expect(big.truncated).toBe(true)
    expect(r3.error).toBe('ECONNREFUSED')
    const s = summarizeFleet([r1, r2, r3])
    expect(s).toEqual({ total: 3, ok: 2, failed: ['h3'], same_output_groups: [['h1', 'h2']] })
    expect(fleetStatusText(big)).toBe('失败（2）')
    expect(fleetStatusText(r3)).toBe('连接失败')
  })
  it('主机清单只含名称 / id / 分组 / 环境', () => {
    const t = fleetHostLines(hosts)
    expect(t).toContain('- web-2 · id=h2 · 分组=web · 生产')
    expect(t).not.toMatch(/@|password/)
  })
})
