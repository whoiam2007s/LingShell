import { describe, it, expect } from 'vitest'
import {
  describeCron, cronNextRun, parseCron, parseCronLine, parseCronList, cronAppend, cronRemove, cronToggle, escapeCronPercent,
  parseCronGen, describeCalendar, describeMonotonic, parseCronRead, parseCronWrite, cronWriteCommand, fmtHostTime, cronAuditLabel, isCronExpr,
} from './cron.js'

describe('describeCron', () => {
  it.each([
    ['*/5 * * * *', '每 5 分钟'],
    ['* * * * *', '每分钟'],
    ['0 3 * * *', '每天 03:00'],
    ['30 9 * * 1-5', '工作日 09:30'],
    ['0 0 1 * *', '每月 1 日 00:00'],
    ['0 3 * * 1', '每周一 03:00'],
    ['0 3 * * mon,wed,fri', '每周一、三、五 03:00'],
    ['0 10 * * 6,0', '周末 10:00'],
    ['15 * * * *', '每小时第 15 分'],
    ['0 * * * *', '每小时整点'],
    ['0 */2 * * *', '每 2 小时整点'],
    ['*/30 9-18 * * 1-5', '工作日 9 点到 18 点每 30 分钟'],
    ['0 8,20 * * *', '每天 08:00、20:00'],
    ['0 0 1 1 *', '每年 1 月 1 日 00:00'],
    ['0 4 1,15 * *', '每月 1、15 日 04:00'],
    ['0/10 * * * *', '每 10 分钟'],
    ['*/5,10 * * * *', '每小时第 0、5、10、15、20、25、30、35、40、45、50、55 分'],   // 多段写法不能当「每分钟」
    ['@daily', '每天 00:00'],
    ['@midnight', '每天 00:00'],
    ['@hourly', '每小时整点'],
    ['@weekly', '每周日 00:00'],
    ['@monthly', '每月 1 日 00:00'],
    ['@yearly', '每年 1 月 1 日 00:00'],
    ['@reboot', '每次开机时'],
  ])('%s → %s', (e, s) => expect(describeCron(e)).toBe(s))
  it('看不懂的原样返回', () => {
    expect(describeCron('61 * * * *')).toBe('61 * * * *')
    expect(describeCron('a b')).toBe('a b')
    expect(isCronExpr('* * * *')).toBe(false)
    expect(() => parseCron('5-1 * * * *')).toThrow()
  })
  it('周 7 = 周日', () => expect(parseCron('0 0 * * 7').dow.set.has(0)).toBe(true))
})

describe('cronNextRun', () => {
  // 2026-10-17 是周六；东八区 10:15
  const now = Date.UTC(2026, 9, 17, 2, 15) / 1000
  const at = (expr: string) => { const t = cronNextRun(expr, now, 480); return t === undefined ? undefined : fmtHostTime(t, 480) }
  it('常见表达式', () => {
    expect(at('0 3 * * *')).toBe('10-18 03:00')
    expect(at('*/5 * * * *')).toBe('10-17 10:20')
    expect(at('30 9 * * 1-5')).toBe('10-19 09:30')   // 周六 → 下周一
    expect(at('0 0 1 * *')).toBe('11-01 00:00')
    expect(at('@hourly')).toBe('10-17 11:00')
    expect(at('0 12 * * *')).toBe('10-17 12:00')
    expect(at('@reboot')).toBeUndefined()
  })
  it('日、周都限定时取「或」', () => expect(at('0 0 31 * 1')).toBe('10-19 00:00'))
  it('2 月 30 日永远不会到', () => expect(cronNextRun('0 0 30 2 *', now, 0)).toBeUndefined())
  it('跨年显示年份', () => expect(fmtHostTime(Date.UTC(2027, 0, 1) / 1000, 0, now)).toBe('2027-01-01 00:00'))
})

describe('parseCronLine', () => {
  it('普通 / 宏 / 注释掉的 / 系统文件带用户', () => {
    expect(parseCronLine('*/5 * * * * /usr/bin/backup.sh --x', false)).toMatchObject({ schedule: '*/5 * * * *', command: '/usr/bin/backup.sh --x' })
    expect(parseCronLine('@daily  run-parts /etc/x', false)).toMatchObject({ schedule: '@daily', command: 'run-parts /etc/x' })
    expect(parseCronLine('# 0 3 * * * old.sh', false)).toMatchObject({ disabled: true, command: 'old.sh' })
    expect(parseCronLine('17 * * * * root cd / && run-parts --report /etc/cron.hourly', true)).toMatchObject({ user: 'root', command: 'cd / && run-parts --report /etc/cron.hourly' })
  })
  it('空行 / 说明注释 / 环境变量 / 表头不算任务', () => {
    for (const l of ['', '# m h  dom mon dow   command', 'SHELL=/bin/sh', 'MAILTO=""', '# 清理日志', '0 3 * * *']) expect(parseCronLine(l, false)).toBeNull()
    expect(parseCronLine('0 3 * * * root', true)).toBeNull()
  })
})

