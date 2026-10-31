import { describe, it, expect } from 'vitest'
import { fmtRate, ioRates, parseDiskstats, parseNetDev, parseNetstatE, scaleToPct, cpuPercent,fmtBytes, fmtUptime, hostStatsCommand, hostStatsDelay, loadPct, memPct, parseDf, parseLinuxStats, parseMacStats, parseProcStatCpu, sparkPoints, statsSummary, statsSupported } from './hostStats.js'

// 真机输出样本（Ubuntu 22.04）；前面带一段登录横幅，验证不会串进数据
const LINUX = `Welcome to Ubuntu 22.04.4 LTS
@@stat1
cpu  10132153 290696 3084719 46828483 16683 0 25195 0 175628 0
@@stat2
cpu  10132253 290696 3084769 46828833 16683 0 25195 0 175628 0
@@mem
MemTotal:       16303428 kB
MemFree:         1084348 kB
MemAvailable:    9874236 kB
Buffers:          526568 kB
Cached:          7964132 kB
SwapCached:            0 kB
Active(anon):    3245112 kB
@@df
Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1        102626232 45234104  52133864      47% /
@@load
0.52 0.58 0.59 1/389 12345
@@up
350735.47 234388.90
@@cores
8
`

// 真机输出样本（macOS 14，Apple Silicon，16K 页）
const MAC = `@@cpu
CPU usage: 5.17% user, 7.75% sys, 87.6% idle
@@memsize
17179869184
@@vm
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3539.
Pages active:                            228426.
Pages inactive:                          226385.
Pages speculative:                         2015.
Pages throttled:                              0.
Pages wired down:                        124575.
Pages purgeable:                          10493.
"Translation faults":                 1033395838.
Pages copy-on-write:                   33459063.
File-backed pages:                       187418.
Anonymous pages:                         269408.
Pages stored in compressor:              524834.
Pages occupied by compressor:            172412.
@@df
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5     482797652 312345678 150123456    68%    /System/Volumes/Data
@@load
{ 1.93 2.10 2.27 }
@@boot
{ sec = 1760000000, usec = 123456 } Thu Oct  9 16:53:20 2025
@@now
1760350000
@@cores
10
`

describe('Linux 解析', () => {
  it('真机样本：CPU 差值 / 内存按 MemAvailable / 根分区 / 负载 / 运行时间 / 核数', () => {
    const s = parseLinuxStats(LINUX, 1)
    expect(s).toEqual({
      at: 1, cpuPct: 30,   // Δtotal=500，Δidle(idle+iowait)=350
      memTotal: 16303428 * 1024, memUsed: (16303428 - 9874236) * 1024,
      diskPct: 46.5, diskUsed: 45234104 * 1024, diskTotal: 102626232 * 1024,
      load: [0.52, 0.58, 0.59], uptimeSec: 350735, cores: 8,
    })
  })
  it('老内核无 MemAvailable：回落 Free + Buffers + Cached', () => {
    const s = parseLinuxStats(LINUX.replace(/^MemAvailable:.*\n/m, ''), 1)
    expect(s.memUsed).toBe((16303428 - 1084348 - 526568 - 7964132) * 1024)
  })
  it('只拿到部分段（如 sleep 失败只有一次 /proc/stat）也能出其它项', () => {
    const s = parseLinuxStats(LINUX.replace(/@@stat2\n.*\n/, ''), 1)
    expect(s.cpuPct).toBeUndefined()
    expect(s.diskPct).toBe(46.5)
  })
  it('完全不像（命令不存在 / 输出被截）→ 抛错当失败', () => {
    expect(() => parseLinuxStats('sh: not found\n', 1)).toThrow('stats_parse_failed')
    expect(() => parseLinuxStats('', 1)).toThrow()
  })
})

