import { describe, it, expect } from 'vitest'
import { diffIsEmpty, diffProfiles, findIssues, hostCheckCommand, hostDirName, parseHostProfile, parseOpensslDate, profileReportText, summarizeDiff, type HostProfile } from './hostProfile.js'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const base = { type: 'check' as const, at: '2026-10-15T00:00:00.000Z', hostKey: 'h1', hostLabel: 'web-1' }

const SAMPLE = [
  '@@hc:sys', 'kernel=5.14.0-362.el9.x86_64', 'arch=x86_64', 'hostname=web-1', 'uptime=864000', 'os=Rocky Linux 9.3 (Blue Onyx)',
  '@@hc:cpu', 'cores=4', 'load=0.52 0.40 0.31',
  '@@hc:mem', 'MemTotal:       16303428 kB', 'MemAvailable:    8151714 kB', 'SwapTotal:       2097148 kB', 'SwapFree:        2097148 kB',
  '@@hc:df',
  'Filesystem     1024-blocks     Used Available Capacity Mounted on',
  '/dev/vda1         41152736 36000000   3000000      93% /',
  'tmpfs               811440        0    811440       0% /run/user/0',
  '/dev/vdb1        103081248 10000000  88000000      11% /data',
  'C:/Program Files/Git 498000000 300000000 198000000 61% /git root',
  '@@hc:dfi',
  'Filesystem      Inodes  IUsed   IFree IUse% Mounted on',
  '/dev/vda1      2621440 100000 2521440    4% /',
  '/dev/vdb1      6553600 6000000 553600   92% /data',
  '@@hc:ports', '@@tool:ss',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3))',
  'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=900,fd=6))',
  '@@hc:failed', '● mysqld.service loaded failed failed MySQL Server', 'kdump.service loaded failed failed Crash recovery kernel arming',
  '@@hc:docker', 'web|nginx:1.25|running|Up 3 days', 'db|mysql:8|exited|Exited (1) 2 hours ago',
  '@@hc:files',
  `@@file /etc/ssh/sshd_config|${'a'.repeat(64)}|20`, '@@content /etc/ssh/sshd_config', b64('PermitRootLogin yes\n'), '@@end',
  `@@file /etc/nginx/nginx.conf|${'b'.repeat(64)}|300000`,
  '@@file /etc/my.cnf|-|',
  '@@hc:uid0', 'root', 'toor',
  '@@hc:last',
  'root     pts/0        203.0.113.5      Wed Oct 14 10:00   still logged in',
  'admin    tty1         0.0.0.0          Tue Oct 13 09:00 - 09:30  (00:30)',
  'reboot   system boot  0.0.0.0          Tue Oct 13 08:59   still running',
  '',
  'wtmp begins Mon Oct  1 00:00:00 2026',
  '@@hc:sshd', '@@src:config', 'PermitRootLogin yes', '#PasswordAuthentication no', 'Match User git', 'PasswordAuthentication no',
  '@@hc:certs', '@@cert /etc/letsencrypt/live/a.com/cert.pem|Oct 30 12:00:00 2026 GMT', '@@cert /etc/nginx/ssl/old.pem|Jan  1 00:00:00 2026 GMT', '@@cert /etc/nginx/x.pem|',
  '@@hc:updates', 'mgr=dnf', 'total=12', 'security=3',
].join('\n')

