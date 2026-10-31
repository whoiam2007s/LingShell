// 本机独立通道：Git 助手 / 本机视图 / 接口调试的只读查询与手动操作在本机跑的子进程，不进用户看得见的终端。
// runSh：Windows 用 Git Bash（同本地终端），其它系统 /bin/sh；runFile：直接起程序（netstat / tasklist / taskkill，不经 shell）。
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecFullResult } from '@lingshell/terminal-core'
import { LOCAL_SHELL } from './bgJobExec.js'

export interface LocalRunOpts { timeoutMs: number; maxBytes?: number; stdin?: string; cwd?: string }

/** sh -c 跑一条命令：stdout / stderr 合并，超时杀掉（code = null） */
export function runSh(command: string, o: LocalRunOpts, shell: { file(): string; env(): NodeJS.ProcessEnv } = LOCAL_SHELL): Promise<ExecFullResult> {
  return new Promise((resolve, reject) => {
    let file: string
    try { file = shell.file() } catch (e) { reject(e); return }
    const p = spawn(file, ['-c', command], { cwd: o.cwd || homedir(), env: shell.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const max = o.maxBytes ?? 512 * 1024
    const chunks: Buffer[] = []
    let size = 0, truncated = false, stopped: ExecFullResult['stopped']
    const take = (d: Buffer) => { if (size >= max) truncated = true; else { chunks.push(d); size += d.length; if (size > max) truncated = true } }
    p.stdout.on('data', take); p.stderr.on('data', take)
    p.stdin.on('error', () => { /* 子进程没读 stdin 就退出：忽略 EPIPE */ })
    p.stdin.end(o.stdin ?? '')
    const timer = setTimeout(() => { stopped = 'timeout'; p.kill() }, o.timeoutMs)
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: stopped ? null : code, output: Buffer.concat(chunks).subarray(0, max).toString('utf8'), truncated, ...(stopped ? { stopped } : {}) })
    })
  })
}

/** 直接起一个程序取输出（Buffer：Windows 自带命令按系统代码页输出，由调用方解码） */
export function runFile(file: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      if (e && typeof e.code === 'string') { reject(e); return }   // ENOENT 等：程序都起不来
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })
    })
  })
}

/** Windows 自带命令的输出：UTF-8 解不干净（有替换字符）就按 GBK（中文系统代码页 936）解 */
export function decodeConsole(b: Buffer): string {
  const u = b.toString('utf8')
  if (!u.includes('�')) return u
  try { return new TextDecoder('gbk').decode(b) } catch { return u }
}

/**
 * 本机数据库客户端：Windows 上 MySQL / PostgreSQL 安装程序默认不把 bin 加进 PATH（装了却找不到 mysql）。
 * 跑本机数据库命令时把标准安装目录里找到的 bin 补到 PATH 前面；其它系统照旧
 */
export function dbClientDirs(root = process.env.ProgramFiles ?? 'C:\\Program Files'): string[] {
  if (process.platform !== 'win32') return []
  const out: string[] = []
  const sub = (dir: string) => { try { return readdirSync(dir) } catch { return [] } }
  for (const v of sub(join(root, 'MySQL')).sort().reverse()) { const b = join(root, 'MySQL', v, 'bin'); if (existsSync(join(b, 'mysql.exe'))) out.push(b) }
  for (const v of sub(join(root, 'PostgreSQL')).sort((a, b) => Number(b) - Number(a))) { const b = join(root, 'PostgreSQL', v, 'bin'); if (existsSync(join(b, 'psql.exe'))) out.push(b) }
  return out
}
export const DB_LOCAL_SHELL = {
  file: () => LOCAL_SHELL.file(),
  env: (): NodeJS.ProcessEnv => {
    const env = LOCAL_SHELL.env()
    const extra = dbClientDirs()
    if (!extra.length) return env
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    return { ...env, [key]: [...extra, env[key] ?? ''].join(';') }
  },
}
