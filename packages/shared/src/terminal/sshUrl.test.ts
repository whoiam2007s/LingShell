import { describe, it, expect } from 'vitest'
import { parseSshUrl, findSshUrlArg, matchSshUrlHost } from './sshUrl.js'
import type { HostSummary } from '../protocol/index.js'

describe('parseSshUrl', () => {
  it('user@host:port、缺省端口 22、无用户名', () => {
    expect(parseSshUrl('ssh://root@10.0.0.5:2222')).toEqual({ user: 'root', host: '10.0.0.5', port: 2222 })
    expect(parseSshUrl('SSH://web.example.com/')).toEqual({ host: 'web.example.com', port: 22 })
  })
  it('IPv6（方括号）、编码的用户名、密码/参数/路径被忽略', () => {
    expect(parseSshUrl('ssh://admin@[2001:db8::1]:22')).toEqual({ user: 'admin', host: '2001:db8::1', port: 22 })
    expect(parseSshUrl('ssh://[::1]')).toEqual({ host: '::1', port: 22 })
    expect(parseSshUrl('ssh://d%C3%A9v.ops@h')).toEqual({ user: 'dév.ops', host: 'h', port: 22 })
    expect(parseSshUrl('ssh://DOMAIN%5Cuser@h')).toEqual({ user: 'DOMAIN\\user', host: 'h', port: 22 })
    expect(parseSshUrl('ssh://u:secret@h:23/path?cmd=rm%20-rf')).toEqual({ user: 'u', host: 'h', port: 23 })
    expect(parseSshUrl('ssh://u;fingerprint=SHA256-abc@h')).toEqual({ user: 'u', host: 'h', port: 22 })
  })
  it('非法输入返回 null', () => {
    for (const s of ['', 'http://h', 'sftp://h', 'ssh://', 'ssh://h:0', 'ssh://h:70000', 'ssh://h:abc', 'ssh://-oProxyCommand=calc', 'ssh://a b',
      'ssh://u%0A@h', 'ssh://u%20x@h', 'ssh://[zz::1]', 'ssh://h%2Fx', 'ssh://%ZZ@h', `ssh://${'a'.repeat(3000)}`]) {
      expect(parseSshUrl(s), s).toBeNull()
    }
  })
})

it('findSshUrlArg：从 argv 找链接', () => {
  expect(findSshUrlArg(['C:\\app.exe', '--flag', 'ssh://u@h'])).toBe('ssh://u@h')
  expect(findSshUrlArg(['app.exe', '.'])).toBeUndefined()
})

it('matchSshUrlHost：地址不分大小写 + 端口；带用户名时也要相同', () => {
  const hosts = [{ id: 'a', label: 'A', host: 'Web.Example.com', port: 22, username: 'root', authType: 'password' }] as HostSummary[]
  expect(matchSshUrlHost(hosts, { host: 'web.example.com', port: 22 })?.id).toBe('a')
  expect(matchSshUrlHost(hosts, { user: 'root', host: 'web.example.com', port: 22 })?.id).toBe('a')
  expect(matchSshUrlHost(hosts, { user: 'ops', host: 'web.example.com', port: 22 })).toBeUndefined()
  expect(matchSshUrlHost(hosts, { host: 'web.example.com', port: 2222 })).toBeUndefined()
})