const LIST = [
  '@@me:alice', '@@uid:1000', '@@now:1792202100 +0800',
  '@@user', 'MAILTO=a@b.c', '# 备份', '0 3 * * * /opt/backup.sh', '# */10 * * * * /opt/old.sh', '', '@@rc:0',
  '@@rootdenied',
  '@@file:/etc/crontab', 'SHELL=/bin/sh', '17 * * * * root cd / && run-parts --report /etc/cron.hourly', '',
  '@@file:/etc/cron.d/php', '09,39 * * * * root [ -x /usr/lib/php/sessionclean ] && /usr/lib/php/sessionclean', '',
  '@@timers',
  'NEXT                         LEFT          LAST                         PASSED       UNIT                         ACTIVATES',
  'Sat 2026-10-17 12:00:00 CST  1h 44min left Sat 2026-10-17 00:00:00 CST  10h ago      logrotate.timer              logrotate.service',
  'n/a                          n/a           n/a                          n/a          snapd.snap-repair.timer      snapd.snap-repair.service',
  '', '2 timers listed.',
  '@@show',
  'Id=logrotate.timer', 'TimersCalendar={ OnCalendar=*-*-* 00:00:00 ; next_elapse=Sat 2026-10-18 00:00:00 CST }', 'TimersMonotonic=', '',
  'Id=snapd.snap-repair.timer', 'TimersCalendar=', 'TimersMonotonic={ OnUnitActiveSec=1d ; next_elapse=n/a }',
].join('\n')

describe('parseCronList', () => {
  it('分段解析', () => {
    const r = parseCronList(LIST)
    expect(r).toMatchObject({ user: 'alice', isRoot: false, rootDenied: true, now: 1792202100, tzOffsetMin: 480 })
    expect(r.userCrontab).toBe('MAILTO=a@b.c\n# 备份\n0 3 * * * /opt/backup.sh\n# */10 * * * * /opt/old.sh\n')
    expect(r.entries.map((e) => [e.source, e.line, e.schedule, e.user ?? '', !!e.disabled])).toEqual([
      ['user', 3, '0 3 * * *', '', false],
      ['user', 4, '*/10 * * * *', '', true],
      ['/etc/crontab', 2, '17 * * * *', 'root', false],
      ['/etc/cron.d/php', 1, '09,39 * * * *', 'root', false],
    ])
    expect(r.timers).toEqual([
      { unit: 'logrotate.timer', activates: 'logrotate.service', next: 'Sat 2026-10-17 12:00:00 CST', left: '1h 44min left', last: 'Sat 2026-10-17 00:00:00 CST', calendar: 'OnCalendar=*-*-* 00:00:00' },
      { unit: 'snapd.snap-repair.timer', activates: 'snapd.snap-repair.service', next: undefined, left: undefined, last: undefined, monotonic: 'OnUnitActiveSec=1d' },
    ])
  })
  it('没有 crontab：rc 非 0', () => {
    const r = parseCronList('@@me:root\n@@uid:0\n@@now:1 +0000\n@@user\n\n@@rc:1\n@@notimers')
    expect(r.userCrontab).toBeUndefined()
    expect(r.entries).toEqual([])
    expect(r.isRoot).toBe(true)
    expect(r.noTimers).toBe(true)
  })
  it('主机时区：+0800 和 +08:00 都认，负偏移也对', () => {
    expect(parseCronList('@@me:u\n@@uid:1\n@@now:1 +08:00\n@@user\n\n@@rc:1').tzOffsetMin).toBe(480)
    expect(parseCronList('@@me:u\n@@uid:1\n@@now:1 -0530\n@@user\n\n@@rc:1').tzOffsetMin).toBe(-330)
    expect(parseCronList('@@me:u\n@@uid:1\n@@now:1\n@@user\n\n@@rc:1').tzOffsetMin).toBe(0)
  })
})

