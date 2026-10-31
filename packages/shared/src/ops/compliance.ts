// ── 基线合规检查（内置 Linux 基线）────────────────────────
// 每条：只读检查（脚本段）+ 判定规则（纯函数）+ 严重度 + 修复建议（只给建议命令，不自动修）。
// 采集同主机体检：sh -c '...' 一次跑完，走独立 exec channel，不用 sudo；读不到（如 /etc/shadow 需要 root）的判「无法判断」。
// $R 是文件路径前缀（远端恒为空；回环测试把假文件放临时目录用 LINGSHELL_HC_ROOT 指过去），脚本里不能有单引号。

import { tk, tr } from '../i18n/i18n.js'

export type ComplianceStatus = 'pass' | 'fail' | 'warn' | 'unknown'
export type ComplianceSeverity = 'high' | 'medium' | 'low'
export interface ComplianceVerdict { status: ComplianceStatus; detail: string }
export interface ComplianceItem {
  id: string; title: string; severity: ComplianceSeverity
  advisory?: boolean       // 建议级：不满足只算「建议」（warn），不算不通过
  section: string          // 用哪段采集输出（几条可共用一段）
  fix: string              // 修复建议（命令仅供参考，需人工确认后执行）
  judge(lines: string[]): ComplianceVerdict
}
export interface ComplianceResult { id: string; status: ComplianceStatus; detail: string }
export interface ComplianceHostRow { hostId: string; label: string; error?: string; results: ComplianceResult[]; at: string }

export const COMPLIANCE_TIMEOUT_MS = 40_000
export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = { pass: tk('通过'), fail: tk('不通过'), warn: tk('建议'), unknown: tk('无法判断') }
export const COMPLIANCE_SEVERITY_LABEL: Record<ComplianceSeverity, string> = { high: tk('高'), medium: tk('中'), low: tk('低') }

