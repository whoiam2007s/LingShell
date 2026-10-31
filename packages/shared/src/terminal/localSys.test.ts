import { describe, it, expect } from 'vitest'
import { csvFields, parseLsofListen, parseNetstatAno, parseTasklist, taskkillArgs, tasksToProcRows } from './localSys.js'
import {
  classifyLocalDockerError, composeActionCommand, composeDecision, composeLogsCommand, dockerAuditLabel, parseComposeLs,
} from '../ops/index.js'

// 中文 Windows 的 netstat -ano（表头本地化，状态列仍是英文）
const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1780
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       12528
  TCP    127.0.0.1:3000         127.0.0.1:50123        ESTABLISHED     12528
  TCP    [::]:135               [::]:0                 LISTENING       1780
  TCP    [::1]:5432             [::]:0                 LISTENING       900
  TCP    [fe80::1%12]:7000      [::]:0                 LISTENING       901
  UDP    0.0.0.0:5353           *:*                                    2000
`
const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","3,584 K"
"node.exe","12528","Console","1","45,120 K"
"svchost.exe","1780","Services","0","12.345 K"
"奇怪 ""名字"".exe","900","Console","1","N/A"
`

describe('Windows', () => {
  it('tasklist CSV：引号 / 转义引号 / 千分位', () => {
    expect(csvFields('"a","b ""c""",d')).toEqual(['a', 'b "c"', 'd'])
    const t = parseTasklist(TASKLIST)
    expect(t.map((x) => [x.name, x.pid, x.memKB])).toEqual([
      ['System Idle Process', 0, 8], ['System', 4, 3584], ['node.exe', 12528, 45120], ['svchost.exe', 1780, 12345], ['奇怪 "名字".exe', 900, undefined],
    ])
    const rows = tasksToProcRows(t)
    expect(rows[0]).toEqual({ pid: 4, user: 'Services', rss: 3584, etime: '', stat: '', command: 'System' })
    expect(rows.some((r) => r.pid === 0)).toBe(false)
  })
  it('netstat -ano：只要 TCP LISTENING，去重，进程名对上 PID，IPv6 去方括号和 %网卡', () => {
    const names = new Map(parseTasklist(TASKLIST).map((t) => [t.pid, t.name]))
    const rows = parseNetstatAno(NETSTAT, names)
    expect(rows.map((r) => [r.proto, r.addr, r.port, r.pid, r.process])).toEqual([
      ['tcp', '0.0.0.0', 135, 1780, 'svchost.exe'], ['tcp6', '::', 135, 1780, 'svchost.exe'],
      ['tcp', '0.0.0.0', 445, 4, 'System'], ['tcp', '127.0.0.1', 3000, 12528, 'node.exe'],
      ['tcp6', '::1', 5432, 900, '奇怪 "名字".exe'], ['tcp6', 'fe80::1', 7000, 901, undefined],
    ])
  })
  it('英文系统输出同样能解析；状态列本地化（德语）也能认出监听；taskkill 参数', () => {
    expect(parseNetstatAno('  Proto  Local Address  Foreign Address  State  PID\n  TCP    0.0.0.0:8080  0.0.0.0:0  LISTENING  77\n')).toEqual([{ proto: 'tcp', addr: '0.0.0.0', port: 8080, pid: 77 }])
    expect(parseNetstatAno('  Proto  Lokale Adresse  Fremde Adresse  Status  PID\n  TCP    0.0.0.0:8080  0.0.0.0:0  ABHÖREN  77\n')).toEqual([{ proto: 'tcp', addr: '0.0.0.0', port: 8080, pid: 77 }])
    expect(taskkillArgs(77, true)).toEqual(['/F', '/PID', '77'])
    expect(taskkillArgs(77, false)).toEqual(['/PID', '77'])
  })
})

describe('macOS lsof', () => {
  it('lsof -nP -iTCP -sTCP:LISTEN', () => {
    const out = [
      'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      'node    41234   me   23u  IPv6 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)',
      'postgres  612   me    7u  IPv4 0x1234567890abcdee      0t0  TCP 127.0.0.1:5432 (LISTEN)',
      'postgres  612   me    8u  IPv6 0x1234567890abcded      0t0  TCP [::1]:5432 (LISTEN)',
      'Google\\x20  900   me    8u  IPv4 0x1      0t0  TCP 127.0.0.1:9222 (LISTEN)',
    ].join('\n')
    expect(parseLsofListen(out).map((r) => [r.proto, r.addr, r.port, r.process, r.pid])).toEqual([
      ['tcp6', '*', 3000, 'node', 41234], ['tcp', '127.0.0.1', 5432, 'postgres', 612], ['tcp6', '::1', 5432, 'postgres', 612], ['tcp', '127.0.0.1', 9222, 'Google ', 900],
    ])
  })
})

describe('本机 Docker / Compose', () => {
  it('Docker Desktop 没启动归为 daemon；找不到命令归为 missing', () => {
    expect(classifyLocalDockerError(1, 'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.')).toBe('daemon')
    expect(classifyLocalDockerError(127, 'sh: line 1: docker: command not found')).toBe('missing')
  })
  it('docker compose ls --format json', () => {
    const p = parseComposeLs('[{"Name":"shop","Status":"running(3)","ConfigFiles":"D:\\\\proj\\\\shop\\\\compose.yml,D:\\\\proj\\\\shop\\\\compose.dev.yml"},{"Name":"bad name","Status":"x"}]')
    expect(p).toEqual([{ name: 'shop', status: 'running(3)', configFiles: ['D:\\proj\\shop\\compose.yml', 'D:\\proj\\shop\\compose.dev.yml'] }])
    expect(parseComposeLs('WARN something\n[]')).toEqual([])
    expect(parseComposeLs('not json')).toEqual([])
    // 警告文本里有方括号：以哨兵为准，不能从第一个 [ 截
    expect(parseComposeLs('warning: [legacy] config\n@@composels\n[{"Name":"shop","Status":"running","ConfigFiles":"/srv/shop/compose.yml"}]')).toEqual([
      { name: 'shop', status: 'running', configFiles: ['/srv/shop/compose.yml'] },
    ])
  })
  it('compose 命令：up 带 -f（单引号），down / restart / logs 按项目名；非法名拒绝', () => {
    const p = { name: 'shop', status: '', configFiles: ["/srv/it's/compose.yml"] }
    expect(composeActionCommand('docker', 'up', p)).toMatch(/docker compose -p shop -f .*compose\.yml.* up -d/)
    expect(composeActionCommand('docker', 'down', p)).toContain('docker compose -p shop down')
    expect(composeLogsCommand('sudo', 'shop')).toContain('sudo -n docker compose -p shop logs --no-color --tail 200')
    expect(() => composeActionCommand('docker', 'down', { ...p, name: 'a;rm' })).toThrow('非法')
    expect(dockerAuditLabel(composeDecision('up'))).toBe('Compose 启动（up -d）')
    expect(dockerAuditLabel('docker_stop')).toBe('容器停止')
  })
})
