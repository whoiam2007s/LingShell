import { describe, expect, it } from 'vitest'
import {
  parseProbeTargets, plannedChecks, probeScript, parseProbeBlock, parseProbeOutput, cellStatus, cellText, nodeErrReason, probeMarkdown, sanitizeProbeTargets, sanitizeProbeChecks,
  type ProbeCell,
} from './connProbe.js'

describe('parseProbeTargets', () => {
  it('URL / host:port / [v6]:port / 裸域名，去重，报错', () => {
    const { targets, errors } = parseProbeTargets('https://api.example.com/health\nredis.local:6379, 10.0.0.5:3306\n[::1]:22 db.internal db.internal\nbad:99999 a/b http://')
    expect(targets).toEqual([
      { raw: 'https://api.example.com/health', host: 'api.example.com', port: 443, url: 'https://api.example.com/health' },
      { raw: 'redis.local:6379', host: 'redis.local', port: 6379 },
      { raw: '10.0.0.5:3306', host: '10.0.0.5', port: 3306 },
      { raw: '[::1]:22', host: '::1', port: 22 },
      { raw: 'db.internal', host: 'db.internal' },
    ])
    expect(errors).toEqual(['bad:99999', 'a/b', 'http://'])
    expect(parseProbeTargets('http://x:8080/').targets[0]).toMatchObject({ port: 8080, url: 'http://x:8080/' })
  })
  it('plannedChecks：IP 不解析、没端口不测 TCP、非 URL 不测 HTTP', () => {
    const all = ['dns', 'tcp', 'http'] as const
    expect(plannedChecks({ raw: '1.2.3.4:80', host: '1.2.3.4', port: 80 }, [...all]).map((x) => x.skip ?? 'go')).toEqual(['是 IP，无需解析', 'go', '不是 URL'])
    expect(plannedChecks({ raw: 'a', host: 'a' }, [...all]).map((x) => x.skip ?? 'go')).toEqual(['go', '没写端口', '不是 URL'])
  })
  it('sanitize：按 raw 重新解析、至少一项检查', () => {
    expect(sanitizeProbeTargets([{ raw: 'x:1', host: 'evil;rm', port: 1 }])).toEqual([{ raw: 'x:1', host: 'x', port: 1 }])
    expect(() => sanitizeProbeTargets([])).toThrow('目标')
    expect(sanitizeProbeChecks(['http', 'nope', 'dns'])).toEqual(['dns', 'http'])
    expect(() => sanitizeProbeChecks([])).toThrow()
  })
})

describe('probeScript', () => {
  it('参数加引号、各目标并行、按序输出', () => {
    const s = probeScript(parseProbeTargets('db:5432 https://a.com/p?q=1').targets, ['dns', 'tcp', 'http'])
    expect(s).toMatch(/^if command -v bash/)
    expect(s).toContain('dns 0 '); expect(s).toContain('tcp 0 ')
    expect(s).toContain('http 1 ')
    // 每块一结束就写 stdout：不再等所有目标结束后才从临时目录统一输出（一个目标卡住会让整行没有结果）
    expect(s).not.toContain('mktemp')
    expect(s).toContain('wait')
    // DNS 套 timeout，卡住的解析不会拖住整个探测
    expect(s).toContain('blk $1 dns getent to getent ahosts')
  })
})

it('目标：不带方括号的 IPv6 整个当地址；URL 里的账号密码被去掉', () => {
  const { targets, errors } = parseProbeTargets('::1 fe80::1 https://user:p%40ss@api.example.com/health?token=x')
  expect(errors).toEqual([])
  expect(targets[0]).toEqual({ raw: '::1', host: '::1' })
  expect(targets[1]).toEqual({ raw: 'fe80::1', host: 'fe80::1' })
  expect(targets[2].url).toBe('https://api.example.com/health?token=x')
  expect(targets[2].raw).not.toContain('p%40ss')
  expect(probeScript([targets[2]], ['http'])).not.toContain('user:')
})