describe('parseHostProfile', () => {
  const { profile: p, contents } = parseHostProfile(SAMPLE, base)
  it('系统 / CPU / 内存', () => {
    expect(p.sys).toEqual({ os: 'Rocky Linux 9.3 (Blue Onyx)', kernel: '5.14.0-362.el9.x86_64', arch: 'x86_64', hostname: 'web-1', uptimeSec: 864000 })
    expect(p.cpu).toEqual({ cores: 4, load: [0.52, 0.4, 0.31] })
    expect(p.mem).toEqual({ totalKb: 16303428, availKb: 8151714, swapTotalKb: 2097148, swapFreeKb: 2097148 })
  })
  it('overlay 根文件系统不当伪文件系统丢掉（容器 / 不可变系统的根盘）', () => {
    const out = ['@@hc:df', 'overlay 100 90 10 90% /', 'tmpfs 50 1 49 2% /run', '@@hc:dfi', 'overlay 10 1 9 10% /'].join('\n')
    const { profile } = parseHostProfile(out, base)
    expect(profile.disks).toEqual([{ mount: '/', fs: 'overlay', sizeKb: 100, usedPct: 90, inodePct: 10 }])
  })
  it('磁盘：去掉 tmpfs 等，合并 inode，名字带空格也认', () => {
    expect(p.disks).toEqual([
      { mount: '/', fs: '/dev/vda1', sizeKb: 41152736, usedPct: 93, inodePct: 4 },
      { mount: '/data', fs: '/dev/vdb1', sizeKb: 103081248, usedPct: 11, inodePct: 92 },
      { mount: '/git root', fs: 'C:/Program Files/Git', sizeKb: 498000000, usedPct: 61 },
    ])
  })
  it('端口 / 失败服务 / 容器', () => {
    expect(p.ports?.map((x) => x.port)).toEqual([22, 80])
    expect(p.failedUnits).toEqual(['mysqld.service', 'kdump.service'])
    expect(p.containers).toEqual([{ name: 'web', image: 'nginx:1.25', state: 'running', status: 'Up 3 days' }, { name: 'db', image: 'mysql:8', state: 'exited', status: 'Exited (1) 2 hours ago' }])
  })
  it('配置文件：哈希、内容（base64 解码）、读不到的', () => {
    expect(p.files).toEqual([
      { path: '/etc/ssh/sshd_config', sha256: 'a'.repeat(64), size: 20, content: true },
      { path: '/etc/nginx/nginx.conf', sha256: 'b'.repeat(64), size: 300000 },
      { path: '/etc/my.cnf', unreadable: true },
    ])
    expect(contents.get('/etc/ssh/sshd_config')).toBe('PermitRootLogin yes\n')
  })
  it('UID0 / 登录 / sshd（Match 之后不算、注释不算、没写的取默认）/ 证书 / 更新', () => {
    expect(p.uid0).toEqual(['root', 'toor'])
    expect(p.logins).toEqual([{ user: 'root', ip: '203.0.113.5', time: 'Wed Oct 14 10:00 still logged in' }, { user: 'admin', ip: '0.0.0.0', time: 'Tue Oct 13 09:00 - 09:30 (00:30)' }])
    expect(p.sshd).toEqual({ permitRootLogin: 'yes', passwordAuthentication: 'yes', source: 'config' })
    expect(p.certs).toEqual([
      { path: '/etc/letsencrypt/live/a.com/cert.pem', notAfter: '2026-10-30T12:00:00.000Z' },
      { path: '/etc/nginx/ssl/old.pem', notAfter: '2026-01-01T00:00:00.000Z' },
      { path: '/etc/nginx/x.pem', error: '读不到证书（文件不存在或没有权限）' },
    ])
    expect(p.updates).toEqual({ manager: 'dnf', total: 12, security: 3 })
  })
  it('缺工具 / 超时 / 截断', () => {
    const r = parseHostProfile(['@@hc:ports', '@@none', '@@hc:failed', '@@none', '@@hc:docker', '@@error', '@@hc:files', `@@file /etc/hosts|${'c'.repeat(64)}|9`, '@@content /etc/hosts', 'aGVsbG8K'].join('\n'), base).profile
    expect(r.ports).toBeNull()
    expect(r.failedUnits).toBeNull()
    expect(r.containers).toBeNull()
    expect(r.files).toEqual([{ path: '/etc/hosts', sha256: 'c'.repeat(64), size: 9 }])   // 没有 @@end：不算存了内容
    expect(r.updates).toEqual({ manager: 'none', unknown: 'timeout' })                    // 体检没收到更新段 = 超时
    expect(r.notes?.length).toBe(2)
    expect(parseHostProfile('@@hc:mem\nMemTotal: 100 kB\nMemFree: 40 kB\n', base).profile.mem?.availKb).toBe(40)   // 老内核没有 MemAvailable
    expect(parseHostProfile('@@hc:updates\nmgr=apt\n@@timeout\n', base).profile.updates).toEqual({ manager: 'apt', unknown: 'timeout' })
    expect(parseHostProfile('@@hc:sshd\n@@src:sshd-T\npermitrootlogin no\npasswordauthentication no\n', base).profile.sshd).toEqual({ permitRootLogin: 'no', passwordAuthentication: 'no', source: 'sshd -T' })
  })
})

describe('findIssues', () => {
  it('磁盘 / inode / 失败服务 / 证书 / sshd / UID0 / 安全更新；严重在前', () => {
    const { profile } = parseHostProfile(SAMPLE, base)
    const issues = findIssues(profile)
    expect(issues.map((i) => [i.level, i.kind])).toEqual([
      ['danger', 'cert'], ['danger', 'sshd'], ['danger', 'uid0'],
      ['warn', 'disk'], ['warn', 'inode'], ['warn', 'service'], ['warn', 'service'], ['warn', 'cert'], ['warn', 'updates'],
    ])
    expect(issues.find((i) => i.kind === 'cert' && i.level === 'warn')?.text).toContain('15 天后到期')
    expect(issues.find((i) => i.kind === 'uid0')?.text).toContain('toor')
  })
  it('健康主机没有问题项；密码登录关了不算', () => {
    const p: HostProfile = { ...base, version: 1, disks: [{ mount: '/', fs: 'x', sizeKb: 1, usedPct: 85, inodePct: 85 }], failedUnits: [], uid0: ['root'], sshd: { permitRootLogin: 'yes', passwordAuthentication: 'no', source: 'config' }, updates: { manager: 'apt', total: 3, security: 0 } }
    expect(findIssues(p)).toEqual([])
    expect(findIssues({ ...p, disks: [{ mount: '/', fs: 'x', sizeKb: 1, usedPct: 96 }] })[0]).toMatchObject({ level: 'danger', kind: 'disk' })
  })
})