describe('macOS 解析', () => {
  it('真机样本：top 的 idle / vm_stat 已用(App+wired+压缩) / Data 卷 / {负载} / boottime', () => {
    const s = parseMacStats(MAC, 2)
    expect(s).toEqual({
      at: 2, cpuPct: 12.4,
      memTotal: 17179869184, memUsed: (269408 - 10493 + 124575 + 172412) * 16384,
      diskPct: 67.5, diskUsed: 312345678 * 1024, diskTotal: 482797652 * 1024,
      load: [1.93, 2.1, 2.27], uptimeSec: 350000, cores: 10,
    })
  })
  it('无 Anonymous pages 的老系统：用 active 近似', () => {
    const s = parseMacStats(MAC.replace(/^Anonymous pages:.*\n/m, ''), 2)
    expect(s.memUsed).toBe((228426 + 124575 + 172412) * 16384)
  })
})

describe('CPU 差值', () => {
  it('cpuPercent：正常 / 计数没动 / 回绕', () => {
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50)
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeUndefined()
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 10, total: 20 })).toBeUndefined()
  })
  it('/proc/stat 只取前 8 列（guest 已含在 user），idle 含 iowait', () => {
    expect(parseProcStatCpu('cpu  1 2 3 4 5 6 7 8 100 100\n')).toEqual({ idle: 9, total: 36 })
    expect(parseProcStatCpu('cpu0 1 2 3 4\n')).toBeUndefined()   // 单核行不算
  })
})

describe('df / 命令 / 展示', () => {
  it('df：无数据行 → 空；Capacity 跟 df 一致按 used/(used+avail)', () => {
    expect(parseDf('df: /: No such file\n')).toEqual({})
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 50 30 63% /\n').diskPct).toBe(62.5)
  })
  it('命令：整体 sh -c 单引号包裹、内部无单引号（csh/fish 登录 shell 也能跑），只读', () => {
    for (const os of ['linux', 'macos'] as const) {
      const c = hostStatsCommand(os)
      expect(c.startsWith("sh -c '")).toBe(true)
      expect(c.split("'").length).toBe(3)
      expect(c).not.toMatch(/\b(rm|kill|reboot|>\s*\/(?!dev\/null))/)
    }
  })
  it('支持范围：本地都行；SSH 只 Linux / macOS', () => {
    expect(statsSupported('local', 'windows')).toBe(true)
    expect(statsSupported('ssh', 'linux')).toBe(true)
    expect(statsSupported('ssh', 'macos')).toBe(true)
    expect(statsSupported('ssh', 'windows')).toBe(false)
    expect(statsSupported('ssh', 'unknown')).toBe(false)
    expect(statsSupported('ssh', undefined)).toBe(false)
  })
  it('间隔：最小 5s、生产 ×3、失败指数退避封顶 5 分钟', () => {
    expect(hostStatsDelay(10, false, 0)).toBe(10_000)
    expect(hostStatsDelay(1, false, 0)).toBe(5_000)
    expect(hostStatsDelay(10, true, 0)).toBe(30_000)
    expect(hostStatsDelay(10, false, 2)).toBe(40_000)
    expect(hostStatsDelay(10, false, 20)).toBe(300_000)
  })
  it('格式化 + 摘要 + 折线', () => {
    expect(fmtBytes(16303428 * 1024)).toBe('15.5G')
    expect(fmtBytes(512)).toBe('512B')
    expect(fmtUptime(350735)).toBe('4 天 1 小时')
    expect(fmtUptime(3700)).toBe('1 小时 1 分')
    const s = parseLinuxStats(LINUX, 1)
    expect(memPct(s)).toBe(39.4)
    expect(loadPct(s)).toBe(6.5)
    expect(statsSummary(s)).toBe('CPU 30% · 内存 39% · 磁盘 47% · 负载 0.52 0.58 0.59')
    expect(sparkPoints([0, undefined, 100], 10, 10)).toBe('0,10 10,0')
    expect(sparkPoints([50], 10, 10)).toBe('')
  })
})

