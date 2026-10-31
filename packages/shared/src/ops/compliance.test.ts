import { describe, it, expect } from 'vitest'
import { LINUX_BASELINE, complianceCommand, parseCompliance, complianceSummary, complianceScore, complianceCsv, enabledItems, sshdConfig, type ComplianceItem } from './compliance.js'

const item = (id: string) => LINUX_BASELINE.find((i) => i.id === id)!
const judge = (id: string, text: string) => item(id).judge(text.split('\n'))

describe('基线条目', () => {
  it('约 15 条、id 唯一、每条有修复建议；建议级只有 SSH 端口 / tmp / ip_forward', () => {
    expect(LINUX_BASELINE.length).toBeGreaterThanOrEqual(15)
    expect(new Set(LINUX_BASELINE.map((i) => i.id)).size).toBe(LINUX_BASELINE.length)
    expect(LINUX_BASELINE.every((i) => i.fix && i.title)).toBe(true)
    expect(LINUX_BASELINE.filter((i) => i.advisory).map((i) => i.id)).toEqual(['ssh_port', 'tmp_mount', 'ip_forward'])
  })
  it('采集命令：只读、无单引号（整段在 sh -c 里）、只带启用条目的段；不用 sudo', () => {
    const all = complianceCommand()
    const body = all.slice("sh -c '".length, -1)
    expect(body).not.toContain("'")
    expect(all).not.toMatch(/\bsudo\b|\brm\b|chmod|sed -i|>\s*\/etc/)
    const one = complianceCommand([item('uid0')])
    expect(one).toContain('S uid0')
    expect(one).not.toContain('S ssh')
    expect(enabledItems(['uid0', 'aslr']).map((i) => i.id)).not.toContain('uid0')
  })
})

