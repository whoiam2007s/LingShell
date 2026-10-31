import { describe, expect, it } from 'vitest'
import {
  buildProcTree, compareProcs, filterProcs, fmtRss, isKillablePid, parseEtime, parsePs, parseRss, parseSignalResult, procAuditCommand, procQuote,
  processListCommand, processSignalCommand, processSupported, sortProcs, type ProcRow,
} from './processes.js'

// GNU procps：ps -eo pid,ppid,user:32,pcpu,pmem,rss,etime,stat,args --sort=-pcpu
const GNU =`    PID    PPID USER                             %CPU %MEM   RSS     ELAPSED STAT COMMAND
   2201       1 mysql                            12.5  8.1 663040  3-04:05:06 Ssl  /usr/sbin/mysqld --basedir=/usr
   1300       1 root                              1.0  0.3 24576    01:02:03 Ss   nginx: master process /usr/sbin/nginx -g daemon on;
   1301    1300 www-data                          0.5  0.2 16384    01:02:03 S    nginx: worker process
      1       0 root                              0.0  0.1 12288 10-00:00:00 Ss   /sbin/init splash
      2       0 root                              0.0  0.0     0 10-00:00:00 S    [kthreadd]
   4242    1301 www-data                          0.0  0.0     0       00:05 Z    [php] <defunct>
`
// macOS：ps -axr -o pid,ppid,user,pcpu,pmem,rss,etime,stat,args
const MAC = `  PID  PPID USER              %CPU %MEM    RSS     ELAPSED STAT ARGS
  412     1 _windowserver     23.4  1.2 201234 02-01:00:00 Ss   /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  999     1 me                 3,5  0.4  65536       12:34 S    /Applications/Visual Studio Code.app/Contents/MacOS/Electron
`
// busybox：ps -o pid,ppid,user,rss,etime,stat,args（无 %CPU / %MEM；RSS 带单位）
const BUSYBOX = `PID   PPID  USER     RSS  ELAPSED STAT COMMAND
    1     0 root      412  1d     S    init
  123     1 root     1.2m  3h     S    /sbin/syslogd -n
  456   123 admin    2560  12:05  R    sh -c sleep 100
`
// 老 busybox 裸 ps：PID Uid VSZ Stat Command（大小写混写，没有 PPID）
const OLD_BUSYBOX = `  PID  Uid        VSZ Stat Command
    1 root       1472 S   init
  101 root       1456 S < /sbin/udhcpc -i eth0
`

