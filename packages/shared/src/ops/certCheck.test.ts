import { describe, it, expect } from 'vitest'
import {
  certAlerts, certDiscoverCommand, certLevel, certTargetLabel, chainFromNodeError, chainFromOpensslCode, hostnameMatches, opensslCheckCommand,
  parseCertDiscover, parseCertSpec, parseOpensslCheck, type CertResult, type CertTarget,
} from './certCheck.js'
import { parseOpensslDate } from './hostProfile.js'

describe('parseCertSpec', () => {
  it('域名 / 端口 / URL / IPv6', () => {
    expect(parseCertSpec('Example.COM')).toEqual({ host: 'example.com', port: 443 })
    expect(parseCertSpec('api.x.com:8443')).toEqual({ host: 'api.x.com', port: 8443 })
    expect(parseCertSpec('https://a.com:9443/path?q=1')).toEqual({ host: 'a.com', port: 9443 })
    expect(parseCertSpec('[::1]:8443')).toEqual({ host: '::1', port: 8443 })
    expect(parseCertSpec('10.0.0.1')).toEqual({ host: '10.0.0.1', port: 443 })
    expect(parseCertSpec('')).toHaveProperty('error')
    expect(parseCertSpec('a.com:99999')).toHaveProperty('error')
    expect(parseCertSpec('a b.com')).toHaveProperty('error')
    expect(certTargetLabel({ host: 'a.com', port: 443 })).toBe('a.com')
    expect(certTargetLabel({ host: '::1', port: 8443 })).toBe('[::1]:8443')
  })
})

describe('域名匹配', () => {
  it('精确 / 通配符只配一级 / IP / 无 SAN 时看 CN', () => {
    expect(hostnameMatches('a.com', ['DNS:a.com'])).toBe(true)
    expect(hostnameMatches('x.a.com', ['*.a.com'])).toBe(true)
    expect(hostnameMatches('a.com', ['*.a.com'])).toBe(false)
    expect(hostnameMatches('x.y.a.com', ['*.a.com'])).toBe(false)
    expect(hostnameMatches('127.0.0.1', ['localhost', 'IP Address:127.0.0.1'])).toBe(true)
    expect(hostnameMatches('b.com', [], 'b.com')).toBe(true)
    expect(hostnameMatches('b.com', ['c.com'], 'b.com')).toBe(false)
  })
})

