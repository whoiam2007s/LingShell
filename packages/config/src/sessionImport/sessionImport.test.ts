import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../HostStore.js'
import { decodeBytes, parseXsh, parsePuttyReg, unescapePuttyName, parseMobaXterm, parseSecureCrt, loadSessions, previewSessions, importSessions, type SessionEnv } from './index.js'

const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])

const XSH = `[CONNECTION]
Port=2222
Host=10.0.0.5
Protocol=SSH
[CONNECTION:AUTHENTICATION]
UserName=deploy
Password=v2:AbCdEf==
Method=1
UserKey=id_rsa_2048
`

describe('decodeBytes', () => {
  it('认 BOM / 无 BOM 的 UTF-16LE / UTF-8 / GBK', () => {
    expect(decodeBytes(utf16('[A]\r\nk=中文'))).toBe('[A]\r\nk=中文')
    expect(decodeBytes(Buffer.from('[A]', 'utf16le'))).toBe('[A]')
    expect(decodeBytes(Buffer.from('\ufeffk=中', 'utf8'))).toBe('k=中')
    expect(decodeBytes(Buffer.from('k=中文', 'utf8'))).toBe('k=中文')
    expect(decodeBytes(Buffer.from([0x6b, 0x3d, 0xd6, 0xd0, 0xce, 0xc4]))).toBe('k=中文')   // GBK
  })
})

describe('Xshell', () => {
  it('解析 UTF-16LE 的 .xsh：地址/端口/用户名，不取密码，用户密钥给提示', () => {
    const r = parseXsh(decodeBytes(utf16(XSH.replace(/\n/g, '\r\n'))), 'web01', '生产/Web')
    expect(r).toMatchObject({ name: 'web01', host: '10.0.0.5', port: 2222, username: 'deploy', group: '生产/Web' })
    expect(JSON.stringify(r)).not.toContain('AbCdEf')
    expect('warnings' in r && r.warnings.join()).toContain('id_rsa_2048')
  })
  it('非 SSH 跳过、缺端口按 22', () => {
    expect(parseXsh('[CONNECTION]\nHost=a\nProtocol=TELNET', 't')).toHaveProperty('skip')
    expect(parseXsh('[CONNECTION]\nHost=a\n[CONNECTION:AUTHENTICATION]\nUserName=u', 'x')).toMatchObject({ port: 22, username: 'u' })
  })
})

describe('PuTTY', () => {
  const REG = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions]

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]
"Protocol"="ssh"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\my%20server]
"HostName"="ops@db.example.com"
"PortNumber"=dword:00000016
"Protocol"="ssh"
"PublicKeyFile"="C:\\\\keys\\\\db.ppk"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\%D6%D0%CE%C4]
"HostName"="10.1.1.1"
"PortNumber"=dword:00000d3d
"UserName"="root"
"Protocol"="ssh"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial]
"HostName"="COM1"
"Protocol"="serial"
`
  it('解析 reg export：user@host 拆分、dword 端口、GBK 转义的会话名、非 SSH 跳过', () => {
    const r = parsePuttyReg(decodeBytes(utf16(REG)))
    expect(r.sessions.map((s) => [s.name, s.host, s.port, s.username])).toEqual([
      ['my server', 'db.example.com', 22, 'ops'],
      ['中文', '10.1.1.1', 3389, 'root'],
    ])
    expect(r.sessions[0].warnings.join()).toContain('C:\\keys\\db.ppk')
    expect(r.warnings).toEqual(['serial：协议 serial 不是 SSH，已跳过'])
  })
  it('会话名反转义', () => { expect(unescapePuttyName('a%20b%25')).toBe('a b%') })
})

describe('MobaXterm', () => {
  const INI = `[Misc]
