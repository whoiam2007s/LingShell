import { describe, it, expect } from 'vitest'
import type { AppEvent } from '@lingshell/shared'
import { BgStatus, ERROR_TTL_MS, type BgStatusDeps } from './bgStatus.js'

function setup(over: Partial<BgStatusDeps> = {}) {
  let now = 1_000_000
  const terms = new Map([['t1', 'web-01']])
  const transfers: { state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; overallPercent: number }[] = []
  const s = new BgStatus({
    sessions: () => [{ id: 's1', title: '排查 nginx' }, { id: 's2', title: '空闲会话' }],
    hostLabelOf: (hk) => (hk === 'local' ? '本地' : hk === 'h1' ? 'web-01' : hk),
    terminalTitle: (tid) => terms.get(tid),
    locked: () => false, lockEnabled: () => true,
    watchdog: () => ({ paused: false, firing: 0 }),
    transfers: () => transfers,
    hosts: () => [{ id: 'h1', label: 'web-01' }],
    ball: () => ({ visible: true, opacity: 80 }),
    now: () => now,
    ...over,
  })
  const ev = (e: AppEvent) => s.onEvent(e)
  return { s, ev, terms, transfers, tick: (ms: number) => { now += ms } }
}

const authReq = (approvalId: string, sessionId: string, extra: Record<string, unknown> = {}): AppEvent => ({
  type: 'auth:request', approvalId, sessionId, terminalId: 'h1', needed: 'write', reason: 'first_access', risk: 'safe', tool: 'exec_in_terminal', command: 'systemctl restart nginx', deadlineMs: 60_000, ...extra,
} as AppEvent)

describe('BgStatus', () => {
  it('运行中 / 待授权的会话与授权摘要（同手机访问旁听同一路事件）', () => {
    const { s, ev } = setup()
    ev({ type: 'agent:turnStarted', sessionId: 's1', turnId: 'u1' })
    expect(s.snapshot().sessions).toEqual([{ id: 's1', title: '排查 nginx', status: 'running' }])
    ev(authReq('a1', 's1'))
    const snap = s.snapshot()
    expect(snap.sessions).toEqual([{ id: 's1', title: '排查 nginx', status: 'waiting' }])
    expect(snap.approvals).toEqual([{ approvalId: 'a1', sessionId: 's1', sessionTitle: '排查 nginx', command: 'systemctl restart nginx', host: 'web-01' }])
    ev({ type: 'auth:resolved', approvalId: 'a1', result: 'allow' } as AppEvent)
    expect(s.snapshot().approvals).toEqual([])
    ev({ type: 'agent:turnCompleted', sessionId: 's1', turnId: 'u1' })
    expect(s.snapshot().sessions).toEqual([])
  })
  it('MCP / 多主机 / 计划的摘要', () => {
    const { s, ev } = setup()
    ev(authReq('m', 's1', { terminalId: 'mcp:grafana', command: undefined, mcp: { server: 'grafana', tool: 'query', args: '{}' } }))
    ev(authReq('t', 's1', { targets: [{ terminalId: 'a', hostKey: 'h1', label: 'a' }, { terminalId: 'b', hostKey: 'h2', label: 'b' }] }))
    ev({ type: 'plan:request', approvalId: 'p', sessionId: 's2', title: '升级', steps: [{ hostKey: 'h1', command: 'x', dangerous: false }], deadlineMs: 60_000 } as unknown as AppEvent)
    const a = s.snapshot().approvals
    expect(a.find((x) => x.approvalId === 'm')).toMatchObject({ command: 'grafana · query', host: 'mcp:grafana' })
    expect(a.find((x) => x.approvalId === 't')).toMatchObject({ host: '2 台主机' })
    expect(a.find((x) => x.approvalId === 'p')).toMatchObject({ command: '计划：升级（1 步）', sessionTitle: '空闲会话' })
  })
  it('最近出错：用户停止的不算；看到主窗口 / 超时 / 该会话重新开跑后清掉', () => {
    const { s, ev, tick } = setup()
    ev({ type: 'agent:turnFailed', sessionId: 's1', turnId: 'u', error: 'x', stopped: true })
    expect(s.snapshot().error).toBeUndefined()
    ev({ type: 'agent:turnFailed', sessionId: 's1', turnId: 'u', error: 'x' })
    expect(s.snapshot().error).toBe('排查 nginx')
    s.clearError()
    expect(s.snapshot().error).toBeUndefined()
    ev({ type: 'agent:turnFailed', sessionId: 's1', turnId: 'u', error: 'x' })
    tick(ERROR_TTL_MS + 1)
    expect(s.snapshot().error).toBeUndefined()
    ev({ type: 'agent:turnFailed', sessionId: 's1', turnId: 'u', error: 'x' })
    ev({ type: 'agent:turnStarted', sessionId: 's1', turnId: 'u2' })
    expect(s.snapshot().error).toBeUndefined()
  })
  it('主机状态取最近一次采样；终端关了 / 太久没更新就不显示', () => {
    const { s, ev, terms, tick } = setup()
    ev({ type: 'terminal:hostStats', terminalId: 't1', stats: { at: 1, cpuPct: 12.5, memUsed: 2, memTotal: 8 } })
    expect(s.snapshot().stats).toEqual({ title: 'web-01', cpuPct: 12.5, memPct: 25 })
    tick(61_000)
    expect(s.snapshot().stats).toBeUndefined()
    ev({ type: 'terminal:hostStats', terminalId: 't1', stats: { at: 2, cpuPct: 1 } })
    terms.delete('t1')
    expect(s.snapshot().stats).toBeUndefined()
  })
  it('传输：进行中 + 排队数与平均进度', () => {
    const { s, transfers } = setup()
    transfers.push({ state: 'running', overallPercent: 20 }, { state: 'running', overallPercent: 60 }, { state: 'queued', overallPercent: 0 }, { state: 'done', overallPercent: 100 })
    expect(s.snapshot().transfers).toEqual({ active: 3, percent: 40 })
  })
  it('悬浮球开关与透明度透传', () => {
    expect(setup().s.snapshot()).toMatchObject({ ball: true, ballOpacity: 80, hosts: [{ id: 'h1', label: 'web-01' }], lockEnabled: true })
  })
})
