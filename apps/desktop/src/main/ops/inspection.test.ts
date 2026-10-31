import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent, InspectionRun, InspectionSchedule } from '@lingshell/shared'
import { nextRunAt, isDue, parseInspectionStatus, unattendedDecide, buildInspectionPrompt, InspectionScheduler } from './inspection.js'
import { isReadOnlyCommand, neededForExec } from './readonlyCommand.js'

const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

describe('nextRunAt', () => {
  it('interval：锚点 + N 小时', () => {
    expect(nextRunAt({ kind: 'interval', hours: 6 }, 0)).toBe(6 * 3_600_000)
  })
  it('daily：当天未到点 → 当天；已过/恰好 → 次日', () => {
    const w = { kind: 'daily' as const, time: '09:30' }
    expect(nextRunAt(w, local(2026, 3, 1, 8, 0))).toBe(local(2026, 3, 1, 9, 30))
    expect(nextRunAt(w, local(2026, 3, 1, 9, 30))).toBe(local(2026, 3, 2, 9, 30))
    expect(nextRunAt(w, local(2026, 3, 31, 23, 0))).toBe(local(2026, 4, 1, 9, 30))   // 跨月
  })
})

describe('isDue', () => {
  const s: InspectionSchedule = { id: 's', name: 'n', prompt: 'p', targets: ['local'], when: { kind: 'daily', time: '09:00' }, enabled: true, createdAt: new Date(local(2026, 3, 1, 10, 0)).toISOString() }
  it('未到点不跑，到点跑，禁用不跑', () => {
    expect(isDue(s, local(2026, 3, 2, 8, 59))).toBe(false)
    expect(isDue(s, local(2026, 3, 2, 9, 0))).toBe(true)
    expect(isDue({ ...s, enabled: false }, local(2026, 3, 2, 9, 0))).toBe(false)
  })
  it('关机多天后启动：只补一次（以 lastRunAt 为锚）', () => {
    const last = new Date(local(2026, 3, 1, 9, 0)).toISOString()
    expect(isDue({ ...s, lastRunAt: last }, local(2026, 3, 5, 8, 0))).toBe(true)
    // 补跑后锚点更新为「现在」，当天 9 点前不再触发
    expect(isDue({ ...s, lastRunAt: new Date(local(2026, 3, 5, 8, 0)).toISOString() }, local(2026, 3, 5, 8, 30))).toBe(false)
  })
})

describe('parseInspectionStatus', () => {
  it.each([
    ['一切正常\n状态: 正常', 'normal'],
    ['磁盘 92%\n**状态：异常**', 'abnormal'],
    ['`状态: 正常`', 'normal'],
    ['先写状态：正常，后来发现问题\n状态: 异常', 'abnormal'],
    ['没写状态行', 'unknown'],
  ])('%s → %s', (text, want) => expect(parseInspectionStatus(text)).toBe(want))
})

describe('isReadOnlyCommand', () => {
  it.each([
    'df -h', 'df -h && free -m', 'ps aux --sort=-%mem | head -n 6',
    "tail -n 1000 /var/log/nginx/access.log | grep ' 5[0-9][0-9] '",
    'systemctl status nginx --no-pager', 'journalctl -u nginx -n 50 --no-pager',
    'echo | openssl s_client -connect a.com:443 -servername a.com 2>/dev/null | openssl x509 -noout -enddate',
    'ss -lntp | grep :80', 'lsof -i :8080', 'cat /etc/os-release; uptime', 'grep "error" /var/log/syslog 2>&1 | tail -n 20',
    'sort -rk4 f | uniq -c', 'top -bn1 | head -20', 'curl -sI https://a.com',
  ])('允许 %s', (c) => expect(isReadOnlyCommand(c)).toBe(true))
  it.each([
    'rm -rf /tmp/x', 'echo x > /etc/hosts', 'systemctl restart nginx', 'cat $(rm a)', 'cat `id`', 'df; rm a',
    'sudo df -h', 'find / -name x -delete', 'find / -exec rm {} ;', 'sort -o out in', 'bash -c "df"', "awk '{print}' f",
    'FOO=1 df', 'curl -o f https://a', 'df &', 'date -s 2020-01-01', 'hostname evil', 'kill 1', 'tail f >> g',
    'grep "$(id)" f', 'cat <(id)', 'sed -i s/a/b/ f', 'docker rm x', 'crontab -r', '', "echo 'unterminated",
    // 只读白名单的逃逸形式（能执行任意程序 / 写文件）
    'ip netns exec ns1 rm -rf /data', 'ip -batch /tmp/evil', 'sort --compress-program=/bin/sh f',
    'sort -T /tmp f', 'curl -c /tmp/cookies https://a.com', 'curl --trace /tmp/t https://a.com',
    'openssl s_client -keylogfile /tmp/k -connect a.com:443', 'file -C -m /tmp/magic',
  ])('拒绝 %s', (c) => expect(isReadOnlyCommand(c)).toBe(false))
  it('引号里的 > | ; 不当结构', () => {
    expect(isReadOnlyCommand("grep '>|;' f")).toBe(true)
  })
})