describe('systemd 定时器翻人话', () => {
  it.each([
    ['OnCalendar=daily', '每天 00:00'],
    ['OnCalendar=*-*-* 03:00:00', '每天 03:00'],
    ['OnCalendar=Mon..Fri *-*-* 09:30:00', '工作日 09:30'],
    ['OnCalendar=*:0/15', '每 15 分钟'],
    ['OnCalendar=Sun *-*-* 04:00:00', '每周日 04:00'],
    ['OnCalendar=*-*-01 06:00:00', '每月 1 日 06:00'],
    ['OnCalendar=*-*-* 06,18:00:00', '每天 06:00、18:00'],
    ['OnCalendar=weird', 'weird'],
  ])('%s → %s', (s, t) => expect(describeCalendar(s)).toBe(t))
  it('单调定时器', () => expect(describeMonotonic('OnBootSec=15min; OnUnitActiveSec=1d')).toBe('开机后 15min；上次运行后每 1d'))
})

describe('编辑 crontab', () => {
  const text = 'MAILTO=x\n0 3 * * * /a.sh\n*/5 * * * * /b.sh\n'
  it('追加：带说明注释、% 转义、补末尾换行', () => {
    expect(cronAppend('0 1 * * * x', '0 2 * * *', 'date +%F > /tmp/d', '记日期')).toBe('0 1 * * * x\n# 记日期\n0 2 * * * date +\\%F > /tmp/d\n')
    expect(cronAppend('', '@daily', '/c.sh')).toBe('@daily /c.sh\n')
    expect(() => cronAppend(text, '99 * * * *', 'x')).toThrow('不合法')
    expect(() => cronAppend(text, '* * * * *', 'a\nb')).toThrow('一行')
    expect(escapeCronPercent('a \\% b % c')).toBe('a \\% b \\% c')
  })
  it('删除 / 注释 / 恢复；原文对不上拒绝', () => {
    expect(cronRemove(text, 2, '0 3 * * * /a.sh')).toBe('MAILTO=x\n*/5 * * * * /b.sh\n')
    const off = cronToggle(text, 3, '*/5 * * * * /b.sh', true)
    expect(off).toBe('MAILTO=x\n0 3 * * * /a.sh\n# */5 * * * * /b.sh\n')
    expect(cronToggle(off, 3, '# */5 * * * * /b.sh', false)).toBe(text)
    expect(() => cronRemove(text, 2, '0 4 * * * /a.sh')).toThrow('已被改动')
  })
  it('读回 / 写回命令与输出', () => {
    expect(parseCronRead('0 3 * * * x\n\n@@rc:0\n')).toBe('0 3 * * * x\n')
    expect(parseCronRead('\n@@rc:1')).toBe('')
    expect(() => parseCronRead('oops')).toThrow()
    const cmd = cronWriteCommand('0 3 * * * 中文\n', '20261017-1_crontab')
    expect(cmd).toContain(btoa(String.fromCharCode(...new TextEncoder().encode('0 3 * * * 中文\n'))))
    expect(cmd).toContain('.lingshell/backups')
    expect(() => cronWriteCommand('x', '../a')).toThrow()
    expect(parseCronWrite('@@backup:/home/u/.lingshell/backups/x\n@@rc:0\n')).toEqual({ rc: 0, backup: '/home/u/.lingshell/backups/x', text: '' })
    expect(parseCronWrite('@@backup:\n"-":1: bad minute\n@@rc:1')).toEqual({ rc: 1, text: '"-":1: bad minute' })
  })
  it('执行记录标签', () => {
    expect(cronAuditLabel('cron_add')).toBe('定时任务·新增（手动）')
    expect(cronAuditLabel('cron_x')).toBeUndefined()
  })
})

describe('parseCronGen', () => {
  it('JSON（含代码块 / think）', () => {
    expect(parseCronGen('<think>x</think>```json\n{"schedule":"0 3 * * *","command":"find /tmp -mtime +7 -delete","explain":"每天凌晨 3 点清理"}\n```'))
      .toEqual({ schedule: '0 3 * * *', command: 'find /tmp -mtime +7 -delete', explain: '每天凌晨 3 点清理' })
  })
  it('拒绝 / 不合法', () => {
    expect(parseCronGen('{"error":"不是定时任务"}')).toEqual({ error: '不是定时任务' })
    expect(parseCronGen('随便说点')).toHaveProperty('error')
    expect(parseCronGen('{"schedule":"0 25 * * *","command":"x"}')).toHaveProperty('error')
    expect(parseCronGen('{"schedule":"0 1 * * *","command":"a\\nb"}')).toHaveProperty('error')
  })
})
