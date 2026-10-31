import { describe, it, expect } from 'vitest'
import type { AuditEntry } from '../protocol/index.js'
import {
  normalizeRunbook, runbookVars, fillRunbook, buildRunbookPrompt, auditToSteps, guessStepKind,
  suggestParamValues, parameterize, parseRunbookJson, runbookMissing, mergeStepRuns, type Runbook,
} from './runbook.js'

const rb: Runbook = {
  id: 'rb_1', name: '重启服务', description: '服务挂了时用', updatedAt: '',
  params: [{ name: '服务', label: '服务名', default: 'nginx' }, { name: '端口', label: '端口' }],
  steps: [
    { title: '看 {{服务}} 状态', command: 'systemctl status {{服务}}', expect: 'active', kind: 'check' },
    { title: '重启', command: 'systemctl restart {{服务}}', kind: 'change' },
    { title: '确认端口', command: 'ss -lnt | grep :{{端口}}', expect: '有 LISTEN', kind: 'check' },
  ],
}

describe('参数', () => {
  it('提取步骤里的占位符，去重保序', () => {
    expect(runbookVars(rb.steps)).toEqual(['服务', '端口'])
  })
  it('填充：用户值优先，空则用默认值，都没有保留占位符', () => {
    const s = fillRunbook(rb, { 服务: '', 端口: '80' })
    expect(s[0]).toMatchObject({ title: '看 nginx 状态', command: 'systemctl status nginx' })
    expect(s[2].command).toBe('ss -lnt | grep :80')
    expect(fillRunbook(rb, {})[2].command).toBe('ss -lnt | grep :{{端口}}')
  })
  it('规整：未声明参数自动补、重复参数去掉、空字段丢弃', () => {
    const n = normalizeRunbook({ name: 'a', description: ' ', params: [{ name: 'x', label: '' }, { name: 'x', label: 'dup' }], steps: [{ title: 't', command: 'echo {{y}}', expect: '', kind: 'check' }] })
    expect(n.params).toEqual([{ name: 'x', label: 'x' }, { name: 'y', label: 'y' }])
    expect(n.steps[0]).toEqual({ title: 't', command: 'echo {{y}}', kind: 'check' })
  })
  it('参数化：替换全部出现处并补参数（默认值=原值）', () => {
    const r = parameterize({ params: [], steps: [{ title: 'ping 10.0.0.5', command: 'ping -c1 10.0.0.5 && ssh root@10.0.0.5', kind: 'check' }] }, '10.0.0.5', '主机')
    expect(r.steps[0]).toMatchObject({ title: 'ping {{主机}}', command: 'ping -c1 {{主机}} && ssh root@{{主机}}' })
    expect(r.params).toEqual([{ name: '主机', label: '主机', default: '10.0.0.5' }])
  })
  it('建议参数：IP、路径、user@host，按次数降序', () => {
    const v = suggestParamValues([
      { title: '', command: 'tail -n 50 /var/log/nginx/error.log', kind: 'check' },
      { title: '', command: 'curl 192.168.1.10:8080/health; cat /var/log/nginx/error.log', kind: 'check' },
      { title: '', command: 'scp a deploy@web1', kind: 'change' },
    ])
    expect(v[0]).toBe('/var/log/nginx/error.log')
    expect(v).toContain('192.168.1.10:8080')
    expect(v).toContain('deploy@web1')
  })
})