describe('判定规则', () => {
  it('sshd：Match 块之后不算；没写的用默认值；root 密码登录 / 端口', () => {
    expect(sshdConfig(['@@src:config', 'PermitRootLogin yes', 'Match User git', 'PasswordAuthentication no'])).toMatchObject({ permitrootlogin: 'yes', passwordauthentication: 'yes', port: '22', source: '配置文件' })
    expect(judge('ssh_root_password', '@@src:sshd-T\npermitrootlogin yes\npasswordauthentication yes').status).toBe('fail')
    expect(judge('ssh_root_password', '@@src:sshd-T\npermitrootlogin yes\npasswordauthentication no').status).toBe('pass')
    expect(judge('ssh_root_password', '@@src:config\n#PermitRootLogin yes').detail).toContain('prohibit-password')
    expect(judge('ssh_root_password', '@@none').status).toBe('unknown')
    expect(judge('ssh_port', '@@src:sshd-T\nport 22').status).toBe('warn')
    expect(judge('ssh_port', '@@src:sshd-T\nport 2222').status).toBe('pass')
  })
  it('空密码 / UID 0 / 全局可写 / sudo：读不到判无法判断', () => {
    expect(judge('empty_password', '@@noread').status).toBe('unknown')
    expect(judge('empty_password', 'guest\n@@ok')).toEqual({ status: 'fail', detail: '空密码账户：guest' })
    expect(judge('empty_password', '@@ok').status).toBe('pass')
    expect(judge('uid0', 'root\ntoor\n@@ok').detail).toBe('UID 0 账户：toor')
    expect(judge('uid0', 'root\n@@ok').status).toBe('pass')
    expect(judge('uid0', '').status).toBe('unknown')
    expect(judge('etc_world_writable', '/etc/a.conf\n@@ok').status).toBe('fail')
    expect(judge('etc_world_writable', '@@ok').status).toBe('pass')
    expect(judge('sudo_nopasswd', 'ops ALL=(ALL) NOPASSWD: ALL\n@@ok').status).toBe('fail')
    expect(judge('sudo_nopasswd', 'deploy ALL=(root) NOPASSWD: /bin/systemctl restart app\n@@ok').status).toBe('warn')
    expect(judge('sudo_nopasswd', '@@ok').status).toBe('pass')
    expect(judge('sudo_nopasswd', '@@noread').status).toBe('unknown')
  })
  it('防火墙：任一在拦即通过（只看入站）；只有 root 才能看的判无法判断；默认允许只算建议', () => {
    expect(judge('firewall', 'firewalld=active').status).toBe('pass')
    expect(judge('firewall', 'firewalld=inactive\nufw=Status: active').status).toBe('pass')
    expect(judge('firewall', 'firewalld=inactive\nnft=drop').status).toBe('pass')
    expect(judge('firewall', 'firewalld=inactive\niptables=drop\nnft=none').status).toBe('pass')
    expect(judge('firewall', 'firewalld=inactive\niptables=rules').status).toBe('pass')
    // Docker 只往 FORWARD / nat 里加规则：入站没有规则不算防火墙已启用
    expect(judge('firewall', 'firewalld=inactive\niptables=none\nnft=accept').status).toBe('warn')
    expect(judge('firewall', 'firewalld=inactive\niptables=none\nnft=none').status).toBe('fail')
    expect(judge('firewall', 'firewalld=inactive\niptables=@@err').status).toBe('unknown')
    expect(judge('firewall', '').status).toBe('unknown')
  })
  it('自动更新 / 时间同步 / auditd / MAC / 日志轮转', () => {
    expect(judge('auto_updates', 'dnf-automatic.timer=disabled\ndnf-automatic-install.timer=enabled').status).toBe('pass')
    expect(judge('auto_updates', 'unattended-upgrades.service=enabled\nAPT::Periodic::Unattended-Upgrade "1";').status).toBe('pass')
    expect(judge('auto_updates', 'dnf-automatic.timer=disabled').status).toBe('fail')
    expect(judge('time_sync', 'chronyd=active\nntpd=inactive').status).toBe('pass')
    expect(judge('time_sync', 'chronyd=inactive\nsystemd-timesyncd=inactive').status).toBe('fail')
    expect(judge('time_sync', '').status).toBe('unknown')
    expect(judge('auditd', 'auditd=active').status).toBe('pass')
    expect(judge('auditd', 'auditd=inactive').status).toBe('fail')
    expect(judge('auditd', '@@none').status).toBe('unknown')
    expect(judge('mac', 'selinux=Enforcing\n@@ok').status).toBe('pass')
    expect(judge('mac', 'apparmor=Y\n@@ok').status).toBe('pass')
    expect(judge('mac', 'selinux=Permissive\n@@ok').status).toBe('warn')
    expect(judge('mac', 'selinux=Disabled\n@@ok').status).toBe('fail')
    expect(judge('logrotate', 'bin=yes\nconf=yes\ntimer=enabled').status).toBe('pass')
    expect(judge('logrotate', 'bin=yes\nconf=yes\ncron=yes').status).toBe('pass')
    expect(judge('logrotate', 'bin=yes\nconf=yes\ntimer=disabled').status).toBe('warn')
    expect(judge('logrotate', 'timer=disabled').status).toBe('fail')
  })
  it('/tmp / 密码策略 / 内核参数', () => {
    expect(judge('tmp_mount', 'tmpfs /tmp tmpfs rw,nosuid,nodev,noexec 0 0\n@@ok').detail).toContain('noexec')
    expect(judge('tmp_mount', '@@ok').status).toBe('warn')
    expect(judge('password_policy', '@@logindefs\nPASS_MAX_DAYS 90\nminlen = 10').status).toBe('pass')
    expect(judge('password_policy', '@@logindefs\nPASS_MAX_DAYS   99999')).toEqual({ status: 'fail', detail: '密码有效期 99999 天；未设密码最短长度' })
    expect(judge('password_policy', '@@logindefs\nPASS_MAX_DAYS 60\npassword requisite pam_pwquality.so retry=3 minlen=6').detail).toBe('最短长度 6')
    expect(judge('password_policy', '').status).toBe('unknown')
    expect(judge('ip_forward', 'net/ipv4/ip_forward=1\n@@ok').status).toBe('warn')
    expect(judge('ip_forward', 'net/ipv4/ip_forward=0\n@@ok').status).toBe('pass')
    expect(judge('icmp_redirects', 'net/ipv4/conf/all/accept_redirects=1\n@@ok').status).toBe('fail')
    expect(judge('aslr', 'kernel/randomize_va_space=2\n@@ok').status).toBe('pass')
    expect(judge('aslr', '@@ok').status).toBe('unknown')
  })
})

describe('解析 / 汇总 / 导出', () => {
  const items: ComplianceItem[] = [item('uid0'), item('aslr'), item('auditd')]
  it('按段分发；段缺失（超时截断）= 无法判断', () => {
    const out = '@@cc:uid0\nroot\n@@ok\r\n@@cc:sysctl\nkernel/randomize_va_space=1\n@@ok\n'
    const r = parseCompliance(out, items)
    expect(r.map((x) => [x.id, x.status])).toEqual([['uid0', 'pass'], ['aslr', 'fail'], ['auditd', 'unknown']])
    expect(r[2].detail).toContain('超时')
    expect(complianceSummary(r)).toEqual({ pass: 1, fail: 1, warn: 0, unknown: 1 })
    expect(complianceScore(r)).toBe(50)
    expect(complianceScore([])).toBeUndefined()
  })
  it('CSV：BOM + 表头 + 每台一行，含逗号 / 引号的转义；连接失败的整行写错误', () => {
    const csv = complianceCsv([
      { hostId: 'a', label: 'web,1', at: 't1', results: [{ id: 'uid0', status: 'fail', detail: 'UID 0 账户："x"' }, { id: 'aslr', status: 'pass', detail: 'ok' }, { id: 'auditd', status: 'unknown', detail: '?' }] },
      { hostId: 'b', label: 'db', at: 't2', error: '连接失败', results: [] },
    ], items)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1).startsWith('主机,')).toBe(true)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('"web,1","不通过：UID 0 账户：""x""",通过：ok,无法判断：?,1,1,0,1,t1')
    expect(lines[2]).toContain('错误：连接失败')
  })
})
