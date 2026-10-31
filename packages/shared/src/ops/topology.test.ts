import { describe, it, expect } from 'vitest'
import { deriveTopology, layoutTopology, edgePath } from './topology.js'

const OUT = [
  '@@listen',
  'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=100,fd=6),("nginx",pid=101,fd=6))',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
  'LISTEN 0 100 127.0.0.1:8080 0.0.0.0:* users:(("java",pid=200,fd=9))',
  'LISTEN 0 80 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=300,fd=6))',
  'LISTEN 0 4096 0.0.0.0:9000 0.0.0.0:* users:(("docker-proxy",pid=400,fd=4))',
  '@@estab',
  '0 0 10.0.0.5:80 203.0.113.9:51000 users:(("nginx",pid=101,fd=10))',
  '0 0 10.0.0.5:80 203.0.113.10:51001 users:(("nginx",pid=101,fd=11))',
  '0 0 127.0.0.1:41000 127.0.0.1:8080 users:(("nginx",pid=101,fd=12))',
  '0 0 127.0.0.1:8080 127.0.0.1:41000 users:(("java",pid=200,fd=20))',
  '0 0 127.0.0.1:42000 127.0.0.1:6379 users:(("java",pid=200,fd=21))',
  '0 0 127.0.0.1:42001 127.0.0.1:6379 users:(("java",pid=200,fd=22))',
  '0 0 127.0.0.1:6379 127.0.0.1:42000 users:(("redis-server",pid=300,fd=7))',
  '0 0 10.0.0.5:43000 10.9.8.7:3306 users:(("java",pid=200,fd=23))',
  '0 0 [::ffff:10.0.0.5]:43001 [::ffff:10.9.8.7]:3306 users:(("java",pid=200,fd=24))',
  '0 0 172.17.0.1:45000 172.17.0.2:9000 users:(("docker-proxy",pid=400,fd=8))',
  '0 0 10.0.0.5:44000 172.17.0.2:9000 users:(("java",pid=200,fd=25))',
  '0 0 10.0.0.5:22 198.51.100.1:60000 users:(("sshd",pid=900,fd=4))',
  '@@addrs',
  '10.0.0.5 172.17.0.1 ',
  '@@dockerps',
  'minio\t0.0.0.0:9000->9000/tcp, [::]:9000->9000/tcp',
  'worker\t',
  '@@dockernet',
  '[{"Name":"bridge","Containers":{"a":{"Name":"minio","IPv4Address":"172.17.0.2/16"},"b":{"Name":"worker","IPv4Address":"172.17.0.3/16"}}}]',
].join('\n')

describe('deriveTopology', () => {
  const t = deriveTopology(OUT)
  const by = (id: string) => t.nodes.find((n) => n.id === id)!
  it('节点：进程 / 容器 / 外部；角色', () => {
    expect(t.nodes.map((n) => [n.id, n.role]).sort()).toEqual([
      ['ctr:minio', 'data'],
      ['ext:10.9.8.7:3306', 'data'],
      ['proc:java', 'internal'],
      ['proc:nginx', 'entry'],
      ['proc:redis-server', 'data'],
      ['proc:sshd', 'entry'],
    ].sort())
    expect(by('proc:nginx')).toMatchObject({ inExternal: 2, pids: [100, 101], listen: [{ addr: '0.0.0.0', port: 80 }] })
    expect(by('ext:10.9.8.7:3306').label).toBe('外部 10.9.8.7:3306')
    expect(by('ctr:minio').listen).toEqual([{ addr: '0.0.0.0', port: 9000 }])
    expect(t).toMatchObject({ docker: true, procVisible: true })
  })
  it('有向边：本机内只记一次，同目标合并计数，docker-proxy 不单独成边', () => {
    expect(t.edges.map((e) => `${e.from}>${e.to}:${e.port}x${e.count}`).sort()).toEqual([
      'proc:java>ctr:minio:9000x1',
      'proc:java>ext:10.9.8.7:3306:3306x2',
      'proc:java>proc:redis-server:6379x2',
      'proc:nginx>proc:java:8080x1',
    ])
    expect(by('proc:java')).toMatchObject({ inConns: 1, outConns: 5 })
  })
  it('没有进程信息（非 root）：按端口成节点', () => {
    const r = deriveTopology('@@listen\nLISTEN 0 1 127.0.0.1:5000 0.0.0.0:*\n@@estab\n0 0 127.0.0.1:40000 127.0.0.1:5000\n@@addrs\n')
    expect(r.procVisible).toBe(false)
    expect(r.edges).toEqual([{ from: 'proc:?', to: 'port:5000', port: 5000, count: 1 }])
  })
})

describe('layoutTopology', () => {
  it('三列：入口左、内部中、数据库 / 外部右；列内居中、数据库排在外部前', () => {
    const l = layoutTopology(deriveTopology(OUT), { nodeW: 100, nodeH: 40, colGap: 50, rowGap: 10, pad: 10 })
    const col = (id: string) => l.nodes.find((n) => n.id === id)!
    expect([col('proc:nginx').col, col('proc:java').col, col('proc:redis-server').col, col('ext:10.9.8.7:3306').col]).toEqual([0, 1, 2, 2])
    expect(col('proc:nginx').x).toBe(10)
    expect(col('proc:java').x).toBe(160)
    expect(l.width).toBe(10 * 2 + 300 + 100)
    const c2 = l.nodes.filter((n) => n.col === 2).map((n) => n.id)
    expect(c2.at(-1)).toBe('ext:10.9.8.7:3306')
    expect(l.height).toBe(10 * 2 + 22 + 3 * 40 + 2 * 10)
    expect(col('proc:java').y).toBe(Math.round(32 + (l.height - 42 - 40) / 2))
  })
  it('edgePath：往右 / 往回', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 100 }, 100, 40)).toBe('M100,20 C150,20 150,120 200,120')
    expect(edgePath({ x: 200, y: 0 }, { x: 200, y: 80 }, 100, 40)).toMatch(/^M300,20 C360,20 360,100 300,100$/)
  })
})