Foo=1
[Bookmarks]
SubRep=
ImgNum=42
Web01=#109#0%10.0.0.1%22%root%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236#0# #-1
[Bookmarks_1]
SubRep=生产\\数据库
ImgNum=41
db-master=#109#0%192.168.1.10%2200%%%-1%-1%%%%%0%0%0%%%-1#MobaFont%10#0# #-1
win-rdp=#91#4%192.168.1.20%3389%admin%0%-1#MobaFont#0# #-1
`
  it('解析 Bookmarks 段：只要 SSH(109)，SubRep 作分组', () => {
    const r = parseMobaXterm(INI)
    expect(r.sessions.map((s) => [s.name, s.host, s.port, s.username, s.group])).toEqual([
      ['Web01', '10.0.0.1', 22, 'root', undefined],
      ['db-master', '192.168.1.10', 2200, '', '生产/数据库'],
    ])
    expect(r.sessions[1].warnings.join()).toContain('用户名')
    expect(r.warnings).toEqual(['win-rdp：不是 SSH 会话，已跳过'])
  })
})

describe('SecureCRT', () => {
  it('解析会话 .ini：十六进制端口', () => {
    const txt = 'S:"Protocol Name"=SSH2\r\nS:"Hostname"=bastion.example\r\nS:"Username"=jump\r\nD:"[SSH2] Port"=00000d05\r\nS:"Password V2"=02:abc\r\n'
    const r = parseSecureCrt(txt, 'bastion', 'infra')
    expect(r).toMatchObject({ name: 'bastion', host: 'bastion.example', port: 3333, username: 'jump', group: 'infra' })
    expect(JSON.stringify(r)).not.toContain('abc')
    expect(parseSecureCrt('S:"Protocol Name"=Telnet\nS:"Hostname"=x', 't')).toHaveProperty('skip')
  })
})

// 内存文件系统
function memEnv(files: Record<string, Buffer | string>, reg?: string): SessionEnv {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), typeof v === 'string' ? Buffer.from(v) : v]))
  return {
    home: '/h', appData: '/h/AppData/Roaming',
    readFile: (p) => map.get(norm(p)),
    listDir: (d) => {
      const pre = norm(d).replace(/\/$/, '') + '/'
      const out = new Map<string, boolean>()
      for (const k of map.keys()) if (k.startsWith(pre)) { const rest = k.slice(pre.length).split('/'); out.set(rest[0], rest.length > 1) }
      return [...out].map(([name, isDir]) => ({ name, isDir }))
    },
    puttyReg: () => (reg === undefined ? undefined : utf16(reg)),
  }
}

describe('loadSessions / 预览 / 导入', () => {
  let dir: string
  const fakeEnc = { available: () => true, encrypt: (s: string) => `E(${s})`, decrypt: (s: string) => s.slice(2, -1) }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sess-imp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('Xshell：取最高版本的会话目录，子目录作分组', () => {
    const env = memEnv({
      '/h/Documents/NetSarang Computer/6/Xshell/Sessions/old.xsh': utf16(XSH),
      '/h/Documents/NetSarang Computer/7/Xshell/Sessions/web.xsh': utf16(XSH),
      '/h/Documents/NetSarang Computer/7/Xshell/Sessions/prod/db/db1.xsh': utf16('[CONNECTION]\r\nHost=10.9.9.9\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=root'),
      '/h/Documents/NetSarang Computer/7/Xshell/Sessions/readme.txt': 'x',
    })
    const l = loadSessions('xshell', undefined, env)
    expect(l.found).toBe(true)
    expect(l.path.replace(/\\/g, '/')).toContain('NetSarang Computer/7/Xshell/Sessions')
    expect(l.sessions.map((s) => [s.name, s.group]).sort()).toEqual([['db1', 'prod/db'], ['web', undefined]])
  })

  it('PuTTY：没有注册表项 → found=false', () => {
    expect(loadSessions('putty', undefined, memEnv({})).found).toBe(false)
  })

  it('SecureCRT：跳过 __FolderData__ / Default', () => {
    const env = memEnv({
      '/h/AppData/Roaming/VanDyke/Config/Sessions/Default.ini': 'S:"Hostname"=d',
      '/h/AppData/Roaming/VanDyke/Config/Sessions/__FolderData__.ini': 'Z:"Folder List"=00000000',
      '/h/AppData/Roaming/VanDyke/Config/Sessions/grp/a.ini': 'S:"Hostname"=a.example\nS:"Username"=u',
    })
    expect(loadSessions('securecrt', undefined, env).sessions.map((s) => [s.name, s.group])).toEqual([['a', 'grp']])
  })

  it('预览标已存在；导入跳过已存在与同批重复，重名加序号，密码不导入', () => {
    const s = new HostStore(dir, fakeEnc)
    s.save({ label: 'old', host: 'DB.example', port: 22, username: 'ops', authType: 'password', password: 'pw' })
    const load = { path: 'x', found: true, warnings: [], sessions: [
      { name: 'db', host: 'db.example', port: 22, username: 'ops', warnings: [] },
      { name: 'web', host: 'w1', port: 22, username: 'root', group: 'G', warnings: [] },
      { name: 'web', host: 'w2', port: 22, username: 'root', warnings: [] },
      { name: 'dup', host: 'w1', port: 22, username: 'root', warnings: [] },
    ] }
    const p = previewSessions(load, s.list())
    expect(p.items.map((i) => [i.alias, !!i.existingId, i.keyStatus])).toEqual([['db', true, 'none'], ['web', false, 'none'], ['web (2)', false, 'none'], ['dup', false, 'none']])
    expect(p.warnings[0]).toContain('密码一律不导入')
    const r = importSessions(s, load, ['db', 'web', 'web (2)', 'dup'])
    expect(r.imported).toBe(2)
    expect(r.warnings).toHaveLength(2)
    const hosts = s.list()
    expect(hosts.map((h) => [h.label, h.host, h.authType, h.group])).toEqual([['old', 'DB.example', 'password', undefined], ['web', 'w1', 'password', 'G'], ['web (2)', 'w2', 'password', undefined]])
    expect(s.resolveConnectOpts(hosts[1].id).password).toBeUndefined()
  })
})