const SEC = '@@cc:'
const HEAD = [
  'exec 2>/dev/null',
  'export LC_ALL=C',
  'R="${LINGSHELL_HC_ROOT:-}"',
  'T() { s=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; else "$@"; fi; }',
  'S() { echo "' + SEC + '$1"; }',
  'HAS() { command -v "$1" >/dev/null 2>&1; }',
]
// 各段采集脚本（只读）
const SECTIONS: Record<string, string[]> = {
  ssh: [
    'D=$(command -v sshd || echo /usr/sbin/sshd)',
    'if o=$(T 5 "$D" -T) && [ -n "$o" ]; then echo "@@src:sshd-T"; printf "%s\\n" "$o" | grep -Ei "^(permitrootlogin|passwordauthentication|port) "',
    // sshd -T 跑不了（非 root / 没有 sshd）时读配置文件；sshd_config.d/*.conf 通常是 Include 在文件开头，先读（首个值生效）
    'elif [ -r $R/etc/ssh/sshd_config ]; then echo "@@src:config"; for f in $R/etc/ssh/sshd_config.d/*.conf; do [ -r "$f" ] && grep -Ei "^[[:space:]]*(permitrootlogin|passwordauthentication|port|match)[[:space:]]" "$f"; done; grep -Ei "^[[:space:]]*(permitrootlogin|passwordauthentication|port|match)[[:space:]]" $R/etc/ssh/sshd_config',
    'else echo "@@none"; fi',
  ],
  shadow: ['if [ -r $R/etc/shadow ]; then cut -d: -f1,2 $R/etc/shadow | grep ":$" | cut -d: -f1; echo "@@ok"; else echo "@@noread"; fi'],
  // 只看入站是否真的在拦：Docker 也会往 iptables / nftables 里塞规则，按「总规则数 > 0」判会把没开防火墙的主机误判成通过
  fw: [
    'HAS systemctl && echo "firewalld=$(T 3 systemctl is-active firewalld)"',
    'if HAS ufw; then if o=$(T 3 ufw status); then echo "ufw=$(printf "%s\\n" "$o" | head -n 1)"; else echo "ufw=@@err"; fi; fi',
    'if HAS nft; then if o=$(T 3 nft list ruleset); then if printf "%s\\n" "$o" | grep "hook input" | grep -q "policy drop"; then echo "nft=drop"; elif printf "%s\\n" "$o" | grep -q "hook input"; then echo "nft=accept"; else echo "nft=none"; fi; else echo "nft=@@err"; fi; fi',
    'if HAS iptables; then if o=$(T 3 iptables -S); then p=$(printf "%s\\n" "$o" | sed -n "s/^-P INPUT //p"); n=$(printf "%s\\n" "$o" | grep -c "^-A INPUT"); if [ "$p" = DROP ] || [ "$p" = REJECT ]; then echo "iptables=drop"; elif [ "$n" -gt 0 ]; then echo "iptables=rules"; else echo "iptables=none"; fi; else echo "iptables=@@err"; fi; fi',
  ],
  autoupd: [
    'HAS systemctl && for u in dnf-automatic.timer dnf-automatic-install.timer yum-cron.service unattended-upgrades.service; do echo "$u=$(T 3 systemctl is-enabled $u)"; done',
    '[ -r $R/etc/apt/apt.conf.d/20auto-upgrades ] && grep -h "Unattended-Upgrade" $R/etc/apt/apt.conf.d/20auto-upgrades',
  ],
  tmp: ['grep -E "^[^ ]+ /tmp " $R/proc/mounts; echo "@@ok"'],
  time: [
    'HAS systemctl && for u in chronyd chrony ntpd ntp systemd-timesyncd; do echo "$u=$(T 3 systemctl is-active $u)"; done',
    'HAS timedatectl && echo "synced=$(T 3 timedatectl show -p NTPSynchronized --value)"',
  ],
  uid0: ['[ -r $R/etc/passwd ] && { grep -E "^[^:]*:[^:]*:0:" $R/etc/passwd | cut -d: -f1; echo "@@ok"; }'],
  pwpolicy: [
    '[ -r $R/etc/login.defs ] && { echo "@@logindefs"; grep -E "^[[:space:]]*PASS_MAX_DAYS" $R/etc/login.defs; }',
    'cat $R/etc/security/pwquality.conf $R/etc/security/pwquality.conf.d/*.conf | grep -E "^[[:space:]]*minlen"',
    'cat $R/etc/pam.d/system-auth $R/etc/pam.d/common-password | grep -E "^[^#]*pam_(pwquality|cracklib)\\.so.*minlen"',
  ],
  auditd: ['if HAS systemctl; then echo "auditd=$(T 3 systemctl is-active auditd)"; else echo "@@none"; fi'],
  mac: [
    'HAS getenforce && echo "selinux=$(T 3 getenforce)"',
    '[ -r $R/sys/module/apparmor/parameters/enabled ] && echo "apparmor=$(cat $R/sys/module/apparmor/parameters/enabled)"',
    'echo "@@ok"',
  ],
  logrotate: [
    'HAS logrotate && echo "bin=yes"',
    '[ -r $R/etc/logrotate.conf ] && echo "conf=yes"',
    'HAS systemctl && echo "timer=$(T 3 systemctl is-enabled logrotate.timer)"',
    '[ -f $R/etc/cron.daily/logrotate ] && echo "cron=yes"',
  ],
  wwetc: ['T 10 find $R/etc -xdev -type f -perm -0002 | head -n 20 | sed "s|^$R||"; echo "@@ok"'],
  sudoers: ['if [ -r $R/etc/sudoers ]; then cat $R/etc/sudoers $R/etc/sudoers.d/* | grep -E "^[^#]*NOPASSWD"; echo "@@ok"; else echo "@@noread"; fi'],
  sysctl: ['for k in net/ipv4/ip_forward net/ipv4/conf/all/accept_redirects kernel/randomize_va_space; do [ -r $R/proc/sys/$k ] && echo "$k=$(cat $R/proc/sys/$k)"; done; echo "@@ok"'],
}

// ── 判定辅助 ──
const kvOf = (lines: string[]) => {
  const o: Record<string, string> = {}
  for (const l of lines) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim() }
  return o
}
const has = (lines: string[], tag: string) => lines.some((l) => l.trim() === tag)
const v = (status: ComplianceStatus, detail: string): ComplianceVerdict => ({ status, detail })
const NO_DATA = () => v('unknown', tr('没有取到检查结果'))

/** sshd 生效配置（sshd -T 或配置文件；Match 块里的只对部分用户生效，不算全局；没写的取 OpenSSH 默认值） */
export function sshdConfig(lines: string[]): { permitrootlogin: string; passwordauthentication: string; port: string; source: string } | undefined {
  if (!lines.length || has(lines, '@@none')) return undefined
  const o: Record<string, string> = {}
  for (const l of lines) {
    const t = l.trim().split(/\s+/)
    const k = t[0]?.toLowerCase()
    if (k === 'match') break
    if ((k === 'permitrootlogin' || k === 'passwordauthentication' || k === 'port') && t[1] && !(k in o)) o[k] = t[1].toLowerCase()
  }
  return { permitrootlogin: o.permitrootlogin ?? 'prohibit-password', passwordauthentication: o.passwordauthentication ?? 'yes', port: o.port ?? '22', source: has(lines, '@@src:sshd-T') ? 'sshd -T' : tr('配置文件') }
}
const sysctlOf = (lines: string[], key: string) => kvOf(lines)[key]

