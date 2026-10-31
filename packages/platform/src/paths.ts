import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'

// 统一数据根目录：~/.lingshell/。
// 所有业务文件（配置、日志、会话隔离）都落在这里，不分散到各处。
export const APP_DIR_NAME = '.lingshell'

export interface AppPaths {
  root: string        // ~/.lingshell
  config: string      // ~/.lingshell/config
  logs: string        // ~/.lingshell/logs
  sessions: string    // ~/.lingshell/sessions
  recordings: string  // ~/.lingshell/recordings（终端录像，按日期分目录）
}

/** 解析并确保数据目录存在。可注入 rootOverride（指定数据目录 / 测试用）；home 可注入（测试用） */
export function resolveAppPaths(rootOverride?: string, home = homedir()): AppPaths {
  const root = rootOverride ?? join(home, APP_DIR_NAME)
  const paths: AppPaths = {
    root,
    config: join(root, 'config'),
    logs: join(root, 'logs'),
    sessions: join(root, 'sessions'),
    recordings: join(root, 'recordings'),
  }
  for (const p of [paths.root, paths.config, paths.logs, paths.sessions, paths.recordings]) {
    mkdirSync(p, { recursive: true })
  }
  return paths
}

/**
 * 按启动时间生成本次运行的日志目录名。
 * 不在内部调 Date（保持可测），由调用方传入时间戳字符串。
 * 格式建议：2026-06-29_15-42-30
 */
export function logSessionDir(logsRoot: string, startedAtLabel: string): string {
  const dir = join(logsRoot, startedAtLabel)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 只保留最近 keep 次运行的日志目录，其余删掉。每次启动建一个目录、从不清理，实测半年攒到 135 个 / 259MB。
 * 目录名是 YYYY-MM-DD_HH-mm-ss，字典序即时间序；名字不合这个格式的不碰。删除失败（被占用）跳过，下次再删。
 */
export function pruneLogDirs(logsRoot: string, keep = 20): string[] {
  const runs = readdirSync(logsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name).sort()
  const removed: string[] = []
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    try { rmSync(join(logsRoot, name), { recursive: true, force: true }); removed.push(name) } catch { /* 被占用 */ }
  }
  return removed
}

/** 生成启动时间标签（YYYY-MM-DD_HH-mm-ss）。在主进程启动时调用一次。 */
export function makeStartedAtLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
