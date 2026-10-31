import { describe, it, expect } from 'vitest'
import { parseFirewalld, parseUfw, parseNft, parseIptables, parseFirewall, ruleMatchesPort, listenLines, questionPort, firewallQuote } from './firewall.js'

const FIREWALLD = `public (active)
  target: default
  icmp-block-inversion: no
  interfaces: eth0
  sources:
  services: cockpit dhcpv6-client ssh
  ports: 8080/tcp 60000-61000/udp
  protocols:
  forward: yes
  masquerade: no
  forward-ports: port=80:proto=tcp:toport=8080:toaddr=
  source-ports:
  icmp-blocks:
  rich rules:
	rule family="ipv4" source address="10.0.0.0/8" port port="3306" protocol="tcp" accept
	rule family="ipv4" source address="1.2.3.4" reject
`
const UFW = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    Anywhere
3306                       ALLOW IN    10.0.0.0/8
Anywhere                   DENY IN     1.2.3.4
OpenSSH                    LIMIT IN    Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
25                         DENY OUT    Anywhere
22/tcp on eth0             ALLOW IN    Anywhere
Anywhere on eth1           DENY IN     1.2.3.4
`
const NFT = `table inet filter {
	set blocked {
		type ipv4_addr
		elements = { 5.6.7.8 }
	}
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		iif "lo" accept
		tcp dport 22 accept
		tcp dport { 80, 443 } counter packets 3 bytes 120 accept
		ip saddr 10.0.0.0/8 tcp dport 3306 accept
		ip saddr 1.2.3.4 drop
		udp dport 53 accept
		jump custom
		counter reject with icmpx type admin-prohibited
	}
	chain output { type filter hook output priority filter; policy accept; }
	chain custom {
		tcp dport 9000 accept
	}
}
`
const IPT = `-P INPUT DROP
-P FORWARD DROP
-P OUTPUT ACCEPT
-N DOCKER
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT
-A INPUT -s 10.0.0.0/8 -p tcp -m tcp --dport 3306 -j ACCEPT
-A INPUT -s 1.2.3.4/32 -j DROP
-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
-A INPUT ! -s 192.168.0.0/16 -p tcp --dport 6379 -j REJECT --reject-with icmp-port-unreachable
-A FORWARD -o docker0 -j DOCKER
-A OUTPUT -p tcp --dport 25 -j DROP`

describe('firewalld', () => {
  it('服务 / 端口 / 转发 / rich rule / 默认策略', () => {
    const r = parseFirewalld('public', FIREWALLD)
    expect(r.rules.map((x) => x.text)).toEqual([
      '允许任何地址访问 9090/tcp（服务 cockpit）',
      '允许任何地址访问 546/udp（服务 dhcpv6-client）',
      '允许任何地址访问 22/tcp（服务 ssh）',
      '允许任何地址访问 8080/tcp',
      '允许任何地址访问 60000-61000/udp',
      '端口转发：80/tcp → 本机:8080',
      '允许 10.0.0.0/8 访问 3306/tcp',
      '拒绝 1.2.3.4 访问所有端口',
    ])
    expect(r.rules[6]).toMatchObject({ dir: 'in', action: 'allow', proto: 'tcp', port: '3306', source: '10.0.0.0/8', chain: 'public' })
    expect(r.policy[0]).toBe('区域 public（网卡 eth0）：未列出的入站拒绝（target default）')
  })
})

describe('ufw', () => {
  it('表格 + 默认策略', () => {
    const r = parseUfw(UFW)
    expect(r.active).toBe(true)
    expect(r.policy).toEqual(['默认入站：拒绝', '默认出站：允许', '默认转发：关闭'])
    expect(r.rules.map((x) => x.text)).toEqual([
      '允许任何地址访问 22/tcp',
      '允许任何地址访问 80,443/tcp',
      '允许 10.0.0.0/8 访问 3306',
      '拒绝 1.2.3.4 访问所有端口',
      '允许任何地址访问 22/tcp（应用 OpenSSH）（限速：30 秒内 6 次以上拒绝）',
      '允许任何地址访问 22/tcp（IPv6）',
      '拒绝本机访问 25',
      '允许任何地址访问 22/tcp（网卡 eth0）',
      '拒绝 1.2.3.4 访问所有端口（网卡 eth1）',
    ])
    expect(r.rules[6].dir).toBe('out')
    expect(r.rules.at(-1)).toMatchObject({ iface: 'eth1', dir: 'in', action: 'deny' })
  })
  it('未启用', () => expect(parseUfw('Status: inactive\n')).toMatchObject({ active: false, rules: [] }))
})

describe('nftables', () => {
  it('hook 链 / 策略 / 集合跳过 / 非 hook 链', () => {
    const r = parseNft(NFT)
    expect(r.policy).toEqual(['inet filter 的 input（入站）默认：丢弃', 'inet filter 的 output（出站）默认：允许'])
    expect(r.rules.map((x) => x.text)).toEqual([
      '允许已建立连接的回包（established / related）',
      '允许本机回环（lo）',
      '允许任何地址访问 22/tcp',
      '允许任何地址访问 80,443/tcp',
      '允许 10.0.0.0/8 访问 3306/tcp',
      '拒绝 1.2.3.4 访问所有端口',
      '允许任何地址访问 53/udp',
      '转到链 custom',
      '拒绝任何地址访问所有端口',
      '允许任何地址访问 9000/tcp',
    ])
    expect(r.rules.at(-1)).toMatchObject({ dir: 'other', chain: 'inet filter custom' })
    expect(r.rules[8].action).toBe('reject')
  })
})

describe('iptables -S', () => {
  it('策略 / 规则 / 取反 / 跳转', () => {
    const r = parseIptables(IPT)
    expect(r.policy).toEqual(['入站默认（INPUT）：丢弃', '转发默认（FORWARD）：丢弃', '出站默认（OUTPUT）：允许'])
    expect(r.rules.map((x) => x.text)).toEqual([
      '允许本机回环（lo）',
      '允许已建立连接的回包（ESTABLISHED / RELATED）',
      '允许任何地址访问 22/tcp',
      '允许 10.0.0.0/8 访问 3306/tcp',
      '拒绝 1.2.3.4 访问所有端口',
      '允许任何地址访问 80,443/tcp',
      '拒绝 非 192.168.0.0/16 访问 6379/tcp',
      '转到链 DOCKER',
      '拒绝本机访问 25/tcp',
    ])
  })
})

describe('parseFirewall', () => {
  it('多工具：primary 选在用的那个；ss 段；权限不足', () => {
    const out = [
      '@@tool:firewalld', '@@state:not running',
      '@@tool:nft', NFT,
      '@@tool:iptables', 'sudo: a password is required', '@@part:L', 'sudo: a password is required',
      '@@ss', 'tcp   LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))', 'tcp   LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("java",pid=9,fd=3))',
    ].join('\n')
    const r = parseFirewall(out)
    expect(r.primary).toBe('nft')
    expect(r.sections.map((s) => [s.tool, s.active, !!s.denied])).toEqual([['nft', true, false], ['firewalld', false, false], ['iptables', false, true]])
    expect(r.sections[1].policy).toEqual(['firewalld 没在运行（not running）'])
    expect(listenLines(r.listen, 8080)).toEqual(['tcp   LISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("java",pid=9,fd=3))'])
    expect(listenLines(r.listen, 9999)).toEqual([])
  })
  it('firewalld 在跑：按 zone 收集', () => {
    const r = parseFirewall(`@@tool:firewalld\n@@state:running\n@@zone:public\n${FIREWALLD}@@ss\n`)
    expect(r.primary).toBe('firewalld')
    expect(r.sections[0].rules).toHaveLength(8)
    expect(r.sections[0].raw).toContain('# zone public')
  })
  it('什么都没有', () => expect(parseFirewall('@@ss\n')).toEqual({ sections: [], listen: '', primary: undefined }))
})

describe('端口辅助', () => {
  it('ruleMatchesPort / questionPort', () => {
    const r = parseIptables(IPT).rules
    expect(r.filter((x) => ruleMatchesPort(x, 443)).map((x) => x.raw)).toContain('-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT')
    expect(ruleMatchesPort({ dir: 'in', action: 'allow', port: '60000-61000', text: '', raw: '' }, 60500)).toBe(true)
    expect(questionPort('为什么 8080 外部访问不了')).toBe(8080)
    expect(questionPort('3306端口连不上')).toBe(3306)
    expect(questionPort('1.2.3.4 连不上')).toBeUndefined()
    expect(questionPort('没有端口')).toBeUndefined()
  })
  it('问 AI 引用：问题 + 规则原文 + 监听', () => {
    const list = parseFirewall(`@@tool:iptables\n${IPT}\n@@part:L\nChain INPUT\n@@ss\ntcp LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*`)
    const q = firewallQuote({ host: 'web-1', question: '为什么 8080 外部访问不了', list, port: 8080 })
    expect(q).toContain('为什么 8080 外部访问不了')
    expect(q).toContain('-P INPUT DROP')
    expect(q).toContain('127.0.0.1:8080')
    expect(firewallQuote({ host: 'h', question: 'q', list, port: 1 })).toContain('没有程序在端口 1 上监听')
  })
})