export const LINUX_BASELINE: ComplianceItem[] = [
  {
    id: 'ssh_root_password', title: tk('禁止 root 用密码登录 SSH'), severity: 'high', section: 'ssh',
    fix: tk('编辑 /etc/ssh/sshd_config：PermitRootLogin prohibit-password（或 no），确认能用普通用户 / 密钥登录后执行 sshd -t && systemctl reload sshd'),
    judge(l) {
      const c = sshdConfig(l)
      if (!c) return v('unknown', tr('读不到 sshd 配置'))
      const ok = ['no', 'prohibit-password', 'without-password', 'forced-commands-only'].includes(c.permitrootlogin)
      if (ok) return v('pass', tr('PermitRootLogin {v}（{src}）', { v: c.permitrootlogin, src: c.source }))
      if (c.passwordauthentication === 'no') return v('pass', tr('PermitRootLogin yes，但已关闭密码登录（{src}）', { src: c.source }))
      return v('fail', tr('PermitRootLogin yes + PasswordAuthentication {v}（{src}）', { v: c.passwordauthentication, src: c.source }))
    },
  },
  {
    id: 'empty_password', title: tk('没有空密码账户'), severity: 'high', section: 'shadow',
    fix: tk('给这些账户设密码（passwd 用户名）或锁定（passwd -l 用户名）'),
    judge(l) {
      if (has(l, '@@noread')) return v('unknown', tr('读取 /etc/shadow 需要 root 权限'))
      if (!has(l, '@@ok')) return NO_DATA()
      const users = l.filter((x) => x.trim() && !x.startsWith('@@'))
      return users.length ? v('fail', tr('空密码账户：{v}', { v: users.join(tr('、')) })) : v('pass', tr('没有空密码账户'))
    },
  },
  {
    id: 'ssh_port', title: tk('SSH 不用默认端口 22'), severity: 'low', advisory: true, section: 'ssh',
    fix: tk('编辑 /etc/ssh/sshd_config 的 Port（同时放通防火墙 / 安全组、SELinux 用 semanage port -a -t ssh_port_t -p tcp 新端口），sshd -t && systemctl reload sshd'),
    judge(l) {
      const c = sshdConfig(l)
      if (!c) return v('unknown', tr('读不到 sshd 配置'))
      return c.port === '22' ? v('warn', tr('使用默认端口 22（改端口可减少扫描噪音）')) : v('pass', tr('端口 {port}', { port: c.port }))
    },
  },
  {
    id: 'firewall', title: tk('防火墙已启用'), severity: 'high', section: 'fw',
    fix: tk('RHEL 系：systemctl enable --now firewalld；Debian / Ubuntu：ufw allow OpenSSH && ufw enable（先放通 SSH 再启用）'),
    judge(l) {
      const o = kvOf(l)
      if (o.firewalld === 'active') return v('pass', tr('firewalld 运行中'))
      if (/^Status:\s*active/i.test(o.ufw ?? '')) return v('pass', tr('ufw 已启用'))
      if (o.nft === 'drop') return v('pass', tr('nftables 入站默认丢弃'))
      if (o.iptables === 'drop') return v('pass', tr('iptables 入站默认丢弃'))
      if (o.iptables === 'rules') return v('pass', tr('iptables 有入站规则'))
      if (!Object.keys(o).length) return v('unknown', tr('没有 firewalld / ufw / nft / iptables'))
      if (Object.values(o).includes('@@err')) return v('unknown', tr('firewalld 未运行；iptables / nft / ufw 需要 root 才能查看'))
      if (o.nft === 'accept') return v('warn', tr('nftables 有入站链，但默认策略是允许（policy accept），规则可能没有实际拦截效果'))
      return v('fail', tr('没有发现启用的防火墙（firewalld / ufw 都没运行，iptables 入站默认允许且没有入站规则）'))
    },
  },
  {
    id: 'auto_updates', title: tk('自动安全更新'), severity: 'medium', section: 'autoupd',
    fix: tk('RHEL 系：dnf install dnf-automatic && 把 /etc/dnf/automatic.conf 的 upgrade_type 设为 security、apply_updates = yes，然后 systemctl enable --now dnf-automatic.timer；Debian / Ubuntu：apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades'),
    judge(l) {
      const o = kvOf(l)
      const on = ['dnf-automatic.timer', 'dnf-automatic-install.timer', 'yum-cron.service'].find((u) => o[u] === 'enabled')
      if (on) return v('pass', tr('{name} 已启用', { name: on }))
      if (l.some((x) => /Unattended-Upgrade\s+"1"/.test(x))) return v('pass', tr('unattended-upgrades 已开启'))
      return v('fail', tr('没有启用 dnf-automatic / yum-cron / unattended-upgrades'))
    },
  },
  {
    id: 'tmp_mount', title: tk('/tmp 独立挂载（最好 noexec）'), severity: 'low', advisory: true, section: 'tmp',
    fix: tk('systemctl enable --now tmp.mount，或在 /etc/fstab 加：tmpfs /tmp tmpfs defaults,nosuid,nodev,noexec 0 0（先评估是否有程序需要在 /tmp 执行）'),
    judge(l) {
      if (!has(l, '@@ok')) return NO_DATA()
      const m = l.find((x) => / \/tmp /.test(x))
      if (!m) return v('warn', tr('/tmp 不是独立挂载（和 / 共用）'))
      const opts = m.trim().split(/\s+/)[3] ?? ''
      return opts.split(',').includes('noexec') ? v('pass', tr('独立挂载（{opts}）', { opts })) : v('pass', tr('独立挂载，未设 noexec（{opts}）', { opts }))
    },
  },
  {
    id: 'time_sync', title: tk('时间同步（chronyd / ntpd）'), severity: 'medium', section: 'time',
    fix: tk('RHEL 系：dnf install chrony && systemctl enable --now chronyd；Debian / Ubuntu：apt install chrony（或 timedatectl set-ntp true 用 systemd-timesyncd）'),
    judge(l) {
      const o = kvOf(l)
      const on = ['chronyd', 'chrony', 'ntpd', 'ntp', 'systemd-timesyncd'].find((u) => o[u] === 'active')
      if (on) return v('pass', tr('{name} 运行中', { name: on }) + (o.synced === 'no' ? tr('（尚未同步）') : ''))
      if (!Object.keys(o).length) return v('unknown', tr('没有 systemctl，无法判断'))
      return v('fail', tr('没有运行中的时间同步服务'))
    },
  },
  {
    id: 'uid0', title: tk('除 root 外没有 UID 0 账户'), severity: 'high', section: 'uid0',
    fix: tk('确认来源后删除或改 UID：userdel 用户名，或 usermod -u 新UID 用户名（先查清是否被入侵植入）'),
    judge(l) {
      if (!has(l, '@@ok')) return NO_DATA()
      const extra = l.map((x) => x.trim()).filter((x) => x && !x.startsWith('@@') && x !== 'root')
      return extra.length ? v('fail', tr('UID 0 账户：{v}', { v: extra.join(tr('、')) })) : v('pass', tr('只有 root'))
    },
  },
  {
    id: 'password_policy', title: tk('密码策略（有效期 ≤ 90 天、最短 8 位）'), severity: 'medium', section: 'pwpolicy',
    fix: tk('/etc/login.defs 设 PASS_MAX_DAYS 90（已有账户：chage -M 90 用户名）；/etc/security/pwquality.conf 设 minlen = 8（或更长）'),
    judge(l) {
      if (!has(l, '@@logindefs')) return v('unknown', tr('读不到 /etc/login.defs'))
      const days = Number(/PASS_MAX_DAYS\s+(\d+)/.exec(l.join('\n'))?.[1] ?? 99999)
      const lens = [...l.join('\n').matchAll(/minlen\s*=\s*(\d+)/g)].map((m) => Number(m[1]))
      const minlen = lens.length ? Math.max(...lens) : undefined
      const bad = [...(days > 90 ? [tr('密码有效期 {n} 天', { n: days })] : []), ...(minlen === undefined ? [tr('未设密码最短长度')] : minlen < 8 ? [tr('最短长度 {n}', { n: minlen })] : [])]
      return bad.length ? v('fail', bad.join(tr('；'))) : v('pass', tr('有效期 {days} 天，最短 {len} 位', { days, len: String(minlen) }))
    },
  },
  {
    id: 'auditd', title: tk('审计服务 auditd 运行中'), severity: 'medium', section: 'auditd',
    fix: tk('RHEL 系：dnf install audit && systemctl enable --now auditd；Debian / Ubuntu：apt install auditd'),
    judge(l) {
      if (has(l, '@@none')) return v('unknown', tr('没有 systemctl，无法判断'))
      const s = kvOf(l).auditd
      if (s === undefined) return NO_DATA()
      return s === 'active' ? v('pass', tr('auditd 运行中')) : v('fail', `auditd ${s || tr('未安装')}`)
    },
  },
  {
    id: 'mac', title: tk('SELinux / AppArmor 已启用'), severity: 'medium', section: 'mac',
    fix: tk('SELinux：/etc/selinux/config 设 SELINUX=enforcing 后重启（先 permissive 观察 audit 日志）；AppArmor：systemctl enable --now apparmor'),
    judge(l) {
      if (!has(l, '@@ok')) return NO_DATA()
      const o = kvOf(l)
      if (o.selinux === 'Enforcing') return v('pass', 'SELinux Enforcing')
      if (o.apparmor === 'Y') return v('pass', tr('AppArmor 已启用'))
      if (o.selinux === 'Permissive') return v('warn', tr('SELinux 是 Permissive（只记录不拦截）'))
      return v('fail', o.selinux ? `SELinux ${o.selinux}` : tr('没有启用 SELinux 或 AppArmor'))
    },
  },
  {
    id: 'logrotate', title: tk('日志轮转已配置'), severity: 'low', section: 'logrotate',
    fix: tk('安装 logrotate（dnf / apt install logrotate），确认 /etc/logrotate.conf 存在且 logrotate.timer 或 /etc/cron.daily/logrotate 在跑：systemctl enable --now logrotate.timer'),
    judge(l) {
      const o = kvOf(l)
      if (o.bin !== 'yes' || o.conf !== 'yes') return v('fail', o.bin === 'yes' ? tr('缺少 /etc/logrotate.conf') : tr('没有 logrotate'))
      if (o.timer === 'enabled' || o.timer === 'static' || o.cron === 'yes') return v('pass', o.cron === 'yes' ? tr('每日 cron 轮转') : tr('logrotate.timer 已启用'))
      return v('warn', tr('装了 logrotate，但没发现定时任务（timer / cron.daily）'))
    },
  },
  {
    id: 'etc_world_writable', title: tk('/etc 下没有全局可写文件'), severity: 'high', section: 'wwetc',
    fix: tk('逐个确认后去掉其他用户写权限：chmod o-w 文件路径'),
    judge(l) {
      if (!has(l, '@@ok')) return NO_DATA()
      const files = l.map((x) => x.trim()).filter((x) => x && !x.startsWith('@@'))
      return files.length ? v('fail', tr('全局可写：{v}', { v: files.slice(0, 5).join(tr('、')) }) + (files.length > 5 ? tr(' 等 {n} 个', { n: files.length }) : '')) : v('pass', tr('没有全局可写文件'))
    },
  },
  {
    id: 'sudo_nopasswd', title: tk('sudo 免密范围受限'), severity: 'medium', section: 'sudoers',
    fix: tk('visudo 编辑 /etc/sudoers（或 /etc/sudoers.d/ 下的文件）：去掉 NOPASSWD: ALL，免密只给具体命令'),
    judge(l) {
      if (has(l, '@@noread')) return v('unknown', tr('读取 /etc/sudoers 需要 root 权限'))
      if (!has(l, '@@ok')) return NO_DATA()
      const rules = l.map((x) => x.trim()).filter((x) => x && !x.startsWith('@@'))
      const all = rules.filter((x) => /NOPASSWD:\s*ALL\b/.test(x))
      if (all.length) return v('fail', tr('免密执行任意命令：{v}', { v: all.slice(0, 3).join(tr('；')) }))
      return rules.length ? v('warn', tr('有 {n} 条免密规则（限定了命令）', { n: rules.length })) : v('pass', tr('没有免密 sudo'))
    },
  },
  {
    id: 'ip_forward', title: tk('内核参数：关闭 IP 转发（net.ipv4.ip_forward）'), severity: 'low', advisory: true, section: 'sysctl',
    fix: tk('非路由 / 容器主机：echo "net.ipv4.ip_forward = 0" > /etc/sysctl.d/90-baseline.conf && sysctl --system（跑 Docker / K8s 的主机需要开着，可在设置里关掉这条）'),
    judge(l) {
      const x = sysctlOf(l, 'net/ipv4/ip_forward')
      if (x === undefined) return NO_DATA()
      return x === '0' ? v('pass', 'ip_forward = 0') : v('warn', tr('ip_forward = 1（容器 / 路由主机需要，可忽略）'))
    },
  },
  {
    id: 'icmp_redirects', title: tk('内核参数：不接受 ICMP 重定向'), severity: 'low', section: 'sysctl',
    fix: 'echo "net.ipv4.conf.all.accept_redirects = 0" >> /etc/sysctl.d/90-baseline.conf && sysctl --system',
    judge(l) {
      const x = sysctlOf(l, 'net/ipv4/conf/all/accept_redirects')
      if (x === undefined) return NO_DATA()
      return x === '0' ? v('pass', 'accept_redirects = 0') : v('fail', `accept_redirects = ${x}`)
    },
  },
  {
    id: 'aslr', title: tk('内核参数：地址空间随机化（ASLR）全开'), severity: 'medium', section: 'sysctl',
    fix: 'echo "kernel.randomize_va_space = 2" >> /etc/sysctl.d/90-baseline.conf && sysctl --system',
    judge(l) {
      const x = sysctlOf(l, 'kernel/randomize_va_space')
      if (x === undefined) return NO_DATA()
      return x === '2' ? v('pass', 'randomize_va_space = 2') : v('fail', `randomize_va_space = ${x}`)
    },
  },
]

