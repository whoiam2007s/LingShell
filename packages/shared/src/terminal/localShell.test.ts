import { describe, it, expect } from 'vitest'
import { isShellId, parseWslList, shellKind, shellLabel, termEnvLabel, wslDistro, wslToWinPath } from './localShell.js'
import { toLayoutItem } from './tabs.js'

// UTF-16LE \u7F16\u7801\uFF08\u5E26 BOM\uFF09\uFF1Ashared \u4E0D\u4F9D\u8D56 node \u7C7B\u578B\uFF0C\u624B\u5DE5\u6309\u7801\u5143\u62C6\u5B57\u8282
const utf16 = (s: string) => new Uint8Array([...('\uFEFF' + s)].flatMap((c) => { const n = c.charCodeAt(0); return [n & 0xff, n >> 8] }))

describe('本地 shell', () => {
  it('shell id 校验：只认四类，WSL 发行版名严格（防参数注入）', () => {
    for (const ok of ['bash', 'powershell', 'cmd', 'wsl:Ubuntu-22.04', 'wsl:openSUSE_Leap']) expect(isShellId(ok)).toBe(true)
    for (const bad of ['zsh', 'wsl:', 'wsl:a b', 'wsl:--exec', 'wsl:x;rm', 1, undefined]) expect(isShellId(bad)).toBe(false)
  })
  it('种类 / 发行版 / 显示名', () => {
    expect(shellKind(undefined)).toBe('bash')
    expect(shellKind('wsl:Ubuntu')).toBe('wsl')
    expect(wslDistro('wsl:Ubuntu')).toBe('Ubuntu')
    expect(shellLabel('powershell')).toBe('PowerShell')
    expect(shellLabel('wsl:Debian')).toBe('WSL · Debian')
  })
  it('终端说明：默认 bash 沿用系统名；仅手动的标出来', () => {
    expect(termEnvLabel({ os: 'windows' })).toBe('Windows · Git Bash')
    expect(termEnvLabel({ os: 'windows', shell: 'powershell', manualOnly: true })).toBe('PowerShell · 仅手动（AI 不可执行命令）')
    expect(termEnvLabel({ os: 'linux', shell: 'wsl:Ubuntu' })).toBe('WSL · Ubuntu（Linux）')
  })
  it('wsl -l -q：UTF-16LE（带 BOM / 空行）与 UTF-8 都能解；去掉 docker-desktop', () => {
    expect(parseWslList(utf16('Ubuntu-22.04\r\ndocker-desktop\r\nDebian\r\n\r\n'))).toEqual(['Ubuntu-22.04', 'Debian'])
    expect(parseWslList(new TextEncoder().encode('Ubuntu\nkali-linux\n'))).toEqual(['Ubuntu', 'kali-linux'])
    expect(parseWslList(new Uint8Array())).toEqual([])
  })
  it('WSL 路径 → Windows 路径', () => {
    expect(wslToWinPath('/mnt/c/Users/x', 'Ubuntu')).toBe('C:\\Users\\x')
    expect(wslToWinPath('/mnt/d', 'Ubuntu')).toBe('D:\\')
    expect(wslToWinPath('/home/u/proj', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj')
  })
  it('布局项：本地终端记住非默认 shell，ssh 不带', () => {
    expect(toLayoutItem('local', undefined, undefined, undefined, 'powershell')).toEqual({ kind: 'local', shell: 'powershell' })
    expect(toLayoutItem('ssh', 'h1', undefined, undefined, 'powershell')).toEqual({ kind: 'ssh', hostId: 'h1' })
  })
})
