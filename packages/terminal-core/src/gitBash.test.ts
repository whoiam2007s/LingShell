import { describe, expect, it } from 'vitest'
import { detectGitBash, isWslLauncher, parseRegInstallPath, type DetectDeps } from './gitBash.js'

// 假文件系统：只有列出的路径存在（大小写不敏感，同 Windows）
function deps(files: string[], o: Partial<DetectDeps> & { reg?: Record<string, string> } = {}): DetectDeps {
  const set = new Set(files.map((f) => f.toLowerCase()))
  return {
    env: { SystemRoot: 'C:\\Windows', ...o.env },
    exists: (p) => set.has(p.toLowerCase()),
    regInstallPath: (k) => o.reg?.[k],
    override: o.override,
  }
}

describe('detectGitBash', () => {
  it('设置里指定的路径优先于一切', () => {
    const r = detectGitBash(deps(['D:\\tools\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], { override: 'D:\\tools\\bash.exe', env: { LINGSHELL_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe' } }))
    expect(r).toEqual({ path: 'D:\\tools\\bash.exe', source: 'settings' })
  })
  it('设置里的路径不存在 → 继续往下找（LINGSHELL_BASH）', () => {
    const r = detectGitBash(deps(['E:\\g\\bin\\bash.exe'], { override: 'X:\\nope\\bash.exe', env: { LINGSHELL_BASH: 'E:\\g\\bin\\bash.exe' } }))
    expect(r).toEqual({ path: 'E:\\g\\bin\\bash.exe', source: 'env' })
  })
  it('注册表 InstallPath（HKCU 用户级安装）', () => {
    const r = detectGitBash(deps(['E:\\Apps\\Git\\bin\\bash.exe'], { reg: { 'HKCU\\SOFTWARE\\GitForWindows': 'E:\\Apps\\Git' } }))
    expect(r).toEqual({ path: 'E:\\Apps\\Git\\bin\\bash.exe', source: 'registry' })
  })
  it('PATH 上的 git.exe（cmd / mingw64\\bin）推导安装根', () => {
    expect(detectGitBash(deps(['F:\\Git\\cmd\\git.exe', 'F:\\Git\\bin\\bash.exe'], { env: { PATH: 'C:\\x;F:\\Git\\cmd' } })))
      .toEqual({ path: 'F:\\Git\\bin\\bash.exe', source: 'path' })
    expect(detectGitBash(deps(['F:\\Git\\mingw64\\bin\\git.exe', 'F:\\Git\\bin\\bash.exe'], { env: { PATH: 'F:\\Git\\mingw64\\bin\\' } })))
      .toEqual({ path: 'F:\\Git\\bin\\bash.exe', source: 'path' })
  })
  it('排除 System32 / WindowsApps 下的 bash.exe（WSL 启动器）', () => {
    const files = ['C:\\Windows\\System32\\bash.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe']
    const env = { PATH: 'C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }
    expect(detectGitBash(deps(files, { env }))).toEqual({})
    expect(detectGitBash(deps(files, { env, override: 'C:\\Windows\\System32\\bash.exe' }))).toEqual({})
    expect(detectGitBash(deps(files, { env: { LINGSHELL_BASH: 'c:\\windows\\system32\\bash.exe' } }))).toEqual({})
  })
  it('PATH 上直接有 Git 的 bash.exe', () => {
    expect(detectGitBash(deps(['C:\\Windows\\System32\\bash.exe', 'G:\\msys\\usr\\bin\\bash.exe'], { env: { PATH: 'C:\\Windows\\System32;G:\\msys\\usr\\bin' } })))
      .toEqual({ path: 'G:\\msys\\usr\\bin\\bash.exe', source: 'path' })
  })
  it('常见位置：scoop、LOCALAPPDATA、D:\\Git', () => {
    expect(detectGitBash(deps(['C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe'], { env: { USERPROFILE: 'C:\\Users\\u' } })))
      .toEqual({ path: 'C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe', source: 'common' })
    expect(detectGitBash(deps(['C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'], { env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } })))
      .toEqual({ path: 'C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', source: 'common' })
    expect(detectGitBash(deps(['D:\\Git\\bin\\bash.exe']))).toEqual({ path: 'D:\\Git\\bin\\bash.exe', source: 'common' })
    expect(detectGitBash(deps(['C:\\Program Files (x86)\\Git\\bin\\bash.exe']))).toEqual({ path: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', source: 'common' })
  })
  it('注册表优先于 PATH 与常见位置', () => {
    const r = detectGitBash(deps(['E:\\G\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], { reg: { 'HKLM\\SOFTWARE\\GitForWindows': 'E:\\G' } }))
    expect(r.source).toBe('registry')
  })
  it('都没有 → 空', () => expect(detectGitBash(deps([]))).toEqual({}))
})

describe('parseRegInstallPath / isWslLauncher', () => {
  it('解析 reg query 输出', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    C:\\Program Files\\Git\r\n\r\n'
    expect(parseRegInstallPath(out)).toBe('C:\\Program Files\\Git')
    expect(parseRegInstallPath('错误: 系统找不到指定的注册表项或值。')).toBeUndefined()
  })
  it('WSL 启动器判断', () => {
    expect(isWslLauncher('C:\\WINDOWS\\system32\\bash.exe', { SystemRoot: 'C:\\Windows' })).toBe(true)
    expect(isWslLauncher('C:\\Program Files\\Git\\bin\\bash.exe', { SystemRoot: 'C:\\Windows' })).toBe(false)
  })
})