/** 启用的条目（disabled = 设置里关掉的 id） */
export const enabledItems = (disabled: readonly string[] = []) => LINUX_BASELINE.filter((i) => !disabled.includes(i.id))

/** 采集命令：只跑启用条目用到的段 */
export function complianceCommand(items: ComplianceItem[] = LINUX_BASELINE): string {
  const secs = [...new Set(items.map((i) => i.section))]
  const body = [...HEAD, ...secs.flatMap((s) => [`S ${s}`, ...SECTIONS[s]])]
  return `sh -c '${body.join('\n')}'`
}

/** 采集输出 → 各条结果（段缺失 = 无法判断，如超时被截断） */
export function parseCompliance(out: string, items: ComplianceItem[] = LINUX_BASELINE): ComplianceResult[] {
  const m = new Map<string, string[]>()
  let cur: string[] | undefined
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith(SEC)) { cur = []; m.set(line.slice(SEC.length).trim(), cur); continue }
    cur?.push(line)
  }
  return items.map((i) => {
    const lines = m.get(i.section)
    if (!lines) return { id: i.id, status: 'unknown', detail: tr('没有取到检查结果（可能超时）') }
    try { return { id: i.id, ...i.judge(lines) } } catch { return { id: i.id, status: 'unknown', detail: tr('结果无法解析') } }
  })
}

