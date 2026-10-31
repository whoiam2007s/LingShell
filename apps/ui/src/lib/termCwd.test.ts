import { describe, it, expect } from 'vitest'
import { msysToWin, setTermCwd, getTermCwd, onTermCwd, clearTermCwd, shellQuotePaths } from './termCwd.js'

describe('termCwd', () => {
  it('MSYS 路径转 Windows', () => {
    expect(msysToWin('/d/work/a b')).toBe('D:\\work\\a b')
    expect(msysToWin('/c')).toBe('C:\\')
    expect(msysToWin('/usr/bin')).toBe('/usr/bin')
  })

  it('本地终端转换、SSH 原样；同值不重复通知', () => {
    const seen: string[] = []
    const off = onTermCwd((id, c) => seen.push(`${id}=${c}`))
    setTermCwd('l1', '/d/x', true)
    setTermCwd('l1', '/d/x', true)
    setTermCwd('s1', '/d/x', false)
    off()
    setTermCwd('s1', '/etc', false)
    expect(seen).toEqual(['l1=D:\\x', 's1=/d/x'])
    expect(getTermCwd('s1')).toBe('/etc')
    clearTermCwd('s1')
    expect(getTermCwd('s1')).toBeUndefined()
  })

  it('拖入本地终端的路径加单引号（内含单引号转义）', () => {
    expect(shellQuotePaths(['C:\\a b\\x.txt', "/tmp/it's"])).toBe(`'C:\\a b\\x.txt' '/tmp/it'\\''s' `)
  })

  it('按 shell 用各自的引号 / 路径写法', () => {
    expect(shellQuotePaths(['D:\\a b\\x.txt'], 'cmd')).toBe('"D:\\a b\\x.txt" ')
    expect(shellQuotePaths(["D:\\it's"], 'powershell')).toBe(`'D:\\it''s' `)
    expect(shellQuotePaths(['D:\\a b\\x.txt'], 'wsl:Ubuntu')).toBe(`'/mnt/d/a b/x.txt' `)
  })
})