describe('diffProfiles', () => {
  const prev = parseHostProfile(SAMPLE, base).profile
  it('同一份没有差异', () => {
    expect(diffIsEmpty(diffProfiles(prev, prev))).toBe(true)
    expect(summarizeDiff(diffProfiles(prev, prev))).toEqual([])
  })
  it('端口 / 服务 / 容器 / 文件 / UID0 / 登录 IP / 磁盘', () => {
    const cur: HostProfile = {
      ...prev, at: '2026-10-16T00:00:00.000Z',
      ports: [...prev.ports!.filter((x) => x.port !== 80), { proto: 'tcp', addr: '0.0.0.0', port: 8080 }, { proto: 'tcp', addr: '0.0.0.0', port: 9090 }],
      failedUnits: ['kdump.service', 'nginx.service'],
      containers: [{ name: 'web', image: 'nginx:1.27', state: 'running' }, { name: 'cache', image: 'redis:7', state: 'running' }],
      files: [{ path: '/etc/ssh/sshd_config', sha256: 'f'.repeat(64) }, { path: '/etc/my.cnf', unreadable: true }, { path: '/etc/hosts', sha256: 'e'.repeat(64) }],
      uid0: ['root', 'toor', 'evil'],
      logins: [...prev.logins!, { user: 'root', ip: '198.51.100.7', time: 'x' }, { user: 'x', ip: '0.0.0.0', time: 'y' }],
      disks: [{ ...prev.disks![0], usedPct: 80 }, { ...prev.disks![1], usedPct: 19 }],
    }
    const d = diffProfiles(prev, cur)
    expect(d.portsAdded.map((x) => x.port)).toEqual([8080, 9090])
    expect(d.portsRemoved.map((x) => x.port)).toEqual([80])
    expect(d.servicesFailed).toEqual(['nginx.service'])
    expect(d.servicesRecovered).toEqual(['mysqld.service'])
    expect(d.containersAdded.map((c) => c.name)).toEqual(['cache'])
    expect(d.containersRemoved.map((c) => c.name)).toEqual(['db'])
    expect(d.containersChanged).toEqual([{ name: 'web', from: { image: 'nginx:1.25', state: 'running' }, to: { image: 'nginx:1.27', state: 'running' } }])
    expect(d.files).toEqual([
      { path: '/etc/ssh/sshd_config', kind: 'modified', from: 'a'.repeat(64), to: 'f'.repeat(64) },
      { path: '/etc/hosts', kind: 'added', to: 'e'.repeat(64) },
      { path: '/etc/nginx/nginx.conf', kind: 'removed', from: 'b'.repeat(64) },
    ])
    expect(d.uid0Added).toEqual(['evil'])
    expect(d.newLoginIps).toEqual(['198.51.100.7'])
    expect(d.disks).toEqual([{ mount: '/', from: 93, to: 80 }])   // /data 11→19 不到 10 个百分点
    expect(summarizeDiff(d)).toEqual([
      '端口 +2 -1', '新失败服务 1', '服务恢复 1', '容器 +1 -1', '容器变化 1',
      'sshd_config 已修改', 'hosts 新出现', 'nginx.conf 已消失', '新增 UID0 用户 evil', '新登录来源 1', '/ 磁盘 93%→80%',
    ])
  })
  it('只比两边都采到的部分（快照没有磁盘等；没有 docker 不算容器全消失）', () => {
    const snap: HostProfile = { version: 1, type: 'snapshot', at: base.at, hostKey: 'h1', ports: prev.ports, failedUnits: prev.failedUnits, containers: null, files: prev.files }
    expect(diffIsEmpty(diffProfiles(prev, snap))).toBe(true)
  })
})

it('报告文本带问题项与漂移；openssl 日期；目录名', () => {
  const { profile } = parseHostProfile(SAMPLE, base)
  const t = profileReportText(profile, findIssues(profile), diffProfiles(profile, { ...profile, ports: [] }))
  expect(t).toContain('主机：web-1')
  expect(t).toContain('[严重] SSH 允许 root 用密码登录')
  expect(t).toContain('和上次体检相比：端口 -2')
  expect(parseOpensslDate('Feb 29 23:59:59 2028 GMT')).toBe('2028-02-29T23:59:59.000Z')
  expect(parseOpensslDate('garbage')).toBeUndefined()
  expect(hostDirName('10.0.0.1:22')).toBe('10.0.0.1_22')
  expect(hostDirName('../x')).toBe('.._x')
  expect(hostDirName('..')).toBe('_')
})

it('采集命令：sh -c 单引号包整段（脚本里没有单引号）；快照不含体检专属段', () => {
  for (const t of ['check', 'snapshot'] as const) {
    const c = hostCheckCommand(t)
    expect(c.startsWith("sh -c '") && c.endsWith("'")).toBe(true)
    expect(c.slice(7, -1)).not.toContain("'")
  }
  expect(hostCheckCommand('snapshot')).not.toContain('S sys')
  expect(hostCheckCommand('snapshot')).toContain('S files')
  expect(hostCheckCommand('check')).toContain('S updates')
})
