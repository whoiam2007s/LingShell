import { describe, expect, it } from 'vitest'
import { BASH_MISSING, listLocalShells, registerLocalShells } from './localShells.js'

const utf16 = (s: string) => new Uint8Array(Buffer.from(String.fromCharCode(0xfeff) + s, 'utf16le'))

describe('terminal:localShells', () => {
  it('Windows：Git Bash / PowerShell / cmd + WSL 发行版（UTF-16 输出）；PowerShell / cmd 标不可 AI', async () => {
    const hs = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerLocalShells({ handle: (ch, fn) => hs.set(ch, fn), platform: 'win32', wslList: async () => utf16('Ubuntu\r\ndocker-desktop\r\n'), hasBash: () => true })
    expect(await hs.get('terminal:localShells')!(null)).toEqual([
      { id: 'bash', label: 'Git Bash', ai: true },
      { id: 'powershell', label: 'PowerShell', ai: false },
      { id: 'cmd', label: 'cmd', ai: false },
      { id: 'wsl:Ubuntu', label: 'WSL · Ubuntu', ai: true },
    ])
  })
  it('没装 WSL：只有三项；其它系统只有默认 shell', async () => {
    expect((await listLocalShells('win32', async () => new Uint8Array())).map((s) => s.id)).toEqual(['bash', 'powershell', 'cmd'])
    expect(await listLocalShells('linux')).toEqual([{ id: 'bash', label: '默认 shell', ai: true }])
  })
  it('没检测到 Git Bash：Git Bash 项带不可用原因（菜单置灰），其余照常', async () => {
    const r = await listLocalShells('win32', async () => new Uint8Array(), () => false)
    expect(r[0]).toEqual({ id: 'bash', label: 'Git Bash', ai: true, unavailable: BASH_MISSING })
    expect(r.slice(1).every((s) => !s.unavailable)).toBe(true)
    expect(await listLocalShells('linux', undefined, () => false)).toEqual([{ id: 'bash', label: '默认 shell', ai: true }])   // 非 Windows 不受影响
  })
  it.runIf(process.platform === 'win32')('本机真实枚举不报错', async () => {
    const r = await listLocalShells()
    expect(r.slice(0, 3).map((s) => s.id)).toEqual(['bash', 'powershell', 'cmd'])
  })
})