describe('parsePs', () => {
  it('GNU：各列 + 命令行里的空格保留', () => {
    const r = parsePs(GNU)
    expect(r.hasCpu).toBe(true)
    expect(r.rows).toHaveLength(6)
    expect(r.rows[0]).toEqual({ pid: 2201, ppid: 1, user: 'mysql', cpu: 12.5, mem: 8.1, rss: 663040, etime: '3-04:05:06', elapsed: 3 * 86400 + 4 * 3600 + 5 * 60 + 6, stat: 'Ssl', command: '/usr/sbin/mysqld --basedir=/usr' })
    expect(r.rows[1].command).toBe('nginx: master process /usr/sbin/nginx -g daemon on;')
    expect(r.rows[5]).toMatchObject({ pid: 4242, stat: 'Z', command: '[php] <defunct>', elapsed: 5 })
  })
  it('macOS：ARGS 表头、逗号小数、带空格的路径', () => {
    const r = parsePs(MAC)
    expect(r.rows.map((x) => x.pid)).toEqual([412, 999])
    expect(r.rows[1]).toMatchObject({ cpu: 3.5, user: 'me', command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', elapsed: 754 })
  })
  it('busybox：无 CPU 列，RSS 单位 / 简写时长', () => {
    const r = parsePs(BUSYBOX)
    expect(r.hasCpu).toBe(false)
    expect(r.rows[0]).toMatchObject({ pid: 1, ppid: 0, user: 'root', rss: 412, etime: '1d', elapsed: 86400 })
    expect(r.rows[0].cpu).toBeUndefined()
    expect(r.rows[1]).toMatchObject({ rss: Math.round(1.2 * 1024), elapsed: 3 * 3600, command: '/sbin/syslogd -n' })
    expect(r.rows[2]).toMatchObject({ pid: 456, ppid: 123, user: 'admin', stat: 'R', command: 'sh -c sleep 100' })
  })
  it('老 busybox 大小写混写表头：未知列忽略', () => {
    const r = parsePs(OLD_BUSYBOX)
    expect(r.rows).toEqual([
      { pid: 1, user: 'root', etime: '', stat: 'S', command: 'init' },
      { pid: 101, user: 'root', etime: '', stat: 'S', command: '< /sbin/udhcpc -i eth0' },   // 两段式状态被当成命令开头，不影响 pid
    ])
  })
  it('登录横幅、截断行、空输出', () => {
    expect(parsePs(`Welcome!\n${GNU}garbage line\n`).rows).toHaveLength(6)
    expect(parsePs('')).toEqual({ rows: [], hasCpu: false, truncated: false })
    expect(parsePs('sh: ps: not found\n').rows).toEqual([])
  })
  it('恰好 500 行不算截断，超过才标记并只留 500', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i + 2} 1 root 0.0 0.0 1 00:01 S x`).join('\n')
    const head = 'PID PPID USER %CPU %MEM RSS ELAPSED STAT COMMAND\n'
    expect(parsePs(head + rows(500))).toMatchObject({ truncated: false })
    expect(parsePs(head + rows(500)).rows).toHaveLength(500)
    const over = parsePs(head + rows(501))
    expect(over.truncated).toBe(true)
    expect(over.rows).toHaveLength(500)
  })
})

describe('小工具', () => {
  it('parseEtime / parseRss / fmtRss', () => {
    expect(parseEtime('05')).toBeUndefined()
    expect(parseEtime('00:05')).toBe(5)
    expect(parseEtime('1:00:00')).toBe(3600)
    expect(parseEtime('2-00:00:01')).toBe(172801)
    expect(parseEtime('?')).toBeUndefined()
    expect(parseRss('2g')).toBe(2 * 1024 * 1024)
    expect(parseRss('-')).toBeUndefined()
    expect([fmtRss(undefined), fmtRss(512), fmtRss(2048), fmtRss(663040), fmtRss(3 * 1024 * 1024)]).toEqual(['—', '512 K', '2.0 M', '648 M', '3.0 G'])
  })
  it('支持判定 / pid 校验', () => {
    expect(processSupported('ssh', 'linux')).toBe(true)
    expect(processSupported('ssh', 'unknown')).toBe(true)
    expect(processSupported('ssh', 'windows')).toBe(false)
    expect(processSupported('local', 'linux')).toBe(false)
    expect([isKillablePid(2), isKillablePid(1), isKillablePid(0), isKillablePid(1.5), isKillablePid('5'), isKillablePid(2 ** 31)]).toEqual([true, false, false, false, false, false])
  })
  it('命令：ps 降级链 / kill 只接受合法 pid 与信号', () => {
    const c = processListCommand()
    expect(c).toMatch(/^sh -c '/)
    for (const s of ['--sort=-pcpu', '-axr -o', '-o pid,ppid,user,rss,etime,stat,args', 'head -n 502']) expect(c).toContain(s)
    expect(processSignalCommand(1234, 'KILL')).toBe(`sh -c 'export LC_ALL=C; kill -KILL 1234 2>&1; echo "@@rc:$?"'`)
    expect(() => processSignalCommand(1, 'TERM')).toThrow()
    expect(() => processSignalCommand(5, 'INT' as never)).toThrow()
  })
  it('退出码拆分 / 执行记录文本 / 问 AI 引用', () => {
    expect(parseSignalResult('@@rc:0\n')).toEqual({ rc: 0, message: '' })
    expect(parseSignalResult('sh: kill: (5) - Operation not permitted\n@@rc:1')).toEqual({ rc: 1, message: 'sh: kill: (5) - Operation not permitted' })
    expect(parseSignalResult('cut off')).toEqual({ message: 'cut off' })
    expect(procAuditCommand(1300, 'TERM', 'nginx: master\nprocess\x1b[0m')).toBe('kill -TERM 1300  # nginx: master process [0m')
    expect(procAuditCommand(9, 'HUP', '')).toBe('kill -HUP 9')
    const q = procQuote('root@web', parsePs(GNU).rows[0])
    expect(q).toContain('终端「root@web」')
    expect(q).toContain('PID 2201（父进程 1） · 用户 mysql · CPU 12.5% · 内存 8.1% · RSS 648 M · 已运行 3-04:05:06 · 状态 Ssl')
    expect(q).toContain('/usr/sbin/mysqld --basedir=/usr')
    expect(procQuote('t', parsePs(BUSYBOX).rows[2])).not.toContain('CPU')
  })
})

describe('排序 / 过滤 / 树', () => {
  const rows = parsePs(GNU).rows
  it('数值 / 字符串排序，缺值永远在后', () => {
    expect(sortProcs(rows, 'cpu', true).map((r) => r.pid).slice(0, 3)).toEqual([2201, 1300, 1301])
    expect(sortProcs(rows, 'pid', false).map((r) => r.pid)).toEqual([1, 2, 1300, 1301, 2201, 4242])
    expect(sortProcs(rows, 'user', false)[0].user).toBe('mysql')
    expect(sortProcs(rows, 'elapsed', true)[0].pid).toBe(1)   // 同为 10 天按 pid
    const bb = parsePs(OLD_BUSYBOX).rows
    expect(sortProcs([...bb, rows[0]], 'cpu', false)[0].pid).toBe(2201)
    expect(sortProcs([...bb, rows[0]], 'cpu', true)[0].pid).toBe(2201)
  })
  it('过滤：命令 / 用户 / pid，多词都要命中，不分大小写', () => {
    expect(filterProcs(rows, 'NGINX').map((r) => r.pid)).toEqual([1300, 1301])
    expect(filterProcs(rows, 'www-data worker').map((r) => r.pid)).toEqual([1301])
    expect(filterProcs(rows, '4242').map((r) => r.pid)).toEqual([4242])
    expect(filterProcs(rows, '  ')).toBe(rows)
  })
  it('树形：按 ppid 缩进，父不在列表的当根', () => {
    const t = buildProcTree(rows, compareProcs('pid', false))
    expect(t.map((x) => `${'.'.repeat(x.depth)}${x.row.pid}`)).toEqual(['1', '.1300', '..1301', '...4242', '.2201', '2'])
    expect(t.find((x) => x.row.pid === 1301)?.hasChildren).toBe(true)
  })
  it('树形 + 过滤：保留命中项与祖先链', () => {
    const t = buildProcTree(rows, compareProcs('pid', false), 'defunct')
    expect(t.map((x) => `${x.depth}:${x.row.pid}`)).toEqual(['0:1', '1:1300', '2:1301', '3:4242'])
  })
  it('树形：自己是自己父进程 / 环 不死循环', () => {
    const a: ProcRow = { pid: 10, ppid: 11, user: 'u', etime: '', stat: '', command: 'a' }
    const b: ProcRow = { pid: 11, ppid: 10, user: 'u', etime: '', stat: '', command: 'b' }
    const c: ProcRow = { pid: 12, ppid: 12, user: 'u', etime: '', stat: '', command: 'c' }
    const t = buildProcTree([a, b, c], compareProcs('pid', false))
    expect(t.map((x) => `${x.depth}:${x.row.pid}`)).toEqual(['0:12', '0:10', '1:11'])   // 环上的两个没有根：补成根，不丢不卡死
  })
})