describe('parseProbeBlock：固定样例', () => {
  it('DNS：getent / nslookup / host', () => {
    expect(parseProbeBlock('dns', 'getent', 0, 3, '93.184.216.34   STREAM example.com\n93.184.216.34   DGRAM\n2606:2800::1 STREAM')).toMatchObject({ status: 'ok', ms: 3, detail: '93.184.216.34, 2606:2800::1' })
    expect(parseProbeBlock('dns', 'getent', 2, 5, '')).toMatchObject({ status: 'fail', detail: '解析失败' })
    const ns = 'Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\nNon-authoritative answer:\nName:\texample.com\nAddress: 93.184.216.34\nName:\texample.com\nAddress: 2606:2800:220:1::1\n'
    expect(parseProbeBlock('dns', 'nslookup', 0, -1, ns)).toMatchObject({ status: 'ok', detail: '93.184.216.34, 2606:2800:220:1::1' })
    expect(parseProbeBlock('dns', 'nslookup', 1, -1, 'Server:\t1.1.1.1\nAddress:\t1.1.1.1#53\n\n** server can\'t find nope.invalid: NXDOMAIN\n')).toMatchObject({ status: 'fail', detail: '解析失败' })
    expect(parseProbeBlock('dns', 'nslookup', 1, -1, ';; connection timed out; no servers could be reached')).toMatchObject({ detail: 'DNS 超时' })
    // getent 被 timeout 杀掉（124）= DNS 服务器不响应，和 NXDOMAIN 的「解析失败」区分
    expect(parseProbeBlock('dns', 'getent', 124, 5000, '')).toMatchObject({ status: 'fail', detail: 'DNS 超时' })
    expect(parseProbeBlock('dns', 'host', 0, -1, 'example.com has address 1.2.3.4\nexample.com has IPv6 address ::1')).toMatchObject({ status: 'ok', detail: '1.2.3.4, ::1' })
  })
  it('TCP：bash /dev/tcp 与 nc', () => {
    expect(parseProbeBlock('tcp', 'bash', 0, 2, '')).toMatchObject({ status: 'ok', ms: 2 })
    expect(parseProbeBlock('tcp', 'bash', 1, 2, 'bash: connect: Connection refused\nbash: line 1: /dev/tcp/127.0.0.1/1: Connection refused')).toMatchObject({ status: 'fail', detail: '拒绝连接' })
    expect(parseProbeBlock('tcp', 'bash', 124, 3000, '')).toMatchObject({ detail: '超时' })
    expect(parseProbeBlock('tcp', 'bash', 1, 1, 'bash: nope.invalid: Name or service not known')).toMatchObject({ detail: '解析失败' })
    expect(parseProbeBlock('tcp', 'bash', 1, 1, 'bash: connect: No route to host')).toMatchObject({ detail: '网络不可达' })
    expect(parseProbeBlock('tcp', 'bash', 1, 1, '127.0.0.1: connect: Connection reset by peer')).toMatchObject({ detail: '连接被重置' })
    expect(parseProbeBlock('tcp', 'nc', 0, -1, 'Connection to db 5432 port [tcp/postgresql] succeeded!')).toMatchObject({ status: 'ok' })
    expect(parseProbeBlock('tcp', 'nc', 1, -1, 'nc: connect to db port 5432 (tcp) timed out: Operation now in progress')).toMatchObject({ detail: '超时' })
  })
  it('HTTP：curl 状态码 / 错误，wget', () => {
    expect(parseProbeBlock('http', 'curl', 0, 30, '200 0.012345')).toMatchObject({ status: 'ok', ms: 12, detail: 'HTTP 200' })
    expect(parseProbeBlock('http', 'curl', 0, 30, '503 0.5')).toMatchObject({ status: 'warn', detail: 'HTTP 503' })
    expect(parseProbeBlock('http', 'curl', 60, 30, '000 0.1\ncurl: (60) SSL certificate problem: self-signed certificate')).toMatchObject({ status: 'fail', detail: '证书不受信任' })
    expect(parseProbeBlock('http', 'curl', 7, 30, '000 0.001\ncurl: (7) Failed to connect')).toMatchObject({ detail: '无法连接' })
    expect(parseProbeBlock('http', 'curl', 23, 30, '200 0.02curl: (23) client returned ERROR on write')).toMatchObject({ status: 'ok', detail: 'HTTP 200' })
    expect(parseProbeBlock('http', 'curl', 99, 30, 'curl: (99) weird thing')).toMatchObject({ detail: 'weird thing' })
    expect(parseProbeBlock('http', 'wget', 8, -1, '  HTTP/1.1 301 Moved\n  HTTP/1.1 404 Not Found\n')).toMatchObject({ status: 'warn', detail: 'HTTP 404' })
    expect(parseProbeBlock('http', 'wget', 4, -1, 'failed: Connection refused.')).toMatchObject({ status: 'fail', detail: '拒绝连接' })
  })
  it('没有命令：na 并说明', () => {
    expect(parseProbeBlock('tcp', 'none', 127, -1, '')).toMatchObject({ status: 'na', detail: '源主机上没有 bash + timeout 或 nc' })
  })
})

