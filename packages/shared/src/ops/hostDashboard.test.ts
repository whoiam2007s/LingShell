import { describe, it, expect } from 'vitest'
import { Ring, dashAskText, dashOnline, dashProblems, dashSummary, dashboardCommand, latestOf, parseDashSample, pointFromStats, sortDashCards, worstMount, type DashOnline } from './hostDashboard.js'

// 一次采样的完整输出（Ubuntu 风格；前面带登录横幅）
const OUT = `Last login: Mon
@@stat1
cpu  100 0 100 800 0 0 0 0 0 0
@@stat2
cpu  150 0 150 900 0 0 0 0 0 0
@@mem
MemTotal:       16000000 kB
MemAvailable:    4000000 kB
@@load
1.50 0.80 0.60 2/300 999
@@cores
4
@@dfall
Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1        100000000 40000000  60000000      40% /
/dev/sdb1        200000000 180000000 20000000      90% /data
/dev/sdc1                0        0         0       -  /mnt/empty
@@failed
nginx.service loaded failed failed The nginx HTTP server
cron.service  loaded failed failed Regular background program
@@failedok
@@docker
running
exited
running
@@dockerok
`

describe('parseDashSample', () => {
  it('一次输出解析出全部指标；磁盘取最满的挂载点', () => {
    expect(parseDashSample(OUT, 1000)).toEqual({
      at: 1000, cpu: 50, mem: 75, load1: 1.5, cores: 4,
      disk: 90, diskMount: '/data', failed: 2, ctRunning: 2, ctTotal: 3,
    })
  })
  it('没有 systemctl / docker（或没权限）时不出数，而不是当成 0；失败服务 0 个 / 没有容器是 0', () => {
    const noTools = OUT.replace(/@@failedok\n/, '').replace(/@@dockerok\n/, '')
    const p = parseDashSample(noTools, 1)
    expect(p.failed).toBeUndefined()
    expect(p.ctTotal).toBeUndefined()
    const empty = OUT.replace(/@@failed\n[\s\S]*?@@failedok/, '@@failed\n@@failedok').replace(/@@docker\n[\s\S]*?@@dockerok/, '@@docker\n@@dockerok')
    expect(parseDashSample(empty, 1)).toMatchObject({ failed: 0, ctRunning: 0, ctTotal: 0 })
  })
  it('超时截断（只到磁盘）也用已收到的；什么都没有则抛错', () => {
    const cut = OUT.slice(0, OUT.indexOf('@@failed'))
    expect(parseDashSample(cut, 1)).toMatchObject({ cpu: 50, disk: 90 })
    expect(() => parseDashSample('bash: sh: not found\n', 1)).toThrow('stats_parse_failed')
    expect(parseDashSample('@@dfall\n/dev/x 100 86 14 86% /\n', 1)).toMatchObject({ disk: 86, diskMount: '/' })
  })
  it('worstMount：挂载点含空格；没有数据行 → undefined', () => {
    expect(worstMount('/dev/a 100 10 90 10% /mnt/my disk\n')).toEqual({ pct: 10, mount: '/mnt/my disk' })
    expect(worstMount('Filesystem 1024-blocks Used Available Capacity Mounted on\n')).toBeUndefined()
  })
  it('命令只读、整体交给 sh -c，含 df / systemctl / docker', () => {
    const c = dashboardCommand()
    expect(c.startsWith("sh -c '")).toBe(true)
    for (const s of ['/proc/stat', 'df -Pk', 'systemctl list-units --state=failed', 'docker ps -a']) expect(c).toContain(s)
    expect(c).not.toMatch(/(^|[^2])>\s*[^&/]/)   // 没有写文件重定向（只有 2>/dev/null）
  })
})

describe('Ring', () => {
  it('满了丢最旧的，保持顺序', () => {
    const r = new Ring<number>(3)
    for (let i = 1; i <= 5; i++) r.push(i)
    expect(r.toArray()).toEqual([3, 4, 5])
    expect(r.size).toBe(3)
    expect(r.last()).toBe(5)
    expect(new Ring<number>().cap).toBe(60)
  })
})

describe('latestOf / pointFromStats', () => {
  it('每项取最近有值的；状态标签样本只带 CPU / 内存 / 负载', () => {
    const a = parseDashSample(OUT, 1)
    const b = pointFromStats({ at: 2, cpuPct: 12, memUsed: 1, memTotal: 4, load: [0.5, 0, 0], cores: 4, diskPct: 10 })
    expect(b).toEqual({ at: 2, cpu: 12, mem: 25, load1: 0.5, cores: 4 })
    expect(latestOf([a, b])).toMatchObject({ at: 2, cpu: 12, mem: 25, disk: 90, diskMount: '/data', failed: 2, ctTotal: 3 })
    expect(latestOf([])).toEqual({})
  })
})

describe('异常判定与排序', () => {
  it('阈值：CPU / 内存 > 90、磁盘 > 85、有失败服务、看门狗报警中', () => {
    expect(dashProblems({ cpu: 90, mem: 90, disk: 85, failed: 0 })).toEqual([])
    expect(dashProblems({ cpu: 91, mem: 95, disk: 86, diskMount: '/data', failed: 1 }, 2))
      .toEqual(['CPU 91%', '内存 95%', '磁盘 /data 86%', '1 个失败服务', '看门狗报警中 ×2'])
    expect(dashProblems({}, 1)).toEqual(['看门狗报警中'])
  })
  it('异常在前（原因多的更前）→ 生产 → 在线 → 名称', () => {
    const c = (label: string, problems: number, online: DashOnline, prod = false) => ({ label, problems: Array(problems).fill('x'), online, prod })
    const sorted = sortDashCards([c('b', 0, 'idle'), c('a', 0, 'connected'), c('z', 1, 'idle'), c('y', 2, 'idle'), c('p', 0, 'idle', true), c('c', 0, 'reachable')])
    expect(sorted.map((x) => x.label)).toEqual(['y', 'z', 'p', 'a', 'c', 'b'])
    expect(dashSummary(sorted)).toEqual({ total: 6, online: 2, abnormal: 2, prod: 1 })
  })
  it('在线判定', () => {
    expect(dashOnline({ connected: true, error: 'x' }, 30, 0)).toBe('connected')
    expect(dashOnline({ connected: false, error: 'x', lastOkAt: 0 }, 30, 0)).toBe('error')
    expect(dashOnline({ connected: false, lastOkAt: 0 }, 30, 90_000)).toBe('reachable')
    expect(dashOnline({ connected: false, lastOkAt: 0 }, 30, 90_001)).toBe('idle')
    expect(dashOnline({ connected: false }, 30, 0)).toBe('idle')
  })
  it('问 AI 的消息带主机 id、指标、异常、告警、体检', () => {
    const t = dashAskText({ id: 'h1', label: 'web-1', group: 'web', env: 'prod' }, latestOf([parseDashSample(OUT, 1)]),
      { problems: ['磁盘 /data 90%'], alerts: ['告警：OOM'], lastCheck: { at: '2026-10-15 10:00', issues: 3 } })
    expect(t).toContain('主机 id：h1，分组 web，生产环境')
    expect(t).toContain('CPU 50%（4 核）；内存 75%；磁盘最满 /data 90%；负载 1.50；失败服务 2；容器 2/3 运行')
    expect(t).toContain('异常：磁盘 /data 90%')
    expect(t).toContain('最近告警：告警：OOM')
    expect(t).toContain('发现 3 个问题')
  })
})