describe('buildRunbookPrompt', () => {
  const p = buildRunbookPrompt(rb, { 端口: '443' }, [{ id: 't1', title: 'web1', detail: 'root@10.0.0.1:22' }, { id: 't2', title: 'web2' }])
  it('按顺序列出步骤、参数已填、目标终端列出', () => {
    const a = p.indexOf('1. [检查] 看 nginx 状态'), b = p.indexOf('2. [改动] 重启'), c = p.indexOf('3. [检查] 确认端口')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
    expect(p).toContain('命令：systemctl restart nginx')
    expect(p).toContain('grep :443')
    expect(p).toContain('预期：active')
    expect(p).toContain('- t1（web1 · root@10.0.0.1:22）')
    expect(p).toContain('- t2（web2）')
    expect(p).not.toContain('{{')
  })
  it('改动步骤要求先 propose_plan；结果不符时停下询问', () => {
    expect(p).toContain('propose_plan')
    expect(p).toMatch(/不符合预期.*停下/)
  })
  it('只有检查步骤时不要求 propose_plan', () => {
    const q = buildRunbookPrompt({ ...rb, steps: [rb.steps[0]] }, {}, [{ id: 't1', title: 'x' }])
    expect(q).toContain('不需要 propose_plan')
  })
})

describe('auditToSteps', () => {
  const e = (at: string, command: string, decision = 'exec_allowed', exitCode: number | undefined = 0): AuditEntry =>
    ({ at, sessionId: 's', terminalId: 't', hostKey: 'local', command, decision, exitCode })
  it('只取成功执行的命令、按时间正序、去连续重复', () => {
    const steps = auditToSteps([
      e('2026-01-01T00:00:05Z', 'df -h'),
      e('2026-01-01T00:00:04Z', 'df -h'),
      e('2026-01-01T00:00:03Z', 'systemctl restart nginx', 'exec_allowed:edited'),
      e('2026-01-01T00:00:02Z', 'cat /nope', 'exec_allowed', 1),
      e('2026-01-01T00:00:01Z', 'rm -rf /', 'deny:user', undefined),
      e('2026-01-01T00:00:00Z', '读取 /etc/hosts', 'read_allowed', undefined),
      e('2026-01-01T00:00:06Z', 'uptime', 'exec_allowed:multi'),
      e('2026-01-01T00:00:07Z', 'df -h'),
    ])
    expect(steps.map((s) => s.command)).toEqual(['systemctl restart nginx', 'df -h', 'uptime', 'df -h'])
    expect(steps[0].kind).toBe('change')
    expect(steps[1].kind).toBe('check')
  })
  it('粗判改动命令', () => {
    expect(guessStepKind('echo hi > /etc/motd')).toBe('change')
    expect(guessStepKind('cat x 2>/dev/null')).toBe('check')
    expect(guessStepKind('ls 2>&1 | head')).toBe('check')
    expect(guessStepKind('sudo apt install nginx')).toBe('change')
  })
})

describe('parseRunbookJson', () => {
  it('导入去掉 id/updatedAt 并校验', () => {
    const r = parseRunbookJson(JSON.stringify(rb))
    expect(r.id).toBeUndefined()
    expect(r.steps).toHaveLength(3)
    expect(() => parseRunbookJson('[]')).toThrow()
    expect(() => parseRunbookJson('{x')).toThrow('JSON')
    expect(() => parseRunbookJson('{"name":"a","steps":[]}')).toThrow('步骤')
  })
})

describe('手册视图', () => {
  it('runbookMissing：没填且没默认值的参数；密钥占位不算', () => {
    const r = { params: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B', default: '1' }], steps: [{ title: 't', kind: 'check' as const, command: 'echo {{a}} {{b}} {{secret:pw}}' }] }
    expect(runbookMissing(r, {})).toEqual(['a'])
    expect(runbookMissing(r, { a: 'x' })).toEqual([])
  })
  it('mergeStepRuns：第一个非 0 退出码为准，耗时累加；没拿到退出码的保持 undefined', () => {
    expect(mergeStepRuns([{ exitCode: 0, durationMs: 100 }, { exitCode: 2, durationMs: 50 }, { exitCode: 0, durationMs: 10 }])).toEqual({ exitCode: 2, durationMs: 160, lines: 3 })
    expect(mergeStepRuns([{ exitCode: 0, durationMs: 5 }])).toEqual({ exitCode: 0, durationMs: 5, lines: 1 })
    expect(mergeStepRuns([{ durationMs: 5 }]).exitCode).toBeUndefined()
  })
})
