import { execFileSync, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tr } from '@lingshell/shared'

// Windows 上 Git Bash 的统一探测（本地终端、诊断包、批量执行等都用这里）。
// 顺序：设置里指定的路径 → LINGSHELL_BASH → 注册表 GitForWindows\InstallPath → PATH 上的 git.exe / bash.exe 推导 → 常见安装位置。
// 只认「存在」（探测要快，启动时同步跑）；用户手动选的文件另跑 --version 校验（validateBash）。
// 排除 System32 / WindowsApps 下的 bash.exe：那是 WSL 启动器，不是 Git Bash。

export type GitBashSource = 'settings' | 'env' | 'registry' | 'path' | 'common'
export interface GitBashResult { path?: string; source?: GitBashSource }

export interface DetectDeps {
  env: Record<string, string | undefined>
  exists(p: string): boolean
  /** 读注册表某键的 InstallPath，读不到返回 undefined */
  regInstallPath(key: string): string | undefined
  override?: string            // 设置里的 bashPath
}

const win = path.win32
const REG_KEYS = ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows']

/** WSL 启动器（System32\bash.exe、WindowsApps\bash.exe）不是 Git Bash */
export function isWslLauncher(p: string, env: Record<string, string | undefined> = {}): boolean {
  const n = win.normalize(p).toLowerCase()
  const sysRoot = win.normalize(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows').toLowerCase()
  return n.startsWith(sysRoot + '\\') || /\\windowsapps\\/.test(n)
}

/** Git 安装根 → bin\bash.exe */
const fromRoot = (root: string) => win.join(root, 'bin', 'bash.exe')

/** 纯逻辑探测（依赖注入，便于测试） */
export function detectGitBash(d: DetectDeps): GitBashResult {
  const ok = (p?: string): p is string => !!p && d.exists(p) && !isWslLauncher(p, d.env)
  if (ok(d.override?.trim())) return { path: d.override!.trim(), source: 'settings' }
  const envBash = d.env.LINGSHELL_BASH
  if (ok(envBash)) return { path: envBash, source: 'env' }
  for (const k of REG_KEYS) {
    const root = d.regInstallPath(k)
    if (root && ok(fromRoot(root))) return { path: fromRoot(root), source: 'registry' }
  }
  // PATH：git.exe 在 <root>\cmd、<root>\bin 或 <root>\mingw64\bin；bash.exe 直接用（跳过 WSL 启动器）
  for (const dir of (d.env.PATH ?? d.env.Path ?? '').split(';').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (d.exists(win.join(dir, 'git.exe'))) {
      const parts = win.normalize(dir).replace(/\\+$/, '').split('\\')
      const tail = parts.slice(-2).join('\\').toLowerCase()
      const root = tail === 'mingw64\\bin' || tail === 'mingw32\\bin' ? parts.slice(0, -2).join('\\')
        : /^(cmd|bin)$/i.test(parts.at(-1) ?? '') ? parts.slice(0, -1).join('\\') : undefined
      if (root && ok(fromRoot(root))) return { path: fromRoot(root), source: 'path' }
    }
    const b = win.join(dir, 'bash.exe')
    if (ok(b)) return { path: b, source: 'path' }
  }
  // 常见位置：Program Files / x86 / 用户级安装 / scoop / 各盘符根下 Git
  const e = d.env
  const roots = [
    e.ProgramW6432 && win.join(e.ProgramW6432, 'Git'), e.ProgramFiles && win.join(e.ProgramFiles, 'Git'),
    e['ProgramFiles(x86)'] && win.join(e['ProgramFiles(x86)'], 'Git'),
    'C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git',
    e.LOCALAPPDATA && win.join(e.LOCALAPPDATA, 'Programs', 'Git'),
    e.SCOOP && win.join(e.SCOOP, 'apps', 'git', 'current'),
    e.USERPROFILE && win.join(e.USERPROFILE, 'scoop', 'apps', 'git', 'current'),
    ...'CDEFGHIJ'.split('').flatMap((c) => [`${c}:\\Git`, `${c}:\\Program Files\\Git`]),
  ].filter(Boolean) as string[]
  for (const r of roots) if (ok(fromRoot(r))) return { path: fromRoot(r), source: 'common' }
  return {}
}

// reg query 输出：`    InstallPath    REG_SZ    C:\Program Files\Git`
export function parseRegInstallPath(out: string): string | undefined {
  return /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(out)?.[1]
}

function regInstallPath(key: string): string | undefined {
  try {
    return parseRegInstallPath(execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { return undefined }
}

// —— 进程内缓存：首次用时探测；设置里的路径变了 / 缓存的文件没了 / 没找到时重新探测 ——
let getOverride: () => string | undefined = () => undefined
let cache: { override?: string; r: GitBashResult } | undefined

/** 主进程启动时注入：从设置读用户指定的 bash 路径（每次探测现读） */
export function setGitBashOverride(fn: () => string | undefined): void { getOverride = fn; cache = undefined }

/** 当前探测结果（非 Windows 恒为空：用 $SHELL，不需要 Git Bash） */
export function gitBash(): GitBashResult {
  if (process.platform !== 'win32') return {}
  // 测试开关：模拟「没装 Git」（隔离实例里验证缺失引导用）；设置里手动指定的路径仍然生效
  const testMissing = process.env.LINGSHELL_FAKE_NO_BASH === '1'
  const override = getOverride()
  if (cache && cache.override === override && (!cache.r.path || existsSync(cache.r.path))) return cache.r
  const r = detectGitBash({
    env: testMissing ? {} : process.env, override,
    exists: testMissing ? (p) => p === override?.trim() && existsSync(p) : existsSync,
    regInstallPath: testMissing ? () => undefined : regInstallPath,
  })
  cache = { override, r }
  return r
}

/** 丢掉缓存重新探测（「我已安装，重新检测」） */
export function refreshGitBash(): GitBashResult { cache = undefined; return gitBash() }

/** 建本地终端用：缓存里没有就再探测一次（期间可能刚装好），还没有就抛明确错误 */
export function requireGitBash(): string {
  const p = (gitBash().path ?? refreshGitBash().path)
  if (p) return p
  throw new Error(`bash_not_found: ${tr('未检测到 Git Bash。本地终端和 AI 操作本地终端都需要它（SSH 远程终端不受影响）。请安装 Git for Windows（https://git-scm.com/download/win），或在 设置 → 通用 →「Git Bash 路径」里指定 bash.exe')}`)
}

/** 用户手动选的 bash.exe：存在、不是 WSL 启动器、--version 是 GNU bash（5 秒超时） */
export function validateBash(p: string): Promise<string | undefined> {
  if (!p || !existsSync(p)) return Promise.resolve(tr('文件不存在'))
  if (!/bash\.exe$/i.test(p)) return Promise.resolve(tr('请选择 bash.exe'))
  if (isWslLauncher(p, process.env)) return Promise.resolve(tr('这是 WSL 的 bash 启动器，不是 Git Bash，请选择 Git 安装目录下的 bin\\bash.exe'))
  return new Promise((res) => {
    execFile(p, ['--version'], { timeout: 5000, windowsHide: true }, (err, out) =>
      res(err ? tr('运行失败：{error}', { error: err.message }) : /GNU bash/i.test(String(out)) ? undefined : tr('不是 GNU bash')))
  })
}