describe('网络 / 磁盘 IO', () => {
  const NET = (eth0: [number, number], docker0: [number, number]) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 10 0 0 0 0 0 0 9999 10 0 0 0 0 0 0
  eth0:${eth0[0]} 10 0 0 0 0 0 0 ${eth0[1]} 10 0 0 0 0 0 0
docker0: ${docker0[0]} 10 0 0 0 0 0 0 ${docker0[1]} 10 0 0 0 0 0 0
`
  const IO = (sda: [number, number]) => `   8       0 sda 100 0 ${sda[0]} 0 50 0 ${sda[1]} 0 0 0 0
   8       1 sda1 100 0 ${sda[0]} 0 50 0 ${sda[1]} 0 0 0 0
   7       0 loop0 5 0 4000 0 0 0 0 0 0 0 0
 253       0 dm-0 100 0 ${sda[0]} 0 50 0 ${sda[1]} 0 0 0 0
`
  // 假 exec 输出：前后两份 /proc 内容 + uptime（间隔 0.5s）
  const out = LINUX.replace('@@stat1', `@@t1\n100.00 1.0\n@@net1\n${NET([1000, 2000], [0, 0])}@@io1\n${IO([0, 0])}@@stat1`)
    .replace('@@stat2', `@@t2\n100.50 1.0\n@@net2\n${NET([1000 + 51200, 2000 + 1024], [500, 500])}@@io2\n${IO([2048, 4096])}@@vnet\nlo\ndocker0\n@@blk\nsda\nloop0\ndm-0\n@@vblk\nloop0\ndm-0\n@@stat2`)
  it('Linux：两次采样差 / 实际间隔 → 速率；排除 lo，虚拟网卡不进合计；分区 / loop / dm 不重复计', () => {
    const s = parseLinuxStats(out, 1)
    expect(s.netRx).toBe(102400)   // 51200 B / 0.5s
    expect(s.netTx).toBe(2048)
    expect(s.nets).toEqual([{ name: 'eth0', rx: 102400, tx: 2048 }, { name: 'docker0', rx: 1000, tx: 1000, virtual: true }])
    expect(s.diskRead).toBe(2048 * 512 * 2)
    expect(s.diskWrite).toBe(4096 * 512 * 2)
    expect(s.cpuPct).toBe(30)   // 原有项不受影响
  })
  it('没有 uptime 段（采集不全）→ 不出速率；计数回绕的项跳过', () => {
    expect(parseLinuxStats(LINUX, 1).netRx).toBeUndefined()
    const r = ioRates({ net: { eth0: { rx: 100, tx: 100 } } }, { net: { eth0: { rx: 50, tx: 200 } } }, 1)
    expect(r.netRx).toBeUndefined()
    expect(ioRates({}, {}, 0)).toEqual({})
  })
  it('容器里只有虚拟网卡：全算；拿不到 /sys/block 时按整盘名认', () => {
    const r = ioRates(
      { net: { eth0: { rx: 0, tx: 0 } }, disk: { vda: { read: 0, write: 0 }, vda1: { read: 0, write: 0 } } },
      { net: { eth0: { rx: 10, tx: 20 } }, disk: { vda: { read: 100, write: 200 }, vda1: { read: 100, write: 200 } } },
      1, { vnet: ['eth0'] })
    expect([r.netRx, r.netTx, r.diskRead, r.diskWrite]).toEqual([10, 20, 100, 200])
  })
  it('解析：/proc/net/dev 冒号后无空格；Windows netstat -e 按形状认（中文系统）', () => {
    expect(parseNetDev('  eth0:123 1 0 0 0 0 0 0 456 1 0 0 0 0 0 0\n')).toEqual({ eth0: { rx: 123, tx: 456 } })
    expect(parseNetDev('garbage')).toBeUndefined()
    expect(parseDiskstats('8 0 sda 1 0 2 0 3 0 4 0 0 0 0\n')).toEqual({ sda: { read: 1024, write: 2048 } })
    expect(parseNetstatE('接口统计\r\n\r\n                           接收的            发送的\r\n\r\n字节                    4110283508      3390256520\r\n单播数据包            45214500        63168794\r\n'))
      .toEqual({ rx: 4110283508, tx: 3390256520 })
  })
  it('展示：速率格式、摘要、走势缩放', () => {
    expect(fmtRate(1536)).toBe('1.5K/s')
    expect(statsSummary({ at: 0, netRx: 2048, netTx: 0 })).toContain('网络 ↓2.0K/s ↑0B/s')
    expect(scaleToPct([[0, 50], [100, undefined]])).toEqual({ scaled: [[0, 50], [100, undefined]], max: 100 })
    expect(scaleToPct([[0, 0]]).max).toBe(1)
  })
})