export function complianceSummary(rs: ComplianceResult[]): Record<ComplianceStatus, number> {
  const s: Record<ComplianceStatus, number> = { pass: 0, fail: 0, warn: 0, unknown: 0 }
  for (const r of rs) s[r.status]++
  return s
}

/** 通过率（通过 /（通过 + 不通过），建议级与无法判断不计） */
export const complianceScore = (rs: ComplianceResult[]) => { const s = complianceSummary(rs); return s.pass + s.fail ? Math.round((s.pass / (s.pass + s.fail)) * 100) : undefined }

const csvCell = (x: string) => (/[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)
/** 「主机 × 条目」矩阵导出 CSV（带 BOM，Excel 直接打开不乱码）：每格「状态：说明」，末尾汇总列 */
export function complianceCsv(rows: ComplianceHostRow[], items: ComplianceItem[] = LINUX_BASELINE): string {
  const head = [tr('主机'), ...items.map((i) => `${tr(i.title)}${tr('（{sev}）', { sev: tr(COMPLIANCE_SEVERITY_LABEL[i.severity]) + (i.advisory ? tr('，建议级') : '') })}`), tr('通过'), tr('不通过'), tr('建议'), tr('无法判断'), tr('检查时间')]
  const lines = rows.map((r) => {
    const by = new Map(r.results.map((x) => [x.id, x]))
    const s = complianceSummary(r.results)
    return [r.label, ...items.map((i) => { const x = by.get(i.id); return r.error ? tr('错误：{v}', { v: r.error }) : x ? `${tr(COMPLIANCE_STATUS_LABEL[x.status])}${tr('：')}${x.detail}` : '' }), String(s.pass), String(s.fail), String(s.warn), String(s.unknown), r.at]
  })
  return '﻿' + [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
