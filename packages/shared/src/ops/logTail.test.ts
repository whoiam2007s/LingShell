import { describe, it, expect } from 'vitest'
import { logTailCommand, parseLogSource, logSupported, logSourceLabel } from './logTail.js'

describe('parseLogSource', () => {
  it('文件路径：去首尾空白；空 / 换行 / 空字符拒绝', () => {
    expect(parseLogSource({ kind: 'file', path: ' /var/log/syslog ' })).toEqual({ kind: 'file', path: '/var/log/syslog' })
    for (const path of ['', '  ', '/a\nrm -rf /', '/a\0b', 1]) expect(() => parseLogSource({ kind: 'file', path })).toThrow('非法的日志路径')
  })
  it('journal：单元名可空，只允许 systemd 单元字符', () => {
    expect(parseLogSource({ kind: 'journal' })).toEqual({ kind: 'journal' })
    expect(parseLogSource({ kind: 'journal', unit: 'nginx.service' })).toEqual({ kind: 'journal', unit: 'nginx.service' })
    expect(parseLogSource({ kind: 'journal', unit: 'getty@tty1' })).toEqual({ kind: 'journal', unit: 'getty@tty1' })
    expect(() => parseLogSource({ kind: 'journal', unit: 'x; reboot' })).toThrow('非法的单元名')
    expect(() => parseLogSource({ kind: 'cmd' })).toThrow('非法的日志来源')
    expect(() => parseLogSource(null)).toThrow()
  })
})

describe('logTailCommand', () => {
  it('固定 sh -c，tail -F 最后 500 行，路径单引号转义（两层）', () => {
    const c = logTailCommand({ kind: 'file', path: "/tmp/it's; rm -rf ~" })
    expect(c.startsWith("sh -c '")).toBe(true)
    // 内层：'/tmp/it'\''s; rm -rf ~'；外层再包一次单引号，' → '\''
    const inner = c.slice(6, -1).replace(/'\\''/g, "'")
    expect(inner).toContain("exec tail -n 500 -F -- '/tmp/it'\\''s; rm -rf ~' 2>&1 3<&-")
    expect(inner).toContain('exec 3<&0; (cat <&3 >/dev/null 2>&1; kill $$ 2>/dev/null) >/dev/null 2>&1 &')
  })
  it('journalctl：-f -n 500，可选 -u', () => {
    expect(logTailCommand({ kind: 'journal' })).toContain('exec journalctl -f -n 500 --no-pager 2>&1')
    expect(logTailCommand({ kind: 'journal', unit: 'nginx' })).toContain("--no-pager -u '\\''nginx'\\'' 2>&1")
  })
  it('支持判断与标签', () => {
    expect(logSupported('ssh', 'linux')).toBe(true)
    expect(logSupported('ssh', 'unknown')).toBe(true)
    expect(logSupported('ssh', 'windows')).toBe(false)
    expect(logSupported('local', 'linux')).toBe(false)
    expect(logSourceLabel({ kind: 'journal', unit: 'nginx' })).toBe('journalctl -u nginx')
  })
})
