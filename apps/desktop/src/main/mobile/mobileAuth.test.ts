import { describe, it, expect } from 'vitest'
import { isPrivateIPv4, lanAddresses, pickBindAddress, bindAddressError, PairingGate, PAIR_TTL_MS, PAIR_LOCK_MS, hashToken, sameHash, newToken, deviceNameOf } from './mobileAuth.js'

describe('isPrivateIPv4', () => {
  it('只认 RFC1918', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '172.31.255.1', '192.168.1.20']) expect(isPrivateIPv4(ip)).toBe(true)
    for (const ip of ['0.0.0.0', '127.0.0.1', '169.254.1.1', '100.64.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '203.0.113.7', '192.169.0.1', '10.0.0.256', 'fe80::1', 'abc']) expect(isPrivateIPv4(ip)).toBe(false)
  })
})

describe('绑定地址', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '203.0.113.5', family: 'IPv4', internal: false }, { address: '192.168.1.8', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wlan: [{ address: '10.1.2.3', family: 'IPv4', internal: false }],
  } as never
  const list = lanAddresses(ifaces)
  it('只列非回环的私有 IPv4（公网地址不出现）', () => {
    expect(list).toEqual([{ address: '10.1.2.3', name: 'wlan' }, { address: '192.168.1.8', name: 'eth0' }])
  })
  it('无线网卡排前，虚拟网卡（VirtualBox 192.168.56.x / vEthernet）排后', () => {
    const l = lanAddresses({
      '以太网 3': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
      'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
      '以太网': [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      WLAN: [{ address: '192.168.31.9', family: 'IPv4', internal: false }],
    } as never)
    expect(l.map((a) => a.address)).toEqual(['192.168.31.9', '10.0.0.5', '192.168.56.1', '172.20.0.1'])
  })
  it('没选时用第一个；选的还在用它；选的不在了不自动换（不启动）', () => {
    expect(pickBindAddress(undefined, list)).toBe('10.1.2.3')
    expect(pickBindAddress('10.1.2.3', list)).toBe('10.1.2.3')
    expect(pickBindAddress('192.168.9.9', list)).toBeUndefined()
    expect(pickBindAddress(undefined, [])).toBeUndefined()
  })
  it('公网 / 0.0.0.0 / 不在本机的地址拒绝', () => {
    expect(bindAddressError('203.0.113.5', list)).toMatch(/不是局域网私有地址/)
    expect(bindAddressError('0.0.0.0', list)).toMatch(/不是局域网私有地址/)
    expect(bindAddressError('192.168.7.7', list)).toMatch(/没有地址/)
    expect(bindAddressError('10.1.2.3', list)).toBeUndefined()
  })
})

describe('设备令牌', () => {
  it('只存哈希、定长比较', () => {
    const t = newToken()
    expect(t.length).toBeGreaterThanOrEqual(40)
    expect(sameHash(hashToken(t), hashToken(t))).toBe(true)
    expect(sameHash(hashToken(t), hashToken(t + 'x'))).toBe(false)
    expect(sameHash('', '')).toBe(false)
  })
})

describe('PairingGate', () => {
  it('一次性：成功后作废', () => {
    const g = new PairingGate(() => '123456')
    expect(g.attempt('123456', 0)).toBe('none')
    g.issue(0)
    expect(g.attempt('123456', 1000)).toBe('ok')
    expect(g.attempt('123456', 2000)).toBe('none')
  })
  it('5 分钟过期', () => {
    const g = new PairingGate(() => '111111')
    g.issue(0)
    expect(g.current(PAIR_TTL_MS - 1)).toBeTruthy()
    expect(g.current(PAIR_TTL_MS)).toBeUndefined()
    expect(g.attempt('111111', PAIR_TTL_MS)).toBe('expired')
  })
  it('同一 IP 错 5 次只锁这个 IP 10 分钟；其他设备仍可配对，桌面端也能重新发码', () => {
    const g = new PairingGate(() => '222222')
    g.issue(0)
    for (let i = 0; i < 4; i++) expect(g.attempt('000000', i, '10.0.0.9')).toBe('bad')
    expect(g.attempt('000000', 5, '10.0.0.9')).toBe('locked')
    expect(g.attempt('222222', 6, '10.0.0.9')).toBe('locked')       // 被锁的 IP 连正确码也不行
    expect(g.lockUntil(6, '10.0.0.9')).toBe(5 + PAIR_LOCK_MS)
    expect(g.lockUntil(6, '10.0.0.10')).toBeUndefined()
    // 错误码不会销毁当前码：合法手机从另一个 IP 仍能配对（以前 5 次错误就把所有人的码作废并全局锁定）
    expect(g.attempt('222222', 7, '10.0.0.10')).toBe('ok')
    // 被锁期间照样能重新生成配对码
    expect(g.issue(8)).toBeTruthy()
    expect(g.attempt('222222', 9, '10.0.0.11')).toBe('ok')
    // 锁定到期后该 IP 恢复（旧码已过期，需要新码）
    g.issue(5 + PAIR_LOCK_MS)
    expect(g.attempt('222222', 6 + PAIR_LOCK_MS, '10.0.0.9')).toBe('ok')
  })
  it('默认生成 6 位数字', () => {
    const c = new PairingGate().issue(0)?.code
    expect(c).toMatch(/^\d{6}$/)
  })
})

describe('deviceNameOf', () => {
  it('UA 摘要；自报名字去掉控制字符和尖括号', () => {
    expect(deviceNameOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17.0 Mobile Safari/604.1')).toBe('iPhone · Safari')
    expect(deviceNameOf('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36')).toBe('Android · Chrome')
    expect(deviceNameOf(undefined, ' <b>我的手机\n')).toBe('b我的手机')
  })
})