describe('unattendedDecide', () => {
  const t = new Set(['h1'])
  it('非目标主机拒；read 放行；只读 exec 放行；写命令拒；从不 prompt', () => {
    expect(unattendedDecide(t, 'local', 'read').kind).toBe('deny')
    expect(unattendedDecide(t, 'h1', 'read').kind).toBe('allow')
    expect(unattendedDecide(t, 'h1', 'write', 'df -h').kind).toBe('allow')
    expect(unattendedDecide(t, 'h1', 'write', 'reboot').kind).toBe('deny')
    expect(unattendedDecide(t, 'h1', 'write').kind).toBe('deny')   // upload_file 无 command
  })
})

describe('buildInspectionPrompt', () => {
  it('替换 {{主机}} 并列出终端与状态行要求', () => {
    const p = buildInspectionPrompt('n', '检查 {{主机}} 磁盘', [{ terminalId: 't1', label: 'web1' }])
    expect(p).toContain('检查 web1 磁盘')
    expect(p).toContain('terminal_id=t1')
    expect(p).toContain('状态: 正常')
  })
})

describe('InspectionScheduler.run', () => {
  it('跑完记录状态、收尾，异常时告警', async () => {
    const listeners = new Set<(ev: AgentEvent) => void>()
    const emit = (ev: AgentEvent) => listeners.forEach((h) => h(ev))
    const sched: InspectionSchedule = { id: 's1', name: 'n', prompt: 'p', targets: ['local'], when: { kind: 'interval', hours: 1 }, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' }
    const runs: InspectionRun[] = []
    const cleanup = vi.fn(async () => {})
    const alert = vi.fn()
    const marks: string[] = []
    const sc = new InspectionScheduler({
      list: () => [sched],
      markRun: (id) => { marks.push(id) },
      putRun: (r) => runs.push(r),
      prepare: async () => ({ sessionId: 'sess', terms: [{ terminalId: 't', label: '本地' }], cleanup }),
      sendTurn: async (sid) => {
        setTimeout(() => {
          emit({ type: 'agent:itemUpdated', sessionId: sid, turnId: 'u', itemId: 'i', kind: 'agent_message', status: 'completed', text: '磁盘满\n状态: 异常' })
          emit({ type: 'agent:turnCompleted', sessionId: sid, turnId: 'u' })
        }, 0)
      },
      interruptTurn: async () => {},
      onEvent: (h) => { listeners.add(h); return () => listeners.delete(h) },
      emitRun: () => {},
      alert,
      push: async () => { throw new Error('群A：HTTP 500') },   // 推送失败不影响巡检，只记 alertError
    })
    sc.tick(Date.parse('2026-01-01T02:00:00.000Z'))
    sc.tick(Date.parse('2026-01-01T02:00:00.000Z'))   // 已在队列，不重复
    await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runs[runs.length - 1].alertError).toBe('群A：HTTP 500'))
    expect(marks).toEqual(['s1'])
    const last = runs[runs.length - 1]
    expect(last.status).toBe('abnormal')
    expect(last.sessionId).toBe('sess')
    expect(last.finishedAt).toBeDefined()
    expect(cleanup).toHaveBeenCalled()
  })
})

describe('neededForExec：生产主机只读命令按读授权', () => {
  it('生产主机 + 只读命令 → read；写命令 / 非生产 / 无命令 → 原样', () => {
    expect(neededForExec('write', 'cat /etc/hosts | wc -l', true)).toBe('read')
    expect(neededForExec('write', 'ls -la /var/log', true)).toBe('read')
    expect(neededForExec('write', 'echo x > /tmp/a', true)).toBe('write')
    expect(neededForExec('write', 'sudo cat /etc/shadow', true)).toBe('write')
    expect(neededForExec('write', 'systemctl restart nginx', true)).toBe('write')
    expect(neededForExec('write', 'cat /etc/hosts', false)).toBe('write')
    expect(neededForExec('write', undefined, true)).toBe('write')
  })
})
