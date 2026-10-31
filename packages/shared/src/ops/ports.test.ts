import { describe, it, expect } from 'vitest'
import { filterPorts, forwardTarget, localForwardUrl, localPortCandidates, parsePorts, portsListCommand, portsSupported, splitHostPort } from './ports.js'

const SS = `@@tool:ss
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=601,fd=14))
LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))
LISTEN 0      128             [::]:22           [::]:*    users:(("sshd",pid=800,fd=4))
LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=800,fd=3))
LISTEN 0      4096               *:9100            *:*
LISTEN 0      80         [::1]:3306           [::]:*
`
const NETSTAT = `@@tool:netstat
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      800/sshd: /usr/sbin
tcp        0      0 127.0.0.1:631           0.0.0.0:*               LISTEN      -
tcp6       0      0 :::22                   :::*                    LISTEN      800/sshd: /usr/sbin
tcp6       0      0 :::8080                 :::*                    LISTEN      2201/java
`

describe('监听端口解析', () => {
  it('ss -ltnpH：地址去方括号 / %网卡，进程取第一个，按端口排序', () => {
    const r = parsePorts(SS)
    expect(r.tool).toBe('ss')
    expect(r.rows).toEqual([
      { proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd', pid: 800 },
      { proto: 'tcp6', addr: '::', port: 22, process: 'sshd', pid: 800 },
      { proto: 'tcp', addr: '127.0.0.53', port: 53, process: 'systemd-resolve', pid: 601 },
      { proto: 'tcp', addr: '0.0.0.0', port: 80, process: 'nginx', pid: 1234 },
      { proto: 'tcp6', addr: '::1', port: 3306 },
      { proto: 'tcp', addr: '*', port: 9100 },
    ])
  })
  it('带表头的老版 ss、带 Netid 列的 ss 也认', () => {
    const r = parsePorts(`@@tool:ss
State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      128    0.0.0.0:22         0.0.0.0:*
tcp LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=99,fd=5))
`)
    expect(r.rows.map((x) => [x.addr, x.port, x.process])).toEqual([['0.0.0.0', 22, undefined], ['127.0.0.1', 5432, 'postgres']])
  })
  it('netstat -ltnp：跳过表头，「-」没有进程，进程名只取程序名', () => {
    const r = parsePorts(NETSTAT)
    expect(r.tool).toBe('netstat')
    expect(r.rows).toEqual([
      { proto: 'tcp', addr: '0.0.0.0', port: 22, process: 'sshd', pid: 800 },
      { proto: 'tcp6', addr: '::', port: 22, process: 'sshd', pid: 800 },
      { proto: 'tcp', addr: '127.0.0.1', port: 631 },
      { proto: 'tcp6', addr: '::', port: 8080, process: 'java', pid: 2201 },
    ])
  })
  it('同一地址端口去重；乱七八糟的行忽略', () => {
    expect(parsePorts('@@tool:ss\nLISTEN 0 1 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 1 0.0.0.0:22 0.0.0.0:*\nhello\n\n').rows).toHaveLength(1)
    expect(parsePorts('').rows).toEqual([])
  })
  it('splitHostPort', () => {
    expect(splitHostPort('[::]:22')).toEqual({ addr: '::', port: 22 })
    expect(splitHostPort(':::22')).toEqual({ addr: '::', port: 22 })
    expect(splitHostPort('*:80')).toEqual({ addr: '*', port: 80 })
    expect(splitHostPort('[fe80::1%eth0]:8080')).toEqual({ addr: 'fe80::1', port: 8080 })
    expect(splitHostPort('0.0.0.0:*')).toBeNull()
    expect(splitHostPort('nocolon')).toBeNull()
  })
})

describe('转发与过滤', () => {
  it('forwardTarget：IPv4 全部地址连 127.0.0.1，IPv6 全部地址连 ::1，具体地址照用', () => {
    expect(['0.0.0.0', '*', ''].map(forwardTarget)).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1'])
    expect(forwardTarget('::')).toBe('::1')
    expect(forwardTarget('::1')).toBe('::1')
    expect(forwardTarget('10.0.0.5')).toBe('10.0.0.5')
  })
  it('本地端口候选：同号起依次 +1，不超过 65535；非 Windows 从 1024 起', () => {
    expect(localPortCandidates(8080, 3)).toEqual([8080, 8081, 8082])
    expect(localPortCandidates(65534)).toEqual([65534, 65535])
    expect(localPortCandidates(80, 3)).toEqual([80, 81, 82])
    expect(localPortCandidates(80, 3, 1024)).toEqual([1024, 1025, 1026])
    expect(localPortCandidates(443, 2, 1024)).toEqual([1024, 1025])
  })
  it('打开转发：远端 443 / 8443 用 https，其余用 http', () => {
    expect(localForwardUrl(8080)).toBe('http://127.0.0.1:8080/')
    expect(localForwardUrl(51000, 443)).toBe('https://127.0.0.1:51000/')
    expect(localForwardUrl(51000, 8443)).toBe('https://127.0.0.1:51000/')
  })
  it('过滤：端口 / 地址 / 进程 / PID', () => {
    const rows = parsePorts(SS).rows
    expect(filterPorts(rows, 'nginx').map((r) => r.port)).toEqual([80])
    expect(filterPorts(rows, '91').map((r) => r.port)).toEqual([9100])
    expect(filterPorts(rows, ' ').length).toBe(rows.length)
  })
  it('只给非 Windows / macOS 的 SSH 终端；命令先 ss 后 netstat', () => {
    expect(portsSupported('ssh', 'linux')).toBe(true)
    expect(portsSupported('ssh', 'unknown')).toBe(true)
    expect(portsSupported('ssh', 'macos')).toBe(false)
    expect(portsSupported('local', 'linux')).toBe(false)
    const c = portsListCommand()
    expect(c.indexOf('ss -ltnpH')).toBeLessThan(c.indexOf('netstat -ltnp'))
  })
})