it('parseProbeOutput：按块对上目标；缺的标没有结果；skip 照列', () => {
  const ts = parseProbeTargets('db.local:5432 https://x.com/').targets
  const out = '@@PB 0 dns getent 0 4\n10.0.0.9 STREAM db.local\n@@PE\n@@PB 0 tcp bash 1 3\nbash: connect: Connection refused\n@@PE\n@@PB 1 http curl 0 -1\n200 0.2\n@@PE\n'
  const cells = parseProbeOutput(out, ts, ['dns', 'tcp', 'http'])
  expect(cells[0].items.map((x) => x.status)).toEqual(['ok', 'fail', 'skip'])
  expect(cells[1].items.map((x) => x.status)).toEqual(['fail', 'fail', 'ok'])   // 1 的 dns / tcp 没有块
  expect(cellStatus(cells[0])).toBe('fail')
  expect(cellText(cells[0])).toBe('✗ 拒绝连接')
  expect(cellText({ items: [{ check: 'dns', status: 'ok', ms: 2 }, { check: 'tcp', status: 'ok', ms: 7 }] })).toBe('✓ 7ms')
  expect(cellText({ items: [{ check: 'http', status: 'warn', detail: 'HTTP 500' }] })).toBe('! HTTP 500')
  expect(cellText({ items: [{ check: 'dns', status: 'skip' }] })).toBe('—')
})

it('nodeErrReason', () => {
  expect(nodeErrReason('ENOTFOUND')).toBe('解析失败')
  expect(nodeErrReason('ECONNREFUSED')).toBe('拒绝连接')
  expect(nodeErrReason(undefined, 'The operation was aborted due to timeout')).toBe('超时')
  expect(nodeErrReason('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('证书错误')
})

it('probeMarkdown', () => {
  const ts = parseProbeTargets('a:1').targets
  const cell: ProbeCell = { items: [{ check: 'tcp', status: 'fail', detail: '超时' }] }
  const md = probeMarkdown(['本机', 'web1'], ts, [{ cells: [cell] }, { cells: [], error: '认证失败' }])
  expect(md).toContain('| 本机 | ✗ 超时 |')
  expect(md).toContain('| web1 | 连接失败：认证失败 |')
  expect(md).toContain('- 本机 → a:1：TCP 不通（超时）')
  // 有部分结果的源：照样输出格子，错误单独列在「未完成的源」，不整行替换成「连接失败」
  const part = probeMarkdown(['db'], ts, [{ cells: [{ items: [{ check: 'tcp', status: 'ok', ms: 3 }] }], error: '执行超时（部分结果）' }])
  expect(part).toContain('| db | ✓ 3ms |')
  expect(part).toContain('未完成的源')
  expect(part).not.toContain('连接失败')
})
