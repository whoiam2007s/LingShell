import { describe, it, expect } from 'vitest'
import type { HostSummary } from '@lingshell/shared'
import { BEGIN, END, authNote, entriesForHost, hostBlock, remoteAlias, removeManagedBlock, upsertManagedBlock, vscodeRemoteArgs } from './vscodeRemote.js'

const USER = 'Host my-own\n  HostName 1.2.3.4\n  User me\n\nHost *\n  ServerAliveInterval 30'

describe('ssh config 托管块', () => {
  const e = { alias: remoteAlias('h1', 'Web 服务器 01'), host: '10.0.0.5', port: 2222, user: 'deploy' }
  it('别名：ASCII 部分 + 4 位哈希，同 key 稳定、不同 key 不撞', () => {
    expect(e.alias).toMatch(/^lingshell-web-01-[0-9a-f]{4}$/)
    expect(remoteAlias('h1', 'x')).not.toBe(remoteAlias('h2', 'x'))
    expect(remoteAlias('h3', '生产库')).toMatch(/^lingshell-[0-9a-f]{4}$/)
  })
  it('写入：追加在末尾，用户自己的条目一字不动；再写一次 changed=false', () => {
    const b = hostBlock(e)
    const r = upsertManagedBlock(USER, e.alias, b)
    expect(r.changed).toBe(true)
    expect(r.text.startsWith(USER)).toBe(true)
    expect(r.text).toContain(`${BEGIN(e.alias)}\nHost ${e.alias}\n  HostName 10.0.0.5\n  Port 2222\n  User deploy\n${END(e.alias)}`)
    expect(upsertManagedBlock(r.text, e.alias, b)).toEqual({ text: r.text, changed: false })
  })
  it('更新：只替换自己的块（端口变了），其它块和用户条目不变', () => {
    const other = { alias: remoteAlias('h9', 'db'), host: 'db', port: 22, user: 'root' }
    let t = upsertManagedBlock(USER, e.alias, hostBlock(e)).text
    t = upsertManagedBlock(t, other.alias, hostBlock(other)).text
    const r = upsertManagedBlock(t, e.alias, hostBlock({ ...e, port: 22 }))
    expect(r.changed).toBe(true)
    expect(r.text).toContain(`Host ${e.alias}\n  HostName 10.0.0.5\n  Port 22\n`)
    expect(r.text).toContain(hostBlock(other))
    expect(r.text.startsWith(USER)).toBe(true)
    expect(r.text.match(/Host lingshell-/g)).toHaveLength(2)
  })
  it('删除只删自己的块；CRLF 文件保持 CRLF；空文件也能写', () => {
    const crlf = USER.replace(/\n/g, '\r\n')
    const t = upsertManagedBlock(crlf, e.alias, hostBlock(e)).text
    expect(t.includes('\r\n') && !/[^\r]\n/.test(t)).toBe(true)
    expect(removeManagedBlock(t, e.alias).trimEnd()).toBe(crlf)
    expect(upsertManagedBlock('', e.alias, hostBlock(e)).text).toBe(hostBlock(e) + '\n')
    expect(removeManagedBlock(USER, e.alias)).toBe(USER)
  })
  it('值不能注入换行 / 引号；带空格加引号', () => {
    expect(() => hostBlock({ ...e, user: 'a\nHost evil' })).toThrow()
    expect(hostBlock({ ...e, user: 'a b' })).toContain('  User "a b"')
  })
})

describe('跳板机与参数', () => {
  const hosts: HostSummary[] = [
    { id: 'j', label: 'jump', host: 'j.example', port: 22, username: 'ops', authType: 'agent' },
    { id: 't', label: 'target', host: '10.1.1.1', port: 22, username: 'app', authType: 'key', jumpHostId: 'j' },
  ]
  it('跳板写成 ProxyJump 别名，并一起写跳板自己的块', () => {
    const es = entriesForHost(hosts[1], (id) => hosts.find((h) => h.id === id))
    expect(es.map((x) => x.host)).toEqual(['10.1.1.1', 'j.example'])
    expect(es[0].proxyJump).toBe(es[1].alias)
  })
  it('认证说明', () => {
    expect(authNote('agent')).toContain('直接连上')
    expect(authNote('key')).toContain('ssh-agent')
    expect(authNote('password')).toContain('弹框要密码')
  })
  it('code 参数：目录 --folder-uri，文件 --remote + -g', () => {
    expect(vscodeRemoteArgs('lingshell-a-1234', '/srv/my app', { dir: true })).toEqual(['--folder-uri', 'vscode-remote://ssh-remote+lingshell-a-1234/srv/my%20app'])
    // # / ? 必须编码，否则 URI 会被截断
    expect(vscodeRemoteArgs('x', '/srv/a#b/c?d', { dir: true })[1]).toBe('vscode-remote://ssh-remote+x/srv/a%23b/c%3Fd')
    expect(vscodeRemoteArgs('x', '/a.py', { line: 12, col: 3 })).toEqual(['--remote', 'ssh-remote+x', '-g', '/a.py:12:3'])
    expect(vscodeRemoteArgs('x', '/a.py', {})).toEqual(['--remote', 'ssh-remote+x', '/a.py'])
  })
})