describe('证书链判定', () => {
  it('Node 错误码', () => {
    expect(chainFromNodeError(undefined)).toBe('ok')
    expect(chainFromNodeError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toBe('incomplete')
    expect(chainFromNodeError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 1)).toBe('incomplete')
    expect(chainFromNodeError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 2)).toBe('untrusted')
    expect(chainFromNodeError('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('self-signed')
    expect(chainFromNodeError('CERT_HAS_EXPIRED')).toBe('expired')
  })
  it('openssl verify 码', () => {
    expect(chainFromOpensslCode(0)).toBe('ok')
    expect(chainFromOpensslCode(21)).toBe('incomplete')
    expect(chainFromOpensslCode(20, 2)).toBe('untrusted')
    expect(chainFromOpensslCode(18)).toBe('self-signed')
    expect(chainFromOpensslCode(10)).toBe('expired')
  })
})

describe('到期分级', () => {
  const r = (daysLeft?: number, ok = true): CertResult => ({ at: '', ok, ...(daysLeft !== undefined ? { daysLeft } : {}) })
  it('30 / 14 / 3 天分黄橙红，负数过期，失败算错误', () => {
    expect(certLevel(r(60))).toBe('ok')
    expect(certLevel(r(30))).toBe('yellow')
    expect(certLevel(r(14))).toBe('orange')
    expect(certLevel(r(3))).toBe('red')
    expect(certLevel(r(-1))).toBe('expired')
    expect(certLevel(r(undefined, false))).toBe('error')
    expect(certLevel(r(40), 45)).toBe('yellow')
  })
})

// 本机 Git Bash 的 openssl 3 对自测 TLS 服务实际跑出来的输出（见 desktop/main/certCheck.real.test.ts 的夹具证书）
const CHAIN_OUT = `@@sclient
 0 s:CN=leaf.test
 1 s:CN=GA Test Intermediate, O=LingShell Test
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Verify return code: 20 (unable to get local issuer certificate)
@@x509
subject=CN=leaf.test
issuer=CN=GA Test Intermediate, O=LingShell Test
notBefore=Oct 18 01:37:34 2026 GMT
notAfter=May 18 01:37:34 2036 GMT
                DNS:localhost, IP Address:127.0.0.1
`
const LEAF_ONLY_OUT = CHAIN_OUT.replace(' 1 s:CN=GA Test Intermediate, O=LingShell Test\n', '').replace('20 (unable to get local issuer certificate)', '21 (unable to verify the first certificate)')
const SELF_OUT = `@@sclient
 0 s:CN=selfsigned.test
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Verify return code: 18 (self-signed certificate)
@@x509
subject=CN=selfsigned.test
issuer=CN=selfsigned.test
notBefore=Oct 18 01:37:35 2026 GMT
notAfter=May 18 01:37:35 2036 GMT
                DNS:selfsigned.test
`
// OpenSSL 1.1 风格（subject 带空格、有 Protocol 行）
const OLD_OUT = `@@sclient
 0 s:/CN=www.example.org
 1 s:/C=US/O=DigiCert Inc/CN=DigiCert TLS RSA SHA256 2020 CA1
    Protocol  : TLSv1.2
    Verify return code: 0 (ok)
@@x509
subject= /C=US/O=Example/CN=www.example.org
issuer= /C=US/O=DigiCert Inc/CN=DigiCert TLS RSA SHA256 2020 CA1
notBefore=Jan 13 00:00:00 2026 GMT
notAfter=Feb 13 23:59:59 2027 GMT
                DNS:www.example.org, DNS:example.org, DNS:*.example.org
`

describe('parseOpensslCheck', () => {
  const now = new Date('2026-10-18T00:00:00Z')
  it('完整链（私有根不受信任）：域名匹配、协议、剩余天数', () => {
    const r = parseOpensslCheck(CHAIN_OUT, 'localhost', now)
    expect(r).toMatchObject({ ok: true, subject: 'leaf.test', issuer: 'GA Test Intermediate（LingShell Test）', san: ['localhost', '127.0.0.1'], nameMatch: true, chain: 'untrusted', chainDepth: 2, protocol: 'TLSv1.3' })
    expect(r.notAfter).toBe('2036-05-18T01:37:34.000Z')
    expect(r.daysLeft).toBeGreaterThan(3400)
  })
  it('只发叶子 → 缺中间证书；域名不匹配', () => {
    const r = parseOpensslCheck(LEAF_ONLY_OUT, 'api.example.com', now)
    expect(r.chain).toBe('incomplete')
    expect(r.nameMatch).toBe(false)
  })
  it('自签名', () => expect(parseOpensslCheck(SELF_OUT, 'selfsigned.test', now)).toMatchObject({ chain: 'self-signed', nameMatch: true }))
  it('OpenSSL 1.1 格式：可信、通配符', () => {
    const r = parseOpensslCheck(OLD_OUT, 'cdn.example.org', new Date('2027-02-11T00:00:00Z'))
    expect(r).toMatchObject({ chain: 'ok', protocol: 'TLSv1.2', nameMatch: true, subject: 'www.example.org（Example）', daysLeft: 2 })
    expect(r.chainError).toBeUndefined()
  })
  it('连不上：拒绝 / 解析失败 / 无 openssl', () => {
    expect(parseOpensslCheck('@@sclient\nconnect:errno=111\nConnection refused\n@@x509\nunable to load certificate\n', 'a', now)).toMatchObject({ ok: false, error: '连接被拒绝（端口没开）' })
    expect(parseOpensslCheck('@@sclient\nBIO_lookup_ex:system lib:getaddrinfo\n@@x509\n', 'a', now).error).toBe('域名解析失败')
    expect(parseOpensslCheck('@@noopenssl\n', 'a', now).error).toContain('openssl')
  })
  it('命令带 SNI（IP 不带）、地址单引号', () => {
    expect(opensslCheckCommand('a.com', 443)).toContain("-connect 'a.com:443' -servername 'a.com'")
    expect(opensslCheckCommand('10.0.0.1', 8443)).not.toContain('-servername')
    expect(opensslCheckCommand('::1', 8443)).toContain("'[::1]:8443'")
    expect(parseOpensslDate('Jan  2 03:04:05 2027 GMT')).toBe('2027-01-02T03:04:05.000Z')
  })
})

describe('certAlerts：提醒去重', () => {
  const t = (id: string): CertTarget => ({ id, host: `${id}.com`, port: 443, createdAt: '' })
  const res = (daysLeft: number): CertResult => ({ at: '', ok: true, daysLeft, notAfter: '2026-11-01T00:00:00Z' })
  const d1 = new Date('2026-10-18T09:00:00Z'), d2 = new Date('2026-10-19T09:00:00Z')
  it('第一次进黄档提醒；同档第二天不再提醒；变橙再提醒；红档每天提醒；续期后清记录', () => {
    let s = certAlerts([t('a')], { a: res(25) }, {}, d1)
    expect(s.alerts.map((x) => x.level)).toEqual(['yellow'])
    s = certAlerts([t('a')], { a: res(24) }, s.notified, d2)
    expect(s.alerts).toEqual([])
    s = certAlerts([t('a')], { a: res(13) }, s.notified, d2)
    expect(s.alerts.map((x) => x.level)).toEqual(['orange'])
    s = certAlerts([t('a')], { a: res(2) }, s.notified, d2)
    expect(s.alerts.map((x) => x.level)).toEqual(['red'])
    expect(certAlerts([t('a')], { a: res(2) }, s.notified, d2).alerts).toEqual([])   // 同一天不重复
    expect(certAlerts([t('a')], { a: res(1) }, s.notified, new Date('2026-10-20T09:00:00Z')).alerts.length).toBe(1)   // 第二天再提醒
    const renewed = certAlerts([t('a')], { a: res(90) }, s.notified, d2)
    expect(renewed.alerts).toEqual([])
    expect(renewed.notified).toEqual({})
  })
  it('检查失败也提醒（每天一次）；没结果的保留旧记录', () => {
    const s = certAlerts([t('a'), t('b')], { a: { at: '', ok: false, error: 'x' } }, { b: { level: 'yellow', day: '2026-10-01' } }, d1)
    expect(s.alerts.map((x) => [x.target.id, x.level])).toEqual([['a', 'error']])
    expect(s.notified.b).toEqual({ level: 'yellow', day: '2026-10-01' })
  })
})

describe('从主机发现域名', () => {
  it('nginx server_name / apache ServerName、Alias，丢掉 _ / 通配 / 正则 / 变量', () => {
    const out = '@@ng     server_name  www.a.com a.com;\n@@ng server_name _;\n@@ng server_name ~^(.+)\\.x\\.com$ *.b.com;\n@@ap   ServerName shop.c.com:443\n@@ap ServerAlias m.c.com\n@@ng server_name $host;\n@@end\n'
    expect(parseCertDiscover(out)).toEqual(['a.com', 'm.c.com', 'shop.c.com', 'www.a.com'])
    expect(certDiscoverCommand()).toContain('ssl_certificate')
    // 根目录可替换（测试用临时目录）；只认行首、没注释的指令，8443 不算 443
    expect(certDiscoverCommand()).toContain(`R='/etc'`)
    expect(certDiscoverCommand("/tmp/it's")).toContain(`R='/tmp/it'\\''s'`)
    expect(certDiscoverCommand()).not.toContain('listen[^;]*443')
  })
})
