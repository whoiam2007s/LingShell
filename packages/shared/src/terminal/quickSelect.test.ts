import { describe, it, expect } from 'vitest'
import { assignHints, findQuickSelect, hintOrder, matchHint, QS_ALPHABET, QS_MAX } from './quickSelect.js'

const texts = (line: string) => findQuickSelect([line]).map((m) => `${m.kind}:${m.text}`)

describe('findQuickSelect', () => {
  it('IPv4（含 CIDR）、端口单独成一项', () => {
    expect(texts('inet 10.0.0.12/24 brd 10.0.0.255 scope global')).toEqual(['ipv4:10.0.0.12/24', 'ipv4:10.0.0.255'])
    expect(texts('listen 127.0.0.1:8080')).toEqual(['ipv4:127.0.0.1', 'port:8080'])
    expect(texts('version 1.2.3.4.5')).toEqual([])           // 不是 IP
    expect(texts('999.1.1.1')).toEqual([])
  })
  it('端口：主机名 / IP / [::] / * 后面的冒号数字；时间不算', () => {
    expect(texts('localhost:3000 *:80 [::]:443')).toEqual(['port:3000', 'port:80', 'port:443'])
    expect(texts('LISTEN 0 128 0.0.0.0:22')).toEqual(['number:128', 'ipv4:0.0.0.0', 'port:22'])
    expect(texts('at 10:20:30')).toEqual([])
  })
  it('IPv6：缩写与完整形式；不认时间和 MAC', () => {
    expect(texts('inet6 fe80::a00:27ff:fe4e:66a1/64 scope link')).toContain('ipv6:fe80::a00:27ff:fe4e:66a1')
    expect(texts('::1 localhost')).toEqual(['ipv6:::1'])
    expect(texts('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toEqual(['ipv6:2001:0db8:85a3:0000:0000:8a2e:0370:7334'])
    expect(texts('12:34:56 up 3 days')).toEqual([])
    expect(texts('ether 08:00:27:4e:66:a1')).toEqual([])
    expect(texts('use std::io;')).toEqual([])
  })
  it('URL：去掉句尾标点与不成对的括号，URL 里的路径 / 端口不重复标', () => {
    expect(texts('见 https://example.com:8443/a/b?x=1.')).toEqual(['url:https://example.com:8443/a/b?x=1'])
    expect(texts('(see http://a.io/x)')).toEqual(['url:http://a.io/x'])
    expect(texts('http://w.org/Foo_(bar)')).toEqual(['url:http://w.org/Foo_(bar)'])
  })
  it('绝对路径：/ ~/ 与 Windows 盘符；单独的 / 与相对路径不算', () => {
    expect(texts('ls /var/log/nginx/access.log, ok')).toEqual(['path:/var/log/nginx/access.log'])
    expect(texts('cd ~/proj/src')).toEqual(['path:~/proj/src'])
    expect(texts('at C:\\Users\\me\\a.txt')).toEqual(['path:C:\\Users\\me\\a.txt'])
    expect(texts('a / b src/main.ts')).toEqual([])
  })
  it('git 哈希 / 容器 ID：须有字母和数字，单词与纯数字不算', () => {
    expect(texts('commit 3f9a2c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f')).toEqual(['hash:3f9a2c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f'])
    expect(texts('a1b2c3d nginx:latest Up 2 hours')).toEqual(['hash:a1b2c3d'])
    expect(texts('defaced facade')).toEqual([])
  })
  it('PID 样的数字列：独立的 3 位以上整数；小数、时间、版本号里的不算', () => {
    expect(texts('root      1234  0.0  0.1 ...')).toEqual(['number:1234'])
    expect(texts('took 1.234s at 10:20')).toEqual([])
    expect(texts('pid 42')).toEqual([])
  })
  it('多行：按行列排序，记行号与区间', () => {
    const m = findQuickSelect(['a 10.0.0.1', '', 'url http://x.io'])
    expect(m).toEqual([
      { row: 0, start: 2, end: 10, text: '10.0.0.1', kind: 'ipv4' },
      { row: 2, start: 4, end: 15, text: 'http://x.io', kind: 'url' },
    ])
  })
})

describe('提示字母', () => {
  it('≤26 个用单字母，否则全用两字母（前缀互斥）', () => {
    expect(assignHints(3)).toEqual(['a', 's', 'd'])
    const h = assignHints(30)
    expect(h).toHaveLength(30)
    expect(h.every((x) => x.length === 2)).toBe(true)
    expect(new Set(h).size).toBe(30)
    expect(assignHints(QS_MAX + 5)).toHaveLength(QS_MAX)
    expect(new Set(QS_ALPHABET).size).toBe(QS_ALPHABET.length)
  })
  it('matchHint：命中 / 前缀 / 无', () => {
    const h = assignHints(30)
    expect(matchHint('a', h)).toBe('more')
    expect(matchHint(h[3], h)).toBe(3)
    expect(matchHint('zz', ['as'])).toBeNull()
  })
  it('hintOrder：最下面、最右边的先拿字母', () => {
    const m = findQuickSelect(['10.0.0.1 10.0.0.2', '10.0.0.3'])
    expect(hintOrder(m).map((i) => m[i].text)).toEqual(['10.0.0.3', '10.0.0.2', '10.0.0.1'])
  })
})
