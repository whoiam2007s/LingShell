// 「周边 Git 项目」扫描（见 docs/0.1.16-规划.md 需求 2）：
//   - 向下 2 层 BFS + 逐级向上到盘符根（Windows `D:\` / Linux `/`），不跨盘
//   - 判定只看 `dir/.git` 是否存在（目录 = 普通仓库，文件 = worktree / submodule 的 gitdir 指针），不跑 git 命令
//   - 硬预算 1000 个目录（readdir + 进入的子目录都算），到数就停并返回 truncated
//   - 跳过 `.` / `_` 开头的目录、各语言的库包与构建产物、Windows 系统目录、无权限目录、符号链接
// 纯只读：不写盘、不改任何东西。
import { lstatSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { GitRepoHit } from '@lingshell/shared'

/** 整次扫描最多看这么多个目录 */
export const SCAN_MAX_DIRS = 1000
/** 向下最多几层 */
export const SCAN_DEPTH = 2

// 各语言的库包 / 构建产物目录（一律小写比较）。注意别放 `packages`：monorepo 的源码就在 packages/ 下
const SKIP = new Set([
  // JS / TS
  'node_modules', 'bower_components', '.yarn', '.pnpm-store',
  // Python
  'venv', 'env', '__pycache__', 'site-packages',
  // Rust / Java / Kotlin / .NET
  'target', 'build', 'out', 'bin', 'obj', '.gradle',
  // Go / PHP / Ruby
  'vendor', 'pkg',
  // iOS / macOS
  'pods', 'carthage', 'deriveddata',
  // 前端产物
  'dist', 'coverage',
  // Windows 系统
  '$recycle.bin', 'system volume information', 'windows', 'windows.old',
  'program files', 'program files (x86)', 'programdata', 'recovery', 'perflogs', '$winreagent',
])

/** 该目录是不是 Git 项目（只看 .git 在不在） */
export function isRepoDir(dir: string): boolean {
  try { return existsSync(join(dir, '.git')) } catch { return false }
}

const skipName = (name: string): boolean => name.startsWith('.') || name.startsWith('_') || SKIP.has(name.toLowerCase())

/** 目录名；盘符根（D:\）取盘符本身 */
function dirName(p: string): string {
  const b = basename(p)
  return b || (p.replace(/[\\/]+$/, '') || p)
}

/** 向上最多看几级（本地和远端一致） */
export const UP_MAX = 2

export function scanGitRepos(startDir: string, opts: { maxDirs?: number; depth?: number } = {}): { repos: GitRepoHit[]; truncated: boolean } {
  const start = resolve(startDir)
  const maxDirs = opts.maxDirs ?? SCAN_MAX_DIRS
  const depth = opts.depth ?? SCAN_DEPTH
  const repos: GitRepoHit[] = []
  const seen = new Set<string>()
  let visited = 0
  let truncated = false

  const push = (dir: string, up: number, rel: string) => {
    const p = resolve(dir)
    if (seen.has(p)) return
    seen.add(p)
    repos.push({ path: p, name: dirName(p), rel, up })
  }

  // 1) 当前目录本身
  if (isRepoDir(start)) push(start, 0, '')

  // 2) 向下 BFS：仓库目录不再往下探（嵌套仓库极少，省预算）
  let level = [start]
  for (let d = 1; d <= depth && level.length && !truncated; d++) {
    const next: string[] = []
    for (const dir of level) {
      let names: string[]
      try { names = readdirSync(dir) } catch { continue }   // 无权限 / 已消失：跳过
      for (const name of names) {
        if (skipName(name)) continue
        const child = join(dir, name)
        try { if (lstatSync(child).isSymbolicLink()) continue } catch { continue }   // 符号链接可能成环
        visited++
        if (visited > maxDirs) { truncated = true; break }
        if (isRepoDir(child)) push(child, 0, relative(start, child).split(sep).join('/'))
        else next.push(child)
      }
      if (truncated) break
    }
    level = next
  }

  // 3) 向上最多 UP_MAX 级（到根 / 目录不足 2 级时按实际层数停，不切目录）
  let cur = start
  for (let up = 1; up <= UP_MAX && !truncated; up++) {
    const parent = dirname(cur)
    if (parent === cur) break
    if (isRepoDir(parent)) push(parent, up, '')
    cur = parent
  }

  return { repos, truncated }
}

/** 远程「周边 Git 项目」：走终端通道跑 find，只向下 2 层（远端不向上到根：根目录 find 太贵），最多 100 条 */
export const REMOTE_SCAN_MAX = 100
const REMOTE_SCAN_TIMEOUT_MS = 8000

type Run = (cmd: string, o: { timeoutMs: number; maxBytes?: number }) => Promise<{ code: number | null; output: string }>

/** 远端扫描：命令在目标终端上跑；超时 / 失败一律当空结果，不能让面板崩 */
export async function scanRemoteRepos(startDir: string, run: Run, opts: { max?: number } = {}): Promise<{ repos: GitRepoHit[]; truncated: boolean }> {
  const dir = startDir.trim().replace(/\/+$/, '') || '/'
  const max = opts.max ?? REMOTE_SCAN_MAX
  // 单引号包裹（路径里可能有空格 / 中文）；内部单引号按 shell 规则转义成 '\''
  const q = "'" + dir.split("'").join("'\\''") + "'"
  // 关键两条：
  // 1) 库包目录必须 -prune（否则 node_modules 下几千个子包全要列一遍，远端能卡十几秒）
  // 2) 命中 .git 后也要 -prune —— 不然 find 会进入 .git/objects 扫几万个对象文件
  const SKIP = '-name node_modules -o -name target -o -name vendor -o -name dist -o -name build -o -name .venv -o -name __pycache__ -o -name .pnpm-store'
  // -maxdepth 3：仓库在 dir 的孙目录时，.git 本身在第 3 层
  // 向下：find（带 prune）。向上：最多 UP_MAX 级，直接 ls -a 上级目录看有没有 .git——
  // 不切目录、一条命令跑完两级；目录不足两级时（到了 /）ls 失败自动跳过
  const downCmd = `find ${q} -maxdepth 3 \\( ${SKIP} \\) -prune -o -name .git -print -prune 2>/dev/null | head -${max + 1}`
  const upCmd = (n: number) => 'd=' + q + '/..'.repeat(n) + '; ls -a "$d" 2>/dev/null | grep -qx "[.]git" && { p=$(cd "$d" 2>/dev/null && pwd); [ -n "$p" ] && echo "' + n + ':$p"; }'
  const cmd = [downCmd, upCmd(1), upCmd(2)].join('; ') + '; true'
  const r = await run(cmd, { timeoutMs: REMOTE_SCAN_TIMEOUT_MS, maxBytes: 256 * 1024 }).catch(() => undefined)
  if (!r || !r.output.trim()) return { repos: [], truncated: false }
  const repos: GitRepoHit[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const raw of r.output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const upHit = /^([12]):(.+)$/.exec(line)
    if (upHit) {
      const depth = Number(upHit[1])
      const full = upHit[2].replace(/\/+$/, '') || '/'
      if (seen.has(full)) continue
      seen.add(full)
      repos.push({ path: full, name: full.split('/').pop() || full, rel: '', up: depth })
      continue
    }
    if (!line.endsWith('/.git')) continue
    const full = line.slice(0, -'/.git'.length) || '/'
    if (seen.has(full)) continue
    if (repos.length >= max) { truncated = true; break }
    seen.add(full)
    const rel = full === dir ? '' : full.startsWith(`${dir}/`) ? full.slice(dir.length + 1) : ''
    repos.push({ path: full, name: full.split('/').pop() || full, rel, up: 0 })
  }
  return { repos, truncated }
}
